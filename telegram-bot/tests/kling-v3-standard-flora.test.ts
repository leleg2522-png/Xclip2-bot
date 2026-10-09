import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { KLING_V3_STANDARD, klingV3StandardVideoError, generateKlingV3StandardFlora } from '../src/kling-v3-standard-flora';
import type { KlingP4Api } from '../src/kling-p4-flora';

const source = fs.readFileSync(path.resolve(__dirname, '../src/index.ts'), 'utf8');
assert.equal(KLING_V3_STANDARD.label, 'Kling MC V3 Pro P5');
assert.equal(KLING_V3_STANDARD.modelId, 'iv2v-kling-v3-standard-motion');
assert.match(source, /kling_v3_standard:\s*3500/);
assert.match(source, /xclip_motion:\s*2500/);
assert.match(source, /mode_klingv3std:\s*'klingv3std'/);
assert.ok(klingV3StandardVideoError(16 * 1024 * 1024, 10));
assert.ok(klingV3StandardVideoError(1000, 31));
assert.ok(klingV3StandardVideoError(1000, 2));
assert.equal(klingV3StandardVideoError(1000, 10), undefined);

const input = {
  image: { buf: Buffer.from('image'), name: 'photo.png', mime: 'image/png' },
  video: { buf: Buffer.from('video'), name: 'ref.mp4', mime: 'video/mp4' },
  prompt: 'follow movement', seconds: 10,
};
function harness(failure?: string) {
  const calls = { submits: [] as any[], polls: [] as string[], dead: [] as string[], statuses: [] as string[] };
  const api: KlingP4Api = {
    getKey: async skip => failure === 'no-key' ? null : ['one', 'two'].find(key => !skip.has(key)) ?? null,
    markDead: async key => { calls.dead.push(key); },
    workspace: async key => {
      if (failure === 'pre-auth' && key === 'one') throw Error('401');
      if (failure === 'all-no-project' || (failure === 'no-project' && key === 'one')) throw Error('FLORA_NO_PROJECT: missing');
      if (failure === 'no-workspace' && key === 'one') throw Error('FLORA_NO_WORKSPACE: missing');
      return { workspaceId: 'workspace', projectId: 'project' };
    },
    upload: async (_key, _ws, _buf, name) => `https://example.test/${name}`,
    generate: async (...args) => {
      calls.submits.push(args);
      if (failure === 'timeout') throw Error('ETIMEDOUT');
      if (failure === 'submit-no-project') throw Error('FLORA_NO_PROJECT: ambiguous submit');
      return failure === 'no-id' ? '' : 'run_fixture';
    },
    poll: async (_key, id) => {
      calls.polls.push(id);
      if (failure === 'poll-auth') throw Error('401');
      if (failure === 'poll-billing') throw Error('BILLING_NOT_ENOUGH_CREDITS');
      return 'https://example.test/native.mp4';
    },
    exhausted: error => /401|BILLING/.test(String(error)),
    status: async text => { calls.statuses.push(text); assert.doesNotMatch(text, /flora|fal/i); },
  };
  return { api, calls };
}
function compile(text: string) {
  return ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
}
// Use the production string-based classifier so runner tests catch an Error
// object being passed directly to raw.toLowerCase().
const classifierContext = vm.createContext({});
for (const [startMarker, endMarker] of [
  ['function describeError(', '// Provider and bridge names'],
  ['function isFloraKeyExhaustedError(', 'function isFloraRetryablePreSubmitError('],
]) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(compile(source.slice(start, end)), classifierContext);
}
async function apiTests() {
  const success = harness();
  await generateKlingV3StandardFlora(input, success.api);
  assert.equal(success.calls.submits[0][2], 'iv2v-kling-v3-standard-motion');
  assert.deepEqual(success.calls.submits[0][3], {
    image_url: 'https://example.test/photo.png', video_url: 'https://example.test/ref.mp4', character_orientation: 'video',
  });
  assert.equal(success.calls.submits[0][4], input.prompt);
  const motion = harness();
  await generateKlingV3StandardFlora({ ...input, publicLabel: 'Xclip Motion' }, motion.api);
  assert.equal(motion.calls.submits[0][2], 'iv2v-kling-v3-standard-motion');
  assert.ok(motion.calls.statuses.every(text => text.includes('Xclip Motion')));
  assert.doesNotMatch(motion.calls.statuses.join(' '), /P5|Flora|Picsart|Renderful|upscal/i);
  const preAuth = harness('pre-auth');
  await generateKlingV3StandardFlora(input, preAuth.api);
  assert.deepEqual(preAuth.calls.dead, ['one']);
  assert.equal(preAuth.calls.submits[0][0], 'two');
  for (const failure of ['no-project', 'no-workspace']) {
    const h = harness(failure);
    await generateKlingV3StandardFlora(input, h.api);
    assert.equal(h.calls.submits.length, 1);
    assert.equal(h.calls.submits[0][0], 'two');
    assert.deepEqual(h.calls.dead, []);
  }
  const noProjects = harness('all-no-project');
  await assert.rejects(generateKlingV3StandardFlora(input, noProjects.api), /KLING_V3_STANDARD_UNAVAILABLE/);
  assert.equal(noProjects.calls.submits.length, 0);
  assert.deepEqual(noProjects.calls.dead, []);
  const ambiguous = harness('submit-no-project');
  await assert.rejects(generateKlingV3StandardFlora(input, ambiguous.api), /FLORA_NO_PROJECT/);
  assert.equal(ambiguous.calls.submits.length, 1);
  for (const error of ['no-key', 'no-id', 'timeout', 'poll-auth', 'poll-billing']) {
    const h = harness(error);
    await assert.rejects(generateKlingV3StandardFlora(input, h.api));
    assert.equal(h.calls.submits.length, error === 'no-key' ? 0 : 1, `${error}: never replay a paid run`);
  }
}
async function billingTest(outcome: string, route: 'p5' | 'p2' | 'p3' | 'xclip_motion' = 'p5') {
  const price = route === 'xclip_motion' ? 2500 : route === 'p2' || route === 'p3' ? 4000 : 3500;
  const label = route === 'p2' ? 'Kling MC V3 PRO P2' : route === 'p3' ? 'Kling MC V3.0 PRO P3'
    : route === 'xclip_motion' ? 'Xclip Motion' : KLING_V3_STANDARD.label;
  const events = { charges: [] as number[], refunds: [] as number[], releases: 0, upscales: 0, deliveries: 0, successes: 0, messages: [] as string[] };
  const ctx = vm.createContext({
    MODEL_PRICES: { kling_v3_standard: 3500, xclip_motion: 2500, kling_p2: 4000, kling_p3: 4000 }, KLING_V3_STANDARD,
    HAR_MODELS: { xclip_motion: { label: 'Xclip Motion' } },
    beginCharge: async (_id: number, amount: number, limit: number) => {
      assert.equal(limit, 3); events.charges.push(amount); return { ok: outcome !== 'insufficient', reason: 'insufficient' };
    },
    chargeFailMsg: () => 'No balance',
    bot: { telegram: { editMessageText: async (_chat: number, _msg: number, _inline: unknown, text: string) => { events.messages.push(text); },
      sendMessage: async (_chat: number, text: string) => { events.messages.push(text); }, deleteMessage: async () => {},
      getFileLink: async (id: string) => ({ href: `https://example.test/${id}` }) } },
    downloadBuffer: async () => ({ buf: Buffer.from('fixture'), mime: 'image/png', ext: 'png' }),
    sharp: () => ({ metadata: async () => ({ format: 'png', width: 600, height: 600 }) }),
    detectVideoType: () => ({ ext: 'mp4', mime: 'video/mp4' }),
    generateKlingV3StandardFlora: async (_input: unknown, api: KlingP4Api) => {
      assert.equal((_input as any).publicLabel, label);
      assert.equal(api.exhausted(Error('401 unauthorized')), true);
      assert.equal(api.exhausted(Error('BILLING_NOT_ENOUGH_CREDITS')), true);
      assert.equal(api.exhausted(Object.assign(Error('request failed'), {
        response: { status: 403, data: { message: 'invalid_credentials' } },
      })), true);
      assert.equal(api.exhausted(Error('ETIMEDOUT')), false);
      if (outcome === 'provider') throw Error('Flora provider failed https://provider.example.test/private-result');
      return 'https://example.test/native.mp4';
    },
    getNextFloraKey() {}, markFloraKeyDead() {}, floraGetWorkspace() {}, floraUploadAsset() {},
    floraGenerate() {}, floraPollRun() {},
    isFloraKeyExhaustedError: classifierContext.isFloraKeyExhaustedError,
    upscaleGeneratedVideo: async (url: string) => {
      events.upscales++; assert.equal(url, 'https://example.test/native.mp4');
      if (outcome === 'upscale-error') throw Error('UPSCALER_FAILED');
      return { url: 'https://example.test/1080.mp4', upscaled: outcome !== 'upscale-fallback' };
    },
    sendResult: async (_chat: number, url: string, caption: string, video: boolean) => {
      events.deliveries++; assert.equal(url, 'https://example.test/1080.mp4');
      assert.ok(caption.includes(label)); assert.ok(caption.includes('1K/1080p'));
      if (route === 'xclip_motion') assert.doesNotMatch(caption, /P5|Kling/i);
      assert.doesNotMatch(caption, /flora|standard|renderful/i); assert.equal(video, true);
      return outcome !== 'delivery';
    },
    addSaldo: async (_id: number, amount: number) => { events.refunds.push(amount); },
    releaseGenerating: () => { events.releases++; }, markGenSuccess: () => { events.successes++; },
    formatRupiah: (n: number) => String(n), describeError: classifierContext.describeError, console: { error() {} },
  });
  const start = source.indexOf('async function runKlingV3Standard(');
  const end = source.indexOf('// ─── Background: Kling MC V3 Pro P4', start);
  vm.runInContext(compile(source.slice(start, end)), ctx);
  if (route === 'xclip_motion') {
    const dispatchStart = source.indexOf('async function runHarModel(');
    const dispatchEnd = source.indexOf('// ─── Background: Kling Motion V3 Standard', dispatchStart);
    vm.runInContext(compile(source.slice(dispatchStart, dispatchEnd)), ctx);
    await ctx.runHarModel(1, 2, 3, 4, 'move', { model: 'xclip_motion', imageFileId: 'image', videoFileId: 'video', seconds: 10 });
  } else if (route === 'p2' || route === 'p3') {
    const from = source.indexOf('async function runKlingP2(');
    const to = source.indexOf('// ─── Background: Picsart Image-to-Video', from);
    const wrappers = source.slice(from, to);
    assert.doesNotMatch(wrappers, /runKlingEdanbot|kling-motion-26-pro/);
    vm.runInContext(compile(wrappers), ctx);
    const run = route === 'p2' ? ctx.runKlingP2 : ctx.runKlingP3;
    await run(1, 2, 3, 4, route === 'p2' ? 'https://example.test/legacy-photo.jpg' : 'photo_file_id', 'video', 10, 'move');
  } else {
    await ctx.runKlingV3Standard(1, 2, 3, 4, 'image', 'video', 10, 'move');
  }
  assert.deepEqual(events.charges, [price]);
  assert.deepEqual(events.refunds, ['success', 'insufficient'].includes(outcome) ? [] : [price]);
  assert.equal(events.releases, outcome === 'insufficient' ? 0 : 1);
  assert.equal(events.successes, outcome === 'success' ? 1 : 0);
  assert.equal(events.deliveries, ['success', 'delivery'].includes(outcome) ? 1 : 0);
  if (route === 'xclip_motion') {
    assert.doesNotMatch(events.messages.join(' '), /Flora|Picsart|Renderful|P5|Kling|provider\.example/i);
  }
}
async function wizardTest(documents = false) {
  const session: any = { mode: 'idle', dbUserId: 33 }, runs: any[] = [], messages: string[] = [];
  const ctx: any = { from: { id: 22 }, chat: { id: 11 }, message: {},
    reply: async (text: string) => { messages.push(text); return { message_id: 44 }; },
    editMessageText: async (text: string) => { messages.push(text); } };
  const sandbox = vm.createContext({
    ctx, KLING_V3_STANDARD, klingV3StandardVideoError, MODEL_PRICES: { kling_v3_standard: 3500 },
    getSession: () => session, setSession: (_id: number, data: any) => Object.assign(session, data),
    requireLogin: async () => true, formatRupiah: (n: number) => `Rp${n.toLocaleString('id-ID')}`,
    getCooldownRemainingMs: () => 0, formatCooldown: () => '', runKlingV3Standard: async (...args: any[]) => { runs.push(args); },
    console: { error() {} },
  });
  async function execute(from: string, to: string, prelude = '') {
    const a = source.indexOf(from), b = source.indexOf(to, a + from.length);
    assert.ok(a >= 0 && b > a);
    await vm.runInContext(compile(`(async()=>{ const userId=ctx.from.id, session=getSession(userId); ${prelude}\n${source.slice(a, b)} })()`), sandbox);
  }
  await execute("  if (data === 'mode_klingv3std') {", "  if (data === 'mode_klingp4') {", "const data='mode_klingv3std';");
  assert.ok(messages.at(-1)!.includes('Rp3.500')); assert.ok(messages.at(-1)!.includes('1K/1080p'));
  const document = () => execute(
    "  if (session.mode === 'klingv3std_wait_prompt') return ctx.reply('Foto dan video",
    "  if (session.mode === 'klingp4_wait_prompt') {\n    return ctx.reply('Foto dan video",
    'const doc=ctx.message.document;'
  );
  if (documents) {
    ctx.message = { document: { file_id: 'photo', mime_type: 'image/png', file_size: 1000 } }; await document();
    ctx.message = { document: { file_id: 'video', mime_type: 'video/mp4', file_size: 1000 } }; await document();
  } else {
    ctx.message = { photo: [{ file_id: 'photo', width: 600, height: 600, file_size: 1000 }] };
    await execute("  if (session.mode === 'klingv3std_wait_prompt' ||", "  if (session.mode === 'klingp4_wait_prompt' ||");
    ctx.message = { video: { file_id: 'video', duration: 31, file_size: 1000 } };
    const video = () => execute(
      "  if (session.mode === 'klingv3std_wait_video' && session.klingV3StdImageFileId) {",
      "  if (session.mode === 'klingp4_wait_video' && session.klingP4ImageFileId) {", 'const vid=ctx.message.video;'
    );
    await video(); assert.equal(session.mode, 'klingv3std_wait_video');
    ctx.message.video.duration = 10; await video();
  }
  assert.equal(session.mode, 'klingv3std_wait_prompt');
  ctx.message = { text: '-' };
  const prompt = () => execute(
    "  if (session.mode === 'klingv3std_wait_prompt') {\n    if (!await requireLogin(ctx)) return;",
    "  if (session.mode === 'klingp4_wait_prompt') {\n    if (!await requireLogin(ctx)) return;"
  );
  await prompt(); await prompt();
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0], [11, 22, 33, 44, 'photo', 'video', documents ? undefined : 10, '']);
}
async function main() {
  await apiTests(); await wizardTest(); await wizardTest(true);
  for (const outcome of ['success', 'delivery', 'provider', 'insufficient', 'upscale-fallback', 'upscale-error']) {
    await billingTest(outcome);
    await billingTest(outcome, 'xclip_motion');
      await billingTest(outcome, 'p2');
      await billingTest(outcome, 'p3');
  }
  console.log('Kling P2/P3/P5 and Xclip Motion: Standard model, branded status, independent prices, 1080p finishing, refunds and no-resubmit tests passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
