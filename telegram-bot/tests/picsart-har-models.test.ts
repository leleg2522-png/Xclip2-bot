import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { HAR_MODELS, buildHarModelParams, harWorkflow, harResultUrl, type HarModelKey } from '../src/picsart-har-models';

const bot = fs.readFileSync(path.resolve(__dirname, '../src/index.ts'), 'utf8');
const backend = fs.readFileSync(path.resolve(__dirname, '../src/picsart.ts'), 'utf8');
for (const [key, price] of Object.entries({ heygen: 2500, xclip_motion: 3000, banana21: 600 })) {
  assert.match(bot, new RegExp(`${key}:\\s*${price}`));
}
const image = 'https://example.test/image.jpg', video = 'https://example.test/video.mp4';
for (const model of Object.keys(HAR_MODELS) as HarModelKey[]) {
  const cfg = HAR_MODELS[model];
  const p = buildHarModelParams({
    model, prompt: 'A cool pose', ratio: '9:16',
    imageUrl: cfg.needsImage ? image : undefined, videoUrl: cfg.needsVideo ? video : undefined,
  });
  if (cfg.video) {
    assert.equal(p.model, 'heygen-video-1');
    assert.equal(p.duration, 15);
    assert.equal(p.resolution, '768p');
    assert.equal(p.prompt_enhancement, 'turbo');
    assert.deepEqual(p.reference_images, [{ type: 'url', url: image }]);
    assert.deepEqual(p.reference_videos, cfg.needsVideo ? [{ type: 'url', url: video }] : undefined);
    assert.equal(harWorkflow(model), '/gw-v2/workflows/heygen/v1/models/video/generate');
  } else {
    assert.equal(p.model, 'gemini-nano-banana-2.1');
    assert.equal(p.count, 1);
    assert.equal(p.imageSize, '4K');
    assert.deepEqual(p.thinkingConfig, { thinkingLevel: 'MINIMAL' });
    assert.deepEqual(p.imageUrls, cfg.needsImage ? [image] : []);
    assert.equal(harWorkflow(model), '/gw-v2/workflows/gemini/v2/images');
  }
}
assert.throws(() => buildHarModelParams({ model: 'xclip_motion', prompt: 'move', ratio: '9:16', imageUrl: image }));
assert.throws(() => buildHarModelParams({ model: 'heygen', prompt: 'move', ratio: '1:1', imageUrl: image }));
assert.throws(() => buildHarModelParams({ model: 'banana21_i2i', prompt: 'edit', ratio: '1:1' }));
assert.equal(harResultUrl({ url: video }, true), video);
assert.equal(harResultUrl({ imageUrls: [{ url: image }] }, false), image);
assert.equal(harResultUrl({ imageUrls: [image] }, false), image);
assert.equal(harResultUrl({ imageUrls: [] }, false), undefined);

function compile(text: string) {
  return ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
}
async function testBackend(model: HarModelKey, failure?: 'poll-auth' | 'no-url' | 'timeout' | 'get-transient') {
  const cfg = HAR_MODELS[model], events = { submissions: 0, accounts: 0, dead: 0, gets: 0 };
  const start = backend.indexOf('export async function generateHarModel(');
  const end = backend.indexOf('export type GptImage25Model', start);
  const ctx = vm.createContext({
    exports: {}, HAR_MODELS, buildHarModelParams, harWorkflow, harResultUrl,
    API_BASE: 'https://api.picsart.com', X_APP_AUTHORIZATION: 'fixture',
    setTimeout: (callback: () => void) => callback(), console: { error() {} },
    runWithAccount: async (_user: number, _pool: any, fn: any) => { events.accounts++; return fn(7); },
    uploadFile: async (_id: number, _buf: Buffer, name: string) => `https://example.test/${name}`,
    getAccessToken: async () => 'fixture',
    commonHeaders: (headers: any) => headers,
    ok2xx: (status: number) => status >= 200 && status < 300,
    isPicsartPostSubmitAuthFailure: (error: any) => /AUTH_DEAD/.test(error.message),
    q: async () => { events.dead++; },
    PollDiag: class { note() { return true; } timeoutError() { return Error('timeout'); } },
    http: {
      post: async (url: string, data: any) => {
        events.submissions++;
        assert.equal(url, `https://api.picsart.com${harWorkflow(model)}/submit`);
        assert.equal(data.params.model, cfg.video ? 'heygen-video-1' : 'gemini-nano-banana-2.1');
        if (failure === 'timeout') throw Error('ETIMEDOUT');
        return { status: 201, data: { response: { id: 'job_fixture' } } };
      },
      get: async (url: string) => {
        events.gets++;
        assert.ok(url.endsWith('/job_fixture/result'));
        if (failure === 'poll-auth') throw Error('PICSART_AUTH_DEAD');
        if (failure === 'get-transient' && events.gets === 1) throw Object.assign(Error('timeout'), { code: 'ETIMEDOUT' });
        return { status: 200, data: { response: { status: 'COMPLETED',
          result: failure === 'no-url' ? {} : cfg.video ? { url: video } : { imageUrls: [{ url: image }] },
          usage: { credits: cfg.video ? 15 : 2 },
        } } };
      },
    },
  });
  vm.runInContext(compile(backend.slice(start, end)), ctx);
  const promise = ctx.exports.generateHarModel({
    userId: 1, model, ratio: '9:16', prompt: 'move',
    image: cfg.needsImage ? { buffer: Buffer.from('image'), name: 'image.jpg', mime: 'image/jpeg' } : undefined,
    video: cfg.needsVideo ? { buffer: Buffer.from('video'), name: 'video.mp4', mime: 'video/mp4' } : undefined,
  });
  if (failure && failure !== 'get-transient') await assert.rejects(promise);
  else assert.equal((await promise).url, cfg.video ? video : image);
  assert.equal(events.submissions, 1);
  assert.equal(events.accounts, 1, 'Accepted jobs must not be replayed on another account');
  assert.equal(events.dead, failure === 'poll-auth' ? 1 : 0);
}

async function testWizard(model: HarModelKey, documents = false) {
  const cfg = HAR_MODELS[model], session: any = { mode: 'idle', dbUserId: 3 };
  const messages: string[] = [], runs: any[] = [];
  const ctx: any = {
    from: { id: 2 }, chat: { id: 1 }, message: {},
    reply: async (text: string) => { messages.push(text); return { message_id: 4 }; },
    editMessageText: async (text: string) => { messages.push(text); },
    answerCbQuery: async () => {},
  };
  const sandbox = vm.createContext({
    ctx, HAR_MODELS, MODEL_PRICES: { heygen: 2500, xclip_motion: 3000, banana21: 600 },
    getSession: () => session, setSession: (_id: number, data: any) => Object.assign(session, data),
    requireLogin: async () => true, getCooldownRemainingMs: () => 0, formatCooldown: () => '',
    formatRupiah: (price: number) => `${price}`,
    Markup: { button: { callback: (text: string, data: string) => ({ text, data }) }, inlineKeyboard: (rows: any) => ({ rows }) },
    runHarModel: async (...args: any[]) => { runs.push(args); },
    console: { error() {} },
  });
  async function execute(from: string, to: string, prelude = '') {
    const a = bot.indexOf(from), b = bot.indexOf(to, a + from.length);
    assert.ok(a >= 0 && b > a, `Missing handler ${from}`);
    await vm.runInContext(compile(`(async () => { const userId = ctx.from.id, session = getSession(userId); ${prelude}\n${bot.slice(a, b)} })()`), sandbox);
  }
  await execute(
    "  if (data.startsWith('mode_har_') && Object.hasOwn(HAR_MODELS, data.slice(9))) {",
    "  if (data === 'mode_klingp4') {", `const data = 'mode_har_${model}';`
  );
  assert.equal(session.mode, 'har_wait_ratio');
  await execute("  if (data.startsWith('har_ratio_')) {", "  if (data === 'mode_klingp4') {", "const data = 'har_ratio_916';");
  assert.equal(session.mode, cfg.needsImage ? 'har_wait_image' : 'har_wait_prompt');
  const photoStart = bot.indexOf("  if (session.mode.startsWith('har_wait_')) {");
  const videoStart = bot.indexOf("  if (session.mode.startsWith('har_wait_')) {", photoStart + 1);
  const docStart = bot.indexOf("  if (session.mode.startsWith('har_wait_')) {\n    const draft = getSession(userId);", videoStart + 1);
  if (cfg.needsImage) {
    ctx.message = documents ? { document: { file_id: 'image_id', mime_type: 'image/png', file_size: 1000 } }
      : { photo: [{ file_id: 'image_id', file_size: 1000 }] };
    const a = documents ? docStart : photoStart;
    const marker = documents ? "  if (session.mode === 'klingp4_wait_prompt') {" : "  if (session.mode === 'klingp4_wait_prompt' ||";
    const b = bot.indexOf(marker, a);
    await vm.runInContext(compile(`(async()=> { const userId=ctx.from.id, session=getSession(userId), doc=ctx.message.document; ${bot.slice(a, b)} })()`), sandbox);
  }
  if (cfg.needsVideo) {
    assert.equal(session.mode, 'har_wait_video');
    ctx.message = documents ? { document: { file_id: 'video_id', mime_type: 'video/mp4', file_size: 1000 } }
      : { video: { file_id: 'video_id', file_size: 1000, duration: 10 } };
    const a = documents ? docStart : videoStart;
    const b = bot.indexOf(documents ? "  if (session.mode === 'klingp4_wait_prompt') {" : "  if (session.mode === 'klingp4_wait_video' &&", a);
    await vm.runInContext(compile(`(async()=> { const userId=ctx.from.id, session=getSession(userId), vid=ctx.message.video, doc=ctx.message.document; ${bot.slice(a, b)} })()`), sandbox);
  }
  assert.equal(session.mode, 'har_wait_prompt');
  ctx.message = { text: 'make a cool pose' };
  await execute("  if (session.mode === 'har_wait_prompt') {", "  if (session.mode === 'klingp4_wait_prompt') {");
  await execute("  if (session.mode === 'har_wait_prompt') {", "  if (session.mode === 'klingp4_wait_prompt') {");
  assert.equal(runs.length, 1, 'Duplicate prompts must not start a second paid job');
  assert.equal(runs[0][5].model, model);
  assert.equal(runs[0][5].imageFileId, cfg.needsImage ? 'image_id' : undefined);
  assert.equal(runs[0][5].videoFileId, cfg.needsVideo ? 'video_id' : undefined);
}

async function main() {
  for (const model of Object.keys(HAR_MODELS) as HarModelKey[]) {
    await testBackend(model);
    await testWizard(model);
    for (const outcome of ['success', 'delivery', 'provider', 'insufficient'] as const) await testBilling(model, outcome);
  }
  await testWizard('xclip_motion', true);
  await testWizard('banana21_i2i', true);
  for (const error of ['poll-auth', 'no-url', 'timeout', 'get-transient'] as const) await testBackend('heygen', error);
  console.log('Heygen, Xclip Motion and Banana 2.1 contracts, wizards, billing/refunds and no-resubmit tests passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });

async function testBilling(model: HarModelKey, outcome: 'success' | 'delivery' | 'provider' | 'insufficient') {
  const cfg = HAR_MODELS[model];
  const prices = { heygen: 2500, xclip_motion: 3000, banana21: 600 };
  const events = { charges: [] as number[], refunds: [] as number[], releases: 0, successes: 0, generations: 0 };
  const start = bot.indexOf('async function runHarModel(');
  const end = bot.indexOf('// ─── Background: Kling MC V3 Pro P4', start);
  const delivered = async (_chat: number, _url: string, caption: string) => {
    assert.ok(caption.includes(cfg.label));
    assert.doesNotMatch(caption, /picsart/i);
    return outcome === 'success';
  };
  const ctx = vm.createContext({
    HAR_MODELS, MODEL_PRICES: prices,
    beginCharge: async (_id: number, amount: number, limit: number) => {
      assert.equal(limit, 3); events.charges.push(amount);
      return { ok: outcome !== 'insufficient', reason: 'insufficient' };
    },
    chargeFailMsg: () => 'Insufficient balance',
    bot: { telegram: {
      getFileLink: async (id: string) => ({ href: `https://example.test/${id}` }),
      editMessageText: async () => {}, deleteMessage: async () => {}, sendMessage: async () => {},
    } },
    downloadBuffer: async () => ({ buf: Buffer.from('fixture'), mime: 'image/png', ext: 'png' }),
    sharp: () => ({ metadata: async () => ({ format: 'png' }) }),
    detectVideoType: () => ({ mime: 'video/mp4', ext: 'mp4' }),
    picsart: { generateHarModel: async (input: any) => {
      events.generations++;
      assert.equal(input.model, model);
      assert.equal(Boolean(input.image), cfg.needsImage);
      assert.equal(Boolean(input.video), cfg.needsVideo);
      if (outcome === 'provider') throw Error('PICSART_ACCEPTED_JOB_FAILED');
      return { url: cfg.video ? video : image };
    } },
    sendResult: delivered, sendImageResult: delivered,
    addSaldo: async (_id: number, amount: number) => { events.refunds.push(amount); },
    releaseGenerating: () => { events.releases++; },
    markGenSuccess: () => { events.successes++; },
    formatRupiah: (amount: number) => `${amount}`,
    describeError: (error: any) => error.message,
    console: { error() {} },
  });
  vm.runInContext(compile(bot.slice(start, end)), ctx);
  await ctx.runHarModel(1, 2, 3, 4, 'pose', {
    model, ratio: '9:16', imageFileId: cfg.needsImage ? 'image_id' : undefined,
    videoFileId: cfg.needsVideo ? 'video_id' : undefined,
  });
  assert.deepEqual(events.charges, [prices[cfg.priceKey]]);
  assert.deepEqual(events.refunds, ['delivery', 'provider'].includes(outcome) ? [prices[cfg.priceKey]] : []);
  assert.equal(events.releases, outcome === 'insufficient' ? 0 : 1);
  assert.equal(events.generations, outcome === 'insufficient' ? 0 : 1);
  assert.equal(events.successes, outcome === 'success' ? 1 : 0);
}
