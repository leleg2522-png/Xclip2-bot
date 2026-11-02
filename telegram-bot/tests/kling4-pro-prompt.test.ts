import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { Telegraf } from 'telegraf';
import * as picsart from '../src/picsart';
import { KLING4_DURATIONS } from '../src/picsart-kling4';
import * as promptHelpers from '../src/kling4-pro-prompt';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
const compile = (text: string) => ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function fn(name: string) {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name);
  return compile(node.getText(ast));
}

function harness(model = 'kling_v4_frames') {
  let state: any = {
    mode: 'picsart_i2v_wait_prompt', dbUserId: 7, picsartI2vModel: model,
    picsartI2vDuration: 15, picsartI2vRatio: '16:9',
    picsartI2vImageUrls: model === 'kling_v4_frames'
      ? ['https://example.test/start.jpg', 'https://example.test/end.jpg']
      : ['https://example.test/start.jpg'],
  };
  let bytes = Buffer.from('Full prompt'), failed = false, cooldown = 0;
  let gate: Promise<void> = Promise.resolve();
  const jobs: any[][] = [], payloads: any[] = [], replies: string[] = [], downloads: any[] = [];
  const context = vm.createContext({
    Buffer, ...promptHelpers, picsart, KLING4_DURATIONS,
    getSession: () => state,
    setSession: (_: number, patch: any) => { state = { ...state, ...patch }; },
    requireLogin: async () => true,
    isPicsartI2vModelKey: (key: string) => key in picsart.PICSART_I2V_MODELS,
    getCooldownRemainingMs: () => cooldown, formatCooldown: () => '10 detik',
    telegramHttp: { get: async (_url: string, options: any) => {
      downloads.push(options);
      await gate;
      if (failed) throw Error('Telegram download containing secret URL');
      return { data: bytes };
    } },
    runPicsartI2v: async (...args: any[]) => {
      jobs.push(args);
      const opts = args[5];
      payloads.push(JSON.parse(JSON.stringify(picsart.buildPicsartI2vParams(
        opts.model, args[4], opts.imageUrls[0], opts,
      ))));
    },
    console: { error() { throw Error('Do not log secret-bearing download errors'); } },
  });
  vm.runInContext(fn('submitPicsartI2vPrompt') + fn('handleKling4ProTxt'), context);
  const ctx: any = {
    from: { id: 1 }, chat: { id: 2 },
    message: { document: { file_id: 'script', file_name: 'prompt.txt' } },
    telegram: { getFileLink: async () => new URL('https://example.test/prompt.txt') },
    reply: async (text: string) => { replies.push(text); return { message_id: 99 }; },
  };
  return {
    state: () => state, jobs, payloads, replies, downloads, context, ctx,
    set: (patch: any) => { state = { ...state, ...patch }; },
    body: (value: Buffer) => { bytes = value; },
    fail: () => { failed = true; },
    cooldown: () => { cooldown = 10000; },
    block: () => { let release!: () => void; gate = new Promise<void>(r => { release = r; }); return release; },
    file: (doc: any = {}) => context.handleKling4ProTxt({
      ...ctx, message: { document: { ...ctx.message.document, ...doc } },
    }),
    text: (text: string) => context.submitPicsartI2vPrompt(ctx, text),
  };
}

async function main() {
  const { decodeKling4ProTxt, validateKling4ProTxtDocument, KLING4_PRO_MAX_TXT_BYTES } = promptHelpers;
  assert.equal(decodeKling4ProTxt(Buffer.from('\ufeffHello\n\nWorld\r\n')), 'Hello\n\nWorld');
  assert.equal(decodeKling4ProTxt(Buffer.from('界'.repeat(11000))).length, 11000);
  for (const bytes of [Buffer.alloc(0), Buffer.from(' \t\n'), Buffer.from('\ufeff'),
    Buffer.from([0xc3, 0x28]), Buffer.from([0xff, 0xfe, 0x61, 0]), Buffer.from('binary\0data'),
    Buffer.from('a'.repeat(26001)), Buffer.from('界'.repeat(11001)), Buffer.alloc(KLING4_PRO_MAX_TXT_BYTES + 1)]) {
    assert.throws(() => decodeKling4ProTxt(bytes));
  }
  for (const doc of [{}, { file_name: 'a.pdf' }, { file_name: 'a.txt.exe' },
    { file_name: 'a.txt', file_size: -1 }, { file_name: 'a.txt', file_size: KLING4_PRO_MAX_TXT_BYTES + 1 }]) {
    assert.throws(() => validateKling4ProTxtDocument(doc));
  }
  const tail = '\nFULL_END_MARKER_1234';
  const long = 'a'.repeat(26000 - tail.length) + tail;
  assert.equal(long.length, 26000);
  for (const model of ['kling_v4_regular', 'kling_v4_frames']) {
    const h = harness(model);
    h.body(Buffer.from('\ufeff' + long));
    await h.file({ file_name: 'PROMPT.TXT', mime_type: 'application/octet-stream' });
    assert.equal(h.jobs.length, 1);
    assert.equal(h.jobs[0][4], long);
    const p = h.payloads[0];
    assert.equal(p.prompt, long, 'Complete decoded text must survive provider JSON serialization');
    assert.equal(p.model_name, 'kling-v4');
    assert.equal(p.image, 'https://example.test/start.jpg');
    assert.equal(p.image_tail, model === 'kling_v4_frames' ? 'https://example.test/end.jpg' : undefined);
    assert.equal(p.duration, '15'); assert.equal(p.aspect_ratio, '16:9');
    assert.equal(p.resolution, '720p');
    assert.ok(!('prompt' in JSON.parse(p.options.drive.attributes.aiSDKPayload)));
    assert.equal(h.downloads[0].maxContentLength, KLING4_PRO_MAX_TXT_BYTES);
    await h.file(); await h.text('duplicate');
    assert.equal(h.jobs.length, 1);
  }
  for (const bytes of [Buffer.alloc(0), Buffer.from('a'.repeat(26001)), Buffer.from([0xff]), Buffer.from('bad\0')]) {
    const h = harness(); h.body(bytes); await h.file();
    assert.equal(h.jobs.length, 0); assert.equal(h.state().mode, 'picsart_i2v_wait_prompt');
    assert.equal(h.state().picsartI2vImageUrls.length, 2);
    h.body(Buffer.from('Fixed')); await h.file(); assert.equal(h.jobs.length, 1);
  }
  const invalid = harness(); await invalid.file({ file_name: 'a.pdf' });
  await invalid.file({ file_size: KLING4_PRO_MAX_TXT_BYTES + 1 });
  assert.equal(invalid.downloads.length, 0);
  const failed = harness(); failed.fail(); await failed.file();
  assert.equal(failed.jobs.length, 0);
  assert.ok(!failed.replies.join('').includes('secret'));
  const cool = harness(); cool.cooldown(); await cool.file(); assert.equal(cool.jobs.length, 0);
  const early = harness(); early.set({ mode: 'picsart_i2v_wait_image' });
  await early.file(); assert.equal(early.downloads.length, 0);
  const legacy = harness('kling_v4'); await legacy.file(); assert.equal(legacy.downloads.length, 0);
  const missingEnd = harness(); missingEnd.set({ picsartI2vImageUrls: ['https://example.test/start.jpg'] });
  await missingEnd.file(); assert.equal(missingEnd.jobs.length, 0);
  const cancelled = harness(), release = cancelled.block();
  const old = cancelled.file(); cancelled.set({ mode: 'idle' }); release(); await old;
  assert.equal(cancelled.jobs.length, 0);
  const switched = harness(), resume = switched.block();
  const oldSettings = switched.file(); switched.set({ picsartI2vDuration: 10 }); resume(); await oldSettings;
  assert.equal(switched.jobs.length, 0);
  const race = harness(); await Promise.all([race.file(), race.file()]);
  assert.equal(race.jobs.length, 1);
  const textRace = harness(), finishDownload = textRace.block();
  const pending = textRace.file(); await textRace.text('Text wins'); finishDownload(); await pending;
  assert.equal(textRace.jobs.length, 1); assert.equal(textRace.jobs[0][4], 'Text wins');

  // Real Telegraf document registration, not an invented document dispatch.
  const h = harness();
  const bot = new Telegraf('fake-token-not-used');
  bot.botInfo = { id: 123, is_bot: true, first_name: 'Test', username: 'test_bot',
    can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false };
  bot.use(async (ctx: any, next) => {
    ctx.reply = h.ctx.reply; ctx.telegram.getFileLink = h.ctx.telegram.getFileLink;
    return next();
  });
  h.context.bot = bot;
  const registration = ast.statements.find(n => n.getText(ast).startsWith("bot.on('document',"));
  assert.ok(registration);
  vm.runInContext(compile(registration.getText(ast)), h.context);
  await bot.handleUpdate({ update_id: 1, message: {
    message_id: 1, date: 1, chat: { id: 2, type: 'private' },
    from: { id: 1, is_bot: false, first_name: 'Test' },
    document: { file_id: 'script', file_unique_id: 'unique', file_name: 'PROMPT.TXT' },
  } } as any);
  assert.equal(h.jobs.length, 1);
  assert.equal(h.jobs[0][4], 'Full prompt');
  assert.ok(source.includes('return submitPicsartI2vPrompt(ctx, ctx.message.text)'));
  assert.ok(source.includes('${KLING4_PRO_PROMPT_HELP}'));
  console.log('PASS Kling 4 Pro TXT: actual document routing, full 26k JSON prompt, UTF-8/bounds, ordered frames/settings, retry, cancellation and one shared text/TXT claim.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
