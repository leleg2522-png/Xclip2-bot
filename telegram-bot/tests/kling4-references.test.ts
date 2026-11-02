import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import vm from 'node:vm';
import ts from 'typescript';
import * as picsart from '../src/picsart';
import { KLING4_DURATIONS } from '../src/picsart-kling4';
import { retryTelegramFileRead } from '../src/telegram-file-retry';
import { KLING4_REFERENCE_VIDEO_MAX_BYTES, validateKling4ReferenceVideo } from '../src/kling4-reference-video';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
const compile = (text: string) => ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function fn(name: string) {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name); return node.getText(ast);
}
function fragment(start: string, end: string) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a); return source.slice(a, b);
}

function harness(model: 'kling_v4' | 'kling_v4_omni') {
  let state: any = { mode: 'picsart_i2v_wait_image', dbUserId: 77,
    picsartI2vModel: model, picsartI2vImageUrls: [], picsartI2vDraftId: 'draft',
    picsartI2vVideoMode: 'feature', picsartI2vDuration: 30, picsartI2vRatio: '9:16' };
  const handlers: Record<string, any> = {}, jobs: any[][] = [], messages: string[] = [];
  let gate = Promise.resolve(), sequence = 0;
  const Markup = { inlineKeyboard: (rows: any) => ({ reply_markup: { inline_keyboard: rows } }),
    button: { callback: (text: string, data: string) => ({ text, callback_data: data }) } };
  const context = vm.createContext({
    picsart, KLING4_DURATIONS, KLING4_REFERENCE_VIDEO_MAX_BYTES, retryTelegramFileRead, Markup,
    getSession: () => state,
    setSession: (_id: number, patch: any) => { state = { ...state, ...patch }; },
    requireLogin: async () => true, getCooldownRemainingMs: () => 0,
    isPicsartI2vModelKey: (key: string) => key in picsart.PICSART_I2V_MODELS,
    runPicsartI2v: async (...args: any[]) => { jobs.push(args); },
    bot: { on: (name: string, handler: any) => { handlers[name] = handler; } },
    console: { error() {} },
  });
  const helpers = [
    'supportsMultiplePicsartI2vImages', 'maxPicsartI2vImages', 'picsartI2vPublicSettings',
    'picsartI2vAddPhotoKeyboard', 'handleKling4ReferenceVideo', 'handleKling4ReferencePhoto',
    'submitPicsartI2vPrompt',
  ].map(fn).join('\n');
  const photoBranch = fragment("if (session.mode === 'picsart_i2v_wait_image')", "if (session.mode === 'oneover_wait_image')");
  const callbackBranches = fragment("if (data === 'picsart_kling4_video_feature'", "if (data.startsWith('mode_pi2v_'))");
  vm.runInContext(compile(helpers + `
    async function handleImageInput(ctx, fileUrl, fileId) {
      const userId = ctx.from.id, session = getSession(userId);
      ${photoBranch}
    }
    async function callback(ctx) {
      const userId = ctx.from.id, data = ctx.callbackQuery.data;
      ${callbackBranches}
    }
  `), context);
  for (const type of ['photo', 'document', 'video']) {
    const node = ast.statements.find(n => ts.isExpressionStatement(n)
      && ts.isCallExpression(n.expression)
      && n.expression.expression.getText(ast) === 'bot.on'
      && (n.expression.arguments[0] as ts.StringLiteral)?.text === type);
    assert.ok(node, type);
    vm.runInContext(compile(node.getText(ast)), context);
  }
  const ctx = (message: any = {}) => ({
    from: { id: 1 }, chat: { id: 2 }, message: { message_id: ++sequence, ...message },
    telegram: { getFileLink: async (id: string) => { await gate; return new URL(`https://example.test/${id}`); } },
    reply: async (text: string) => { messages.push(text); return { message_id: sequence }; },
    editMessageText: async (text: string) => { messages.push(text); },
    answerCbQuery: async (text: string) => { messages.push(text); },
  });
  return {
    state: () => state, messages, jobs, context,
    set: (patch: any) => { state = { ...state, ...patch }; },
    photo: (id: string) => handlers.photo(ctx({ photo: [{ file_id: id }] })),
    document: (document: any) => handlers.document(ctx({ document })),
    video: (video: any) => handlers.video(ctx({ video })),
    callback: (data: string) => context.callback({ ...ctx(), callbackQuery: { data } }),
    prompt: () => context.submitPicsartI2vPrompt(ctx(), 'A scene'),
    block: () => { let release!: () => void; gate = new Promise<void>(r => { release = r; }); return release; },
  };
}

async function main() {
  for (const model of ['kling_v4', 'kling_v4_omni'] as const) {
    const h = harness(model);
    await h.callback('picsart_i2v_photos_done');
    assert.equal(h.state().mode, 'picsart_i2v_wait_image', 'A reference is required');
    await h.video({ file_id: 'oversize', mime_type: 'video/mp4', file_size: KLING4_REFERENCE_VIDEO_MAX_BYTES + 1 });
    assert.equal(h.state().picsartI2vVideoFileId, undefined);
    await h.video({ file_id: 'wrong', mime_type: 'video/quicktime' });
    assert.equal(h.state().picsartI2vVideoFileId, undefined);
    const release = h.block();
    const photos = Array.from({ length: 8 }, (_, n) => n % 2
      ? h.photo(`image-${n}`) : h.document({ file_id: `image-${n}`, mime_type: 'image/png' }));
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(h.state().picsartI2vPendingImages, 8);
    await h.callback('picsart_i2v_photos_done');
    assert.equal(h.state().mode, 'picsart_i2v_wait_image', 'Cannot finish while photos resolve');
    release(); await Promise.all(photos);
    assert.equal(h.state().picsartI2vImageUrls.length, 8);
    await h.photo('ninth');
    assert.equal(h.state().picsartI2vImageUrls.length, 8);
    await h.document({ file_id: 'clip', mime_type: 'application/octet-stream', file_name: 'reference.mp4' });
    await h.video({ file_id: 'second-clip', mime_type: 'video/mp4' });
    assert.equal(h.state().picsartI2vVideoFileId, 'clip');
    await h.callback('picsart_kling4_video_base');
    await h.callback('picsart_i2v_photos_done');
    await Promise.all([h.prompt(), h.prompt()]);
    assert.equal(h.jobs.length, 1);
    assert.equal(h.jobs[0][5].videoFileId, 'clip');
    assert.equal(h.jobs[0][5].referType, 'base');
    assert.equal(h.jobs[0][5].imageUrls.length, 8);
    assert.equal(h.state().picsartI2vVideoFileId, undefined, 'Clear claimed references');
    const only = harness(model);
    await only.video({ file_id: 'only', mime_type: 'video/mp4' });
    await only.callback('picsart_i2v_photos_done'); await only.prompt();
    assert.equal(only.jobs.length, 1);
    assert.equal(only.jobs[0][5].imageUrls.length, 0);
    assert.equal(only.jobs[0][5].referType, 'feature');
    const cancelled = harness(model);
    const resume = cancelled.block();
    const pending = cancelled.photo('old');
    await new Promise<void>(resolve => setImmediate(resolve));
    cancelled.set({ mode: 'idle', picsartI2vDraftId: 'replacement', picsartI2vPendingImages: 0 });
    resume(); await pending;
    assert.equal(cancelled.state().picsartI2vImageUrls.length, 0, 'Ignore stale asynchronous uploads');
  }
  const mp4 = execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=1', '-t', '31',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov', '-f', 'mp4', 'pipe:1',
  ]);
  await validateKling4ReferenceVideo(mp4); // Docs do not specify a reference duration cap.
  for (const bytes of [Buffer.alloc(0), Buffer.from('<html>not video</html>'), Buffer.alloc(KLING4_REFERENCE_VIDEO_MAX_BYTES + 1)]) {
    await assert.rejects(validateKling4ReferenceVideo(bytes));
  }
  console.log('PASS Kling 4 refs: real photo/video/document routes, 8 images + 1 video, video-only, modes, pending/cancel guards, single claim, actual MP4 validation.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
