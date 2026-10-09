import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { klingV3StandardVideoError } from '../src/kling-v3-standard-flora';

const source = fs.readFileSync(path.resolve(__dirname, '../src/index.ts'), 'utf8');
for (const priceKey of ['kling_p2', 'kling_p3']) assert.match(source, new RegExp(`${priceKey}:\\s*4000`));
const wrappersFrom = source.indexOf('async function runKlingP2(');
const wrappersTo = source.indexOf('// ─── Background: Picsart Image-to-Video', wrappersFrom);
const wrappers = source.slice(wrappersFrom, wrappersTo);
assert.doesNotMatch(wrappers, /runKlingEdanbot|kling-motion-26-pro/);
assert.match(wrappers, /prompt,\s*'p2'/);
assert.match(wrappers, /prompt,\s*'p3'/);
function compile(text: string) {
  return ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
}
async function wizard(variant: 'p2' | 'p3', document: boolean) {
  const n = variant === 'p2' ? '2' : '3';
  const session: any = { mode: 'idle', dbUserId: 7 };
  const messages: string[] = [], runs: any[] = [];
  const ctx: any = {
    from: { id: 9 }, chat: { id: 9 }, message: {},
    reply: async (text: string) => { messages.push(text); return { message_id: 88 }; },
    editMessageText: async (text: string) => { messages.push(text); },
  };
  const context = vm.createContext({
    ctx, MODEL_PRICES: { kling_p2: 4000, kling_p3: 4000 }, KLING_P3_MAX_REF_SECONDS: 30,
    klingV3StandardVideoError,
    getSession: () => session, setSession: (_id: number, patch: any) => Object.assign(session, patch),
    requireLogin: async () => true, formatRupiah: (price: number) => `Rp${price}`,
    getCooldownRemainingMs: () => 0, formatCooldown: () => '',
    runKlingP2: async (...args: any[]) => { runs.push(args); },
    runKlingP3: async (...args: any[]) => { runs.push(args); },
    console: { error() {} },
  });
  async function execute(from: string, to: string, prelude = '') {
    const a = source.indexOf(from), b = source.indexOf(to, a + from.length);
    assert.ok(a >= 0 && b > a, `Handler not found: ${from}`);
    await vm.runInContext(compile(`(async()=>{ const userId=9, session=getSession(userId); ${prelude}\n${source.slice(a, b)} })()`), context);
  }
  const callbackEnd = variant === 'p2' ? "  if (data === 'mode_klingp3')" : "  if (data === 'mode_rw')";
  await execute(`  if (data === 'mode_kling${variant}')`, callbackEnd, `const data='mode_kling${variant}';`);
  assert.equal(session.mode, `kling${variant}_wait_image`);
  assert.match(messages.at(-1)!, /1K\/1080p/);
  assert.match(messages.at(-1)!, /3–30 detik/);
  assert.match(messages.at(-1)!, /4000/);
  ctx.message = document
    ? { document: { file_size: 1000, mime_type: 'image/png' } }
    : { photo: [{ width: 600, height: 900, file_size: 1000 }] };
  await execute(
    `  if (session.mode === 'kling${variant}_wait_image') {`,
    variant === 'p2' ? "  if (session.mode === 'klingp3_wait_prompt')" : "  if (session.mode === 'rw_wait_image')",
    "const fileUrl='https://telegram.test/old-photo-url', fileId='photo_id';"
  );
  assert.equal(session[`klingP${n}ImageFileId`], 'photo_id');
  assert.equal(session.mode, `kling${variant}_wait_video`);
  const video = () => document
    ? execute(
        `  if (doc.mime_type?.startsWith('video/') && session.mode === 'kling${variant}_wait_video'`,
        variant === 'p2' ? "  if (doc.mime_type?.startsWith('video/') && session.mode === 'kling_wait_video'" : "  if (doc.mime_type?.startsWith('video/') && session.mode === 'topaz_wait_video'",
        'const doc=ctx.message.document;'
      )
    : execute(
        `  if (session.mode === 'kling${variant}_wait_video' && session.characterUrlP${n}) {`,
        `  if (session.mode === 'kling${variant}_wait_prompt') {`, 'const vid=ctx.message.video;'
      );
  for (const invalid of [{ duration: 2, file_size: 1000 }, { duration: 31, file_size: 1000 }, { duration: 10, file_size: 16 * 1024 * 1024 }]) {
    ctx.message = document
      ? { document: { ...invalid, file_id: 'invalid', mime_type: 'video/mp4' } }
      : { video: { ...invalid, file_id: 'invalid' } };
    await video();
    assert.equal(session.mode, `kling${variant}_wait_video`);
    assert.equal(session[`klingP${n}VideoFileId`], undefined);
  }
  ctx.message = document
    ? { document: { file_id: 'video_id', mime_type: 'video/mp4', file_size: 1000 } }
    : { video: { file_id: 'video_id', file_size: 1000, duration: 10 } };
  await video();
  assert.equal(session.mode, `kling${variant}_wait_prompt`);
  ctx.message = { text: '-' };
  const prompt = () => execute(
    `  if (session.mode === 'kling${variant}_wait_prompt') {\n    if (!await requireLogin(ctx)) return;`,
    variant === 'p2' ? "  // ── Kling MC V3.0 PRO P3 prompt" : "  // ── Seedance 2 Mini Video Edit prompt"
  );
  await prompt(); await prompt();
  assert.equal(runs.length, 1, 'Duplicate prompts must not start two paid jobs');
  assert.deepEqual(runs[0], [9, 9, 7, 88, 'photo_id', 'video_id', document ? undefined : 10, '']);
  assert.doesNotMatch(messages.join(' '), /Flora|Edanbot|P5|upscal/i);
}
async function main() {
  for (const variant of ['p2', 'p3'] as const) {
    await wizard(variant, false);
    await wizard(variant, true);
  }
  console.log('P2/P3 use the P5 Standard backend: public names/prices, fresh photo IDs, 3–30s/15MB limits, document input and duplicate-prompt safety passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
