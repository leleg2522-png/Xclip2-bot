import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import * as labels from '../src/seedance-reference-labels';
import { createSeedance25P2Bot } from '../src/seedance25-edan-bot';
import { SEEDANCE25_P2, validateP2References } from '../src/seedance25-edan';
import { validateSeedance25Prompt } from '../src/seedance25-prompt';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
function compile(names: string[]) {
  return ts.transpileModule(ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text ?? ''))
    .map(n => n.getText(ast)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}
function harness(model = 'seedance_2') {
  let state: any = { mode: 'picsart_i2v_wait_image', dbUserId: 1, picsartI2vModel: model, picsartI2vRatio: '9:16' };
  const jobs: any[][] = [], messages: string[] = [], links: string[] = [];
  const isSeedance2I2vModel = (key: string) => ['seedance_2', 'seedance_2_mini', 'seedance_2_fast'].includes(key);
  const context = vm.createContext({
    ...labels, validateSeedance25Prompt, SEEDANCE25_MAX_IMAGES: 30,
    getSession: () => state, setSession: (_id: number, patch: any) => { state = { ...state, ...patch }; },
    isSeedance2I2vModel, isPicsartI2vModelKey: isSeedance2I2vModel,
    maxPicsartI2vImages: () => 5, picsartI2vAddPhotoKeyboard: () => ({}),
    seedance25InputKeyboard: () => ({}),
    picsart: { PICSART_I2V_MODELS: Object.fromEntries(['seedance_2', 'seedance_2_mini', 'seedance_2_fast']
      .map(key => [key, { label: key, settingsLabel: '15 detik' }])) },
    requireLogin: async () => true, getCooldownRemainingMs: () => 0,
    validateSeedance25Request() {}, retryTelegramFileRead: async (read: any) => read(),
    retryTelegramRateLimit: async (send: any) => send(),
    bot: { telegram: { getFileLink: async (id: string) => {
      if (id === 'first') await new Promise(resolve => setTimeout(resolve, 5));
      links.push(id); return { href: `https://example.test/${id}` };
    } } },
    runPicsartI2v: async (...args: any[]) => { jobs.push(args); },
    runPicsartSeedance25: async (...args: any[]) => { jobs.push(args); },
    console: { error() {} },
  });
  vm.runInContext(compile(['handleImageInput', 'submitPicsartI2vPrompt', 'submitSeedance25Prompt']), context);
  const ctx = (message: any = {}) => ({ from: { id: 1 }, chat: { id: 1 }, message,
    reply: async (text: string) => { messages.push(text); return { message_id: 10 }; } });
  return { state: () => state, patch: (patch: any) => { state = { ...state, ...patch }; }, jobs, messages, links,
    image: (id: string) => context.handleImageInput(ctx(), '', id),
    staleImage: () => context.handleImageInput(ctx(), 'https://example.test/old-flow.jpg', 'old-flow'),
    prompt: (text: string) => context.submitPicsartI2vPrompt(ctx(), text),
    primaryPrompt: (text: string) => context.submitSeedance25Prompt(ctx(), text),
  };
}
async function i2v() {
  for (const model of ['seedance_2', 'seedance_2_mini', 'seedance_2_fast']) {
    const h = harness(model);
    await h.staleImage();
    assert.equal(h.state().picsartSeedanceImageFileIds, undefined);
    h.messages.length = 0;
    await Promise.all([h.image('first'), h.image('second')]);
    assert.deepEqual(Array.from(h.state().picsartSeedanceImageFileIds), ['first', 'second']);
    assert.equal(h.links.length, 0, 'Reserve labels without waiting for Telegram file links');
    assert.match(h.messages[0], /@1/);
    assert.match(h.messages[1], /@2/);
    await h.image('first');
    assert.equal(h.state().picsartSeedanceImageFileIds.length, 2);
    h.patch({ mode: 'picsart_i2v_wait_prompt' });
    await h.prompt('Use @3');
    assert.equal(h.jobs.length, 0);
    assert.equal(h.state().mode, 'picsart_i2v_wait_prompt');
    await h.prompt('@2 left; @1 right');
    await h.prompt('@2 left; @1 right');
    assert.equal(h.jobs.length, 1);
    assert.equal(h.jobs[0][4], '@2 left; @1 right');
    assert.deepEqual(Array.from(h.jobs[0][5].imageFileIds), ['first', 'second']);
    assert.equal(h.state().picsartSeedanceImageFileIds, undefined);
    const cap = harness(model);
    for (let i = 0; i < 6; i++) await cap.image(`photo-${i}`);
    assert.equal(cap.state().picsartSeedanceImageFileIds.length, 5);
    assert.match(cap.messages.at(-1)!, /Maksimal 5/);
  }
}
async function primary() {
  const h = harness();
  h.patch({ mode: 'oneover_wait_image', seedance25Settings: { provider: 'picsart', mode: 'reference', resolution: 1080, audio: true, ratio: '9:16' },
    seedance25ImageFileIds: [], seedance25Videos: [], seedance25Audios: [] });
  await h.staleImage();
  assert.equal(h.state().seedance25ImageFileIds.length, 0);
  h.messages.length = 0;
  await h.image('first'); await h.image('second');
  assert.match(h.messages[0], /@1/); assert.match(h.messages[1], /@2/);
  h.patch({ mode: 'oneover_wait_prompt' });
  await h.primaryPrompt('Use @3');
  assert.equal(h.jobs.length, 0);
  assert.equal(h.state().mode, 'oneover_wait_prompt');
  const prompt = '人物 @2 在左边，@1 在右边。';
  await h.primaryPrompt(prompt);
  assert.equal(h.jobs.length, 1);
  assert.equal(h.jobs[0][4], prompt);
  assert.deepEqual(Array.from(h.jobs[0][5]), ['https://example.test/first', 'https://example.test/second']);
  assert.deepEqual(h.links, ['second', 'first'], 'Completion order differs but reference order stays fixed');
}
async function p2() {
  let state: any = { mode: 's25p2_wait_media', dbUserId: 1,
    seedance25P2: { id: 'draft', ratio: '9:16', refs: [], pending: [] } };
  const messages: string[] = [], jobs: any[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const controller = createSeedance25P2Bot({
    getSession: () => state, setSession: (_id, patch) => { state = { ...state, ...patch }; },
    price: () => 7500, cooldown: () => 0,
    download: async id => { if (id === 'first') await gate; return Buffer.from(id === 'txt' ? '@2 left; @1 right' : 'image'); },
    inspect: async () => ({}), run: async job => { jobs.push(job); },
  });
  const ctx = (id: number, message: any) => ({ from: { id: 1 }, chat: { id: 1 }, message: { message_id: id, ...message },
    reply: async (text: string) => { messages.push(text); return { message_id: 4 }; },
    editMessageText: async (text: string) => { messages.push(text); } });
  const first = controller.message(ctx(10, { photo: [{ file_id: 'first' }] }));
  await controller.message(ctx(11, { photo: [{ file_id: 'second' }] }));
  assert.doesNotMatch(messages.at(-1)!, /Gambar: @1/, 'Do not assign a premature label while earlier images are pending');
  release(); await first;
  assert.deepEqual(state.seedance25P2.refs.map((ref: any) => ref.fileId), ['first', 'second']);
  await controller.callback(ctx(12, {}), 's25p2_done:draft');
  assert.match(messages.at(-1)!, /Gambar: @1, @2/);
  await controller.message(ctx(13, { text: 'Use @3' }));
  assert.equal(jobs.length, 0);
  await controller.message(ctx(14, { document: { file_id: 'txt', file_name: 'prompt.txt' } }));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].prompt, '@2 left; @1 right');
  const calls: any[][] = [];
  const context = vm.createContext({
    ...labels, validateSeedance25Prompt, validateP2References, SEEDANCE25_P2,
    MODEL_PRICES: { seedance25_p2: 7500 },
    retryTelegramFileRead: async (read: any) => read(),
    bot: { telegram: { getFileLink: async (id: string) => ({ href: `https://example.test/${id}` }) } },
    runPicsartSeedance25: async (...args: any[]) => { calls.push(args); },
  });
  vm.runInContext(compile(['runSeedance25P2']), context);
  await context.runSeedance25P2({ ...jobs[0], refs: [...jobs[0].refs].reverse() });
  assert.deepEqual(Array.from(calls[0][5]), ['https://example.test/first', 'https://example.test/second']);
}
async function main() {
  await i2v(); await primary(); await p2();
  console.log('Picsart reference labels: Mini/Fast/Standard, primary 2.5 and P2, exact prompt preservation, TXT, reversed downloads, limits and duplicate-claim protection passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
