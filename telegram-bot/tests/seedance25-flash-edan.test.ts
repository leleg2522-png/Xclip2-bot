import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {
  generateSeedance25FlashEdan,
  seedance25FlashEdanRequest,
  SEEDANCE25_FLASH_EDAN,
} from '../src/seedance25-flash-edan';

const asset = { type: 'image', url: 'https://edanbot.digital/uploads/reference.png', name: 'reference.png', size: 20 };
const image = { buffer: Buffer.from('image'), name: 'reference.png', mime: 'image/png' };

const request = seedance25FlashEdanRequest('A bright landscape', [asset]);
assert.equal(request.model, 'seedance-2.5-flash-480p');
assert.match(request.request_id, /^[\da-f-]{36}$/i);
assert.deepEqual(request.fields, {
  prompt: 'A bright landscape',
  aspect_ratio: '16:9',
  duration: 30,
  resolution: '480p',
  reference_images: ['https://edanbot.digital/uploads/reference.png'],
});
assert.equal(SEEDANCE25_FLASH_EDAN.maxImages, 9);
assert.throws(() => seedance25FlashEdanRequest('prompt', []), /INVALID_REFERENCES/);
assert.throws(() => seedance25FlashEdanRequest('prompt', [
  { ...asset, url: 'http://edanbot.digital/reference.png' },
]), /INVALID_REFERENCES/);
assert.throws(() => seedance25FlashEdanRequest('prompt', [
  { ...asset, url: 'https://evil.example/reference.png' },
]), /INVALID_REFERENCES/);
assert.throws(() => seedance25FlashEdanRequest('prompt', Array.from({ length: 10 }, () => asset)), /INVALID_REFERENCES/);

async function providerTests() {
  const events = { submitted: 0, polled: 0, markedDead: [] as number[], uploaded: 0, stages: [] as string[] };
  const result = await generateSeedance25FlashEdan('A bright landscape', [image], {
    cookies: async () => [{ id: 1, cookie: 'cookie' }],
    markDead: async id => { events.markedDead.push(id); },
    upload: async () => { events.uploaded++; return asset; },
    submit: async (_cookie, body) => {
      events.submitted++;
      assert.equal(body.model, 'seedance-2.5-flash-480p');
      assert.match(body.request_id, /^[\da-f-]{36}$/i);
      assert.deepEqual(body.fields.reference_images, [asset.url]);
      return 'accepted-job';
    },
    poll: async (_cookie, jobId) => {
      events.polled++;
      assert.equal(jobId, 'accepted-job');
      return 'https://cdn.example/result.mp4';
    },
    onStatus: stage => { events.stages.push(stage); },
  });
  assert.deepEqual(result, { url: 'https://cdn.example/result.mp4', jobId: 'accepted-job' });
  assert.deepEqual(events.stages, ['upload', 'submit', 'poll']);
  assert.equal(events.submitted, 1);
  assert.equal(events.polled, 1);
  assert.equal(events.uploaded, 1);
  assert.deepEqual(events.markedDead, []);

  const authEvents = { submitted: 0, markedDead: [] as number[] };
  const authResult = await generateSeedance25FlashEdan('prompt', [image], {
    cookies: async () => [{ id: 1, cookie: 'dead' }, { id: 2, cookie: 'valid' }],
    markDead: async id => { authEvents.markedDead.push(id); },
    upload: async cookie => {
      if (cookie === 'dead') throw Object.assign(new Error('expired'), { response: { status: 401 } });
      return asset;
    },
    submit: async () => { authEvents.submitted++; return 'accepted-after-rotation'; },
    poll: async () => 'https://cdn.example/result.mp4',
  });
  assert.equal(authResult.jobId, 'accepted-after-rotation');
  assert.equal(authEvents.submitted, 1);
  assert.deepEqual(authEvents.markedDead, [1]);

  for (const failure of ['submit-timeout', 'poll-failure']) {
    const state = { submits: 0, polls: 0 };
    await assert.rejects(generateSeedance25FlashEdan('prompt', [image], {
      cookies: async () => [{ id: 1, cookie: 'one' }, { id: 2, cookie: 'two' }],
      markDead: async () => {},
      upload: async () => asset,
      submit: async () => {
        state.submits++;
        if (failure === 'submit-timeout') throw new Error('ETIMEDOUT');
        return 'accepted-once';
      },
      poll: async () => {
        state.polls++;
        throw new Error('poll failed');
      },
    }));
    assert.equal(state.submits, 1, `${failure} must not replay a paid submission`);
    assert.equal(state.polls, failure === 'poll-failure' ? 1 : 0);
  }
  await assert.rejects(generateSeedance25FlashEdan('prompt', [image], {
    cookies: async () => [], markDead: async () => {}, upload: async () => asset,
    submit: async () => 'unused', poll: async () => 'unused',
  }), /NO_COOKIE/);
}

async function billingTests() {
  const source = readFileSync('src/index.ts', 'utf8');
  const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
  const declaration = ast.statements.find(node =>
    ts.isFunctionDeclaration(node) && node.name?.text === 'runEdanbotSeedance25Flash');
  assert(declaration, 'runEdanbotSeedance25Flash exists');
  const runner = declaration.getText(ast);
  const events = { charge: 0, refund: 0, release: 0, delivered: 0, generated: 0, usage: 0, notify: 0 };

  for (const failure of ['none', 'generation', 'delivery', 'charge', 'throw-delivery']) {
    Object.keys(events).forEach(key => { (events as any)[key] = 0; });
    const context = vm.createContext({
      MODEL_PRICES: { edanbot_seedance25_flash: 6000 },
      MAX_PARALLEL_GENERATIONS_PER_USER: 3,
      SEEDANCE25_FLASH_EDAN,
      beginCharge: async (_id: number, amount: number) => {
        events.charge++;
        assert.equal(amount, 6000);
        return { ok: failure !== 'charge' };
      },
      chargeFailMsg: () => 'no saldo',
      bot: { telegram: {
        editMessageText: async () => {},
        sendMessage: async () => {},
        deleteMessage: async () => {},
      } },
      generateSeedance25FlashEdan: async (_prompt: string, _images: unknown, deps: any) => {
        events.generated++;
        assert.equal(deps.cookies, context.getAvailableEdanbotCookies);
        if (failure === 'generation') throw new Error('generation failed');
        return { url: 'https://cdn.example/video.mp4', jobId: 'accepted' };
      },
      getAvailableEdanbotCookies: async () => [],
      markEdanbotCookieDead: async () => {},
      uploadToEdanbot: async () => ({}),
      edanbotHttp: { post: async () => ({ data: { job_id: 'accepted' } }) },
      pollEdanbotJob: async () => 'https://cdn.example/video.mp4',
      EDANBOT_JOB_TIMEOUT_MS: 1_200_000,
      sendResult: async (_chat: number, _url: string, caption: string) => {
        events.delivered++;
        assert.match(caption, /Seedance 2\.5 Flash 480p/);
        assert.match(caption, /480p/);
        assert.doesNotMatch(caption, /Edanbot|Picsart/i);
        if (failure === 'throw-delivery') throw new Error('delivery failed');
        return failure !== 'delivery';
      },
      incrementKlingUsage: async () => { events.usage++; return 1; },
      markGenSuccess: () => {},
      addSaldo: async (_id: number, amount: number) => { assert.equal(amount, 6000); events.refund++; },
      releaseGenerating: () => { events.release++; },
      describeError: () => 'safe error',
      notifyGenerationFailure: async () => { events.notify++; },
      formatRupiah: (amount: number) => `Rp${amount}`,
      console: { log() {}, error() {} },
    });
    vm.runInContext(ts.transpile(runner, {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
    }), context);
    await context.runEdanbotSeedance25Flash(1, 2, 3, 4, 'prompt', [image]);
    assert.equal(events.refund, ['none', 'charge'].includes(failure) ? 0 : 1, failure);
    assert.equal(events.usage, failure === 'none' ? 1 : 0, failure);
    assert.equal(events.release, failure === 'charge' ? 0 : 1, failure);
    assert.equal(events.generated, failure === 'charge' ? 0 : 1, failure);
    assert.equal(events.notify, ['none', 'charge'].includes(failure) ? 0 : 1, failure);
  }
  assert.match(source, /mode_seedance25_flash_edanbot/);
  assert.match(source, /Seedance 2\.5 Flash · Gambar · 30 detik · 480p/);
  assert.match(source, /mode_seedance25_flash_edanbot\s*:\s*'seedance25_flash'/);
  assert.match(source, /runPicsartSeedance25Flash\(/);
}

async function main() {
  await providerTests();
  await billingTests();
  console.log('Edanbot Seedance 2.5 Flash: HAR contract, cookie rotation, no replay, menu routing and refunds passed');
}
main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
