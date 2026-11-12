import assert from 'node:assert/strict';
import * as referenceLabels from '../src/seedance-reference-labels';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { Telegraf } from 'telegraf';
import sharp from 'sharp';
import { execFileSync } from 'node:child_process';
import { inspectSeedance25Media } from '../src/seedance25-media';
import { createSeedance25P2Bot } from '../src/seedance25-edan-bot';
import {
  SEEDANCE25_P2, generateSeedance25P2, seedance25P2Request, validateP2References,
  type P2ProviderDeps, type P2Reference,
} from '../src/seedance25-edan';
import { validateSeedance25Prompt } from '../src/seedance25-prompt';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
const compile = (s: string) => ts.transpileModule(s, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function fn(name: string) {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name); return compile(node.getText(ast));
}
const refs: P2Reference[] = [
  { kind: 'image', fileId: 'image', size: 10, order: 1 },
  { kind: 'video', fileId: 'video', size: 20, duration: 15.104, order: 2 },
];
const assets = [{ kind: 'image' as const, url: 'https://example.test/image.png' },
  { kind: 'video' as const, url: 'https://example.test/reference.mp4' }];
const auth = () => Object.assign(Error('private upstream error'), { response: { status: 401 } });

async function providerTests() {
  assert.deepEqual(seedance25P2Request('Move like reference', '16:9', assets), {
    model: 'seedance-2.5', fields: {
      prompt: 'Move like reference', aspect_ratio: '16:9', duration: 30, resolution: '720p',
      reference_images: [assets[0].url], reference_videos: [assets[1].url],
    },
  });
  for (const bad of [[], [refs[0], refs[0]], [{ ...refs[1], duration: 31 }],
    [{ ...refs[1], duration: 1 }], [{ ...refs[0], size: SEEDANCE25_P2.maxBytes + 1 }],
    Array.from({ length: 11 }, (_, i) => ({ ...refs[0], fileId: String(i) }))]) {
    assert.throws(() => validateP2References(bad));
  }
  assert.throws(() => seedance25P2Request('move', '4:3' as any, assets));
  const tenImages = Array.from({ length: 10 }, (_, i) => ({ ...refs[0], fileId: `image-${i}` }));
  const tenVideos = Array.from({ length: 10 }, (_, i) => ({ ...refs[1], fileId: `video-${i}`, duration: 3 }));
  validateP2References([...tenImages, ...tenVideos]);
  const twentyAssets = [...tenImages, ...tenVideos].map(r => ({
    kind: r.kind, url: `https://example.test/${r.fileId}`,
  }));
  const mixed = seedance25P2Request('Ten images and ten videos', '16:9', twentyAssets);
  assert.equal(mixed.fields.reference_images.length, 10);
  assert.equal(mixed.fields.reference_videos.length, 10);
  for (const extra of [{ ...refs[0], fileId: 'image-eleven' }, { ...refs[1], fileId: 'video-eleven', duration: 2 }]) {
    assert.throws(() => validateP2References([...tenImages, ...tenVideos, extra]), /10 gambar, 10 video, dan 10 audio/);
    assert.throws(() => seedance25P2Request('Too many', '16:9', [
      ...twentyAssets, { kind: extra.kind, url: 'https://example.test/extra' },
    ]));
  }
  assert.throws(() => seedance25P2Request('move', '9:16', [{ kind: 'video', url: 'file:///private' }]));
  for (const failure of ['none', 'upload-auth', 'submit-auth', 'upload-500', 'submit-timeout', 'missing-id', 'poll-auth', 'poll-failed']) {
    const events = { uploads: 0, submits: 0, polls: 0, dead: [] as number[] };
    const deps: P2ProviderDeps = {
      cookies: async () => [{ id: 1, cookie: 'test-one' }, { id: 2, cookie: 'test-two' }],
      markDead: async id => { events.dead.push(id); },
      upload: async (cookie, ref) => {
        events.uploads++;
        if (failure === 'upload-auth' && cookie === 'test-one') throw auth();
        if (failure === 'upload-500') throw Error('upload failed');
        return { kind: ref.kind, url: `https://example.test/${ref.fileId}` };
      },
      submit: async (cookie, body) => {
        events.submits++; assert.equal(body.fields.duration, 30);
        if (failure === 'submit-auth' && cookie === 'test-one') throw auth();
        if (failure === 'submit-timeout') throw Error('ETIMEDOUT');
        return failure === 'missing-id' ? '' : 'accepted';
      },
      poll: async (_cookie, id) => {
        events.polls++; assert.equal(id, 'accepted');
        if (failure === 'poll-auth') throw auth();
        if (failure === 'poll-failed') throw Error('paid job failed');
        return 'https://example.test/result.mp4';
      },
    };
    const result = generateSeedance25P2('move', '16:9', refs, deps);
    if (['none', 'upload-auth', 'submit-auth'].includes(failure)) await result;
    else await assert.rejects(result);
    assert.equal(events.submits, failure === 'upload-500' ? 0 : failure === 'submit-auth' ? 2 : 1, failure);
    if (failure.startsWith('poll-')) assert.deepEqual(events.dead, failure === 'poll-auth' ? [1] : []);
    if (failure === 'submit-timeout' || failure === 'missing-id') assert.equal(events.polls, 0);
  }
}

function uiHarness() {
  const sessions = new Map<number, any>([[1, { mode: 'idle', dbUserId: 77 }], [2, { mode: 'idle', dbUserId: 88 }]]);
  const jobs: any[] = [], replies: string[] = [], downloads: number[] = [];
  let bytes = Buffer.from('file'), duration = 15.104, gate = Promise.resolve(), badFile = false;
  const context = vm.createContext({
    sessions, generating: new Map(), MAX_PARALLEL_GENERATIONS_PER_USER: 3,
    GENERATION_DRAFT_MODES: new Set(['s25p2_wait_ratio', 's25p2_wait_media', 's25p2_wait_prompt']),
    requireLogin: async () => true,
  });
  for (const name of ['getSession', 'setSession', 'generationDraftKindForStart', 'generationDraftKindForContinuation',
    'generationDraftBlockReason', 'reserveGenerationDraft', 'isGenerationEntryCallback', 'replyGenerationDraftBlock']) {
    vm.runInContext(fn(name), context);
  }
  const ui = createSeedance25P2Bot({
    getSession: context.getSession, setSession: context.setSession, price: () => 7500, cooldown: () => 0,
    download: async (_id, max) => { downloads.push(max); await gate; if (badFile) throw Error('private URL'); return bytes; },
    inspect: async (_bytes, kind) => kind === 'video' ? { duration } : {},
    run: async job => { jobs.push(job); },
  });
  context.seedance25P2Bot = ui;
  const bot = new Telegraf('fake-token-not-used');
  bot.botInfo = { id: 123, is_bot: true, first_name: 'Test', username: 'test_bot',
    can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false };
  bot.use(async (ctx: any, next) => {
    ctx.reply = async (text: string) => { replies.push(text); return { message_id: 99 }; };
    ctx.editMessageText = ctx.reply; ctx.answerCbQuery = async () => true;
    return next();
  });
  context.bot = bot;
  const callback = ast.statements.find(n => n.getText(ast).startsWith("bot.on('callback_query',"));
  const middleware = ast.statements.find(n => n.getText(ast).startsWith('bot.use(async (ctx, next)')
    && n.getText(ast).includes(".startsWith('s25p2_')"));
  assert.ok(callback && middleware);
  vm.runInContext(compile(middleware.getText(ast)), context);
  vm.runInContext(compile(callback.getText(ast)), context);
  let counter = 0;
  function update(message?: any, data?: string, userId = 1) {
    const from = { id: userId, is_bot: false, first_name: 'Test' };
    const base = { message_id: ++counter, date: 1, chat: { id: userId, type: 'private' }, from };
    return bot.handleUpdate(data ? { update_id: counter, callback_query: {
      id: String(counter), from, chat_instance: 'test', message: base, data,
    } } as any : { update_id: counter, message: { ...base, ...message } } as any);
  }
  const token = () => sessions.get(1).seedance25P2.id;
  return {
    sessions, jobs, replies, downloads, token,
    callback: (data: string, userId = 1) => update(undefined, data, userId),
    message: (message: any, userId = 1) => update(message, undefined, userId),
    body: (b: Buffer) => { bytes = b; },
    duration: (d: number) => { duration = d; },
    bad: () => { badFile = true; },
    block: () => { let release!: () => void; gate = new Promise<void>(r => { release = r; }); return release; },
    start: async () => { await update(undefined, 'mode_seedance25_p2'); await update(undefined, `s25p2_ratio_169:${token()}`); },
    done: () => update(undefined, `s25p2_done:${token()}`),
  };
}

async function uiTests() {
  const h = uiHarness(); await h.start();
  assert.match(h.replies.join(' '), /7\.500/);
  const draftId = h.token();
  await h.callback('mode_oneover_seedance25'); // Actual shared reservation blocks switching mid-draft.
  assert.equal(h.token(), draftId);
  await h.done(); assert.equal(h.sessions.get(1).mode, 's25p2_wait_media');
  await h.callback('s25p2_done:stale'); assert.equal(h.sessions.get(1).mode, 's25p2_wait_media');
  const release = h.block();
  const image = h.message({ photo: [{ file_id: 'photo', file_unique_id: 'p', width: 1, height: 1 }] });
  // Give Telegraf its pre-handler awaits; then verify pending-upload gating.
  await new Promise(r => setImmediate(r));
  await h.done(); assert.equal(h.sessions.get(1).mode, 's25p2_wait_media');
  release(); await image;
  await h.message({ video: { file_id: 'video', file_unique_id: 'v', duration: 999, width: 1, height: 1 } });
  assert.equal(h.sessions.get(1).seedance25P2.refs[1].duration, 15.104, 'Ignore Telegram-reported duration');
  await h.message({ photo: [{ file_id: 'photo', file_unique_id: 'p', width: 1, height: 1 }] });
  assert.equal(h.sessions.get(1).seedance25P2.refs.length, 2);
  await h.done();
  const text = 'a'.repeat(19996) + '\nEND';
  h.body(Buffer.from('\ufeff' + text));
  await Promise.all([
    h.message({ document: { file_id: 'txt', file_unique_id: 't', file_name: 'PROMPT.TXT' } }),
    h.message({ document: { file_id: 'txt', file_unique_id: 't', file_name: 'PROMPT.TXT' } }),
  ]);
  assert.equal(h.jobs.length, 1); assert.equal(h.jobs[0].prompt, text);
  assert.equal(h.jobs[0].refs.length, 2); assert.equal(h.jobs[0].ratio, '16:9');
  assert.equal(h.sessions.get(1).generationDraft, false);
  const body = seedance25P2Request(h.jobs[0].prompt, h.jobs[0].ratio, assets);
  assert.equal(body.fields.prompt, text);
  assert.equal(body.fields.reference_videos.length, 1);
  assert.equal(h.sessions.get(2).mode, 'idle');
  assert.doesNotMatch(h.replies.join(' '), /edanbot|picsart|renderful|private URL/i);
  await h.start(); await h.callback(`s25p2_ratio_916:${draftId}`);
  assert.equal(h.sessions.get(1).seedance25P2.ratio, '16:9');
  const cancelled = uiHarness(); await cancelled.start();
  const finish = cancelled.block();
  const pending = cancelled.message({ video: { file_id: 'v', file_unique_id: 'v', duration: 5, width: 1, height: 1 } });
  await new Promise(r => setImmediate(r));
  cancelled.sessions.set(1, { mode: 'idle', dbUserId: 77 }); finish(); await pending;
  assert.equal(cancelled.sessions.get(1).mode, 'idle'); assert.equal(cancelled.jobs.length, 0);
  const limits = uiHarness(); await limits.start();
  await limits.message({ document: { file_id: 'huge', file_unique_id: 'h', file_name: 'x.mp4', file_size: SEEDANCE25_P2.maxBytes + 1 } });
  assert.equal(limits.downloads.length, 0);
  limits.duration(31);
  await limits.message({ video: { file_id: 'long', file_unique_id: 'l', width: 1, height: 1, duration: 2 } });
  assert.equal(limits.sessions.get(1).seedance25P2.refs.length, 0);
  assert.equal(limits.sessions.get(1).seedance25P2.pending.length, 0);
}

async function billingTests() {
  const calls: any[][] = [], replies: string[] = [];
  let linkFailure = false;
  const context = vm.createContext({
    ...referenceLabels, SEEDANCE25_P2, validateP2References, validateSeedance25Prompt,
    MODEL_PRICES: { seedance25_p2: 7500 },
    retryTelegramFileRead: async (read: () => Promise<any>) => read(),
    runPicsartSeedance25: async (...args: any[]) => { calls.push(args); },
    bot: { telegram: {
      getFileLink: async (fileId: string) => {
        if (linkFailure) throw Error('Telegram file link unavailable');
        return { href: `https://telegram.example.test/${fileId}` };
      },
      editMessageText: async (...args: any[]) => { replies.push(args[3]); },
    } },
  });
  vm.runInContext(fn('runSeedance25P2'), context);
  await context.runSeedance25P2({
    chatId: 1, userId: 1, dbUserId: 77, statusMsgId: 9,
    prompt: 'move', ratio: '16:9', refs,
  });
  assert.equal(calls.length, 1);
  const args = calls[0];
  assert.deepEqual(args.slice(0, 5), [1, 1, 77, 9, 'move']);
  assert.deepEqual(JSON.parse(JSON.stringify(args[5])), ['https://telegram.example.test/image']);
  assert.deepEqual(JSON.parse(JSON.stringify(args[6])), {
    provider: 'picsart', mode: 'reference', resolution: 1080, audio: true, ratio: '16:9',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(args[7])), [{
    url: 'https://telegram.example.test/video', mime: 'video/mp4', duration: 15.104,
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(args[8])), []);
  assert.equal(args[9], 7500, 'P2 uses its updated charge on the P1 provider route');
  assert.equal(args[10], 'Seedance 2.5 P2');

  await context.runSeedance25P2({
    chatId: 1, userId: 1, dbUserId: 77, statusMsgId: 9,
    prompt: 'move', ratio: '16:9', refs: [],
  });
  assert.equal(calls.length, 1, 'invalid references must not reach the paid P1 runner');
  assert.match(replies.join(' '), /Saldo tidak dipotong/);
  linkFailure = true;
  await context.runSeedance25P2({
    chatId: 1, userId: 1, dbUserId: 77, statusMsgId: 9,
    prompt: 'move', ratio: '16:9', refs,
  });
  assert.equal(calls.length, 1, 'Telegram download-link failures must happen before charge');
  const runner = fn('runSeedance25P2');
  assert.match(runner, /runPicsartSeedance25/);
  assert.doesNotMatch(runner, /generateSeedance25P2|edanbot|720p|upscaleGeneratedVideo/);
  assert.ok(source.includes('seedance25_p2: 7500'));
  assert.ok(source.includes("mode_oneover_seedance25: 'oneover'"));
}

async function tenPlusTenTests() {
  for (const input of ['text', 'txt']) {
    const h = uiHarness(); await h.start(); h.duration(3);
    assert.match(h.replies.join(' '), /10 gambar, 10 video, dan 10 audio/);
    await Promise.all(Array.from({ length: 10 }, (_, i) =>
      h.message({ photo: [{ file_id: `photo-${i}`, file_unique_id: `p-${i}`, width: 1, height: 1 }] })));
    await Promise.all(Array.from({ length: 10 }, (_, i) =>
      h.message({ video: { file_id: `video-${i}`, file_unique_id: `v-${i}`, duration: 3, width: 1, height: 1 } })));
    const draft = h.sessions.get(1).seedance25P2;
    assert.equal(draft.refs.length, 20);
    assert.equal(draft.pending.length, 0);
    const count = h.downloads.length;
    await h.message({ photo: [{ file_id: 'photo-eleven', file_unique_id: 'p-eleven', width: 1, height: 1 }] });
    await h.message({ video: { file_id: 'video-eleven', file_unique_id: 'v-eleven', duration: 2, width: 1, height: 1 } });
    assert.equal(h.downloads.length, count, 'Reject reference eleven of either kind before downloading');
    assert.equal(h.sessions.get(1).seedance25P2.refs.length, 20);
    await h.done();
    if (input === 'text') await h.message({ text: 'Prompt for all twenty references' });
    else {
      h.body(Buffer.from('Prompt for all twenty references'));
      await h.message({ document: { file_id: 'txt', file_unique_id: 't', file_name: 'prompt.txt' } });
    }
    assert.equal(h.jobs.length, 1);
    assert.equal(h.jobs[0].refs.filter((r: P2Reference) => r.kind === 'image').length, 10);
    assert.equal(h.jobs[0].refs.filter((r: P2Reference) => r.kind === 'video').length, 10);
    assert.equal(h.jobs[0].prompt, 'Prompt for all twenty references');
  }
}

async function adapterTests() {
  const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: 'white' } }).png().toBuffer();
  const video = execFileSync('ffmpeg', [
    '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=32x32:r=1', '-t', '2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov',
    '-f', 'mp4', 'pipe:1',
  ], { maxBuffer: 1024 * 1024 });
  let captured: any;
  const context = vm.createContext({
    Buffer, sharp, inspectSeedance25Media, SEEDANCE25_P2,
    createSeedance25P2Bot: (deps: any) => { captured = deps; return {}; },
    getSession() {}, setSession() {}, getCooldownRemainingMs: () => 0,
    bot: { telegram: {
      getFileLink: async (fileId: string) => new URL(`https://example.test/${fileId}`),
    } },
    telegramHttp: { get: async (url: string, options: any) => {
      assert.equal(options.maxContentLength, SEEDANCE25_P2.maxBytes);
      return { data: url.endsWith('/image') ? image : video };
    } },
    runSeedance25P2: async () => {},
  });
  const initialization = ast.statements.find(n => ts.isVariableStatement(n)
    && n.declarationList.declarations.some(d => d.name.getText(ast) === 'seedance25P2Bot'));
  assert.ok(initialization);
  vm.runInContext(compile(initialization.getText(ast)), context);
  const downloadedImage = await captured.download('image', SEEDANCE25_P2.maxBytes);
  const downloadedVideo = await captured.download('video', SEEDANCE25_P2.maxBytes);
  assert.equal(downloadedImage.length, image.length);
  assert.equal(downloadedVideo.length, video.length);
  assert.equal(Object.keys(await captured.inspect(image, 'image')).length, 0);
  const metadata = await captured.inspect(video, 'video');
  assert.equal(metadata.duration, 2);
  await assert.rejects(captured.inspect(Buffer.from('not an mp4'), 'video'));
  await assert.rejects(captured.inspect(Buffer.from('not an image'), 'image'));
}

async function main() {
  await providerTests(); await uiTests(); await tenPlusTenTests(); await billingTests(); await adapterTests();
  console.log('PASS Seedance 2.5 P2: mixed references/TXT, Picsart P1 route, Rp7500/30s, mandatory 1080p finishing and full refunds.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
