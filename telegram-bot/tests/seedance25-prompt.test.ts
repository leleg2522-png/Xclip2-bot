import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {
  SEEDANCE25_MAX_TXT_BYTES, validateSeedance25Prompt,
  validateSeedance25TxtDocument, decodeSeedance25Txt,
} from '../src/seedance25-prompt';
import { validateSeedance25Request, type Seedance25Settings } from '../src/seedance25-picsart';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
function functionCode(name: string) {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name);
  return ts.transpileModule(node.getText(ast), {
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
  const getFileLink = async (fileId: string) => ({ href: `https://example.test/${fileId}` });
  const context = vm.createContext({
    Buffer, SEEDANCE25_MAX_TXT_BYTES, validateSeedance25Prompt,
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
    console: { error: () => { throw Error('Must not log Telegram download errors'); } },
  });
  vm.runInContext(helpers, context);
  const ctx = {
    from: { id: 1 }, chat: { id: 2 }, telegram: { getFileLink },
    message: { document: { file_id: 'script', file_name: 'script.txt' } },
    reply: async (message: string) => { messages.push(message); return { message_id: 99 }; },
  };
  return {
    session: () => session, jobs, messages, downloads,
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

async function main() {
  checkDecoding(); await checkFlow();
  console.log('PASS Seedance 2.5 TXT: strict UTF-8, full long prompt, bounds, retry, references, shared text/TXT claim, cancellation and isolation.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
