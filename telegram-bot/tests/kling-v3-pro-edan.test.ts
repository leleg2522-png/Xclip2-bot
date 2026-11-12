import assert from 'node:assert/strict';
import { withGenerationErrors } from './generation-error-harness';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { generateKlingV3Pro, klingV3ProRequest, KLING_V3_PRO } from '../src/kling-v3-pro-edan';

const asset = { type: 'image', url: 'https://edan.test/start.png', name: 'start.png', size: 100 };
const end = { ...asset, url: 'https://edan.test/end.png', name: 'end.png' };
const image = { buffer: Buffer.from('image'), name: 'frame.png', mime: 'image/png' };
assert.deepEqual(klingV3ProRequest('move', [asset, end]), {
  model: 'kling-3',
  fields: {
    prompt: 'move', aspect_ratio: '9:16', duration: 15, resolution: '1080p',
    start_image: asset, end_image: end, generate_audio: true,
  },
});
assert.equal('end_image' in klingV3ProRequest('move', [asset]).fields, false);
assert.throws(() => klingV3ProRequest('move', []), /INVALID_INPUT/);
assert.throws(() => klingV3ProRequest('move', [asset, end, asset]), /INVALID_INPUT/);

async function providerTests() {
  for (const failure of ['none', 'upload-auth', 'submit-auth', 'poll-auth', 'timeout', 'missing-id', 'poll-fail']) {
    const events = { submits: 0, polls: 0, dead: [] as number[], uploads: 0 };
    const auth = () => Object.assign(new Error('authentication rejected'), { response: { status: 401 } });
    const promise = generateKlingV3Pro('move', [image, image], {
      cookies: async () => [{ id: 1, cookie: 'one' }, { id: 2, cookie: 'two' }],
      markDead: async id => { events.dead.push(id); },
      upload: async cookie => {
        events.uploads++;
        if (failure === 'upload-auth' && cookie === 'one') throw auth();
        return asset;
      },
      submit: async cookie => {
        events.submits++;
        if (failure === 'submit-auth' && cookie === 'one') throw auth();
        if (failure === 'timeout') throw new Error('ETIMEDOUT');
        return failure === 'missing-id' ? '' : 'accepted';
      },
      poll: async (_cookie, jobId) => {
        events.polls++;
        assert.equal(jobId, 'accepted');
        if (failure === 'poll-auth') throw auth();
        if (failure === 'poll-fail') throw new Error('provider failed');
        return 'https://edan.test/native.mp4';
      },
    });
    if (['none', 'upload-auth', 'submit-auth'].includes(failure)) {
      assert.equal((await promise).url, 'https://edan.test/native.mp4');
      assert.equal(events.polls, 1);
      assert.equal(events.submits, failure === 'submit-auth' ? 2 : 1);
    } else {
      await assert.rejects(promise);
      assert.equal(events.submits, 1, `${failure} must never resubmit`);
    }
    if (failure.endsWith('-auth')) assert.deepEqual(events.dead, [1]);
  }
  await assert.rejects(generateKlingV3Pro('move', [image], {
    cookies: async () => [], markDead: async () => {}, upload: async () => asset,
    submit: async () => 'unused', poll: async () => 'unused',
  }), /NO_COOKIE/);
}

const source = readFileSync('src/index.ts', 'utf8');
assert.doesNotMatch(source, /Kling v3 Standard/);
assert.match(source, /if \(opts\.model === 'kling_v3'\) \{\s*return runKlingV3Pro/);
assert.match(source, /Kling v3 Turbo/);
assert.match(source, /Tambah Frame Akhir/);
assert.match(source, /model === 'kling_v3' \? KLING_V3_PRO.maxImages/);

async function billingTests() {
  const start = source.indexOf('async function runKlingV3Pro(');
  const stop = source.indexOf('async function runPicsartI2v(', start);
  const runner = source.slice(start, stop);
  assert.doesNotMatch(runner, /upscaleGeneratedVideo|generatePicsartI2v/);
  for (const failure of ['none', 'generate', 'delivery', 'throw-delivery', 'charge', 'download', 'invalid']) {
    const events = { charges: 0, refunds: 0, released: 0, delivered: 0, usage: 0, provider: 0 };
    const ctx = vm.createContext({
      KLING_V3_PRO, getPicsartI2vPrice: () => 3500,
      beginCharge: async (_id: number, price: number) => { events.charges++; assert.equal(price, 3500); return {ok: failure !== 'charge'}; },
      chargeFailMsg: () => 'no saldo',
      bot: {telegram: { editMessageText: async () => {}, sendMessage: async () => {}, deleteMessage: async () => {} }},
      downloadBuffer: async () => { if (failure === 'download') throw new Error('failed'); return {buf: Buffer.from('image'),ext:'png',mime:'image/png'}; },
      generateKlingV3Pro: async () => { events.provider++; if (failure === 'generate') throw new Error('failed'); return {url:'https://edan.test/native.mp4',jobId:'accepted'}; },
      getAvailableEdanbotCookies() {}, markEdanbotCookieDead() {}, uploadToEdanbot() {}, edanbotHttp: {}, pollEdanbotJob() {}, EDANBOT_JOB_TIMEOUT_MS: 1200000,
      sendResult: async (_chat: number, url: string, caption: string) => {
        events.delivered++; assert.equal(url, 'https://edan.test/native.mp4');
        assert.match(caption, /Kling v3 Pro 1080/); assert.doesNotMatch(caption, /Edan|Picsart|Renderful/i);
        if (failure === 'throw-delivery') throw new Error('Telegram failed');
        return failure !== 'delivery';
      },
      incrementKlingUsage: async () => { events.usage++; }, markGenSuccess() {},
      addSaldo: async (_id: number, price: number) => { assert.equal(price,3500); events.refunds++; },
      releaseGenerating: () => { events.released++; }, describeError: () => 'error',
      formatRupiah: (n: number) => `Rp${n}`, console: {log() {},error() {}},
    });
    vm.runInContext(ts.transpile(runner, {target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}), withGenerationErrors(ctx));
    await ctx.runKlingV3Pro(1, 2, 3, 4, 'move', failure === 'invalid' ? [] : ['https://photo.test/a']);
    assert.equal(events.refunds, ['none','charge'].includes(failure) ? 0 : 1, failure);
    assert.equal(events.usage, failure === 'none' ? 1 : 0);
    assert.equal(events.released, failure === 'charge' ? 0 : 1);
    if (failure === 'charge' || failure === 'invalid' || failure === 'download') assert.equal(events.provider, 0);
  }
}

async function main() {
  await providerTests();
  await billingTests();
  console.log('Kling v3 Pro: HAR payload, routing, optional end frame, failover and refund tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
