import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { FLORA_480_VIDEO_MODELS } from '../src/flora-video-models';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
function fragment(start: string, end: string) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a, start);
  return source.slice(a, b);
}
const callbacks = fragment("  if (data === 'mode_flora_seedance_2_480')", "  if (data === 'mode_flora_minimax_h3_480'");
const handler = fragment('async function handleFloraSeedance2VideoInput(', 'async function handleFloraSeedance25VideoReference(');
const photo = fragment("  if (session.mode === 'flora_seedance_2_480_wait_image'", "  if (session.mode === 'flora_seedance_2_5_480_wait_image')");
const prompt = fragment("  if (\n    session.mode === 'flora_minimax_h3_480_wait_prompt'", '  // ── Runway Gen-4.5 prompt');
const videoRoute = fragment("bot.on('video'", "bot.on('text'");
const documentRoute = fragment("bot.on('document'", 'async function runKling21Pro(');
for (const route of [videoRoute, documentRoute]) {
  assert.match(route, /session\.mode === 'flora_seedance_2_480_wait_image'/);
  assert.match(route, /return handleFloraSeedance2VideoInput\(ctx,/);
}

const executable = ts.transpileModule(`
  async function callback(data, ctx, userId) { ${callbacks} }
  ${handler}
  async function photo(ctx, userId, fileUrl) { const session = getSession(userId); ${photo} }
  async function prompt(ctx, userId) { const session = getSession(userId); ${prompt} }
`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

function harness() {
  let state: any = { mode: 'idle', dbUserId: 7 };
  let sequence = 0, invalid = false;
  let inspectHook: undefined | (() => Promise<void>);
  const messages: string[] = [], jobs: any[][] = [], reads: string[] = [];
  const context = vm.createContext({
    Buffer, FLORA_480_VIDEO_MODELS, SEEDANCE25_MAX_MEDIA_BYTES: 19 * 1024 * 1024,
    MODEL_PRICES: { flora_seedance_2_480: 15000, flora_seedance_2_5_480_per_second: 1500 },
    crypto: { randomUUID: () => `draft-${++sequence}` },
    Markup: { inlineKeyboard: (rows: any) => ({ rows }), button: { callback: (text: string, data: string) => ({ text, data }) } },
    getSession: () => state,
    setSession: (_: number, patch: any) => { state = { ...state, ...patch }; },
    formatRupiah: (price: number) => `Rp${price}`,
    requireLogin: async () => true, getCooldownRemainingMs: () => 0,
    retryTelegramFileRead: async (read: () => Promise<any>) => read(),
    telegramHttp: { get: async (url: string, options: any) => {
      reads.push(url);
      assert.equal(options.maxContentLength, 19 * 1024 * 1024);
      return { data: Buffer.from('MP4 fixture') };
    } },
    inspectFloraUpscaleVideo: async () => {
      if (inspectHook) await inspectHook();
      if (invalid) throw Error('INVALID_VIDEO');
      // Do not inherit Seedance 2.5's 1.8s minimum or Picsart's 30s cap.
      return { width: 1280, height: 720, duration: 1 };
    },
    runFlora480Video: async (...args: any[]) => { jobs.push(args); },
    console: { error() {} },
  });
  vm.runInContext(executable, context);
  const ctx = {
    from: { id: 9 }, chat: { id: 9 }, message: { text: 'Restyle this footage' },
    telegram: { getFileLink: async (id: string) => ({ href: `https://telegram.example.test/${id}` }) },
    editMessageText: async (text: string) => { messages.push(text); },
    reply: async (text: string) => { messages.push(text); return { message_id: 88 }; },
  };
  return {
    messages, jobs, reads, state: () => state,
    patch: (update: any) => { state = { ...state, ...update }; },
    invalid: () => { invalid = true; },
    onInspect: (hook: () => Promise<void>) => { inspectHook = hook; },
    callback: (data: string) => context.callback(data, ctx, 9),
    photo: () => context.photo(ctx, 9, 'https://example.test/photo.jpg'),
    video: (file: any = { file_id: 'clip', mime_type: 'video/mp4' }) => context.handleFloraSeedance2VideoInput(ctx, file),
    prompt: () => context.prompt(ctx, 9),
  };
}

async function start(h: ReturnType<typeof harness>, ratio = '916') {
  await h.callback('mode_flora_seedance_2_480');
  await h.callback(`flora480_seedance_ratio_${ratio}`);
}

async function main() {
  for (const ratio of ['916', '169']) {
    const h = harness();
    await start(h, ratio);
    assert.match(h.messages.at(-1)!, /foto acuan atau 1 video MP4/);
    await h.video({ file_id: 'clip', mime_type: 'application/octet-stream', file_name: 'input.mp4' });
    assert.equal(h.state().mode, 'flora_seedance_2_480_wait_prompt');
    assert.equal(h.state().floraSeedance2480ImageUrl, undefined);
    await h.prompt();
    await h.prompt();
    assert.deepEqual(h.jobs, [[9, 9, 7, 88, 'seedance_2_480', '', 'Restyle this footage',
      ratio === '916' ? '9:16' : '16:9', 15, 'clip', 'video/mp4']]);
    assert.equal(h.state().mode, 'idle');
    assert.equal(h.state().floraSeedance2480VideoFileId, undefined);
    assert.equal(h.state().floraSeedance2480DraftId, undefined);
    await start(h, ratio);
    await h.photo();
    await h.prompt();
    assert.equal(h.jobs[1][5], 'https://example.test/photo.jpg');
    assert.equal(h.jobs[1][9], undefined, 'new photo job must not reuse a previous video');
  }
  for (const file of [
    { file_id: 'huge', file_size: 20 * 1024 * 1024, mime_type: 'video/mp4' },
    { file_id: 'wrong', mime_type: 'video/quicktime', file_name: 'input.mov' },
  ]) {
    const h = harness();
    await start(h);
    await h.video(file);
    assert.equal(h.reads.length, 0);
    assert.equal(h.state().mode, 'flora_seedance_2_480_wait_image');
    assert.equal(h.jobs.length, 0);
  }
  const invalid = harness();
  await start(invalid);
  invalid.invalid();
  await invalid.video();
  assert.equal(invalid.state().mode, 'flora_seedance_2_480_wait_image');
  assert.equal(invalid.state().floraSeedance2480VideoPending, false);
  assert.match(invalid.messages.at(-1)!, /Video tidak bisa dibaca/);

  for (const videoFirst of [false, true]) {
    const combined = harness();
    await start(combined);
    if (videoFirst) {
      await combined.video();
      await combined.photo();
    } else {
      await combined.photo();
      const draftId = combined.state().floraSeedance2480DraftId;
      await combined.callback(`flora480_seedance_addvideo_${draftId}`);
      assert.equal(combined.state().mode, 'flora_seedance_2_480_wait_image');
      await combined.video();
    }
    assert.match(combined.messages.at(-1)!, /Foto \+ video siap digabung/);
    await combined.callback(`flora480_seedance_addvideo_${combined.state().floraSeedance2480DraftId}`);
    assert.equal(combined.state().mode, 'flora_seedance_2_480_wait_prompt', 'old add-video button must not reopen a completed upload');
    assert.equal(combined.state().floraSeedance2480VideoFileId, 'clip');
    await combined.prompt();
    await combined.prompt();
    assert.equal(combined.jobs.length, 1);
    assert.equal(combined.jobs[0][5], 'https://example.test/photo.jpg');
    assert.equal(combined.jobs[0][9], 'clip');
    assert.equal(combined.state().floraSeedance2480VideoFileId, undefined);
    assert.equal(combined.state().floraSeedance2480ImageUrl, undefined);
    await start(combined);
    await combined.video();
    await combined.prompt();
    assert.equal(combined.jobs[1][5], '', 'new draft must not reuse old character photo');
  }
  const direct = harness();
  await start(direct);
  await direct.photo();
  await direct.video();
  await direct.prompt();
  assert.equal(direct.jobs[0][5], 'https://example.test/photo.jpg');
  assert.equal(direct.jobs[0][9], 'clip', 'direct video attachment after photo must work without pressing button');
  const skip = harness();
  await start(skip);
  await skip.photo();
  const skipId = skip.state().floraSeedance2480DraftId;
  assert.ok(Buffer.byteLength(`flora480_seedance_skipvideo_${'x'.repeat(36)}`) <= 64);
  await skip.callback(`flora480_seedance_addvideo_${skipId}`);
  await skip.callback(`flora480_seedance_skipvideo_${skipId}`);
  await skip.prompt();
  assert.equal(skip.jobs.length, 1);
  assert.equal(skip.jobs[0][9], undefined);
  await start(skip);
  await skip.photo();
  await skip.callback(`flora480_seedance_addvideo_${skipId}`);
  assert.equal(skip.state().mode, 'flora_seedance_2_480_wait_prompt', 'stale button must not reopen a new draft');
  assert.match(skip.messages.at(-1)!, /sudah tidak aktif/);

  const pendingMixed = harness();
  await start(pendingMixed);
  await pendingMixed.photo();
  let finishInspection!: () => void, notifyInspection!: () => void;
  const inspectionBegun = new Promise<void>(resolve => { notifyInspection = resolve; });
  pendingMixed.onInspect(async () => {
    notifyInspection();
    await new Promise<void>(resolve => { finishInspection = resolve; });
  });
  const pendingVideo = pendingMixed.video();
  await inspectionBegun;
  await pendingMixed.prompt();
  await pendingMixed.video();
  assert.equal(pendingMixed.jobs.length, 0, 'prompt while video validates must not submit photo-only job');
  assert.equal(pendingMixed.reads.length, 1);
  finishInspection();
  await pendingVideo;
  await pendingMixed.prompt();
  assert.equal(pendingMixed.jobs.length, 1);
  assert.equal(pendingMixed.jobs[0][9], 'clip');

  const concurrent = harness();
  await start(concurrent);
  let release!: () => void, inspecting!: () => void;
  const begun = new Promise<void>(resolve => { inspecting = resolve; });
  concurrent.onInspect(async () => {
    inspecting();
    await new Promise<void>(resolve => { release = resolve; });
  });
  const first = concurrent.video();
  await begun;
  await concurrent.video();
  await concurrent.photo();
  await concurrent.prompt();
  assert.equal(concurrent.reads.length, 1, 'pending guard blocks a duplicate download');
  assert.equal(concurrent.jobs.length, 0);
  // A reset/new wizard must invalidate an upload that completes late.
  await start(concurrent);
  const newDraft = concurrent.state().floraSeedance2480DraftId;
  release();
  await first;
  assert.equal(concurrent.state().floraSeedance2480DraftId, newDraft);
  assert.equal(concurrent.state().mode, 'flora_seedance_2_480_wait_image');
  assert.equal(concurrent.state().floraSeedance2480VideoFileId, undefined);
  console.log('Seedance 2 video input: wizard, MP4 documents, size, invalid media, duplicates and stale uploads passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
