import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { VivareelWanClient, wanRequest, VIVAREEL_WAN_MODEL } from '../src/vivareel-wan';
import { wanCropPlan } from '../src/vivareel-wan-media';

const json = (data: unknown, status = 200) => new Response(JSON.stringify({ code: 200, data }), { status });
const catalog = { video_models: [{ name: VIVAREEL_WAN_MODEL, is_available: true,
  max_reference_images: 5,
  allowed_resolutions: ['720P'], capabilities: ['text_to_video', 'first_frame', 'image_reference'],
  max_duration_seconds: { text_to_video: 30, first_frame: 30, image_reference: 30 } }] };
async function main() {
  for (const ratio of ['9:16', '16:9'] as const) {
    for (const count of [0, 1, 5]) {
      const body = wanRequest('duel', ratio, Array.from({ length: count }, (_, i) => `https://cdn.example/${i}.jpg`));
      assert.equal(body.duration_seconds, 30);
      assert.equal(body.resolution, '720P');
      assert.equal(body.aspect_ratio, ratio);
      assert.equal(body.audio, true);
      assert.equal(body.watermark, false);
      assert.equal(body.capability, count === 1 ? 'first_frame' : count > 1 ? 'image_reference' : undefined);
      assert.equal(body.image_url, count === 1 ? 'https://cdn.example/0.jpg' : undefined);
      assert.equal(body.reference_urls?.length ?? 0, count > 1 ? count : 0);
    }
  }
  assert.throws(() => wanRequest('', '9:16'));
  assert.throws(() => wanRequest('test', '9:16', ['http://example.com/image']));
  assert.throws(() => wanRequest('test', '9:16', Array(6).fill('https://cdn.example/image')));
  assert.throws(() => new VivareelWanClient(''));
  assert.deepEqual(wanCropPlan(720, 1280, '9:16'), { width: 648, height: 1152, x: 36, y: 0 });
  assert.deepEqual(wanCropPlan(1280, 720, '16:9'), { width: 1088, height: 612, x: 0, y: 0 });
  assert.throws(() => wanCropPlan(720, 720, '9:16'));

  const image = { buffer: Buffer.from('reference'), mime: 'image/jpeg', name: 'reference.jpg' };
  const calls: { path: string; method: string; body?: any }[] = [];
  let reads = 0;
  const transport: typeof fetch = async (url, options) => {
    const path = new URL(String(url)).pathname;
    assert.equal((options?.headers as any).Authorization, 'Bearer fake-test-key');
    const method = options?.method ?? 'GET';
    calls.push({ path, method, body: typeof options?.body === 'string' ? JSON.parse(options.body) : options?.body });
    if (path.endsWith('/models')) return json(catalog);
    if (path.endsWith('/files')) {
      assert.ok(options?.body instanceof FormData);
      assert.equal((options?.headers as any)['Content-Type'], undefined);
      return json({ url: 'https://cdn.example/reference.jpg' });
    }
    if (method === 'POST') return json({ task_id: 'job-accepted-once' });
    if (++reads === 1) return new Response('', { status: 503 });
    if (reads === 2) return json({ status: 'running' });
    return json({ status: 'completed', result_url: 'https://cdn.example/result.mp4',
      points_cost: 210, extra: { billing_points: 180 } });
  };
  const client = new VivareelWanClient('fake-test-key', transport, async () => {});
  const stages: string[] = [];
  const result = await client.generate({ prompt: 'duel', ratio: '16:9', images: [image],
    onStatus: stage => stages.push(stage) });
  assert.deepEqual(stages, ['upload', 'submit', 'poll']);
  assert.equal(result.credits, 180);
  assert.equal(calls.filter(c => c.path.endsWith('/videos/generations')).length, 1);
  const body = calls.find(c => c.path.endsWith('/videos/generations'))!.body;
  assert.equal(body.capability, 'first_frame');
  assert.equal(body.resolution, '720P');
  assert.equal(body.aspect_ratio, '16:9');

  for (const failure of ['timeout', '401', '429', 'invalid', 'missing-id']) {
    let submissions = 0;
    const fail: typeof fetch = async () => {
      submissions++;
      if (failure === 'timeout') throw Error('transport error with sensitive content');
      if (failure === 'invalid') return new Response('not json');
      if (failure === 'missing-id') return json({});
      return new Response('', { status: Number(failure) });
    };
    const c = new VivareelWanClient('fake-test-key', fail, async () => {});
    await assert.rejects(c.submit(wanRequest('duel', '9:16')), error => {
      assert.doesNotMatch(String(error), /sensitive content|fake-test-key/);
      return true;
    });
    assert.equal(submissions, 1);
  }
  for (const state of ['failed', 'cancelled', 'unexpected']) {
    const c = new VivareelWanClient('fake-test-key', async () => json({ status: state }), async () => {});
    await assert.rejects(c.poll('accepted-job'));
  }
  await assert.rejects(client.poll('accepted-job', undefined, 0), /TIMEOUT/);
  const missing = new VivareelWanClient('fake-test-key', async () => json({ video_models: [] }), async () => {});
  await assert.rejects(missing.generate({ prompt: 'test' }), /MODEL_UNAVAILABLE/);

  // Execute the actual Telegram orchestration without starting the bot or touching a wallet.
  const source = readFileSync('src/index.ts', 'utf8');
  const start = source.indexOf('async function runPicsartI2v(');
  const end = source.indexOf('// ─── Background: Picsart Seedance 2.5', start);
  const compiled = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  for (const mode of ['success', 'provider-failure', 'crop-failure', 'delivery-failure', 'charge-rejected', 'other-model']) {
    const events: string[] = [], refunds: number[] = [];
    const context: any = {
      console: { log() {}, warn() {}, error() {} },
      Buffer, Date, Error, Math,
      picsart: {
        PICSART_I2V_MODELS: { wan_v3: { label: 'Wan 3.0', settingsLabel: '30 detik · 720p · crop otomatis' },
          pixverse_v6: { label: 'PixVerse', settingsLabel: '15 detik' } },
        PICSART_I2V_MAX_IMAGES: 5,
        generatePicsartI2v: async () => { events.push('picsart'); return { url: 'https://cdn.example/other.mp4' }; },
        describePicsartPostSubmitCause: () => '',
      },
      customerSafeModelLabel: (x: string) => x, isSeedance2I2vModel: () => false,
      userModelPrice: async () => 6000, getPicsartI2vPrice: () => 6000,
      beginCharge: async () => ({ ok: mode !== 'charge-rejected', reason: 'insufficient' }),
      chargeFailMsg: () => 'insufficient', supportsMultiplePicsartI2vImages: () => true,
      downloadBuffer: async () => ({ buf: Buffer.from('reference'), ext: 'jpg', mime: 'image/jpeg' }),
      generateVivareelWan: async () => {
        events.push('vivareel');
        if (mode === 'provider-failure') throw Error('VIVAREEL_SUBMIT_AMBIGUOUS');
        return { url: 'https://cdn.example/native.mp4', credits: 120 };
      },
      prepareWanDelivery: async (_url: string, ratio: string) => {
        events.push('crop');
        assert.equal(ratio, '9:16');
        if (mode === 'crop-failure') throw Error('WAN_CROP_VALIDATION_FAILED');
        return Buffer.from('cropped-output');
      },
      sendResult: async (...args: any[]) => {
        events.push('send');
        if (mode !== 'other-model') assert.equal(args[5].toString(), 'cropped-output');
        return mode !== 'delivery-failure';
      },
      incrementKlingUsage: async () => { events.push('usage'); return 1; },
      markGenSuccess: () => events.push('success'),
      addSaldo: async (_id: number, price: number) => refunds.push(price),
      formatRupiah: (n: number) => String(n), describeError: (e: Error) => e.message,
      releaseGenerating: () => events.push('release'),
      bot: { telegram: { editMessageText: async () => {}, sendMessage: async () => {}, deleteMessage: async () => {} } },
    };
    vm.createContext(context);
    vm.runInContext(compiled, context);
    await context.runPicsartI2v(1, 2, 3, 4, 'duel', {
      model: mode === 'other-model' ? 'pixverse_v6' : 'wan_v3', imageUrls: ['https://example.com/photo.jpg'],
      ratio: '9:16',
    });
    if (mode === 'charge-rejected') assert.deepEqual(events, []);
    else {
      assert.equal(events.at(-1), 'release');
      assert.equal(events.filter(e => e === 'vivareel').length, mode === 'other-model' ? 0 : 1);
      assert.equal(events.includes('picsart'), mode === 'other-model');
      assert.deepEqual(refunds, ['provider-failure', 'crop-failure', 'delivery-failure'].includes(mode) ? [6000] : []);
      if (mode === 'provider-failure' || mode === 'crop-failure') assert.ok(!events.includes('send'));
      if (mode === 'success') assert.ok(events.includes('success'));
    }
  }
  assert.match(source, /picsart_wan_v3: 6000/);
  assert.match(source, /true, false, preparedBuffer/);
  assert.match(readFileSync('src/picsart.ts', 'utf8'), /input\.model === 'wan_v3'.*WAN_V3_USES_VIVAREEL/);
  // Confirm the shared sender uses only processed bytes, including its link fallback.
  const senderStart = source.indexOf('async function sendResult(');
  const senderEnd = source.indexOf('\n}', senderStart) + 2;
  const senderCode = ts.transpileModule(source.slice(senderStart, senderEnd), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  for (const strategy of ['video', 'document', 'link', 'failed']) {
    const bytes = Buffer.from('cropped-only');
    const deliveries: string[] = [];
    const context: any = {
      console: { log() {} }, Buffer,
      telegramHttp: { get: async () => { throw Error('Must not download the branded original'); } },
      publishMedia: async (buffer: Buffer) => {
        assert.equal(buffer, bytes);
        if (strategy === 'failed') throw Error('hosting failed');
        deliveries.push('link');
        return 'https://our-bot.example/dl/processed';
      },
      bot: { telegram: {
        sendVideo: async (_chat: number, media: any) => {
          assert.equal(media.source, bytes);
          if (strategy !== 'video') throw Error('video rejected');
          deliveries.push('video');
        },
        sendDocument: async (_chat: number, media: any) => {
          assert.equal(media.source, bytes);
          if (strategy !== 'document') throw Error('document rejected');
          deliveries.push('document');
        },
        sendMessage: async (_chat: number, message: string) => {
          assert.doesNotMatch(message, /cdn\.example/);
        },
      } },
    };
    vm.createContext(context);
    vm.runInContext(senderCode, context);
    const delivered = await context.sendResult(1, 'https://cdn.example/native.mp4', 'Wan 3.0', true, false, bytes);
    assert.equal(delivered, strategy !== 'failed');
    assert.deepEqual(deliveries, strategy === 'failed' ? [] : [strategy]);
  }
  console.log('Vivareel Wan tests passed: inputs, ratios, upload, single submit, polling, crop routing, refunds, other models.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
