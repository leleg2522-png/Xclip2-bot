import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { isFloraWorkspaceSetupError } from '../src/kling-p4-flora';
import {
  FLORA_480_VIDEO_MODELS,
  resolveFlora480VideoModel,
  resolveFlora480VideoModelContract,
  buildFlora480VideoParams,
  type Flora480VideoModelKey,
} from '../src/flora-video-models';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const start = source.indexOf('function isExplicitFlora480KeyRejection');
const end = source.indexOf('// ─── Background: Flora image generation', start);
assert.ok(start > 0 && end > start);
const runnerSource = source.slice(start, end);
assert.match(runnerSource, /await upscaleGeneratedVideo\(resultUrl, userId, chatId, statusMsgId\)/);
assert.match(runnerSource, /if \(!delivered && finalVideo\.upscaled && !config\.mandatoryUpscale\)/);
assert.match(source, /flora_minimax_h3_480:\s*10000/);
assert.match(source, /flora_wan_v3_480:\s*15000/);
assert.match(source, /flora_seedance_2_480:\s*15000/);
assert.match(source, /flora_seedance_2_5_480_per_second:\s*1500/);
assert.match(source, /Seedance 2\.5 Uncensored • 1K • 10\/15\/30 detik/);
assert.match(source, /Seedance 2\.5 Uncensored \(1K · 10\/15\/30 detik\)/);
assert.doesNotMatch(source, /Seedance 2\.5 Uncensored[^\n]*480p/);
assert.match(source, /if \(config\.mandatoryUpscale && !finalVideo\.upscaled\)/);
assert.match(source, /if \(config\.mandatoryUpscale && !delivered\)/);
assert.match(source, /Seedance 2 Uncensored • 15 detik • 1080p/);
assert.match(source, /Seedance 2 Uncensored \(15 detik · 1080p\)/);
assert.doesNotMatch(source, /Seedance 2\.0 480p/);
assert.equal(FLORA_480_VIDEO_MODELS.minimax_h3_480.label, 'MiniMax H3 Uncensored');
assert.equal(FLORA_480_VIDEO_MODELS.wan_v3_480.label, 'Wan 3.0 Uncensored');
assert.match(source, /MiniMax H3 Uncensored • 15 detik • hingga 1K/);
assert.match(source, /Wan 3\.0 Uncensored • 30 detik • hingga 1K/);
assert.doesNotMatch(source, /MiniMax H3 P2|Wan 3\.0 P2|Video selesai dibuat\. Menyiapkan hasil akhir/);
for (const route of ['flora_minimax_h3_480', 'flora_wan_v3_480', 'flora_seedance_2_480', 'flora_seedance_2_5_480']) {
  const modes = route === 'flora_seedance_2_5_480'
    ? ['wait_ratio', 'wait_image', 'wait_video_choice', 'wait_video', 'wait_duration', 'wait_prompt']
    : ['wait_ratio', 'wait_image', 'wait_prompt'];
  for (const mode of modes) {
    assert.match(source, new RegExp(`'${route}_${mode}'`));
  }
  assert.match(source, new RegExp(`mode_${route}: '${route}'`));
}
assert.match(source, /data\.startsWith\('flora480_minimax_'\).*return 'flora_minimax_h3_480'/);
assert.match(source, /data\.startsWith\('flora480_wan_'\).*return 'flora_wan_v3_480'/);
assert.match(source, /data\.startsWith\('flora480_seedance_'\).*return 'flora_seedance_2_480'/);
assert.match(source, /data\.startsWith\('flora480_seedance25_'\).*return 'flora_seedance_2_5_480'/);
assert.match(source, /referenceVideoFileId, referenceVideoMime/);

const executable = ts.transpileModule(runnerSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function catalog() {
  return {
    models: (['minimax_h3_480', 'wan_v3_480', 'seedance_2_480', 'seedance_2_5_480'] as const).map(key => {
      const singleImageInput = key === 'seedance_2_480' || key === 'seedance_2_5_480';
      const config = FLORA_480_VIDEO_MODELS[key];
      const durations = config.durationOptionsSeconds ?? [config.durationSeconds!];
      return ({
      model_id: `live-${key}`,
      name: key === 'minimax_h3_480'
        ? 'MiniMax H3 Max'
        : key === 'seedance_2_480'
          ? 'Seedance 2.0'
          : key === 'seedance_2_5_480'
            ? 'Seedance 2.5'
            : 'WAN 3.0',
      type: 'video',
      capabilities: [key === 'seedance_2_5_480'
        ? 'reference-to-video'
        : singleImageInput ? 'image-to-video' : 'audio-image-to-video'],
      params: [
        { name: singleImageInput ? 'image_url' : 'image_urls', type: singleImageInput ? 'string' : 'string[]' },
        ...(key === 'seedance_2_5_480' ? [{ name: 'video_urls', type: 'string[]' }] : []),
        { name: 'duration', options: durations.map(value => ({ value: String(value) })) },
        { name: 'resolution', options: [{ value: config.resolution }] },
        { name: 'aspect_ratio', options: [{ value: '9:16' }, { value: '16:9' }] },
      ],
    }); }),
  };
}

type Options = {
  keys?: string[];
  chargeOk?: boolean;
  catalog?: (key: string, attempt: number) => unknown;
  workspace?: (key: string) => { workspaceId: string; projectId: string };
  submit?: (key: string, prompt: string) => string;
  poll?: (runId: string) => string;
  deliver?: boolean | ((url: string) => boolean);
  upscale?: boolean;
  sendThrows?: (url: string) => boolean;
  refundFails?: boolean;
};

function harness(options: Options = {}) {
  const events = {
    charges: [] as number[],
    refunds: [] as number[],
    releases: [] as number[],
    dead: [] as string[],
    submissions: [] as Array<{ key: string; model: string; params: any; prompt: string }>,
    videoUploads: [] as Array<{ key: string; mime: string }>,
    deliveries: [] as Array<{ chatId: number; url: string; caption: string }>,
    messages: [] as string[],
    successes: [] as number[],
    polls: [] as string[],
    upscales: [] as Array<{ sourceUrl: string; userId: number; chatId: number; statusMsgId: number }>,
    order: [] as string[],
    catalogCalls: 0,
    workspaceKeys: [] as string[],
    uploads: [] as string[],
  };
  const keys = options.keys ?? ['key-a', 'key-b'];
  const context = vm.createContext({
    Buffer,
    FLORA_480_VIDEO_MODELS,
    buildFlora480VideoParams,
    resolveFlora480VideoModel,
    resolveFlora480VideoModelContract,
    isFloraWorkspaceSetupError,
    MODEL_PRICES: {
      flora_minimax_h3_480: 10000,
      flora_wan_v3_480: 15000,
      flora_seedance_2_480: 15000,
      flora_seedance_2_5_480_per_second: 1500,
    },
    FLORA_BASE: 'https://provider.example.test',
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (callback: () => void) => callback(),
    describeError: (error: any) => String(error.message ?? ''),
    isFloraRetryablePreSubmitError: (desc: string) => desc.includes('Server Error'),
    beginCharge: async (_: number, price: number, limit: number) => {
      assert.equal(limit, 3);
      events.charges.push(price);
      return { ok: options.chargeOk !== false, reason: 'saldo' };
    },
    chargeFailMsg: () => 'Saldo tidak cukup',
    downloadBuffer: async (url: string) => url.includes('video-reference')
      ? { buf: Buffer.from('video fixture'), ext: 'mp4', mime: 'video/mp4' }
      : { buf: Buffer.from('fixture'), ext: 'jpg', mime: 'image/jpeg' },
    retryTelegramFileRead: async (read: () => Promise<any>) => read(),
    floraUploadAsset: async (key: string, _workspace: string, _buf: Buffer, _name: string, mime: string) => {
      events.videoUploads.push({ key, mime });
      return 'https://provider.example.test/video-reference.mp4';
    },
    getNextFloraKey: async (skipped: Set<string>) => keys.find(key => !skipped.has(key)) ?? null,
    markFloraKeyDead: async (key: string) => { events.dead.push(key); },
    floraHttp: {
      get: async (_: string, config: any) => {
        const key = config.headers.Authorization.replace('Bearer ', '');
        events.catalogCalls++;
        return { data: options.catalog ? options.catalog(key, events.catalogCalls) : catalog() };
      },
    },
    floraGetWorkspace: async (key: string) => {
      events.workspaceKeys.push(key);
      return options.workspace ? options.workspace(key) : { workspaceId: 'workspace', projectId: 'project' };
    },
    floraUploadImage: async (key: string) => {
      events.uploads.push(key);
      return 'https://provider.example.test/image.jpg';
    },
    telegramHttp: { get: async () => ({ data: Buffer.from('video fixture') }) },
    inspectFloraSeedance25Video: async () => 2,
    SEEDANCE25_MAX_MEDIA_BYTES: 19 * 1024 * 1024,
    floraSeedance25DurationKeyboard: () => ({}),
    crypto: { randomUUID: () => 'draft-uuid' },
    floraGenerate: async (key: string, _: any, model: string, params: any, prompt: string, type: string) => {
      assert.equal(type, 'video');
      events.submissions.push({ key, model, params, prompt });
      return options.submit ? options.submit(key, prompt) : `run-${prompt}`;
    },
    floraPollRun: async (_: string, runId: string, maxMs: number) => {
      assert.equal(maxMs, 20 * 60 * 1000);
      events.polls.push(runId);
      events.order.push('poll');
      return options.poll ? options.poll(runId) : `https://provider.example.test/${runId}.mp4`;
    },
    upscaleGeneratedVideo: async (sourceUrl: string, userId: number, chatId: number, statusMsgId: number) => {
      events.upscales.push({ sourceUrl, userId, chatId, statusMsgId });
      events.order.push('upscale');
      return options.upscale === false
        ? { url: sourceUrl, upscaled: false }
        : { url: sourceUrl.replace('.mp4', '-1k.mp4'), upscaled: true };
    },
    sendResult: async (chatId: number, url: string, caption: string, video: boolean) => {
      assert.equal(video, true);
      events.deliveries.push({ chatId, url, caption });
      events.order.push('deliver');
      if (options.sendThrows?.(url)) throw new Error('Telegram delivery failed');
      return typeof options.deliver === 'function' ? options.deliver(url) : options.deliver !== false;
    },
    markGenSuccess: (userId: number) => { events.successes.push(userId); },
    addSaldo: async (_: number, price: number) => {
      events.refunds.push(price);
      if (options.refundFails) throw new Error('Database connection lost');
    },
    releaseGenerating: (userId: number) => { events.releases.push(userId); },
    formatRupiah: (value: number) => `Rp${value}`,
    bot: {
      telegram: {
        getFileLink: async (fileId: string) => ({ href: `https://telegram.example.test/video-reference/${fileId}` }),
        editMessageText: async (_: number, __: number, ___: unknown, text: string) => { events.messages.push(text); },
        sendMessage: async (_: number, text: string) => { events.messages.push(text); },
        deleteMessage: async () => {},
      },
    },
  });
  vm.runInContext(executable, context);
  const run = (
    key: Flora480VideoModelKey,
    chatId = 1,
    prompt = 'fixture',
    ratio: '16:9' | '9:16' = '16:9',
    durationSeconds = FLORA_480_VIDEO_MODELS[key].durationSeconds ?? 10,
    referenceVideoFileId?: string,
    referenceVideoMime?: string,
  ) =>
    context.runFlora480Video(chatId, chatId, chatId, chatId * 10, key,
      'https://example.test/reference.jpg', prompt, ratio, durationSeconds,
      referenceVideoFileId, referenceVideoMime) as Promise<void>;
  return { events, run };
}

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { response: { status } });
}

async function verifySeedanceWizard() {
  const callbacks = source.slice(source.indexOf("  if (data === 'mode_flora_seedance_2_480')"), source.indexOf("  if (data === 'mode_flora_minimax_h3_480'"));
  const photo = source.slice(source.indexOf("  if (session.mode === 'flora_seedance_2_480_wait_image')"), source.indexOf("  if (session.mode === 'flora_minimax_h3_480_wait_image')"));
  const prompt = source.slice(source.indexOf("  if (\n    session.mode === 'flora_minimax_h3_480_wait_prompt'"), source.indexOf('  // ── Runway Gen-4.5 prompt'));
  assert.ok(callbacks && photo && prompt);
  for (const ratio of ['9:16', '16:9'] as const) {
    let state: any = { mode: 'idle', dbUserId: 7 };
    const messages: string[] = [];
    const jobs: any[][] = [];
    const context = vm.createContext({
      FLORA_480_VIDEO_MODELS,
    MODEL_PRICES: { flora_seedance_2_480: 15000, flora_seedance_2_5_480_per_second: 1500 },
      Markup: { inlineKeyboard: (buttons: any) => ({ buttons }), button: { callback: (text: string, data: string) => ({ text, data }) } },
      getSession: () => state,
      setSession: (_: number, update: any) => { state = { ...state, ...update }; },
      formatRupiah: (amount: number) => `Rp${amount}`,
      requireLogin: async () => true,
      getCooldownRemainingMs: () => 0,
      runFlora480Video: async (...args: any[]) => { jobs.push(args); },
      console: { error() {} },
    });
    const wizardCode = ts.transpileModule(
      `async function callback(data, ctx, userId) { ${callbacks} }
       async function photo(ctx, userId, fileUrl) { const session = getSession(userId); ${photo} }
       async function prompt(ctx, userId) { const session = getSession(userId); ${prompt} }`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }
    ).outputText;
    vm.runInContext(wizardCode, context);
    const ctx = {
      chat: { id: 9 }, message: { text: 'Animate this image' },
      editMessageText: async (text: string) => { messages.push(text); },
      reply: async (text: string) => { messages.push(text); return { message_id: 88 }; },
    };
    await context.callback('mode_flora_seedance_2_480', ctx, 9);
    assert.equal(state.mode, 'flora_seedance_2_480_wait_ratio');
    assert.match(messages.at(-1)!, /Rp15000/);
    await context.callback(`flora480_seedance_ratio_${ratio === '16:9' ? '169' : '916'}`, ctx, 9);
    assert.equal(state.mode, 'flora_seedance_2_480_wait_image');
    assert.equal(state.floraSeedance2480Ratio, ratio);
    await context.photo(ctx, 9, 'https://example.test/ref.jpg');
    assert.equal(state.mode, 'flora_seedance_2_480_wait_prompt');
    await context.prompt(ctx, 9);
    await context.prompt(ctx, 9);
    assert.equal(jobs.length, 1, 'duplicate prompt must not submit twice');
    assert.deepEqual(jobs[0], [
      9, 9, 7, 88, 'seedance_2_480', 'https://example.test/ref.jpg',
      'Animate this image', ratio, 15, undefined, undefined,
    ]);
    assert.equal(state.mode, 'idle');
    assert.equal(state.floraSeedance2480ImageUrl, undefined);
    assert.equal(state.floraSeedance2480Ratio, undefined);
    await context.callback('flora480_seedance_ratio_916', ctx, 9);
    assert.equal(state.mode, 'idle', 'stale ratio callback must not reopen a paid draft');
    assert.match(messages.at(-1)!, /sudah tidak aktif/);
    assert.match(messages.join(' '), /Seedance 2 Uncensored/);
    assert.match(messages.join(' '), /1080p/);
    assert.doesNotMatch(messages.join(' '), /Flora|Renderful|upscal|480p|1K/i);
  }
}

async function verifySeedance25Wizard() {
  const callbacks = source.slice(source.indexOf("  if (data === 'mode_flora_seedance_2_480')"), source.indexOf("  if (data === 'mode_flora_minimax_h3_480'"));
  const photo = source.slice(source.indexOf("  if (session.mode === 'flora_seedance_2_480_wait_image')"), source.indexOf("  if (session.mode === 'flora_minimax_h3_480_wait_image')"));
  const prompt = source.slice(source.indexOf("  if (\n    session.mode === 'flora_minimax_h3_480_wait_prompt'"), source.indexOf('  // ── Runway Gen-4.5 prompt'));
  const videoHandler = source.slice(
    source.indexOf('async function handleFloraSeedance25VideoReference('),
    source.indexOf('// Label model gambar'),
  );
  let state: any = { mode: 'idle', dbUserId: 7 };
  const messages: string[] = [];
  const jobs: any[][] = [];
  const context = vm.createContext({
    Buffer,
    FLORA_480_VIDEO_MODELS,
    MODEL_PRICES: { flora_seedance_2_480: 15000, flora_seedance_2_5_480_per_second: 1500 },
    Markup: { inlineKeyboard: (buttons: any) => ({ buttons }), button: { callback: (text: string, data: string) => ({ text, data }) } },
    getSession: () => state,
    setSession: (_: number, update: any) => { state = { ...state, ...update }; },
    formatRupiah: (amount: number) => `Rp${amount}`,
    requireLogin: async () => true,
    getCooldownRemainingMs: () => 0,
    runFlora480Video: async (...args: any[]) => { jobs.push(args); },
    crypto: { randomUUID: () => 'draft-uuid' },
    SEEDANCE25_MAX_MEDIA_BYTES: 19 * 1024 * 1024,
    retryTelegramFileRead: async (read: () => Promise<any>) => read(),
    telegramHttp: { get: async () => ({ data: Buffer.from('video fixture') }) },
    inspectFloraSeedance25Video: async () => 2.4,
    floraSeedance25VideoChoiceKeyboard: () => ({}),
    floraSeedance25DurationKeyboard: () => ({}),
    console: { error() {} },
  });
  const wizardCode = ts.transpileModule(
    `async function callback(data, ctx, userId) { ${callbacks} }
     async function photo(ctx, userId, fileUrl) { const session = getSession(userId); ${photo} }
     ${videoHandler}
     async function prompt(ctx, userId) { const session = getSession(userId); ${prompt} }`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }
  ).outputText;
  vm.runInContext(wizardCode, context);
  const ctx = {
    from: { id: 9 }, chat: { id: 9 }, message: { text: 'Animate this image' },
    telegram: { getFileLink: async (fileId: string) => ({ href: `https://telegram.example.test/${fileId}` }) },
    editMessageText: async (text: string) => { messages.push(text); },
    reply: async (text: string) => { messages.push(text); return { message_id: 88 }; },
  };
  await context.callback('mode_flora_seedance_2_5_480', ctx, 9);
  assert.equal(state.mode, 'flora_seedance_2_5_480_wait_ratio');
  assert.match(messages.at(-1)!, /Rp1500 per detik/);
  await context.callback('flora480_seedance25_ratio_169', ctx, 9);
  assert.equal(state.mode, 'flora_seedance_2_5_480_wait_image');
  assert.equal(state.floraSeedance25480Ratio, '16:9');
  await context.photo(ctx, 9, 'https://example.test/ref.jpg');
  assert.equal(state.mode, 'flora_seedance_2_5_480_wait_video_choice');
  await context.callback('flora480_seedance25_video_add', ctx, 9);
  assert.equal(state.mode, 'flora_seedance_2_5_480_wait_video');
  await context.handleFloraSeedance25VideoReference(ctx, {
    file_id: 'video-ref-1', file_size: 1024, mime_type: 'video/mp4',
  });
  assert.equal(state.mode, 'flora_seedance_2_5_480_wait_duration');
  assert.equal(state.floraSeedance25480VideoFileId, 'video-ref-1');
  assert.equal(state.floraSeedance25480VideoDuration, 2.4);
  await context.callback('flora480_seedance25_duration_11', ctx, 9);
  assert.equal(state.mode, 'flora_seedance_2_5_480_wait_duration');
  assert.match(messages.at(-1)!, /tidak valid/);
  await context.callback('flora480_seedance25_duration_15', ctx, 9);
  assert.equal(state.mode, 'flora_seedance_2_5_480_wait_prompt');
  assert.equal(state.floraSeedance25480Duration, 15);
  assert.match(messages.at(-1)!, /Rp22500/);
  await context.prompt(ctx, 9);
  await context.prompt(ctx, 9);
  assert.equal(jobs.length, 1, 'duplicate prompt must not submit twice');
  assert.deepEqual(jobs[0], [
    9, 9, 7, 88, 'seedance_2_5_480', 'https://example.test/ref.jpg',
    'Animate this image', '16:9', 15, 'video-ref-1', 'video/mp4',
  ]);
  assert.equal(state.mode, 'idle');
  assert.equal(state.floraSeedance25480ImageUrl, undefined);
  assert.equal(state.floraSeedance25480Ratio, undefined);
  assert.equal(state.floraSeedance25480Duration, undefined);
  assert.equal(state.floraSeedance25480VideoFileId, undefined);

  state = { mode: 'idle', dbUserId: 7 };
  await context.callback('mode_flora_seedance_2_5_480', ctx, 9);
  await context.callback('flora480_seedance25_ratio_916', ctx, 9);
  await context.photo(ctx, 9, 'https://example.test/ref.jpg');
  assert.equal(state.mode, 'flora_seedance_2_5_480_wait_video_choice');
  await context.callback('flora480_seedance25_video_skip', ctx, 9);
  assert.equal(state.mode, 'flora_seedance_2_5_480_wait_duration');
  await context.callback('flora480_seedance25_duration_10', ctx, 9);
  await context.prompt(ctx, 9);
  assert.deepEqual(jobs[1], [
    9, 9, 7, 88, 'seedance_2_5_480', 'https://example.test/ref.jpg',
    'Animate this image', '9:16', 10, undefined, undefined,
  ]);
}

async function main() {
  await verifySeedanceWizard();
  await verifySeedance25Wizard();
  for (const model of ['wan_v3_480', 'minimax_h3_480', 'seedance_2_480', 'seedance_2_5_480'] as const) {
    for (const code of ['FLORA_NO_PROJECT', 'FLORA_NO_WORKSPACE']) {
      const fallback = harness({ workspace: key => {
        if (key === 'key-a') throw new Error(`${code}: missing setup`);
        return { workspaceId: 'workspace', projectId: 'project' };
      } });
      await fallback.run(model);
      assert.deepEqual(fallback.events.workspaceKeys, ['key-a', 'key-b']);
      assert.deepEqual(fallback.events.uploads, ['key-b']);
      assert.equal(fallback.events.submissions.length, 1);
      assert.equal(fallback.events.submissions[0].key, 'key-b');
      assert.deepEqual(fallback.events.dead, []);
      assert.deepEqual(fallback.events.refunds, []);
      assert.deepEqual(fallback.events.releases, [1]);
      assert.doesNotMatch(fallback.events.messages.join(' '), /FLORA_NO|workspace|project|key-|provider/i);
    }
    const unavailable = harness({ workspace: () => { throw new Error('FLORA_NO_PROJECT: missing setup'); } });
    await unavailable.run(model);
    assert.deepEqual(unavailable.events.workspaceKeys, ['key-a', 'key-b']);
    assert.equal(unavailable.events.uploads.length, 0);
    assert.equal(unavailable.events.submissions.length, 0);
    assert.deepEqual(unavailable.events.dead, []);
    assert.equal(unavailable.events.refunds.length, 1);
    assert.equal(unavailable.events.refunds[0], unavailable.events.charges[0]);
    assert.deepEqual(unavailable.events.releases, [1]);
  }
  for (const options of [
    { submit: () => { throw new Error('FLORA_NO_PROJECT: ambiguous submit'); } },
    { poll: () => { throw new Error('FLORA_NO_PROJECT: accepted run failure'); } },
  ]) {
    const failed = harness(options);
    await failed.run('wan_v3_480');
    assert.equal(failed.events.submissions.length, 1);
    assert.deepEqual(failed.events.workspaceKeys, ['key-a']);
    assert.deepEqual(failed.events.dead, []);
    assert.deepEqual(failed.events.refunds, [15000]);
    assert.deepEqual(failed.events.releases, [1]);
  }
  for (const ratio of ['16:9', '9:16'] as const) {
    const native = harness();
    await native.run('seedance_2_480', 1, 'fixture', ratio);
    assert.deepEqual(native.events.charges, [15000]);
    assert.deepEqual(native.events.order, ['poll', 'upscale', 'deliver']);
    assert.equal(native.events.upscales.length, 1);
    assert.equal(native.events.submissions[0].model, 'live-seedance_2_480');
    assert.equal(native.events.submissions[0].params.image_url, 'https://provider.example.test/image.jpg');
    assert.equal(native.events.submissions[0].params.aspect_ratio, ratio);
    assert.equal(native.events.submissions[0].params.duration, '15');
    assert.equal(native.events.submissions[0].params.resolution, '480p');
    assert.equal(native.events.submissions[0].params.image_urls, undefined);
    assert.equal(native.events.deliveries[0].url, 'https://provider.example.test/run-fixture-1k.mp4');
    assert.match(native.events.deliveries[0].caption, /Seedance 2 Uncensored/);
    assert.match(native.events.deliveries[0].caption, /1080p/);
    assert.doesNotMatch(native.events.messages.join(' ') + native.events.deliveries[0].caption, /1K|480p|Flora|upscal|Renderful/i);
    assert.deepEqual(native.events.refunds, []);
    assert.deepEqual(native.events.releases, [1]);
  }
  for (const duration of [10, 15, 30] as const) {
    const draft = harness();
    await draft.run('seedance_2_5_480', 1, 'draft prompt', '9:16', duration);
    assert.deepEqual(draft.events.charges, [duration * 1500]);
    assert.equal(draft.events.submissions.length, 1);
    assert.equal(draft.events.submissions[0].model, 'live-seedance_2_5_480');
    assert.deepEqual(draft.events.submissions[0].params, {
      image_url: 'https://provider.example.test/image.jpg',
      duration: String(duration),
      resolution: '480p',
      aspect_ratio: '9:16',
    });
    assert.deepEqual(draft.events.order, ['poll', 'upscale', 'deliver']);
    assert.equal(draft.events.upscales.length, 1);
    assert.equal(draft.events.deliveries[0].url, 'https://provider.example.test/run-draft prompt-1k.mp4');
    assert.match(draft.events.deliveries[0].caption, new RegExp(`Seedance 2\\.5 Uncensored.*${duration} detik.*1K`));
    assert.deepEqual(draft.events.refunds, []);
    assert.deepEqual(draft.events.successes, [1]);
    assert.deepEqual(draft.events.releases, [1]);
  }
  const withReferenceVideo = harness();
  await withReferenceVideo.run(
    'seedance_2_5_480', 3, 'follow video motion', '16:9', 15, 'telegram-video-id', 'video/mp4'
  );
  assert.deepEqual(withReferenceVideo.events.charges, [22500]);
  assert.deepEqual(withReferenceVideo.events.videoUploads, [{ key: 'key-a', mime: 'video/mp4' }]);
  assert.deepEqual(withReferenceVideo.events.order, ['poll', 'upscale', 'deliver']);
  assert.equal(withReferenceVideo.events.upscales.length, 1);
  assert.equal(withReferenceVideo.events.deliveries[0].url, 'https://provider.example.test/run-follow video motion-1k.mp4');
  assert.match(withReferenceVideo.events.deliveries[0].caption, /Seedance 2\.5 Uncensored.*1K/);
  assert.equal(withReferenceVideo.events.submissions.length, 1);
  assert.equal(withReferenceVideo.events.submissions[0].params.video_urls[0],
    'https://provider.example.test/video-reference.mp4');
  assert.equal(withReferenceVideo.events.submissions[0].params.duration, '15');
  assert.deepEqual(withReferenceVideo.events.refunds, []);
  assert.deepEqual(withReferenceVideo.events.releases, [3]);

  const requiredUpscaleFailed = harness({ upscale: false });
  await requiredUpscaleFailed.run('seedance_2_5_480', 5, 'uncensored upscale failure', '9:16', 10);
  assert.deepEqual(requiredUpscaleFailed.events.order, ['poll', 'upscale']);
  assert.equal(requiredUpscaleFailed.events.deliveries.length, 0, 'never send native 480p as fallback');
  assert.deepEqual(requiredUpscaleFailed.events.refunds, [15000]);
  assert.deepEqual(requiredUpscaleFailed.events.successes, []);

  const requiredDeliveryFailed = harness({ deliver: false });
  await requiredDeliveryFailed.run('seedance_2_5_480', 6, 'uncensored delivery failure', '9:16', 10);
  assert.deepEqual(requiredDeliveryFailed.events.deliveries.map(d => d.url), [
    'https://provider.example.test/run-uncensored delivery failure-1k.mp4',
  ], 'do not send native 480p when 1K delivery fails');
  assert.deepEqual(requiredDeliveryFailed.events.refunds, [15000]);
  assert.deepEqual(requiredDeliveryFailed.events.successes, []);

  const referenceParamUnavailable = harness({
    catalog: () => ({
      models: catalog().models.map((model: any) => model.name === 'Seedance 2.5'
        ? { ...model, params: model.params.filter((param: any) => param.name !== 'video_urls') }
        : model),
    }),
  });
  await referenceParamUnavailable.run(
    'seedance_2_5_480', 4, 'follow video motion', '16:9', 15, 'telegram-video-id', 'video/mp4'
  );
  assert.equal(referenceParamUnavailable.events.submissions.length, 0);
  assert.equal(referenceParamUnavailable.events.videoUploads.length, 0);
  assert.deepEqual(referenceParamUnavailable.events.refunds, [22500]);
  assert.deepEqual(referenceParamUnavailable.events.releases, [4]);

  for (const options of [
    { deliver: false },
    { poll: () => { throw new Error('FLORA_RUN_TIMEOUT'); } },
    { submit: () => { throw new Error('network timeout'); } },
  ]) {
    const failed = harness(options);
    await failed.run('seedance_2_480');
    assert.equal(failed.events.submissions.length, 1);
    assert.equal(failed.events.upscales.length, 'deliver' in options ? 1 : 0);
    assert.deepEqual(failed.events.refunds, [15000]);
    assert.deepEqual(failed.events.releases, [1]);
  }
  for (const options of [
    { upscale: false },
    { deliver: (url: string) => !url.includes('-1k.mp4') },
    { sendThrows: (url: string) => url.includes('-1k.mp4') },
  ]) {
    const fallback = harness(options);
    await fallback.run('seedance_2_480');
    assert.equal(fallback.events.submissions.length, 1);
    assert.equal(fallback.events.upscales.length, 1);
    assert.equal(fallback.events.deliveries.at(-1)?.url, 'https://provider.example.test/run-fixture.mp4');
    assert.match(fallback.events.deliveries.at(-1)?.caption ?? '', /Seedance 2 Uncensored.*480p/);
    assert.doesNotMatch(fallback.events.deliveries.at(-1)?.caption ?? '', /1080|1K|native|asli|Renderful|Flora|upscal/i);
    assert.deepEqual(fallback.events.refunds, []);
    assert.deepEqual(fallback.events.successes, [1]);
    assert.deepEqual(fallback.events.releases, [1]);
  }
  for (const key of ['minimax_h3_480', 'wan_v3_480'] as const) {
    const { events, run } = harness();
    await run(key);
    assert.deepEqual(events.charges, [key === 'minimax_h3_480' ? 10000 : 15000]);
    assert.equal(events.submissions.length, 1);
    assert.equal(events.submissions[0].model, `live-${key}`);
    assert.equal(events.submissions[0].params.duration, String(FLORA_480_VIDEO_MODELS[key].durationSeconds));
    assert.equal(events.submissions[0].params.resolution, FLORA_480_VIDEO_MODELS[key].resolution);
    assert.equal(events.submissions[0].params.aspect_ratio, '16:9');
    assert.deepEqual(events.refunds, []);
    assert.deepEqual(events.releases, [1]);
    assert.match(events.deliveries[0].caption, /· 1K\)/);
    assert.match(events.deliveries[0].caption, /Uncensored/);
    assert.match(events.deliveries[0].url, /-1k\.mp4$/);
    assert.deepEqual(events.order, ['poll', 'upscale', 'deliver']);
    assert.deepEqual(events.upscales, [{
      sourceUrl: 'https://provider.example.test/run-fixture.mp4',
      userId: 1, chatId: 1, statusMsgId: 10,
    }]);
    assert.doesNotMatch(events.messages.join(' ') + events.deliveries[0].caption, /upscal|Flora|Renderful|ByteDance|gateway|key-|1080/i);
  }

  for (const key of ['minimax_h3_480', 'wan_v3_480'] as const) {
    const fallback = harness({ upscale: false });
    await fallback.run(key);
    assert.equal(fallback.events.submissions.length, 1);
    assert.equal(fallback.events.upscales.length, 1);
    assert.equal(fallback.events.deliveries.length, 1);
    assert.equal(fallback.events.deliveries[0].url, 'https://provider.example.test/run-fixture.mp4');
    assert.match(fallback.events.deliveries[0].caption, /· 480p\)/);
    assert.doesNotMatch(fallback.events.deliveries[0].caption, /1K|asli|native|upscal|renderful/i);
    assert.deepEqual(fallback.events.refunds, []);
  }

  for (const key of ['minimax_h3_480', 'wan_v3_480'] as const) {
    for (const throwOnUpscaled of [false, true]) {
      const fallback = harness({
        deliver: url => !url.includes('-1k.mp4'),
        sendThrows: throwOnUpscaled ? url => url.includes('-1k.mp4') : undefined,
      });
      await fallback.run(key);
      assert.equal(fallback.events.submissions.length, 1);
      assert.equal(fallback.events.upscales.length, 1, 'do not resubmit the finishing pass after delivery failure');
      assert.equal(fallback.events.deliveries.length, 2);
      assert.match(fallback.events.deliveries[0].caption, /· 1K\)/);
      assert.match(fallback.events.deliveries[1].caption, /· 480p\)/);
      assert.doesNotMatch(fallback.events.deliveries[1].caption, /asli|native|upscal|renderful/i);
      assert.equal(fallback.events.deliveries[1].url, 'https://provider.example.test/run-fixture.mp4');
      assert.deepEqual(fallback.events.refunds, []);
      assert.deepEqual(fallback.events.successes, [1]);
    }
  }

  const rotated = harness({ catalog: key => {
    if (key === 'key-a') throw httpError(403, 'Forbidden');
    return catalog();
  } });
  await rotated.run('minimax_h3_480');
  assert.deepEqual(rotated.events.dead, ['key-a']);
  assert.equal(rotated.events.submissions[0].key, 'key-b');
  assert.deepEqual(rotated.events.refunds, []);

  const absent = harness({ catalog: key => key === 'key-a' ? { models: [] } : catalog() });
  await absent.run('wan_v3_480');
  assert.deepEqual(absent.events.dead, []);
  assert.equal(absent.events.submissions[0].key, 'key-b');
  assert.equal(absent.events.submissions.length, 1);

  const quota = harness({ submit: key => {
    if (key === 'key-a') throw httpError(402, 'Payment required');
    return 'accepted';
  } });
  await quota.run('minimax_h3_480');
  assert.deepEqual(quota.events.dead, ['key-a']);
  assert.equal(quota.events.submissions.length, 2);
  assert.deepEqual(quota.events.polls, ['accepted']);
  assert.deepEqual(quota.events.refunds, []);

  for (const message of ['network timeout', 'Server Error', 'FLORA_SUBMIT_FAILED: no run_id']) {
    const ambiguous = harness({ submit: () => { throw new Error(message); } });
    await ambiguous.run('wan_v3_480');
    assert.equal(ambiguous.events.submissions.length, 1, 'ambiguous submit must never repeat');
    assert.deepEqual(ambiguous.events.dead, []);
    assert.deepEqual(ambiguous.events.refunds, [15000]);
    assert.deepEqual(ambiguous.events.releases, [1]);
  }
  for (const error of [
    httpError(500, 'Gateway failure: quota exceeded'),
    httpError(503, 'Forbidden billing_not_enough_credits'),
    Object.assign(new Error('Gateway failure: quota exceeded'), { isAxiosError: true }),
    new Error('Ambiguous submission mentions insufficient credits'),
  ]) {
    const ambiguous = harness({ submit: () => { throw error; } });
    await ambiguous.run('wan_v3_480');
    assert.equal(ambiguous.events.submissions.length, 1, 'incidental quota/auth wording must not cause resubmission');
    assert.deepEqual(ambiguous.events.dead, []);
    assert.deepEqual(ambiguous.events.refunds, [15000]);
    assert.deepEqual(ambiguous.events.releases, [1]);
  }

  for (const error of [
    new Error('FLORA_RUN_FAILED [BILLING_NOT_ENOUGH_CREDITS]'),
    httpError(401, 'Unauthorized'),
    new Error('FLORA_RUN_TIMEOUT'),
    new Error('PROMPT_MODERATED provider details'),
  ]) {
    const failed = harness({ poll: () => { throw error; } });
    await failed.run('minimax_h3_480');
    assert.equal(failed.events.submissions.length, 1, 'accepted job must never be resubmitted');
    assert.equal(failed.events.upscales.length, 0, 'a failed generation must not be upscaled');
    assert.deepEqual(failed.events.refunds, [10000]);
    assert.deepEqual(failed.events.releases, [1]);
    assert.equal(failed.events.dead.length, /BILLING|Unauthorized/.test(error.message) ? 1 : 0);
    assert.doesNotMatch(failed.events.messages.join(' '), /FLORA_|BILLING|provider details|PROMPT_MODERATED/);
  }

  const deliveryFailed = harness({ deliver: false });
  await deliveryFailed.run('wan_v3_480');
  assert.equal(deliveryFailed.events.submissions.length, 1);
  assert.equal(deliveryFailed.events.deliveries.length, 2, 'failed 1K delivery must attempt the original before refund');
  assert.deepEqual(deliveryFailed.events.refunds, [15000]);
  assert.deepEqual(deliveryFailed.events.successes, []);

  const pendingRefund = harness({ deliver: false, refundFails: true });
  await pendingRefund.run('wan_v3_480');
  assert.deepEqual(pendingRefund.events.refunds, [15000], 'ambiguous credit must not be blindly repeated');
  assert.deepEqual(pendingRefund.events.releases, [1]);
  assert.match(pendingRefund.events.messages.join(' '), /belum dapat dikonfirmasi/);
  assert.match(pendingRefund.events.messages.join(' '), /video-1-10/);
  assert.doesNotMatch(pendingRefund.events.messages.join(' '), /Saldo Rp15000 dikembalikan/);

  const empty = harness({ keys: [] });
  await empty.run('minimax_h3_480');
  assert.equal(empty.events.submissions.length, 0);
  assert.deepEqual(empty.events.refunds, [10000]);
  assert.deepEqual(empty.events.releases, [1]);

  const noSaldo = harness({ chargeOk: false });
  await noSaldo.run('wan_v3_480');
  assert.equal(noSaldo.events.submissions.length, 0);
  assert.deepEqual(noSaldo.events.refunds, []);
  assert.deepEqual(noSaldo.events.releases, []);

  const preparation = harness({ catalog: (_, attempt) => {
    if (attempt === 1) throw new Error('Server Error');
    return catalog();
  } });
  await preparation.run('wan_v3_480');
  assert.equal(preparation.events.submissions.length, 1);
  assert.equal(preparation.events.catalogCalls, 2);
  assert.deepEqual(preparation.events.dead, []);

  const parallel = harness();
  await Promise.all([
    parallel.run('minimax_h3_480', 11, 'minimax'),
    parallel.run('wan_v3_480', 22, 'wan'),
    parallel.run('seedance_2_480', 33, 'seedance'),
  ]);
  assert.equal(parallel.events.submissions.length, 3);
  assert.equal(parallel.events.deliveries.find(d => d.chatId === 11)?.url, 'https://provider.example.test/run-minimax-1k.mp4');
  assert.equal(parallel.events.deliveries.find(d => d.chatId === 22)?.url, 'https://provider.example.test/run-wan-1k.mp4');
  assert.equal(parallel.events.deliveries.find(d => d.chatId === 33)?.url, 'https://provider.example.test/run-seedance-1k.mp4');
  assert.match(parallel.events.deliveries.find(d => d.chatId === 33)?.caption ?? '', /1080p/);
  assert.match(parallel.events.deliveries.find(d => d.chatId === 11)?.caption ?? '', /1K/);
  assert.match(parallel.events.deliveries.find(d => d.chatId === 22)?.caption ?? '', /1K/);
  assert.deepEqual(parallel.events.refunds, []);
  assert.deepEqual(parallel.events.releases.sort(), [11, 22, 33]);
  console.log('Flora 480p generation, automatic 1K delivery, native fallback, refunds and parallel-isolation simulations passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });