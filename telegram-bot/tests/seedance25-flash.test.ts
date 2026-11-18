import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { GENJUTSU_PROMPT } from '../src/genjutsu';

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
  'export type Seedance25FlashTaskType',
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
    accountAssignment: [] as boolean[],
    events: [] as string[],
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
    acquireAccount: async (_userId: number, _pool: unknown, tried: number[], _strictPool: boolean, assignUser: boolean) => {
      const available = [1, 2].slice(0, options.accountCount ?? 1);
      const id = available.find(value => !tried.includes(value)) ?? null;
      if (id != null) {
        calls.accounts.push(id);
        calls.accountAssignment.push(assignUser);
      }
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
        calls.events.push('submit');
        return options.submitResponse ?? { status: 201, data: { response: { id: 'accepted-task' } } };
      },
      get: async (url: string) => {
        calls.gets.push(url);
        calls.events.push('poll');
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
  assert.equal(h.calls.posts[0].body.params.params.aspectRatio, '16:9');
  assert.equal(h.calls.posts[0].body.params.params.generateAudio, false);
  assert.equal(h.calls.posts[0].body.params.params.omniReferenceTaskType, 'auto');
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

async function checkDocumentedReferenceSubtasks() {
  const image = { buffer: Buffer.from('image'), name: 'image.jpg', mime: 'image/jpeg' };
  const video = { buffer: Buffer.from('video'), name: 'source.mp4', mime: 'video/mp4', duration: 10 };
  const audio = { buffer: Buffer.from('audio'), name: 'audio.mp3', mime: 'audio/mpeg', duration: 3 };
  for (const refs of [
    { images: [image] }, { videos: [video] }, { audios: [audio] },
    { images: [image], audios: [audio] }, { videos: [video], audios: [audio] },
  ]) {
    const h = harness();
    await h.generate('Use these references to create a new scene', refs);
    for (const request of h.calls.posts) {
      assert.equal(request.body.params.model, 'seedance-2.5-flash');
      const params = request.body.params.params;
      assert.equal(params.omniReferenceTaskType, 'reference');
      assert.equal(params.duration, 30);
      assert.equal(params.aspectRatio, '16:9');
      assert.equal(params.resolution, '480p');
    }
    const metadata = JSON.parse(h.calls.posts[1].body.params.options.drive.attributes.aiSDKPayload);
    assert.equal(metadata.omniReferenceTaskType, 'reference');
  }
  // A caller may explicitly request reference-to-video even with both media.
  const reference = harness();
  await reference.generate('New scene', { images: [image], videos: [video], taskType: 'reference' });
  assert.equal(reference.calls.posts[0].body.params.params.duration, 30);
  assert.equal(reference.calls.posts[0].body.params.params.omniReferenceTaskType, 'reference');

  for (const duration of [0, 3.999, 30.01, NaN, Infinity]) {
    const invalid = harness();
    await assert.rejects(() => invalid.generate('Edit', {
      images: [image], videos: [{ ...video, duration }],
    }), /SEEDANCE25_FLASH_EDIT_REQUIRES_VIDEO/);
    assert.equal(invalid.calls.uploads.length, 0);
    assert.equal(invalid.calls.posts.length, 0, 'Invalid edit must not quote or submit');
  }
  for (const duration of [4, 30]) {
    const valid = harness();
    await valid.generate('Edit', { images: [image], videos: [{ ...video, duration }] });
    const params = valid.calls.posts[0].body.params.params;
    assert.equal(params.omniReferenceTaskType, 'edit');
    assert.equal(params.duration, -1);
    assert.equal(params.aspectRatio, 'adaptive');
  }
}

async function checkEditQuoteOnly() {
  const h = harness();
  const quote = await h.generate('Replace the man with the image character', {
    taskType: 'edit',
    quoteOnly: true,
    images: [{ buffer: Buffer.from('image'), name: 'character.jpg', mime: 'image/jpeg' }],
    videos: [{ buffer: Buffer.from('15-second video'), name: 'source.mp4', mime: 'video/mp4', duration: 15 }],
  });
  assert.equal(quote.quoteOnly, true);
  assert.equal(quote.taskType, 'edit');
  assert.equal(quote.duration, -1);
  assert.equal(quote.aspectRatio, 'adaptive');
  assert.equal(quote.credits, 90);
  assert.equal(h.calls.posts.length, 1, 'Quote-only must never submit a generation job');
  assert.equal(h.calls.gets.length, 0);
  assert.deepEqual(h.calls.accountAssignment, [false], 'Quote-only must not create a sticky account assignment');
  const params = h.calls.posts[0].body.params.params;
  assert.equal(params.duration, -1);
  assert.equal(params.aspectRatio, 'adaptive');
  assert.equal(params.omniReferenceTaskType, 'edit');
  assert.equal(params.generateAudio, true);
}

async function checkApprovedCreditLimit() {
  const overLimit = harness();
  await assert.rejects(
    () => overLimit.generate('Replace the man with the image character', {
      taskType: 'edit',
      persistAccount: false,
      maxProviderCredits: 89,
      images: [{ buffer: Buffer.from('image'), name: 'character.jpg', mime: 'image/jpeg' }],
      videos: [{ buffer: Buffer.from('15-second video'), name: 'source.mp4', mime: 'video/mp4', duration: 15 }],
    }),
    /PICSART_SEEDANCE25_FLASH_QUOTE_EXCEEDS_APPROVAL/,
  );
  assert.equal(overLimit.calls.posts.length, 1, 'A quote above the approved limit must not submit');
  assert.equal(overLimit.calls.gets.length, 0);
  assert.deepEqual(overLimit.calls.accountAssignment, [false]);

  const withinLimit = harness();
  const result = await withinLimit.generate('Replace the man with the image character', {
    taskType: 'edit',
    persistAccount: false,
    maxProviderCredits: 90,
    images: [{ buffer: Buffer.from('image'), name: 'character.jpg', mime: 'image/jpeg' }],
    videos: [{ buffer: Buffer.from('15-second video'), name: 'source.mp4', mime: 'video/mp4', duration: 15 }],
  });
  assert.equal(result.url, 'https://result.test/video.mp4');
  assert.equal(withinLimit.calls.posts.filter(call => call.url.endsWith('/submit')).length, 1);
  assert.deepEqual(withinLimit.calls.accountAssignment, [false]);
}

async function checkSubmittedStateIsPersistedBeforePolling() {
  const h = harness();
  let savedSubmission: { credentialId: number; taskId: string } | undefined;
  await h.generate('Replace the performer with the image character', {
    onSubmitted: async (submission: { credentialId: number; taskId: string }) => {
      await Promise.resolve();
      savedSubmission = submission;
      h.calls.events.push('state-saved');
    },
  });
  assert.equal(savedSubmission?.credentialId, 1);
  assert.equal(savedSubmission?.taskId, 'accepted-task');
  assert.deepEqual(h.calls.events, ['submit', 'state-saved', 'poll']);
  assert.equal(h.calls.posts.filter(call => call.url.endsWith('/submit')).length, 1);
}

async function checkStateSaveFailureDoesNotReplaySubmit() {
  const h = harness();
  await h.generate('Replace the performer with the image character', {
    onSubmitted: () => { throw new Error('simulated disk error'); },
  });
  assert.equal(h.calls.posts.filter(call => call.url.endsWith('/submit')).length, 1);
  assert.equal(h.calls.gets.length, 1, 'Continue polling the accepted job when local state saving fails');
  assert.deepEqual(h.calls.accounts, [1], 'Never switch accounts or resubmit after acceptance');
}

async function checkMixedReferencePayload() {
  const h = harness();
  const references = {
    images: [{ buffer: Buffer.from('image'), name: 'reference-image-1.png', mime: 'image/png' }],
    videos: [{ buffer: Buffer.from('video'), name: 'reference-video-1.mp4', mime: 'video/mp4', duration: 15 }],
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
  assert.equal(quoteParams.duration, -1);
  assert.equal(quoteParams.aspectRatio, 'adaptive');
  assert.equal(quoteParams.omniReferenceTaskType, 'edit');
  const submitParams = h.calls.posts[1].body.params.params;
  assert.deepEqual(Array.from(submitParams.imageUrls), Array.from(quoteParams.imageUrls));
  assert.deepEqual(Array.from(submitParams.videoUrls), Array.from(quoteParams.videoUrls));
  assert.deepEqual(Array.from(submitParams.audioUrls), Array.from(quoteParams.audioUrls));
  const sdkPayload = JSON.parse(h.calls.posts[1].body.params.options.drive.attributes.aiSDKPayload);
  assert.deepEqual(sdkPayload.imageUrls, ['https://uploads.test/reference-image-1.png']);
  assert.deepEqual(sdkPayload.videoUrls, ['https://uploads.test/reference-video-1.mp4']);
  assert.deepEqual(sdkPayload.audioUrls, ['https://uploads.test/reference-audio-1.mp3']);
  assert.equal(sdkPayload.omniReferenceTaskType, 'edit');
  assert.equal(sdkPayload.duration, -1);
  assert.equal(sdkPayload.aspectRatio, 'adaptive');

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
  let providerInput: any;
  let finishingCalls = 0;
  let finishingMode: 'success' | 'fallback' | 'throw' = 'success';
  let deliveryOk = true;
  const finishingInputs: any[] = [];
  const failures: string[] = [];
  const order: string[] = [];
  const publicMessages: string[] = [];
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
    picsart: {
      SEEDANCE25_FLASH_DURATION_SECONDS: 30,
      describePicsartPostSubmitCause: () => '',
      generateSeedance25Flash: async (input: any) => {
        providerCalls++;
        order.push('generate');
        providerInput = input;
        for (const stage of ['upload', 'quote', 'submit', 'poll']) input.onStatus?.(stage);
        return { url: 'https://result.test/video.mp4', credits: 90 };
      },
    },
    sendResult: async (...args: any[]) => { order.push('deliver'); deliveries.push(args); return deliveryOk; },
    incrementKlingUsage: async () => 1,
    markGenSuccess: () => {},
    addSaldo: async (_id: number, amount: number) => { refunds.push(amount); },
    releaseGenerating: (id: number) => releases.push(id),
    describeError: (error: Error) => error.message,
    notifyGenerationFailure: async (_chat: number, _status: number, _error: Error, stage: string) => { failures.push(stage); },
    upscaleGeneratedVideo: async (...args: any[]) => {
      finishingCalls++;
      finishingInputs.push(args);
      order.push('upscale');
      if (finishingMode === 'throw') throw Error('Finishing unavailable');
      return finishingMode === 'fallback'
        ? { url: args[0], upscaled: false }
        : { url: 'https://result.test/video-1080.mp4', upscaled: true };
    },
    bot: { telegram: {
      editMessageText: async (_chat: number, _message: number, _inline: unknown, text: string) => { publicMessages.push(text); },
      sendMessage: async () => {},
      deleteMessage: async () => {},
    } },
  });
  vm.runInContext(compile(runner), context);
  await context.runPicsartSeedance25Flash(1, 2, 3, 4, 'Replace the man with the image character', {
    images: [{ buffer: Buffer.from('image'), name: 'character.jpg', mime: 'image/jpeg' }],
    videos: [{ buffer: Buffer.from('15-second video'), name: 'source.mp4', mime: 'video/mp4', duration: 15 }],
    audios: [],
    taskType: 'edit',
  });
  assert.deepEqual(charges, [6000]);
  assert.equal(providerCalls, 1);
  assert.equal(deliveries.length, 1);
  assert.equal(providerInput.taskType, 'edit');
  assert.equal(providerInput.generateAudio, undefined, 'Ordinary Flash keeps its existing audio settings');
  assert.equal(deliveries[0][1], 'https://result.test/video-1080.mp4');
  assert.match(deliveries[0][2], /edit · durasi mengikuti video sumber · 1080p · audio aktif/);
  assert.doesNotMatch(deliveries[0][2], /upscal|renderful|480p|native/i);
  assert.equal(deliveries[0][3], true);
  assert.deepEqual(refunds, []);
  assert.deepEqual(releases, [3]);
  assert.equal(finishingCalls, 1, 'Flash must complete finishing before delivery');
  assert.equal(finishingInputs[0][0], 'https://result.test/video.mp4');
  assert.match(finishingInputs[0][4], /menyiapkan hasil 1080p/);
  assert.doesNotMatch(finishingInputs[0][4], /upscal|renderful|480p|native/i);
  assert.deepEqual(order, ['generate', 'upscale', 'deliver']);
  assert.doesNotMatch(publicMessages.join('\n'), /upscal|renderful|480p|native|provider/i);

  for (const mode of ['fallback', 'throw'] as const) {
    finishingMode = mode;
    const beforeProvider = providerCalls;
    await context.runPicsartSeedance25Flash(1, 2, 3, 4, 'A new scene', {
      images: [], videos: [], audios: [], taskType: 'auto',
    });
    assert.equal(deliveries.length, 1, 'Never deliver a native fallback as 1080p');
    assert.equal(providerCalls, beforeProvider + 1, 'Never regenerate after finishing fails');
    assert.equal(failures.at(-1), 'finishing');
  }
  assert.deepEqual(refunds, [6000, 6000], 'Every finishing failure refunds the full price');
  finishingMode = 'success';
  deliveryOk = false;
  await context.runPicsartSeedance25Flash(1, 2, 3, 4, 'A new scene', {
    images: [], videos: [], audios: [], taskType: 'auto',
  });
  assert.equal(deliveries.length, 2, 'Failed delivery does not retry with the native source');
  assert.equal(deliveries[1][1], 'https://result.test/video-1080.mp4');
  assert.match(deliveries[1][2], /30 detik · 16:9 · 1080p/);
  assert.deepEqual(refunds, [6000, 6000, 6000], 'Failed final delivery also refunds');
  assert.deepEqual(releases, [3, 3, 3, 3]);
  const callsBeforeProviderFailure = finishingCalls;

  const failingContext = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    MAX_PARALLEL_GENERATIONS_PER_USER: 3,
    MODEL_PRICES: { picsart_seedance_25_flash: 6000 },
    beginCharge: async (_id: number, price: number) => { charges.push(price); return { ok: true }; },
    chargeFailMsg: () => 'Saldo tidak cukup',
    formatRupiah: (amount: number) => `Rp${amount}`,
    picsart: {
      SEEDANCE25_FLASH_DURATION_SECONDS: 30,
      describePicsartPostSubmitCause: () => '',
      generateSeedance25Flash: async () => { throw Error('PICSART_GEN_FAILED'); },
    },
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
  await failingContext.runPicsartSeedance25Flash(1, 2, 3, 4, 'A test prompt', {
    images: [], videos: [], audios: [], taskType: 'auto',
  });
  assert.deepEqual(charges, [6000, 6000, 6000, 6000, 6000]);
  assert.deepEqual(refunds, [6000, 6000, 6000, 6000], 'Provider failure refunds the full customer price');
  assert.deepEqual(releases, [3, 3, 3, 3, 3]);
  assert.equal(finishingCalls, callsBeforeProviderFailure, 'Do not upscale failed generations');
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

async function checkFlashContinuationDraftGuard() {
  const draftRouting = fragment(
    botSource,
    'function generationDraftKindForStart(',
    'function generationDraftBlockReason(',
  );
  const context = vm.createContext({});
  vm.runInContext(compile(draftRouting), context);
  const startKind = context.generationDraftKindForStart('mode_seedance25_flash');
  const continueKind = context.generationDraftKindForContinuation('seedance25_flash_refs_done');
  assert.equal(startKind, 'seedance25_flash');
  assert.equal(continueKind, startKind, 'Flash continue button must match its active draft kind');

  assert.equal(context.generationDraftKindForStart('mode_oneover_seedance25'), 'oneover');
  assert.equal(context.generationDraftKindForContinuation('seedance25_inputs_done'), 'oneover');
}

async function checkEditRejectedBeforePromptAndCharge() {
  const callback = fragment(botSource, "  if (data === 'seedance25_flash_refs_done') {",
    "  if (data.startsWith('seedance25_mode_')) {");
  const promptPrefix = fragment(botSource,
    'async function submitSeedance25FlashPrompt(', "  let totalBytes = 0;");
  let session: any = {
    dbUserId: 9, mode: 'seedance25_flash_wait_media', seedance25FlashDraftId: 'active',
    seedance25FlashImageFileIds: ['image'],
    seedance25FlashVideos: [{ fileId: 'short-video', duration: 3 }],
    seedance25FlashAudios: [],
  };
  const replies: string[] = [];
  let promptScreens = 0;
  const screenTexts: string[] = [];
  const context = vm.createContext({
    getSession: () => session,
    setSession: (_id: number, patch: any) => { session = { ...session, ...patch }; },
    seedance25FlashInputKeyboard: () => ({}),
    validateSeedance25Prompt: (value: string) => value,
    getCooldownRemainingMs: () => 0,
  });
  vm.runInContext(compile(
    `async function continueFlash(ctx) { const userId = ctx.from.id; const data = 'seedance25_flash_refs_done'; ${callback} }\n`
    + promptPrefix + '\nthrow Error("Unexpectedly proceeded to download or charge");\n}'),
    context,
  );
  const ctx = {
    from: { id: 1 },
    reply: async (text: string) => { replies.push(text); },
    editMessageText: async (text: string) => { promptScreens++; screenTexts.push(text); },
  };
  await context.continueFlash(ctx);
  assert.equal(session.mode, 'seedance25_flash_wait_media');
  assert.equal(promptScreens, 0);
  assert.match(replies[0], /4–30 detik/);
  // Also protect old prompt screens that were opened before these checks.
  session.mode = 'seedance25_flash_wait_prompt';
  await context.submitSeedance25FlashPrompt(ctx, 'Replace the character');
  assert.equal(session.mode, 'seedance25_flash_wait_media');
  assert.equal(session.seedance25FlashDraftId, 'active', 'Keep references so a valid video can be added');
  assert.match(replies[1], /Saldo belum dipotong/);
  session.seedance25FlashVideos.push({ fileId: 'valid-video', duration: 4 });
  await context.continueFlash(ctx);
  assert.equal(session.mode, 'seedance25_flash_wait_prompt');
  assert.equal(promptScreens, 1);
  for (const refs of [
    { seedance25FlashImageFileIds: [], seedance25FlashVideos: [], seedance25FlashAudios: [] },
    { seedance25FlashImageFileIds: ['image'], seedance25FlashVideos: [], seedance25FlashAudios: [] },
    { seedance25FlashImageFileIds: [], seedance25FlashVideos: [], seedance25FlashAudios: [{ duration: 3 }] },
  ]) {
    session = { ...session, ...refs, mode: 'seedance25_flash_wait_media' };
    await context.continueFlash(ctx);
    assert.equal(session.mode, 'seedance25_flash_wait_prompt', 'Every reference is optional, including all of them');
  }
  assert(screenTexts.some(text => text.includes('text-to-video tanpa referensi')));
  assert.doesNotMatch(screenTexts.join('\n'), /upscal|renderful|480p|native/i);
}

async function checkGenjutsuIdentityPayload() {
  const h = harness();
  await h.generate(GENJUTSU_PROMPT, {
    taskType: 'edit', generateAudio: false,
    images: [{ buffer: Buffer.from('identity-photo'), name: 'identity.jpg', mime: 'image/jpeg' }],
    videos: [{ buffer: Buffer.from('performance'), name: 'performance.mp4', mime: 'video/mp4', duration: 10 }],
  });
  assert.equal(h.calls.posts.length, 2, 'One quote and one mocked submit, without retries');
  for (const call of h.calls.posts) {
    const params = call.body.params.params;
    assert.equal(params.prompt, GENJUTSU_PROMPT, 'The identity instructions reach both quote and submit unchanged');
    assert.deepEqual(Array.from(params.imageUrls), ['https://uploads.test/identity.jpg']);
    assert.deepEqual(Array.from(params.videoUrls), ['https://uploads.test/performance.mp4']);
    assert.equal(params.omniReferenceTaskType, 'edit');
    assert.equal(params.generateAudio, false);
    assert.equal(params.duration, -1);
    assert.equal(params.aspectRatio, 'adaptive');
    assert.equal(params.audioUrls, undefined);
    assert.equal(params.faceStrength, undefined, 'Do not invent unsupported identity-control parameters');
    assert.equal(params.negativePrompt, undefined, 'Exclusions stay inline; Flash documents no negativePrompt field');
    assert.equal(params.negative_prompt, undefined, 'Do not invent an alternate negative-prompt field');
  }
  const metadata = JSON.parse(h.calls.posts[1].body.params.options.drive.attributes.aiSDKPayload);
  assert.deepEqual(metadata.imageUrls, ['https://uploads.test/identity.jpg']);
  assert.deepEqual(metadata.videoUrls, ['https://uploads.test/performance.mp4']);
}

async function main() {
  await checkGenjutsuIdentityPayload();
  await checkSuccessfulContract();
  await checkNoSubmitWhenUnaffordable();
  await checkDocumentedReferenceSubtasks();
  await checkEditQuoteOnly();
  await checkApprovedCreditLimit();
  await checkSubmittedStateIsPersistedBeforePolling();
  await checkStateSaveFailureDoesNotReplaySubmit();
  await checkMixedReferencePayload();
  await checkAmbiguousSubmitNeverReplays();
  await checkPostSubmitAuthNeverReplays();
  await checkBotBillingDeliveryAndRefund();
  await checkFlashMediaIntake();
  await checkFlashContinuationDraftGuard();
  await checkEditRejectedBeforePromptAndCharge();
  const flashMenuRow = botSource.split('\n').find(line => line.includes("'mode_seedance25_flash')"));
  assert.match(flashMenuRow!, /1080p/);
  assert.doesNotMatch(flashMenuRow!, /480p/);
  const entry = fragment(botSource, "  if (data === 'mode_seedance25_flash' || data === 'mode_seedance25_flash_edanbot'",
    "  if (data === 'seedance25_flash_refs_done') {");
  assert.match(entry, /edanbotFlash \?/);
  assert.match(entry, /Output text-to-video: \*30 detik\* • \*1080p\* • \*16:9\*/);
  const flashPriceRow = botSource.split('\n').find(line => line.includes('Flash Teks / Referensi'));
  assert.match(flashPriceRow!, /1080p/);
  assert.doesNotMatch(flashPriceRow!, /upscal|renderful|480p|native/i);
  console.log('Seedance 2.5 Flash passed: documented subtasks, quoted-credit preflight, mandatory Renderful 1080p, no native fallback, Rp6.000 billing/refunds.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
