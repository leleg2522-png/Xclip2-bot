import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { createSeedanceAudioHandler, supportsSeedance2Audio, seedanceAudioContent,
  validateSeedanceAudioBuffers, seedanceAudioMime, loadSeedanceReferenceAudios } from '../src/seedance-reference-audio';
import { buildPicsartI2vParams, buildSeedanceMiniVideoEditParams, buildSeedanceFastVideoEditParams,
  buildSeedance2VideoEditParams, PICSART_I2V_MODELS } from '../src/picsart';
import { createSeedance25P2Bot } from '../src/seedance25-edan-bot';
import { validateP2References, SEEDANCE25_P2 } from '../src/seedance25-edan';
import { generationErrorMessage } from '../src/generation-errors';
import { withGenerationErrors } from './generation-error-harness';

const reference = 'https://example.test/reference.jpg';
const audioUrl = 'https://example.test/reference.mp3';
function functionCode(source: string, names: string[]) {
  const ast = ts.createSourceFile('source.ts', source, ts.ScriptTarget.Latest, true);
  return ts.transpileModule(ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text ?? ''))
    .map(n => n.getText(ast).replace(/^export\s+/, '')).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}
const picsartSource = readFileSync(new URL('../src/picsart.ts', import.meta.url), 'utf8');
const botSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const file = (id: string, extra: any = {}) => ({ file_id: id, mime_type: 'audio/mpeg', ...extra });

function intake() {
  let session: any = { mode: 'picsart_i2v_wait_image', picsartI2vModel: 'seedance_2' };
  let duration = 2, invalid = false, reads = 0, gate = Promise.resolve();
  const messages: string[] = [];
  const handler = createSeedanceAudioHandler({
    getSession: () => session,
    setSession: (_id, patch) => { session = { ...session, ...patch }; },
    download: async () => { reads++; await gate; return Buffer.from('media'); },
    inspect: async () => { if (invalid) throw Error('Picsart private error'); return duration; },
  });
  const ctx = { from: { id: 1 }, reply: async (text: string) => { messages.push(text); } };
  return { handle: (value: any) => handler(ctx, value), session: () => session, messages,
    set: (patch: any) => { session = { ...session, ...patch }; }, duration: (value: number) => { duration = value; },
    invalid: () => { invalid = true; }, reads: () => reads, gate: (value: Promise<void>) => { gate = value; } };
}

async function payloadAndProvider() {
  const expected = [{ type: 'audio_url', audio_url: { url: audioUrl }, role: 'reference_audio' }];
  assert.deepEqual(seedanceAudioContent([audioUrl]), expected);
  assert.throws(() => seedanceAudioContent(Array(4).fill(audioUrl)));
  assert.throws(() => seedanceAudioContent(['http://example.test/audio']));
  assert.throws(() => seedanceAudioContent(['https://user:password@example.test/audio']));
  assert.equal(seedanceAudioMime({ file_name: 'voice.wav', mime_type: 'application/octet-stream' }), 'audio/wav');
  const audio = { buffer: Buffer.from('audio'), duration: 3, name: 'voice.wav', mime: 'audio/wav' };
  validateSeedanceAudioBuffers([audio]);
  for (const duration of [0, -1, NaN, Infinity, 16]) assert.throws(() => validateSeedanceAudioBuffers([{ ...audio, duration }]));
  assert.throws(() => validateSeedanceAudioBuffers(Array(4).fill(audio)));
  assert.throws(() => validateSeedanceAudioBuffers([{ ...audio, duration: 10 }, { ...audio, duration: 6 }]));
  assert.throws(() => validateSeedanceAudioBuffers([{ ...audio, buffer: Buffer.alloc(0) }]));
  await assert.rejects(loadSeedanceReferenceAudios([{ fileId: 'bad', mime: 'audio/mpeg', duration: 1 }], async () => Buffer.from('not audio')));

  for (const model of ['seedance_2', 'seedance_2_fast', 'seedance_2_mini'] as const) {
    const payload = buildPicsartI2vParams(model, 'walk', reference, { audioUrls: [audioUrl] }) as any;
    assert.deepEqual(payload.content.filter((item: any) => item.type === 'audio_url'), expected);
    assert.equal(payload.content.filter((item: any) => item.type === 'image_url').length, 1);
    assert.equal(payload.generate_audio, true);
  }
  for (const build of [buildSeedanceMiniVideoEditParams, buildSeedanceFastVideoEditParams, buildSeedance2VideoEditParams]) {
    const payload = build({ prompt: 'walk', videoUrl: 'https://example.test/video.mp4', audioUrls: [audioUrl], ratio: '9:16' }) as any;
    assert.deepEqual(payload.content.filter((item: any) => item.type === 'audio_url'), expected);
    assert.deepEqual(JSON.parse(payload.options.drive.attributes.aiSDKPayload).audioUrls, [audioUrl]);
  }
  for (const model of ['seedance_2', 'seedance_2_fast', 'seedance_2_mini'] as const) {
    const uploads: any[] = [], submits: any[] = [];
    let accounts = 0;
    const context = vm.createContext({
      Buffer, PICSART_I2V_MODELS, PICSART_I2V_MAX_IMAGES: 5,
      validateSeedanceAudioBuffers,
      picsartI2vAccountPolicy: () => ({ pool: 'any' }),
      runWithAccount: async (_id: number, _pool: string, run: any) => { accounts++; return run(91); },
      uploadFile: async (...args: any[]) => { uploads.push(args); return `https://example.test/upload-${uploads.length}`; },
      submitPicsartI2v: async (...args: any[]) => { submits.push(args); return 'accepted'; },
      pollPicsartI2vResult: async () => ({ url: 'https://example.test/result.mp4' }),
      console: { log() {} },
    });
    vm.runInContext(functionCode(picsartSource, ['generatePicsartI2v']), context);
    await context.generatePicsartI2v({ userId: 1, model, prompt: 'walk',
      images: [{ buffer: Buffer.from('photo') }], audios: [audio] });
    assert.equal(accounts, 1);
    assert.equal(submits.length, 1);
    assert.equal(uploads.length, 2);
    assert.ok(uploads.every(args => args[0] === 91), 'Audio and photo use the same account');
    assert.equal(uploads[1][2], 'voice.wav');
    assert.equal(uploads[1][3], 'audio/wav');
    assert.deepEqual(Array.from(submits[0][4].audioUrls), ['https://example.test/upload-2']);
  }
}

async function intakeTests() {
  const normal = intake();
  await normal.handle(file('one', { mime_type: 'application/octet-stream', file_name: 'voice.wav' }));
  assert.equal(normal.session().seedanceAudioDraft.refs[0].mime, 'audio/wav');
  assert.equal(normal.session().seedanceAudioDraft.pending.length, 0);
  await normal.handle(file('one'));
  assert.equal(normal.reads(), 1);
  normal.set({ mode: 'picsart_i2v_wait_prompt' });
  await normal.handle(file('two'));
  assert.equal(normal.session().seedanceAudioDraft.refs.length, 2);
  const large = intake();
  await large.handle(file('large', { file_size: 20 * 1024 * 1024 }));
  assert.equal(large.reads(), 0);
  const duration = intake(); duration.duration(15);
  await duration.handle(file('one')); duration.duration(1);
  await duration.handle(file('two'));
  assert.equal(duration.session().seedanceAudioDraft.refs.length, 1);
  assert.equal(duration.session().seedanceAudioDraft.pending.length, 0);
  const invalid = intake(); invalid.invalid(); await invalid.handle(file('one'));
  assert.equal(invalid.session().seedanceAudioDraft.refs.length, 0);
  assert.doesNotMatch(invalid.messages.join('\n'), /Picsart|private/i);
  const parallel = intake();
  let release!: () => void;
  parallel.gate(new Promise<void>(resolve => { release = resolve; }));
  const tasks = ['one', 'two', 'three', 'four'].map(id => parallel.handle(file(id)));
  assert.equal(parallel.session().seedanceAudioDraft.pending.length, 3);
  release(); await Promise.all(tasks);
  assert.equal(parallel.session().seedanceAudioDraft.refs.length, 3);
  assert.equal(parallel.session().seedanceAudioDraft.pending.length, 0);
  const cancelled = intake();
  cancelled.gate(new Promise<void>(resolve => { release = resolve; }));
  const pending = cancelled.handle(file('one'));
  cancelled.set({ mode: 'idle', seedanceAudioDraft: undefined });
  release(); await pending;
  assert.equal(cancelled.session().seedanceAudioDraft, undefined);
  assert.equal(cancelled.messages.length, 0);
  for (const model of ['wan_v3', 'kling_v4', 'grok_imagine']) {
    assert.equal(supportsSeedance2Audio({ mode: 'picsart_i2v_wait_image', picsartI2vModel: model }), false);
  }
}

async function p2Tests() {
  let state: any = { mode: 's25p2_wait_media', dbUserId: 1, seedance25P2: { id: 'draft', ratio: '9:16', refs: [], pending: [] } };
  const messages: string[] = [], jobs: any[] = [];
  const controller = createSeedance25P2Bot({
    getSession: () => state, setSession: (_id, patch) => { state = { ...state, ...patch }; },
    price: () => 7500, cooldown: () => 0,
    download: async () => Buffer.from('media'), inspect: async () => ({ duration: 2 }),
    run: async job => { jobs.push(job); },
  });
  const ctx = (message: any) => ({ from: { id: 1 }, chat: { id: 1 }, message: { message_id: 4, ...message },
    reply: async (text: string) => { messages.push(text); return { message_id: 1 }; },
    editMessageText: async (text: string) => { messages.push(text); } });
  await controller.message(ctx({ audio: file('audio') }));
  await controller.message(ctx({ voice: file('voice') }));
  await controller.message(ctx({ document: file('doc', { mime_type: 'application/octet-stream', file_name: 'sample.wav' }) }));
  assert.equal(state.seedance25P2.refs.length, 3);
  assert.equal(state.seedance25P2.refs[1].mime, 'audio/ogg');
  assert.equal(state.seedance25P2.refs[2].mime, 'audio/wav');
  validateP2References(state.seedance25P2.refs);
  const refs = state.seedance25P2.refs;
  await controller.callback(ctx({}), 's25p2_done:draft');
  assert.equal(state.mode, 's25p2_wait_prompt');
  await controller.message(ctx({ text: 'animate to this audio' }));
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].refs.length, 3);
  const calls: any[][] = [];
  const context = vm.createContext({
    SEEDANCE25_P2, validateP2References, validateSeedance25Prompt: (value: string) => value,
    MODEL_PRICES: { seedance25_p2: 7500 },
    retryTelegramFileRead: async (fn: any) => fn(),
    bot: { telegram: { getFileLink: async (id: string) => ({ href: `https://example.test/${id}` }) } },
    runPicsartSeedance25: async (...args: any[]) => { calls.push(args); },
  });
  vm.runInContext(functionCode(botSource, ['runSeedance25P2']), context);
  await context.runSeedance25P2({ ...jobs[0], refs });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][8].length, 3);
  assert.equal(calls[0][8][1].mime, 'audio/ogg');
  assert.equal(calls[0][9], 7500);
}

async function runnerTests() {
  const pendingReplies: string[] = [];
  const pending = vm.createContext({
    getSession: () => ({ mode: 'picsart_i2v_wait_prompt', dbUserId: 1,
      seedanceAudioDraft: { id: 'draft', refs: [], pending: ['uploading'] } }),
  });
  vm.runInContext(functionCode(botSource, ['submitPicsartI2vPrompt']), pending);
  await pending.submitPicsartI2vPrompt({ from: { id: 1 },
    reply: async (message: string) => { pendingReplies.push(message); } }, 'walk');
  assert.equal(pendingReplies.length, 1);
  assert.match(pendingReplies[0], /Audio masih diperiksa/);
  for (const fail of [false, true]) {
    const inputs: any[] = [], refunds: number[] = [], messages: string[] = [];
    const context = withGenerationErrors(vm.createContext({
      isSeedance2I2vModel: (model: string) => model.startsWith('seedance_2'),
      supportsMultiplePicsartI2vImages: () => true,
      customerSafeModelLabel: (label: string) => label,
      picsart: { PICSART_I2V_MODELS, PICSART_I2V_MAX_IMAGES: 5,
        generatePicsartI2v: async (input: any) => { inputs.push(input); if (fail) throw Error('Picsart input_text_sensitive'); return { url: 'https://example.test/result.mp4' }; },
        describePicsartPostSubmitCause: () => '' },
      MODEL_PRICES: {}, getPicsartI2vPrice: () => 4000, userModelPrice: async (_id: number, _model: string, normal: number) => normal,
      beginCharge: async () => ({ ok: true }), downloadBuffer: async () => ({ buf: Buffer.from('image'), mime: 'image/jpeg', ext: 'jpg' }),
      loadSeedanceReferenceAudios: async (refs: any[]) => refs.map(ref => ({ buffer: Buffer.from('audio'), name: 'voice.ogg', mime: ref.mime, duration: ref.duration })),
      downloadTelegramFileBuffer: async () => Buffer.from('audio'),
      upscaleGeneratedVideo: async () => ({ url: 'https://example.test/1080.mp4', upscaled: true }),
      sendResult: async () => true, incrementKlingUsage: async () => 1, markGenSuccess() {},
      addSaldo: async (_id: number, amount: number) => { refunds.push(amount); }, releaseGenerating() {},
      describeError: (error: any) => error.message, formatRupiah: (amount: number) => `Rp${amount}`,
      bot: { telegram: { editMessageText: async (...args: any[]) => { messages.push(args[3]); }, sendMessage: async (_id: number, message: string) => { messages.push(message); }, deleteMessage: async () => {} } },
      console: { log() {}, error() {} },
    }));
    vm.runInContext(functionCode(botSource, ['runPicsartI2v']), context);
    await context.runPicsartI2v(1, 1, 1, 1, 'walk', { model: 'seedance_2', imageUrls: [reference],
      audioRefs: [{ fileId: 'one', mime: 'audio/ogg', duration: 2 }] });
    assert.equal(inputs.length, 1);
    assert.equal(inputs[0].audios[0].mime, 'audio/ogg');
    assert.equal(refunds.length, fail ? 1 : 0);
    assert.doesNotMatch(messages.join('\n'), /Picsart/i);
  }
}

async function main() {
  await payloadAndProvider(); await intakeTests(); await p2Tests(); await runnerTests();
  assert.match(botSource, /supportsSeedance2Audio\(session\)\) return handleSeedance2Audio\(ctx, ctx\.message\.audio\)/);
  assert.match(botSource, /supportsSeedance2Audio\(session\)\) return handleSeedance2Audio\(ctx, \{ \.\.\.ctx\.message\.voice/);
  assert.match(botSource, /doc\.file_name.*\n.*return handleSeedance2Audio\(ctx, doc\)/);
  assert.match(botSource, /activeDraft\.seedanceAudioDraft\?\.pending\.length/);
  assert.match(generationErrorMessage(Error('Picsart input_text_sensitive')), /Prompt ditolak/);
  console.log('Seedance reference audio: documented payloads, same-account uploads, real invalid-media probe, input limits, concurrency/cancel, P2 audio-only routing, refunds and provider privacy passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
