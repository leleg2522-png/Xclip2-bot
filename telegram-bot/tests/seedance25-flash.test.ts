import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/picsart.ts', import.meta.url), 'utf8');
const botSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
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

const accountRunner = fragment(source, 'async function runWithAccount<T>(', '// Admin: register');
const poller = fragment(
  source,
  'export async function pollSeedance25FlashResult(',
  'export async function generateSeedance25Flash(',
).replace('export async function', 'async function');
const generator = fragment(
  source,
  'export async function generateSeedance25Flash(',
  '// ─── Picsart Image-to-Video models',
).replace('export async function', 'async function');

function harness(options: {
  balance?: number;
  submitResponse?: { status: number; data: any };
  pollAuthError?: boolean;
  accountCount?: number;
} = {}) {
  const calls = {
    posts: [] as Array<{ url: string; body: any }>,
    gets: [] as string[],
    uploads: [] as Array<{ name: string; mime: string; bytes: number; gateway: boolean }>,
    accounts: [] as number[],
    ownerNotices: 0,
  };
  class TestPollDiag {
    note(response: { status: number }) {
      if (options.pollAuthError) throw new Error('PICSART_AUTH_DEAD: test');
      return response.status >= 200 && response.status < 300;
    }
    timeoutError() { return new Error('PICSART_TIMEOUT'); }
  }
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (callback: () => void) => { callback(); return 0; },
    Date,
    API_BASE: 'https://picsart.test',
    X_APP_AUTHORIZATION: 'test-app-auth',
    SEEDANCE25_FLASH_MODEL: 'seedance-2.5-flash',
    SEEDANCE25_FLASH_DURATION_SECONDS: 30,
    SEEDANCE25_FLASH_RESOLUTION: '480p',
    SEEDANCE25_FLASH_RATIO: '16:9',
    SEEDANCE25_FLASH_MAX_IMAGES: 10,
    SEEDANCE25_FLASH_MAX_VIDEOS: 5,
    SEEDANCE25_FLASH_MAX_AUDIOS: 5,
    SEEDANCE25_FLASH_MAX_MEDIA_BYTES: 19 * 1024 * 1024,
    SEEDANCE25_FLASH_MAX_TOTAL_BYTES: 100 * 1024 * 1024,
    SEEDANCE25_FLASH_MAX_REFERENCE_SECONDS: 30,
    ERR_INSUFFICIENT_CREDITS: 'PICSART_INSUFFICIENT_CREDITS',
    MAX_ACCOUNT_ATTEMPTS: options.accountCount ?? 1,
    ok2xx: (status: number) => status >= 200 && status < 300,
    PollDiag: TestPollDiag,
    q: async () => ({ rows: [{ n: options.accountCount ?? 1 }] }),
    acquireAccount: async (_userId: number, _pool: unknown, tried: number[]) => {
      const available = [1, 2].slice(0, options.accountCount ?? 1);
      const id = available.find(value => !tried.includes(value)) ?? null;
      if (id != null) calls.accounts.push(id);
      return id;
    },
    getCredits: async () => ({ credits: options.balance ?? 500 }),
    getAccessToken: async () => 'test-access',
    commonHeaders: (headers: Record<string, string>) => headers,
    uploadFile: async (_id: number, buffer: Buffer, name: string, mime: string, opts: { gateway?: boolean }) => {
      calls.uploads.push({ name, mime, bytes: buffer.length, gateway: Boolean(opts?.gateway) });
      return `https://uploads.test/${name}`;
    },
    isPicsartSubmitTokenRejection: (error: Error) => /PICSART_(?:SUBMIT|SEEDANCE25_FLASH_OPTIONS)_FAILED status 401/.test(error.message),
    isPicsartPostSubmitAuthFailure: (error: Error) => /PICSART_AUTH_DEAD|PICSART_REFRESH_DEAD/.test(error.message),
    isCreditError: () => false,
    handleCreditError: async () => {},
    loadCredential: async () => null,
    discardAccount: async () => {},
    notifyOwner: () => { calls.ownerNotices++; },
    http: {
      post: async (url: string, body: any) => {
        calls.posts.push({ url, body });
        if (url.endsWith('/options')) {
          return { status: 201, data: { status: 'success', response: { credits: 90, price: 3, unit: 'second', usageAmount: 30, chargeCredits: false } } };
        }
        return options.submitResponse ?? { status: 201, data: { response: { id: 'accepted-task' } } };
      },
      get: async (url: string) => {
        calls.gets.push(url);
        return { status: 200, data: { response: { status: 'COMPLETED', result: { url: 'https://result.test/video.mp4' }, usage: { credits: 90 } } } };
      },
    },
  });
  vm.runInContext(compile(accountRunner + poller + generator), context);
  return {
    calls,
    generate: (prompt = 'A quiet city at sunrise', references: any = {}) => context.generateSeedance25Flash({
      userId: 42, prompt, ...references,
    }),
  };
}

async function checkSuccessfulContract() {
  const h = harness();
  const result = await h.generate();
  assert.equal(result.url, 'https://result.test/video.mp4');
  assert.equal(result.credits, 90);
  assert.equal(h.calls.posts.length, 2);
  assert.equal(h.calls.posts[0].url, 'https://picsart.test/gw-v2/workflows/v1/models/options');
  assert.equal(h.calls.posts[0].body.params.model, 'seedance-2.5-flash');
  assert.equal(h.calls.posts[0].body.params.params.duration, 30);
  assert.equal(h.calls.posts[0].body.params.params.resolution, '480p');
  assert.equal(h.calls.posts[0].body.params.params.generateAudio, false);
  assert.equal(h.calls.posts[1].url, 'https://picsart.test/gw-v2/workflows/v1/models/submit');
  assert.equal(h.calls.posts[1].body.params.options.drive.folder.path, 'AI Playground');
  assert.equal(h.calls.posts[1].body.params.options.drive.attributes.appId, 'com.picsart.ai-playground');
  assert.equal(h.calls.gets[0], 'https://picsart.test/gw-v2/workflows/v1/models/accepted-task/result');
}

async function checkNoSubmitWhenUnaffordable() {
  const h = harness({ balance: 89 });
  await assert.rejects(() => h.generate(), /PICSART_INSUFFICIENT_CREDITS/);
  assert.equal(h.calls.posts.length, 1, 'Only free options quote; no paid submit');
  assert.equal(h.calls.gets.length, 0);
}

async function checkMixedReferencePayload() {
  const h = harness();
  const references = {
    images: [{ buffer: Buffer.from('image'), name: 'reference-image-1.png', mime: 'image/png' }],
    videos: [{ buffer: Buffer.from('video'), name: 'reference-video-1.mp4', mime: 'video/mp4', duration: 3 }],
    audios: [{ buffer: Buffer.from('audio'), name: 'reference-audio-1.mp3', mime: 'audio/mpeg', duration: 2 }],
  };
  await h.generate('A character walks through the scene', references);
  assert.equal(h.calls.uploads.length, 3);
  assert(h.calls.uploads.every(upload => upload.gateway));
  const quoteParams = h.calls.posts[0].body.params.params;
  assert.deepEqual(Array.from(quoteParams.imageUrls), ['https://uploads.test/reference-image-1.png']);
  assert.deepEqual(Array.from(quoteParams.videoUrls), ['https://uploads.test/reference-video-1.mp4']);
  assert.deepEqual(Array.from(quoteParams.audioUrls), ['https://uploads.test/reference-audio-1.mp3']);
  assert.equal(quoteParams.generateAudio, true);
  const submitParams = h.calls.posts[1].body.params.params;
  assert.deepEqual(Array.from(submitParams.imageUrls), Array.from(quoteParams.imageUrls));
  assert.deepEqual(Array.from(submitParams.videoUrls), Array.from(quoteParams.videoUrls));
  assert.deepEqual(Array.from(submitParams.audioUrls), Array.from(quoteParams.audioUrls));
  const sdkPayload = JSON.parse(h.calls.posts[1].body.params.options.drive.attributes.aiSDKPayload);
  assert.deepEqual(sdkPayload.imageUrls, ['https://uploads.test/reference-image-1.png']);
  assert.deepEqual(sdkPayload.videoUrls, ['https://uploads.test/reference-video-1.mp4']);
  assert.deepEqual(sdkPayload.audioUrls, ['https://uploads.test/reference-audio-1.mp3']);
  assert.equal(sdkPayload.omniReferenceTaskType, 'auto');

  const tooMany = harness();
  await assert.rejects(
    () => tooMany.generate('prompt', { images: Array.from({ length: 11 }, () => ({ buffer: Buffer.from('i') })) }),
    /SEEDANCE25_FLASH_TOO_MANY_REFERENCES/,
  );
  assert.equal(tooMany.calls.uploads.length, 0);
  assert.equal(tooMany.calls.posts.length, 0);
  await assert.rejects(
    () => tooMany.generate('prompt', { videos: Array.from({ length: 6 }, () => ({ buffer: Buffer.from('v'), duration: 1 })) }),
    /SEEDANCE25_FLASH_TOO_MANY_REFERENCES/,
  );
  await assert.rejects(
    () => tooMany.generate('prompt', { audios: Array.from({ length: 6 }, () => ({ buffer: Buffer.from('a'), duration: 1 })) }),
    /SEEDANCE25_FLASH_TOO_MANY_REFERENCES/,
  );
}

async function checkAmbiguousSubmitNeverReplays() {
  const h = harness({ accountCount: 2, submitResponse: { status: 201, data: { response: {} } } });
  await assert.rejects(() => h.generate(), /PICSART_SEEDANCE25_FLASH_POST_SUBMIT_FAILED/);
  assert.equal(h.calls.posts.filter(call => call.url.endsWith('/submit')).length, 1);
  assert.deepEqual(h.calls.accounts, [1], 'Do not fail over after an ambiguous accepted submit');
}

async function checkPostSubmitAuthNeverReplays() {
  const h = harness({ accountCount: 2, pollAuthError: true });
  await assert.rejects(() => h.generate(), /PICSART_POST_SUBMIT_AUTH_LOST/);
  assert.equal(h.calls.posts.filter(call => call.url.endsWith('/submit')).length, 1);
  assert.deepEqual(h.calls.accounts, [1], 'Accepted jobs must not be resubmitted after polling auth loss');
  assert.equal(h.calls.ownerNotices, 1);
}

async function checkBotBillingDeliveryAndRefund() {
  const runner = fragment(
    botSource,
    'async function runPicsartSeedance25Flash(',
    '// ─── Background: Seedance 2 Video Edit pipelines',
  );
  const charges: number[] = [];
  const refunds: number[] = [];
  const releases: number[] = [];
  const deliveries: any[] = [];
  let providerCalls = 0;
  let finishingCalls = 0;
  const context = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    MAX_PARALLEL_GENERATIONS_PER_USER: 3,
    MODEL_PRICES: { picsart_seedance_25_flash: 6000 },
    beginCharge: async (_id: number, price: number) => {
      charges.push(price);
      return { ok: true };
    },
    chargeFailMsg: () => 'Saldo tidak cukup',
    formatRupiah: (amount: number) => `Rp${amount}`,
    picsart: { SEEDANCE25_FLASH_DURATION_SECONDS: 30, generateSeedance25Flash: async () => {
      providerCalls++;
      return { url: 'https://result.test/video.mp4', credits: 90 };
    } },
    sendResult: async (...args: any[]) => { deliveries.push(args); return true; },
    incrementKlingUsage: async () => 1,
    markGenSuccess: () => {},
    addSaldo: async (_id: number, amount: number) => { refunds.push(amount); },
    releaseGenerating: (id: number) => releases.push(id),
    describeError: (error: Error) => error.message,
    notifyGenerationFailure: async () => {},
    upscaleGeneratedVideo: async () => { finishingCalls++; throw Error('Flash must remain native 480p'); },
    bot: { telegram: {
      editMessageText: async () => {},
      sendMessage: async () => {},
      deleteMessage: async () => {},
    } },
  });
  vm.runInContext(compile(runner), context);
  await context.runPicsartSeedance25Flash(1, 2, 3, 4, 'A test prompt', { images: [], videos: [], audios: [] });
  assert.deepEqual(charges, [6000]);
  assert.equal(providerCalls, 1);
  assert.equal(deliveries.length, 1);
  assert.match(deliveries[0][2], /30 detik · 480p · tanpa audio/);
  assert.equal(deliveries[0][3], true);
  assert.deepEqual(refunds, []);
  assert.deepEqual(releases, [3]);
  assert.equal(finishingCalls, 0, 'Flash delivers native 480p without upscaling');

  const failingContext = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    MAX_PARALLEL_GENERATIONS_PER_USER: 3,
    MODEL_PRICES: { picsart_seedance_25_flash: 6000 },
    beginCharge: async (_id: number, price: number) => { charges.push(price); return { ok: true }; },
    chargeFailMsg: () => 'Saldo tidak cukup',
    formatRupiah: (amount: number) => `Rp${amount}`,
    picsart: { SEEDANCE25_FLASH_DURATION_SECONDS: 30, generateSeedance25Flash: async () => { throw Error('PICSART_GEN_FAILED'); } },
    sendResult: async () => false,
    incrementKlingUsage: async () => 1,
    markGenSuccess: () => {},
    addSaldo: async (_id: number, amount: number) => { refunds.push(amount); },
    releaseGenerating: (id: number) => releases.push(id),
    describeError: (error: Error) => error.message,
    notifyGenerationFailure: async () => {},
    bot: { telegram: {
      editMessageText: async () => {},
      sendMessage: async () => {},
      deleteMessage: async () => {},
    } },
  });
  vm.runInContext(compile(runner), failingContext);
  await failingContext.runPicsartSeedance25Flash(1, 2, 3, 4, 'A test prompt', { images: [], videos: [], audios: [] });
  assert.deepEqual(charges, [6000, 6000]);
  assert.deepEqual(refunds, [6000], 'Provider failure refunds the full customer price');
  assert.deepEqual(releases, [3, 3]);
}

async function checkFlashMediaIntake() {
  const handlers = fragment(
    botSource,
    'async function handleSeedance25FlashImage(',
    'async function handleSeedance25Reference(',
  );
  const replies: string[] = [];
  let session: any = {
    mode: 'seedance25_flash_wait_media',
    seedance25FlashDraftId: 'draft-1',
    seedance25FlashImageFileIds: [],
    seedance25FlashVideos: [],
    seedance25FlashAudios: [],
    seedance25FlashPendingUploads: 0,
  };
  const context = vm.createContext({
    Buffer,
    SEEDANCE25_MAX_MEDIA_BYTES: 19 * 1024 * 1024,
    SEEDANCE25_MAX_REFERENCE_SECONDS: 30,
    SEEDANCE25_MAX_VIDEOS: 10,
    SEEDANCE25_MAX_AUDIOS: 10,
    picsart: {
      SEEDANCE25_FLASH_MAX_IMAGES: 10,
      SEEDANCE25_FLASH_MAX_VIDEOS: 5,
      SEEDANCE25_FLASH_MAX_AUDIOS: 5,
    },
    getSession: () => session,
    setSession: (_userId: number, patch: any) => { session = { ...session, ...patch }; },
    seedance25FlashInputKeyboard: () => ({ keyboard: true }),
    retryTelegramFileRead: async (read: () => Promise<any>) => read(),
    telegramHttp: { get: async () => ({ data: Buffer.from('valid-test-media') }) },
    inspectSeedance25Media: async (_buffer: Buffer, kind: string) => kind === 'video' ? 4 : 3,
    seedanceAudioMime: () => 'audio/ogg',
  });
  vm.runInContext(compile(handlers), context);
  const ctx = {
    from: { id: 77 },
    telegram: { getFileLink: async () => ({ href: 'https://telegram.test/file' }) },
    reply: async (message: string) => { replies.push(message); return {}; },
  };
  for (let i = 0; i < 10; i++) {
    await context.handleSeedance25FlashImage(ctx, `image-${i + 1}`, 1024);
  }
  assert.equal(session.seedance25FlashImageFileIds.length, 10);
  await context.handleSeedance25FlashImage(ctx, 'image-11', 1024);
  assert(replies.some(text => text.includes('Maksimal 10 gambar')));
  await context.handleSeedance25FlashMedia(ctx, 'video', {
    file_id: 'video-1', file_size: 2048, mime_type: 'video/mp4', duration: 4,
  });
  await context.handleSeedance25FlashMedia(ctx, 'audio', {
    file_id: 'audio-1', file_size: 2048, mime_type: 'audio/ogg', duration: 3,
  });
  assert.equal(session.seedance25FlashVideos[0].duration, 4);
  assert.equal(session.seedance25FlashAudios[0].duration, 3);
  assert.equal(session.seedance25FlashPendingUploads, 0);
  session = {
    ...session,
    seedance25FlashVideos: Array.from({ length: 5 }, (_, i) => ({
      fileId: `video-${i}`,
      mime: 'video/mp4',
      duration: 1,
    })),
  };
  await context.handleSeedance25FlashMedia(ctx, 'video', {
    file_id: 'video-6', file_size: 2048, mime_type: 'video/mp4', duration: 1,
  });
  assert(replies.some(text => text.includes('Maksimal 5 referensi video')));
}

async function main() {
  await checkSuccessfulContract();
  await checkNoSubmitWhenUnaffordable();
  await checkMixedReferencePayload();
  await checkAmbiguousSubmitNeverReplays();
  await checkPostSubmitAuthNeverReplays();
  await checkBotBillingDeliveryAndRefund();
  await checkFlashMediaIntake();
  console.log('Seedance 2.5 Flash passed: 30s gateway settings, quoted-credit preflight, no duplicate jobs, Rp6.000 billing/refunds, native 480p delivery.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
