import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { KLING_P4, klingP4VideoError, generateKlingP4Flora, type KlingP4Api } from '../src/kling-p4-flora';

const source = fs.readFileSync(path.resolve(__dirname, '../src/index.ts'), 'utf8');
assert.match(source, /kling_p4:\s*4000/);
assert.match(source, /mode_klingp4:\s*'klingp4'/);
for (const mode of ['image', 'video', 'prompt']) {
  assert.ok(source.includes(`'klingp4_wait_${mode}'`));
}
assert.match(source, /KLING_P4.label.*MODEL_PRICES.kling_p4/);
assert.equal(KLING_P4.label, 'Kling MC V3 Pro P4');
assert.equal(KLING_P4.modelId, 'iv2v-kling-2.6-motion');
assert.equal(klingP4VideoError(100, 3), undefined);
assert.equal(klingP4VideoError(100, 30), undefined);
assert.ok(klingP4VideoError(100, 31));
assert.ok(klingP4VideoError(100, 2));
assert.ok(klingP4VideoError(16 * 1024 * 1024, 10));

const input = {
  image: { buf: Buffer.from('image'), name: 'photo.png', mime: 'image/png' },
  video: { buf: Buffer.from('video'), name: 'ref.mp4', mime: 'video/mp4' },
  prompt: 'copy this motion', seconds: 10,
};

function apiHarness(failure?: 'pre-auth' | 'poll-auth' | 'poll-billing' | 'timeout' | 'no-id' | 'no-key') {
  const calls = { submits: [] as any[], polls: [] as string[], dead: [] as string[], uploads: [] as string[] };
  const api: KlingP4Api = {
    getKey: async skip => failure === 'no-key' ? null : skip.has('one') ? 'two' : 'one',
    markDead: async key => { calls.dead.push(key); },
    workspace: async key => {
      if (failure === 'pre-auth' && key === 'one') throw Error('401');
      return { workspaceId: 'ws_fixture', projectId: 'prj_fixture' };
    },
    upload: async (_key, _ws, _buf, name) => { calls.uploads.push(name); return `https://example.test/${name}`; },
    generate: async (...args) => {
      calls.submits.push(args);
      if (failure === 'timeout') throw Error('ETIMEDOUT');
      return failure === 'no-id' ? '' : 'run_fixture';
    },
    poll: async (_key, id) => {
      calls.polls.push(id);
      if (failure === 'poll-auth') throw Error('401');
      if (failure === 'poll-billing') throw Error('BILLING_NOT_ENOUGH_CREDITS');
      return 'https://example.test/result.mp4';
    },
    exhausted: e => /401|BILLING/.test(String(e)),
    status: async text => { assert.ok(!/flora|fal/i.test(text)); },
  };
  return { api, calls };
}

async function testApi() {
  const success = apiHarness();
  assert.equal(await generateKlingP4Flora(input, success.api), 'https://example.test/result.mp4');
  const submit = success.calls.submits[0];
  assert.equal(submit[2], KLING_P4.modelId);
  assert.deepEqual(submit[3], {
    image_url: 'https://example.test/photo.png', video_url: 'https://example.test/ref.mp4', character_orientation: 'video',
  });
  assert.equal(submit[4], input.prompt);
  assert.equal(submit[5], 'video');
  assert.equal(success.calls.submits.length, 1);
  const fallback = apiHarness('pre-auth');
  await generateKlingP4Flora(input, fallback.api);
  assert.deepEqual(fallback.calls.dead, ['one']);
  assert.equal(fallback.calls.submits[0][0], 'two');
  for (const fail of ['poll-auth', 'poll-billing', 'timeout', 'no-id', 'no-key'] as const) {
    const h = apiHarness(fail);
    await assert.rejects(generateKlingP4Flora(input, h.api));
    assert.equal(h.calls.submits.length, fail === 'no-key' ? 0 : 1, `${fail}: must not resubmit`);
  }
  const skippedPrompt = apiHarness();
  await generateKlingP4Flora({ ...input, prompt: '' }, skippedPrompt.api);
  assert.ok(skippedPrompt.calls.submits[0][4].length > 0);
}

const start = source.indexOf('async function runKlingP4(');
const end = source.indexOf('// ─── Background: Kling Motion Control', start);
const compiled = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

async function testBilling(delivered: boolean, failure = false, chargeOk = true) {
  const events = { charges: [] as number[], refunds: [] as number[], releases: 0, successes: 0 };
  const ctx = vm.createContext({
    MODEL_PRICES: { kling_p4: 4000 }, KLING_P4,
    beginCharge: async (_id: number, price: number, max: number) => {
      assert.equal(max, 3); events.charges.push(price); return { ok: chargeOk, reason: 'insufficient' };
    },
    chargeFailMsg: () => 'Insufficient balance',
    bot: { telegram: {
      editMessageText: async () => {}, sendMessage: async () => {}, deleteMessage: async () => {},
      getFileLink: async (id: string) => ({ href: `https://example.test/${id}` }),
    } },
    downloadBuffer: async () => ({ buf: Buffer.from('media'), mime: 'image/png', ext: 'png' }),
    sharp: () => ({ metadata: async () => ({ format: 'png', width: 600, height: 600 }) }),
    detectVideoType: () => ({ ext: 'mp4', mime: 'video/mp4' }),
    generateKlingP4Flora: async () => { if (failure) throw Error('failed'); return 'https://example.test/result.mp4'; },
    getNextFloraKey() {}, markFloraKeyDead() {}, floraGetWorkspace() {},
    floraUploadAsset() {}, floraGenerate() {}, floraPollRun() {}, isFloraKeyExhaustedError() {},
    sendResult: async (_chat: number, _url: string, caption: string, video: boolean) => {
      assert.ok(caption.includes(KLING_P4.label)); assert.equal(video, true); return delivered;
    },
    incrementKlingUsage: async () => {}, markGenSuccess: () => { events.successes++; },
    addSaldo: async (_id: number, amount: number) => { events.refunds.push(amount); },
    releaseGenerating: () => { events.releases++; },
    formatRupiah: (n: number) => `${n}`,
    describeError: (e: any) => e.message,
    console: { error() {} },
  });
  vm.runInContext(compiled, ctx);
  await ctx.runKlingP4(1, 2, 3, 4, 'image', 'video', 10, 'prompt');
  assert.deepEqual(events.charges, [4000]);
  assert.deepEqual(events.refunds, !chargeOk || (delivered && !failure) ? [] : [4000]);
  assert.equal(events.releases, chargeOk ? 1 : 0);
  assert.equal(events.successes, chargeOk && delivered && !failure ? 1 : 0);
}

async function main() {
  await testApi();
  await testWizard();
  await testBilling(true);
  await testBilling(false);
  await testBilling(false, true);
  await testBilling(false, false, false);
  console.log('Kling P4 Flora contract, no-resubmit, billing and delivery tests passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

async function testWizard() {
  const session: any = { mode: 'idle', dbUserId: 33 };
  const messages: string[] = [];
  const runs: any[] = [];
  const ctx: any = {
    from: { id: 22 }, chat: { id: 11 }, message: {},
    reply: async (text: string) => { messages.push(text); return { message_id: 44 }; },
    editMessageText: async (text: string) => { messages.push(text); },
  };
  const sandbox = vm.createContext({
    ctx, KLING_P4, klingP4VideoError,
    MODEL_PRICES: { kling_p4: 4000 },
    getSession: () => session,
    setSession: (_id: number, data: any) => Object.assign(session, data),
    requireLogin: async () => true,
    formatRupiah: (n: number) => `Rp${n.toLocaleString('id-ID')}`,
    getCooldownRemainingMs: () => 0, formatCooldown: () => '',
    runKlingP4: async (...args: any[]) => { runs.push(args); },
    console: { error() {} },
  });
  async function execute(from: string, to: string, prelude = '') {
    const a = source.indexOf(from), b = source.indexOf(to, a + from.length);
    assert.ok(a >= 0 && b > a, `Missing wizard block ${from}`);
    const code = ts.transpileModule(`(async () => {
      const userId = ctx.from.id, session = getSession(userId);
      ${prelude}
      ${source.slice(a, b)}
    })()`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
    await vm.runInContext(code, sandbox);
  }
  const open = () => execute("  if (data === 'mode_klingp4') {", '  // ── Kling MC V3 PRO P2 wizard', "const data = 'mode_klingp4';");
  const photo = () => execute(
    "  if (session.mode === 'klingp4_wait_prompt' || session.mode === 'klingp4_wait_video') {",
    "  if (session.mode === 'klingp2_wait_prompt') {"
  );
  const video = () => execute(
    "  if (session.mode === 'klingp4_wait_video' && session.klingP4ImageFileId) {",
    "  if (session.mode === 'klingp2_wait_video' && session.characterUrlP2) {",
    'const vid = ctx.message.video;'
  );
  const prompt = () => execute(
    "  if (session.mode === 'klingp4_wait_prompt') {\n    if (!await requireLogin(ctx)) return;",
    '  // ── Kling MC V3 PRO P2 prompt'
  );
  await open();
  assert.equal(session.mode, 'klingp4_wait_image');
  assert.ok(messages.at(-1)!.includes('Rp4.000'));
  ctx.message = { photo: [{ file_id: 'photo_id', width: 800, height: 800, file_size: 1000 }] };
  await photo();
  assert.equal(session.mode, 'klingp4_wait_video');
  ctx.message = { video: { file_id: 'video_id', duration: 31, file_size: 1000 } };
  await video();
  assert.equal(session.mode, 'klingp4_wait_video', 'Invalid video must retain the draft');
  ctx.message.video.duration = 10;
  await video();
  assert.equal(session.mode, 'klingp4_wait_prompt');
  ctx.message = { text: '-' };
  await prompt();
  await prompt();
  assert.equal(runs.length, 1, 'Duplicate prompt must not create a second paid job');
  assert.deepEqual(runs[0], [11, 22, 33, 44, 'photo_id', 'video_id', 10, '']);
  assert.equal(session.mode, 'idle');

  // Also exercise images/videos sent as documents, which lack duration metadata.
  await open();
  const document = () => execute(
    "  if (session.mode === 'klingp4_wait_prompt') {\n    return ctx.reply('Foto dan video sudah diterima.",
    "  if (doc.mime_type?.startsWith('video/') && session.mode === 'klingp2_wait_prompt') {",
    'const doc = ctx.message.document;'
  );
  ctx.message = { document: { file_id: 'doc_photo', mime_type: 'image/png', file_size: 1000 } };
  await document();
  assert.equal(session.mode, 'klingp4_wait_video');
  ctx.message = { document: { file_id: 'doc_video', mime_type: 'video/mp4', file_size: 1000 } };
  await document();
  assert.equal(session.mode, 'klingp4_wait_prompt');
  ctx.message = { text: 'move like the reference' };
  await prompt();
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[1], [11, 22, 33, 44, 'doc_photo', 'doc_video', undefined, 'move like the reference']);
}
