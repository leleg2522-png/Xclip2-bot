import assert from 'node:assert/strict';
import * as referenceLabels from '../src/seedance-reference-labels';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { Telegraf } from 'telegraf';
import { retryTelegramFileRead } from '../src/telegram-file-retry';
import { retryTelegramRateLimit } from '../src/telegram-rate-limit';
import * as limits from '../src/seedance25-picsart';
import {
  SEEDANCE25_MAX_TXT_BYTES, validateSeedance25Prompt,
  validateSeedance25TxtDocument, decodeSeedance25Txt,
} from '../src/seedance25-prompt';
import { validateSeedance25Request, type Seedance25Settings } from '../src/seedance25-picsart';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
function functionCode(name: string, file = ast) {
  const node = file.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name);
  return ts.transpileModule(node.getText(file).replace(/^export /, ''), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}
const helpers = functionCode('submitSeedance25Prompt') + functionCode('handleSeedance25Txt');
const settings: Seedance25Settings = {
  provider: 'picsart', mode: 't2v', audio: true, ratio: '9:16', resolution: 1080,
};

function checkDecoding() {
  assert.equal(decodeSeedance25Txt(Buffer.from('Full scene\n\nCamera: push in.\nDialogue: "Halo."\n')), 'Full scene\n\nCamera: push in.\nDialogue: "Halo."');
  assert.equal(decodeSeedance25Txt(Buffer.from('\ufeff中文 prompt 🎥\r\nBaris kedua')), '中文 prompt 🎥\r\nBaris kedua');
  assert.equal(decodeSeedance25Txt(Buffer.from('a'.repeat(20000))).length, 20000);
  assert.equal(decodeSeedance25Txt(Buffer.from('界'.repeat(20000))).length, 20000);
  for (const bytes of [
    Buffer.alloc(0), Buffer.from(' \r\n\t'), Buffer.from('\ufeff'),
    Buffer.from([0xc3, 0x28]), Buffer.from([0xff, 0xfe, 0x61, 0]),
    Buffer.from('binary\0file'), Buffer.from('a'.repeat(20001)),
    Buffer.alloc(SEEDANCE25_MAX_TXT_BYTES + 1),
  ]) assert.throws(() => decodeSeedance25Txt(bytes));
  assert.throws(() => validateSeedance25Prompt('a'.repeat(20001)));
  for (const file of [
    { file_name: 'script.txt' }, { file_name: 'script.TXT', file_size: 60003 },
    { file_name: 'prompt.txt', file_size: SEEDANCE25_MAX_TXT_BYTES },
  ]) validateSeedance25TxtDocument(file);
  for (const file of [
    {}, { file_name: 'script.pdf' }, { file_name: 'script.txt.exe' },
    { file_name: 'script.txt', file_size: SEEDANCE25_MAX_TXT_BYTES + 1 },
  ]) assert.throws(() => validateSeedance25TxtDocument(file));
}

function harness() {
  let session: any = {
    mode: 'oneover_wait_prompt', seedance25Step: 'prompt', dbUserId: 101,
    seedance25Settings: { ...settings }, seedance25ImageFileIds: [],
    seedance25Videos: [], seedance25Audios: [],
  };
  let body = Buffer.from('complete prompt'), failed = false, cooldown = 0;
  let gate: Promise<void> = Promise.resolve();
  const jobs: any[][] = [], messages: string[] = [], downloads: any[] = [];
  const linkErrors: any[] = [], replyErrors: any[] = [], waits: number[] = [];
  const getFileLink = async (fileId: string) => {
    if (linkErrors.length) throw linkErrors.shift();
    return { href: `https://example.test/${fileId}` };
  };
  const context = vm.createContext({
    Buffer, ...referenceLabels, SEEDANCE25_MAX_TXT_BYTES, validateSeedance25Prompt,
    retryTelegramFileRead: (fn: any) => retryTelegramFileRead(fn, async ms => { waits.push(ms); }),
    retryTelegramRateLimit: (fn: any) => retryTelegramRateLimit(fn, async ms => { waits.push(ms); }),
    validateSeedance25TxtDocument, decodeSeedance25Txt, validateSeedance25Request,
    getSession: () => session,
    setSession: (_: number, update: any) => { session = { ...session, ...update }; },
    requireLogin: async () => true, getCooldownRemainingMs: () => cooldown, formatCooldown: () => '10 detik',
    telegramHttp: { get: async (url: string, options: any) => {
      downloads.push({ url, options }); await gate;
      if (failed) throw Error('URL containing secret must not be shown');
      return { data: body };
    } },
    bot: { telegram: { getFileLink } },
    runPicsartSeedance25: async (...args: any[]) => { jobs.push(args); },
    console: { warn() {}, error: () => { throw Error('Must not log Telegram download errors'); } },
  });
  vm.runInContext(helpers, context);
  const ctx = {
    from: { id: 1 }, chat: { id: 2 }, telegram: { getFileLink },
    message: { document: { file_id: 'script', file_name: 'script.txt' } },
    reply: async (message: string) => {
      if (replyErrors.length) throw replyErrors.shift();
      messages.push(message); return { message_id: 99 };
    },
  };
  return {
    session: () => session, jobs, messages, downloads, linkErrors, replyErrors, waits,
    set: (update: any) => { session = { ...session, ...update }; },
    body: (value: Buffer) => { body = value; }, fail: () => { failed = true; },
    cooldown: () => { cooldown = 10000; },
    block: () => { let release!: () => void; gate = new Promise<void>(resolve => { release = resolve; }); return release; },
    file: (doc: any = {}) => context.handleSeedance25Txt({ ...ctx, message: { document: { ...ctx.message.document, ...doc } } }),
    text: (prompt: string) => context.submitSeedance25Prompt(ctx, prompt),
  };
}

async function checkFlow() {
  const longPrompt = 'Opening: slow push-in.\n' + 'Continuous detailed action. '.repeat(300);
  const h = harness(); h.body(Buffer.from(longPrompt));
  const chosen = h.session().seedance25Settings;
  await h.file();
  assert.equal(h.jobs.length, 1);
  assert.equal(h.jobs[0][4], longPrompt.trim(), 'Send complete decoded text, not a filename, URL, summary, or truncated prompt');
  assert.equal(h.jobs[0][6], chosen);
  assert.equal(h.session().mode, 'idle');
  assert.equal(h.downloads[0].options.maxContentLength, SEEDANCE25_MAX_TXT_BYTES);
  await h.file(); await h.text('another');
  assert.equal(h.jobs.length, 1, 'Consumed draft cannot submit again');

  const mixed = harness();
  mixed.set({
    seedance25Settings: { ...settings, mode: 'reference' }, seedance25ImageFileIds: ['i'],
    seedance25Videos: [{ fileId: 'v', mime: 'video/mp4', duration: 3 }],
    seedance25Audios: [{ fileId: 'a', mime: 'audio/ogg', duration: 2 }],
  });
  await mixed.file({ file_name: 'scene.TXT', mime_type: 'application/octet-stream' });
  assert.deepEqual(Array.from(mixed.jobs[0][5]), ['https://example.test/i']);
  assert.equal(mixed.jobs[0][7][0].url, 'https://example.test/v');
  assert.equal(mixed.jobs[0][8][0].url, 'https://example.test/a');
  assert.equal(mixed.jobs[0][8][0].mime, 'audio/ogg');

  for (const bytes of [Buffer.alloc(0), Buffer.from('x'.repeat(20001)), Buffer.from([0xff]), Buffer.from('\0')]) {
    const bad = harness(); bad.body(bytes); await bad.file();
    assert.equal(bad.jobs.length, 0); assert.equal(bad.session().mode, 'oneover_wait_prompt');
    bad.body(Buffer.from('corrected')); await bad.file(); assert.equal(bad.jobs.length, 1);
  }
  const wrong = harness(); await wrong.file({ file_name: 'wrong.pdf' });
  assert.equal(wrong.downloads.length, 0); assert.equal(wrong.session().mode, 'oneover_wait_prompt');
  await wrong.file({ file_size: SEEDANCE25_MAX_TXT_BYTES + 1 });
  assert.equal(wrong.downloads.length, 0);
  const failed = harness(); failed.fail(); await failed.file();
  assert.equal(failed.jobs.length, 0); assert.equal(failed.session().mode, 'oneover_wait_prompt');
  assert.ok(!failed.messages.join('').includes('secret'));
  const cool = harness(); cool.cooldown(); await cool.file(); assert.equal(cool.jobs.length, 0);

  const cancelled = harness(); const unblock = cancelled.block();
  const old = cancelled.file(); cancelled.set({ mode: 'idle' }); unblock(); await old;
  assert.equal(cancelled.jobs.length, 0);
  const switched = harness(); const release = switched.block();
  const oldFile = switched.file();
  const newSettings = { ...settings, ratio: '16:9' };
  switched.set({ seedance25Settings: newSettings }); release(); await oldFile;
  assert.equal(switched.jobs.length, 0); assert.equal(switched.session().seedance25Settings, newSettings);
  const race = harness();
  await Promise.all([race.file(), race.file()]); assert.equal(race.jobs.length, 1);
  const textRace = harness(); const resume = textRace.block();
  const file = textRace.file(); await textRace.text('plain text wins'); resume(); await file;
  assert.equal(textRace.jobs.length, 1); assert.equal(textRace.jobs[0][4], 'plain text wins');
  const plain = harness(); await plain.text('regular text');
  assert.equal(plain.jobs[0][4], 'regular text');
  const otherModel = harness(); otherModel.set({ mode: 'kling_wait_prompt' });
  await otherModel.file(); assert.equal(otherModel.downloads.length, 0);

  assert.match(source, /if \(session.mode === 'oneover_wait_prompt'\) return handleSeedance25Txt\(ctx\);/);
  assert.match(source, /return submitSeedance25Prompt\(ctx, ctx.message.text\);/);
  assert.match(source, /Kirim prompt sebagai pesan teks atau file \.txt UTF-8/);
}

async function checkDocumentToProviderPayload() {
  // Use the actual Telegraf document registration and real orchestration/submit
  // functions. Only Telegram/Picsart transport, account selection and finishing
  // are simulated. This deliberately spends no upstream credits.
  const providerSource = readFileSync(new URL('../src/picsart.ts', import.meta.url), 'utf8');
  const providerAst = ts.createSourceFile('picsart.ts', providerSource, ts.ScriptTarget.Latest, true);
  const registration = ast.statements.find(n => n.getText(ast).startsWith("bot.on('document',"));
  assert.ok(registration);
  const tail = '\nFINAL_MARKER_20000';
  const prompt = '界'.repeat(20000 - tail.length) + tail;
  assert.equal(prompt.length, 20000);
  const bytes = Buffer.from(prompt);
  const bot = new Telegraf('not-a-real-token');
  bot.botInfo = { id: 123, is_bot: true, first_name: 'Test', username: 'test_bot',
    can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false };
  const session: any = {
    mode: 'oneover_wait_prompt', dbUserId: 101, seedance25Settings: { ...settings },
    seedance25ImageFileIds: [], seedance25Videos: [], seedance25Audios: [],
  };
  let current = session, posted: any, pipeline: Promise<unknown> | undefined;
  const charges: number[] = [], refunds: number[] = [], deliveries: string[] = [];
  let submitCount = 0, finishCount = 0;
  bot.use(async (ctx: any, next) => {
    ctx.reply = async () => ({ message_id: 99 });
    ctx.telegram.getFileLink = async () => new URL('https://example.test/prompt.txt');
    return next();
  });
  const context = vm.createContext({
    Buffer, ...limits, ...referenceLabels, bot, SEEDANCE25_MAX_TXT_BYTES,
    retryTelegramFileRead, retryTelegramRateLimit,
    validateSeedance25Prompt, validateSeedance25TxtDocument, decodeSeedance25Txt,
    getSession: () => current,
    setSession: (_: number, update: any) => { current = { ...current, ...update }; },
    requireLogin: async () => true, getCooldownRemainingMs: () => 0,
    telegramHttp: { get: async () => ({ data: bytes }) },
    MODEL_PRICES: { picsart_seedance_25: 15000 }, MAX_PARALLEL_GENERATIONS_PER_USER: 3,
    beginCharge: async (_: number, amount: number) => { charges.push(amount); return { ok: true }; },
    addSaldo: async (_: number, amount: number) => { refunds.push(amount); },
    releaseGenerating() {}, incrementKlingUsage: async () => 1, markGenSuccess() {},
    upscaleGeneratedVideo: async () => { finishCount++; return { url: 'https://example.test/1080.mp4', upscaled: true }; },
    sendResult: async (_: number, url: string) => { deliveries.push(url); return true; },
    SEEDANCE_MAX_REF_IMAGES: 30, SEEDANCE_MAX_REF_VIDEOS: 10, SEEDANCE_MAX_REF_AUDIOS: 10,
    SEEDANCE_MODEL: 'seedance_2_5', SEEDANCE_MIN_CREDITS: { '480p': { 30: 130 } },
    API_BASE: 'https://example.test', X_APP_AUTHORIZATION: 'test',
    runWithAccount: async (_: number, __: unknown, run: any) => run(1),
    getCredits: async () => ({ credits: 500 }), getAccessToken: async () => 'test',
    commonHeaders: (value: unknown) => value, ok2xx: (status: number) => status >= 200 && status < 300,
    http: { post: async (_: string, body: any) => {
      submitCount++; posted = JSON.parse(JSON.stringify(body));
      return { status: 200, data: { response: { id: 'accepted-test-job' } } };
    } },
    pollSeedanceResult: async () => ({ url: 'https://example.test/480.mp4' }),
    describeError: (error: Error) => error.message, formatRupiah: (value: number) => `Rp${value}`,
    console: { log() {}, warn() {}, error(error: any) { throw Error(String(error)); } },
  });
  // The runner invokes these Telegram status methods independently of ctx.
  bot.telegram.editMessageText = async () => true as any;
  bot.telegram.deleteMessage = async () => true as any;
  vm.runInContext(helpers + functionCode('runPicsartSeedance25')
    + functionCode('generateSeedance', providerAst) + functionCode('submitSeedance', providerAst), context);
  context.picsart = { generateSeedance: context.generateSeedance };
  const runner = context.runPicsartSeedance25;
  context.runPicsartSeedance25 = (...args: any[]) => { pipeline = runner(...args); return pipeline; };
  vm.runInContext(ts.transpileModule(registration.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, context);
  const update: any = { update_id: 1, message: {
    message_id: 1, date: 1, chat: { id: 2, type: 'private' },
    from: { id: 1, is_bot: false, first_name: 'Test' },
    document: { file_id: 'script', file_unique_id: 'unique', file_name: 'script.TXT',
      mime_type: 'text/plain', file_size: bytes.length },
  } };
  await bot.handleUpdate(update);
  assert.ok(pipeline, 'Actual document handler must reach the generation runner');
  await pipeline;
  const content = posted.params.content.find((item: any) => item.type === 'text');
  assert.equal(content.text, prompt);
  assert.equal(content.text.length, 20000);
  const metadata = posted.params.options.drive.attributes;
  assert.ok(!('prompt' in JSON.parse(metadata.aiSDKPayload)),
    'Do not duplicate long prompts into the separately limited Drive metadata');
  assert.ok(JSON.stringify(metadata).length < 20000);
  assert.equal(posted.params.resolution, '480p');
  assert.equal(posted.params.duration, 30);
  assert.equal(submitCount, 1); assert.equal(finishCount, 1);
  assert.deepEqual(charges, [15000]); assert.deepEqual(refunds, []);
  assert.deepEqual(deliveries, ['https://example.test/1080.mp4']);
  console.log('PASS actual Telegraf document route → full 20,000-character Picsart payload → simulated accepted job → mandatory 1080p delivery; one charge.');
}

async function main() {
  const rateLimit = () => Object.assign(Error('Too Many Requests'), {
    response: { error_code: 429, parameters: { retry_after: 8 } },
  });
  const retry = harness();
  retry.set({ seedance25Settings: { ...settings, mode: 'reference' }, seedance25ImageFileIds: ['ref'] });
  retry.linkErrors.push(rateLimit()); retry.replyErrors.push(rateLimit());
  await retry.text('A scene');
  assert.deepEqual(retry.waits, [8000, 8000]);
  assert.equal(retry.jobs.length, 1, '429 retries must never duplicate generation');
  assert.equal(retry.messages.length, 1);
  const invalid = harness();
  invalid.set({ seedance25Settings: { ...settings, mode: 'reference' }, seedance25ImageFileIds: ['ref'] });
  invalid.linkErrors.push(Object.assign(Error('invalid file'), { response: { error_code: 400 } }));
  invalid.replyErrors.push(rateLimit());
  await invalid.text('A scene');
  assert.deepEqual(invalid.waits, [8000]);
  assert.equal(invalid.jobs.length, 0, 'No paid generate after reference failure');
  assert.match(invalid.messages[0], /Referensi tidak bisa dibaca/);
  checkDecoding(); await checkFlow(); await checkDocumentToProviderPayload();
  console.log('PASS Seedance 2.5 TXT: strict UTF-8, full long prompt, bounds, retry, references, shared text/TXT claim, cancellation and isolation.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
