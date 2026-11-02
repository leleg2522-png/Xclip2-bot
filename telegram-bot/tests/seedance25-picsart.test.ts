import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {
  SEEDANCE25_RATIOS, SEEDANCE25_MAX_IMAGES, SEEDANCE25_MAX_VIDEOS, SEEDANCE25_MAX_AUDIOS,
  SEEDANCE25_MAX_MEDIA_BYTES, SEEDANCE25_MAX_TOTAL_BYTES, SEEDANCE25_MAX_REFERENCE_SECONDS,
  validateSeedance25Request, seedance25ReferenceName, type Seedance25Settings,
} from '../src/seedance25-picsart';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const provider = readFileSync(new URL('../src/picsart.ts', import.meta.url), 'utf8');
function fragment(text: string, start: string, end: string) {
  const a = text.indexOf(start), b = text.indexOf(end, a);
  assert.ok(a >= 0 && b > a, `Missing boundaries: ${start}`);
  return text.slice(a, b);
}
function compile(text: string) {
  return ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}
const runner = compile(fragment(source, 'async function runPicsartSeedance25(', '// ─── Background: Seedance 2 Video Edit pipelines'));
const settings: Seedance25Settings = {
  provider: 'picsart', mode: 'reference', resolution: 1080, ratio: '9:16', audio: true,
};
type Options = {
  chargeFails?: boolean; downloadFails?: boolean; generationFails?: boolean;
  finishingFails?: boolean; finishingThrows?: boolean; deliveryFails?: boolean; deliveryThrows?: boolean;
  mediaSeconds?: number; mediaInvalid?: boolean;
};
function harness(options: Options = {}) {
  const events = {
    order: [] as string[], charges: [] as number[], refunds: [] as number[],
    releases: [] as number[], inputs: [] as any[], successes: [] as number[],
    deliveries: [] as Array<{ chatId: number; url: string; caption: string }>,
  };
  const context = vm.createContext({
    Buffer, validateSeedance25Request, MAX_PARALLEL_GENERATIONS_PER_USER: 3,
    SEEDANCE25_MAX_MEDIA_BYTES, SEEDANCE25_MAX_TOTAL_BYTES, SEEDANCE25_MAX_REFERENCE_SECONDS,
    seedance25ReferenceName,
    MODEL_PRICES: { picsart_seedance_25: 6000 },
    beginCharge: async (_: number, price: number) => {
      events.charges.push(price); return { ok: !options.chargeFails, reason: 'saldo' };
    },
    chargeFailMsg: () => 'Saldo tidak cukup',
    downloadBuffer: async () => {
      if (options.downloadFails) throw Error('DOWNLOAD_FAILED');
      return { buf: Buffer.from('reference'), mime: 'image/jpeg', ext: 'jpg' };
    },
    telegramHttp: { get: async () => {
      if (options.downloadFails) throw Error('DOWNLOAD_FAILED');
      return { data: Buffer.from('reference') };
    } },
    detectMime: () => ({ mime: 'image/jpeg', ext: 'jpg' }),
    inspectSeedance25Media: async () => {
      if (options.mediaInvalid) throw Error('INVALID_MEDIA');
      return options.mediaSeconds ?? 3;
    },
    picsart: { generateSeedance: async (input: any) => {
      events.order.push('generate'); events.inputs.push(input); input.onStatus('poll');
      if (options.generationFails) throw Error('PICSART_TIMEOUT');
      return { url: `https://example.test/${input.userId}-480.mp4` };
    } },
    upscaleGeneratedVideo: async (url: string) => {
      events.order.push('finish');
      if (options.finishingThrows) throw Error('UPSCALER_FAILED');
      return { url: options.finishingFails ? url : url.replace('-480', '-1080'), upscaled: !options.finishingFails };
    },
    sendResult: async (chatId: number, url: string, caption: string) => {
      events.order.push('deliver'); events.deliveries.push({ chatId, url, caption });
      if (options.deliveryThrows) throw Error('DELIVERY_FAILED');
      return !options.deliveryFails;
    },
    addSaldo: async (_: number, amount: number) => { events.refunds.push(amount); },
    releaseGenerating: (id: number) => events.releases.push(id),
    incrementKlingUsage: async () => 1,
    markGenSuccess: (id: number) => events.successes.push(id),
    describeError: (error: Error) => error.message,
    formatRupiah: (amount: number) => `Rp${amount}`,
    console: { log() {}, warn() {}, error() {} },
    bot: { telegram: {
      editMessageText: async () => {}, sendMessage: async () => {}, deleteMessage: async () => {},
    } },
  });
  vm.runInContext(runner, context);
  return {
    events,
    run: (draft = settings, count = draft.mode === 't2v' ? 0 : 1, id = 1, videos = 0, audios = 0) =>
      context.runPicsartSeedance25(id, id, id, 10, 'Epic action', Array(count).fill('https://example.test/ref.jpg'), draft,
        Array.from({ length: videos }, () => ({ url: 'https://example.test/v.mp4', mime: 'video/mp4', duration: 3 })),
        Array.from({ length: audios }, () => ({ url: 'https://example.test/a.mp3', mime: 'audio/mpeg', duration: 3 }))),
  };
}

async function checkAcceptedJobBinding() {
  const accountRunner = fragment(provider, 'async function runWithAccount<T>(', '// Admin: register');
  const generate = fragment(provider, 'export async function generateSeedance(', '// ─── Picsart Image-to-Video models')
    .replace('export async function', 'async function');
  for (const error of ['PICSART_INSUFFICIENT_CREDITS', 'PICSART_SUBMIT_FAILED status 401: expired', 'PICSART_REFRESH_DEAD', 'PICSART_TIMEOUT']) {
    let submits = 0;
    const context = vm.createContext({
      console: { log() {}, warn() {}, error() {} },
      MAX_ACCOUNT_ATTEMPTS: 2, ERR_INSUFFICIENT_CREDITS: 'PICSART_INSUFFICIENT_CREDITS',
      SEEDANCE_MIN_CREDITS: { '480p': { 30: 130 } },
      SEEDANCE_MAX_REF_IMAGES: 30, SEEDANCE_MAX_REF_VIDEOS: 10, SEEDANCE_MAX_REF_AUDIOS: 10,
      q: async () => ({ rows: [{ n: 2 }] }),
      acquireAccount: async (_: number, pool: unknown, tried: number[]) => {
        assert.equal(pool, null); return [1, 2].find(id => !tried.includes(id)) ?? null;
      },
      getCredits: async () => ({ credits: 500 }),
      uploadFile: async () => 'https://example.test/upload.jpg',
      submitSeedance: async () => { submits++; return 'accepted-job'; },
      pollSeedanceResult: async () => { throw Error(error); },
      isPicsartPostSubmitAuthFailure: (e: Error) => /PICSART_AUTH_DEAD|PICSART_REFRESH_DEAD/.test(e.message),
      isPicsartSubmitTokenRejection: () => false, isCreditError: () => true,
      handleCreditError: async () => {}, notifyOwner: () => {},
    });
    vm.runInContext(compile(accountRunner + generate), context);
    await assert.rejects(() => context.generateSeedance({
      userId: 1, images: [], prompt: 'test', duration: 30, resolution: '480p', ratio: '9:16',
    }), /PICSART_(?:SEEDANCE25_POST_SUBMIT_FAILED|POST_SUBMIT_AUTH_LOST)/);
    assert.equal(submits, 1, `Accepted job must not replay after ${error}`);
  }
}

async function checkSubmitContract() {
  const submit = fragment(provider, 'export async function submitSeedance(', 'export async function pollSeedanceResult(')
    .replace('export async function', 'async function');
  for (const status of [200, 401, 500, 202]) {
    let captured: any;
    const context = vm.createContext({
      API_BASE: 'https://example.test', SEEDANCE_MODEL: 'seedance_2_5',
      X_APP_AUTHORIZATION: 'test', getAccessToken: async () => 'test',
      SEEDANCE_MAX_REF_IMAGES: 30, SEEDANCE_MAX_REF_VIDEOS: 10, SEEDANCE_MAX_REF_AUDIOS: 10,
      commonHeaders: (headers: unknown) => headers, ok2xx: (n: number) => n >= 200 && n < 300,
      http: { post: async (_: string, payload: any) => {
        captured = payload.params;
        return { status, data: status === 200 ? { response: { id: 'accepted' } } : { credits: 'quota' } };
      } },
    });
    vm.runInContext(compile(submit), context);
    const promise = context.submitSeedance(1, {
      prompt: 'test', imageUrls: ['https://example.test/ref.jpg'], duration: 30,
      resolution: '480p', ratio: '16:9', generateAudio: false,
      videoUrls: ['https://example.test/video.mp4'], audioUrls: ['https://example.test/audio.mp3'],
    });
    if (status === 200) assert.equal(await promise, 'accepted');
    else await assert.rejects(() => promise, status === 401
      ? /PICSART_SUBMIT_FAILED status 401/
      : /PICSART_SEEDANCE25_POST_SUBMIT_FAILED/);
    assert.equal(captured.model, 'seedance_2_5');
    assert.equal(captured.duration, 30); assert.equal(captured.resolution, '480p');
    assert.equal(captured.ratio, '16:9'); assert.equal(captured.generate_audio, false);
    assert.equal(captured.omni_reference_task_type, 'reference');
    assert.equal(captured.content[0].role, 'reference_video');
    assert.equal(captured.content[1].role, 'reference_audio');
    assert.equal(captured.content[2].role, 'reference_image');
    assert.equal(captured.content[0].video_url.url, 'https://example.test/video.mp4');
    assert.equal(captured.content[1].audio_url.url, 'https://example.test/audio.mp3');
    const priorPayload = captured;
    await assert.rejects(() => context.submitSeedance(1, {
      prompt: 'test', imageUrls: ['https://example.test/' + 'x'.repeat(20000)],
      duration: 30, resolution: '480p', ratio: '16:9',
    }), /PICSART_SEEDANCE25_METADATA_TOO_LARGE/);
    assert.equal(captured, priorPayload, 'Oversized metadata must fail before a paid HTTP submit');
  }
}

async function checkMultiReferenceUploads() {
  const generate = compile(fragment(provider, 'export async function generateSeedance(', '// ─── Picsart Image-to-Video models')
    .replace('export async function', 'async function'));
  const uploads: Array<{ name: string; mime: string }> = [];
  let submitted: any, creditBalance = 500, accepted = 0;
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    SEEDANCE_MIN_CREDITS: { '480p': { 30: 130 } },
    SEEDANCE_MAX_REF_IMAGES: 30, SEEDANCE_MAX_REF_VIDEOS: 10, SEEDANCE_MAX_REF_AUDIOS: 10,
    ERR_INSUFFICIENT_CREDITS: 'PICSART_INSUFFICIENT_CREDITS',
    runWithAccount: async (_: number, pool: unknown, callback: any) => { assert.equal(pool, null); return callback(7); },
    getCredits: async () => ({ credits: creditBalance }),
    uploadFile: async (id: number, _: Buffer, name: string, mime: string, options: any) => {
      assert.equal(id, 7); assert.equal(options.gateway, true);
      uploads.push({ name, mime }); return `https://example.test/upload-${uploads.length}`;
    },
    submitSeedance: async (id: number, input: any) => { assert.equal(id, 7); submitted = input; accepted++; return 'job'; },
    pollSeedanceResult: async (id: number, job: string) => {
      assert.equal(id, 7); assert.equal(job, 'job'); return { url: 'https://example.test/result.mp4' };
    },
  });
  vm.runInContext(generate, context);
  const image = { buffer: Buffer.from('image'), name: 'ref.jpg', mime: 'image/jpeg' };
  const video = { buffer: Buffer.from('video'), name: 'ref.mp4', mime: 'video/mp4', duration: 3 };
  const audio = { buffer: Buffer.from('audio'), name: 'ref.ogg', mime: 'audio/ogg', duration: 3 };
  const input = { userId: 1, images: Array(30).fill(image), videos: Array(10).fill(video), audios: Array(10).fill(audio),
    prompt: 'Use all references', duration: 30, resolution: '480p', ratio: '9:16', generateAudio: false };
  await context.generateSeedance(input);
  assert.equal(uploads.length, 50); assert.equal(accepted, 1);
  assert.equal(submitted.imageUrls.length, 30); assert.equal(submitted.videoUrls.length, 10); assert.equal(submitted.audioUrls.length, 10);
  assert.equal(submitted.generateAudio, false); assert.equal(submitted.resolution, '480p');
  assert.equal(uploads.filter(u => u.mime === 'audio/ogg').length, 10);
  creditBalance = 130;
  await assert.rejects(() => context.generateSeedance(input), /INSUFFICIENT_CREDITS/);
  assert.equal(uploads.length, 50); assert.equal(accepted, 1, 'Input video costs must be included before submit');
  creditBalance = 500;
  for (const change of [
    { images: Array(31).fill(image) }, { videos: Array(11).fill(video) }, { audios: Array(11).fill(audio) },
    { videos: [{ ...video, duration: 31 }] }, { audios: [{ ...audio, duration: NaN }] },
  ]) {
    await assert.rejects(() => context.generateSeedance({ ...input, ...change }), /SEEDANCE25_INVALID/);
  }
  assert.equal(accepted, 1);
  await context.generateSeedance({ ...input, images: [], videos: [], audios: [audio] });
  assert.equal(submitted.imageUrls.length, 0); assert.equal(submitted.videoUrls.length, 0); assert.equal(submitted.audioUrls.length, 1);
}

async function main() {
  assert.deepEqual(SEEDANCE25_RATIOS, ['16:9', '9:16']);
  assert.equal(SEEDANCE25_MAX_IMAGES, 30); assert.equal(SEEDANCE25_MAX_VIDEOS, 10); assert.equal(SEEDANCE25_MAX_AUDIOS, 10);
  for (const count of [1, 30]) validateSeedance25Request(settings, 'test', count);
  validateSeedance25Request(settings, 'test', 30, 10, 10);
  validateSeedance25Request(settings, 'test', 0, 0, 1);
  validateSeedance25Request(settings, 'test', 0, 1, 0);
  assert.throws(() => validateSeedance25Request(settings, 'test', 0, 11, 0));
  assert.throws(() => validateSeedance25Request(settings, 'test', 0, 0, 11));
  assert.throws(() => validateSeedance25Request({ ...settings, mode: 't2v' }, 'test', 0, 0, 1));
  validateSeedance25Request({ ...settings, mode: 't2v' }, 'test', 0);
  for (const [draft, count] of [
    [{ ...settings, provider: undefined }, 1], [{ ...settings, mode: 'start_end' }, 2],
    [{ ...settings, ratio: 'auto' }, 1], [{ ...settings, ratio: '1:1' }, 1],
    [{ ...settings, resolution: 720 }, 1], [{ ...settings, mode: 't2v' }, 1],
    [settings, 0], [settings, 31],
  ] as Array<[any, number]>) {
    assert.throws(() => validateSeedance25Request(draft, 'test', count));
  }
  for (const draft of [settings, { ...settings, mode: 't2v' as const, audio: false, ratio: '16:9' as const }]) {
    const h = harness(); await h.run(draft, draft.mode === 't2v' ? 0 : 30);
    assert.deepEqual(h.events.order, ['generate', 'finish', 'deliver']);
    assert.deepEqual(h.events.charges, [6000]); assert.deepEqual(h.events.refunds, []);
    assert.deepEqual(h.events.releases, [1]); assert.deepEqual(h.events.successes, [1]);
    const request = h.events.inputs[0];
    assert.equal(request.resolution, '480p'); assert.equal(request.duration, 30);
    assert.equal(request.ratio, draft.ratio); assert.equal(request.generateAudio, draft.audio);
    assert.equal(request.images.length, draft.mode === 't2v' ? 0 : 30);
    assert.equal(h.events.deliveries[0].url, 'https://example.test/1-1080.mp4');
    assert.match(h.events.deliveries[0].caption, /1080p/);
  }
  for (const [images, videos, audios] of [[0, 0, 1], [0, 1, 0], [30, 10, 10]]) {
    const h = harness(); await h.run(settings, images, 1, videos, audios);
    assert.deepEqual(h.events.charges, [6000]); assert.deepEqual(h.events.refunds, []);
    assert.equal(h.events.inputs[0].images.length, images);
    assert.equal(h.events.inputs[0].videos.length, videos);
    assert.equal(h.events.inputs[0].audios.length, audios);
    assert.deepEqual(h.events.order, ['generate', 'finish', 'deliver']);
  }
  for (const options of [{ mediaInvalid: true }, { mediaSeconds: 16 }]) {
    const h = harness(options); await h.run(settings, 0, 1, 2, 0);
    assert.deepEqual(h.events.refunds, [6000]); assert.equal(h.events.inputs.length, 0);
  }
  for (const options of [
    { downloadFails: true }, { generationFails: true }, { finishingFails: true },
    { finishingThrows: true }, { deliveryFails: true }, { deliveryThrows: true },
  ]) {
    const h = harness(options); await h.run();
    assert.deepEqual(h.events.refunds, [6000]); assert.deepEqual(h.events.releases, [1]);
    assert.deepEqual(h.events.successes, []);
    assert.ok(h.events.inputs.length <= 1);
    assert.ok(h.events.deliveries.every(d => d.url.endsWith('-1080.mp4')), 'Never deliver native fallback');
    if (options.finishingFails || options.finishingThrows) assert.equal(h.events.deliveries.length, 0);
  }
  const blocked = harness({ chargeFails: true }); await blocked.run();
  assert.deepEqual(blocked.events.order, []); assert.deepEqual(blocked.events.refunds, []);
  const invalid = harness();
  await assert.rejects(() => invalid.run({ ...settings, provider: undefined } as any));
  assert.deepEqual(invalid.events.charges, []);
  const parallel = harness();
  await Promise.all([parallel.run(settings, 1, 11), parallel.run(settings, 1, 22)]);
  assert.deepEqual(parallel.events.deliveries.map(d => [d.chatId, d.url]).sort(), [
    [11, 'https://example.test/11-1080.mp4'], [22, 'https://example.test/22-1080.mp4'],
  ]);
  const wizard = fragment(source, "if (data === 'mode_oneover_seedance25')", "if (data.startsWith('picsart_duration_'))");
  assert.match(wizard, /provider: 'picsart'/);
  assert.match(wizard, /1080p melalui upscale/);
  assert.match(wizard, /seedance25_mode_t2v/);
  assert.match(wizard, /seedance25_mode_reference/);
  assert.doesNotMatch(wizard, /seedance25_mode_start|1–3 gambar|generateAlriz/);
  assert.doesNotMatch(source, /generateAlrizSeedance25/);
  await checkSubmitContract();
  await checkMultiReferenceUploads();
  await checkAcceptedJobBinding();
  assert.match(source, /picsart_seedance_25:\s*6000,/);
  console.log('PASS Seedance 2.5 Picsart: public inputs, native 480p → mandatory 1080p, Rp6000 billing/refunds, isolation, no accepted-job replay.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
