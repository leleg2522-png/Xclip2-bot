import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { Telegraf, Markup } from 'telegraf';
import { createGenjutsuFlow, GENJUTSU_PROMPT, type GenjutsuDraft } from '../src/genjutsu';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
const compile = (code: string) => ts.transpileModule(code, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
function functionCode(name: string) {
  const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert(node, name);
  return node.getText(ast);
}
function routeCode(event: string) {
  const node = ast.statements.find(node => ts.isExpressionStatement(node)
    && ts.isCallExpression(node.expression) && node.expression.expression.getText(ast) === 'bot.on'
    && node.expression.arguments[0]?.getText(ast) === `'${event}'`);
  assert(node, event);
  return node.getText(ast);
}

function harness() {
  let draft: GenjutsuDraft | undefined;
  let duration = 10;
  let invalidImage = false;
  let blockVideo: Promise<void> | undefined;
  const messages: string[] = [], submitted: any[] = [];
  const ctx = {
    from: { id: 1 },
    reply: async (text: string, options?: any) => { messages.push(text); return { text, options }; },
    editMessageText: async (text: string) => { messages.push(text); },
  };
  const flow = createGenjutsuFlow({
    get: () => draft, set: (_id, value) => { draft = value; },
    price: () => 'Rp6.000',
    inspectVideo: async () => { await blockVideo; return duration; },
    inspectImage: async () => { if (invalidImage) throw Error('broken'); },
    submit: async (_ctx, value, prompt) => { submitted.push({ value, prompt }); },
  });
  return {
    flow, ctx, messages, submitted,
    draft: () => draft,
    duration: (value: number) => { duration = value; },
    invalidImage: (value: boolean) => { invalidImage = value; },
    cancel: () => { draft = undefined; },
    block: (value: Promise<void>) => { blockVideo = value; },
  };
}

async function checkWizard() {
  const h = harness();
  await h.flow.callback(h.ctx, 'mode_genjutsu');
  await h.flow.image(h.ctx, { file_id: 'early-photo' });
  assert.equal(h.draft()?.step, 'video', 'Photo cannot skip the mandatory video');
  for (const duration of [3.99, 30.01, NaN]) {
    h.duration(duration);
    await h.flow.video(h.ctx, { file_id: 'invalid' });
    assert.equal(h.draft()?.step, 'video');
  }
  h.duration(10);
  await h.flow.video(h.ctx, { file_id: 'large', file_size: 20 * 1024 * 1024 });
  assert.equal(h.draft()?.step, 'video');
  await h.flow.video(h.ctx, { file_id: 'video', mime_type: 'video/mp4' });
  assert.equal(h.draft()?.step, 'image');
  h.invalidImage(true);
  await h.flow.image(h.ctx, { file_id: 'broken' });
  assert.equal(h.draft()?.step, 'image');
  h.invalidImage(false);
  await h.flow.image(h.ctx, { file_id: 'character' });
  assert.equal(h.draft()?.step, 'confirm');
  assert.equal(h.submitted.length, 0, 'Uploading media never charges or submits');
  const callback = `genjutsu_generate_${h.draft()!.id}`;
  await h.flow.callback(h.ctx, 'genjutsu_generate_old');
  assert.equal(h.submitted.length, 0);
  await Promise.all([h.flow.callback(h.ctx, callback), h.flow.callback(h.ctx, callback)]);
  assert.equal(h.submitted.length, 1, 'A double click can submit only once');
  assert.equal(h.submitted[0].value.video.fileId, 'video');
  assert.equal(h.submitted[0].value.imageFileId, 'character');
  assert.equal(h.submitted[0].prompt, GENJUTSU_PROMPT);
  assert.match(GENJUTSU_PROMPT, /main foreground person/);
  assert.match(GENJUTSU_PROMPT, /ONLY identity and appearance reference/);
  assert.match(GENJUTSU_PROMPT, /NOT the replacement face/);
  assert.match(GENJUTSU_PROMPT, /not just their clothes/);
  assert.match(GENJUTSU_PROMPT, /Do not retain the original performer/);
  assert.match(GENJUTSU_PROMPT, /first frame through the final frame/);
  assert.match(GENJUTSU_PROMPT, /after hands or hair uncover the face/);
  assert.match(GENJUTSU_PROMPT, /Generate visuals only/);
  assert.match(h.messages.join('\n'), /Kemiripan wajah tidak dijamin/);
  assert.match(h.messages.join('\n'), /Boleh kirim sebagai file gambar/);
  assert.match(h.messages.join('\n'), /Rp6.000/);
  assert.doesNotMatch(h.messages.join('\n'), /picsart|seedance|renderful|upscal|480p/i);
}

async function checkCancellation() {
  const h = harness();
  let release!: () => void;
  h.block(new Promise(resolve => { release = resolve; }));
  await h.flow.callback(h.ctx, 'mode_genjutsu');
  const oldId = h.draft()!.id;
  const pending = h.flow.video(h.ctx, { file_id: 'old-video' });
  h.cancel();
  await h.flow.callback(h.ctx, 'mode_genjutsu');
  const newId = h.draft()!.id;
  release();
  await pending;
  assert.notEqual(oldId, newId);
  assert.equal(h.draft()?.step, 'video');
  assert.equal(h.draft()?.video, undefined, 'Cancelled uploads cannot overwrite a new draft');
  await h.flow.callback(h.ctx, `genjutsu_generate_${oldId}`);
  assert.equal(h.submitted.length, 0);
}

/** Drive actual Telegram callback/photo/video/document handlers without any network. */
async function checkTelegramRouting() {
  const bot = new Telegraf('fixture-token');
  bot.botInfo = { id: 900, is_bot: true, first_name: 'Fixture', username: 'fixture_bot',
    can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false };
  (bot.telegram as any).callApi = async () => ({ message_id: 99 });
  bot.use((ctx, next) => {
    (ctx.telegram as any).callApi = async () => ({ message_id: 99 });
    return next();
  });
  let session: any = { mode: 'idle', dbUserId: 7 };
  const submissions: any[] = [];
  const flow = createGenjutsuFlow({
    get: () => session.mode === 'genjutsu' ? session.genjutsuDraft : undefined,
    set: (_id, draft) => { session = { ...session, mode: 'genjutsu', genjutsuDraft: draft }; },
    price: () => 'Rp6.000',
    inspectVideo: async () => 10, inspectImage: async () => {},
    submit: async (_ctx, draft, prompt) => { submissions.push({ draft, prompt }); },
  });
  const context = vm.createContext({
    bot, Markup, genjutsuFlow: flow, Object,
    requireLogin: async () => true,
    getSession: () => session,
    setSession: (_id: number, patch: any) => { session = { ...session, ...patch }; },
    generating: new Map(), MAX_PARALLEL_GENERATIONS_PER_USER: 3,
    GENERATION_DRAFT_MODES: new Set(['genjutsu', 'seedance25_flash_wait_media', 'seedance25_flash_wait_prompt']),
    mainMenuKeyboard: () => ({}),
  });
  vm.runInContext(compile([
    'generationDraftKindForStart', 'generationDraftKindForContinuation', 'generationDraftBlockReason',
    'reserveGenerationDraft', 'isGenerationEntryCallback', 'replyGenerationDraftBlock',
  ].map(functionCode).join('\n') + '\n' +
    ['callback_query', 'photo', 'video', 'document', 'text', 'audio', 'voice'].map(routeCode).join('\n')), context);
  let updateId = 0;
  const user = { id: 1, is_bot: false, first_name: 'Test' };
  const chat = { id: 1, type: 'private' };
  const callback = async (data: string) => bot.handleUpdate({
    update_id: ++updateId, callback_query: {
      id: String(updateId), from: user, chat_instance: 'test', data,
      message: { message_id: 1, date: 1, chat, text: 'Menu' },
    },
  } as any);
  const message = async (content: any) => bot.handleUpdate({
    update_id: ++updateId, message: { message_id: updateId, date: 1, from: user, chat, ...content },
  } as any);
  for (const asDocument of [false, true]) {
    await callback('mode_genjutsu');
    assert.equal(session.generationDraftKind, 'genjutsu');
    await message(asDocument
      ? { document: { file_id: 'source', file_unique_id: 'v', mime_type: 'video/mp4', file_name: 'source.mp4' } }
      : { video: { file_id: 'source', file_unique_id: 'v', duration: 10, width: 720, height: 1280 } });
    await message(asDocument
      ? { document: { file_id: 'character', file_unique_id: 'i', mime_type: 'image/jpeg', file_name: 'character.jpg' } }
      : { photo: [{ file_id: 'character', file_unique_id: 'i', width: 720, height: 1280 }] });
    assert.equal(session.genjutsuDraft.step, 'confirm');
    const id = session.genjutsuDraft.id;
    await callback(`genjutsu_generate_${id}`);
    await callback(`genjutsu_generate_${id}`);
    await callback('back_main');
    assert.equal(session.mode, 'idle');
    await callback(`genjutsu_generate_${id}`);
  }
  assert.equal(submissions.length, 2);
  assert(submissions.every(s => s.draft.video.fileId === 'source' && s.draft.imageFileId === 'character'));
  assert.match(source, /'genjutsu',/);
  assert.match(source, /'mode_genjutsu'\)/);
}

async function checkRealGenerationAdapter() {
  const declaration = ast.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(d => d.name.getText(ast) === 'genjutsuFlow'));
  assert(declaration);
  for (const scenario of ['success', 'upscale-fail', 'audio-fail', 'publish-fail', 'silent']) {
    const upscale = scenario !== 'upscale-fail';
    let session: any = {
      mode: 'genjutsu', dbUserId: 7, generationDraft: true, generationDraftKind: 'genjutsu',
      genjutsuDraft: {
        id: 'confirmed-draft', step: 'confirm', imageFileId: 'image',
        video: { fileId: 'source', mime: 'video/mp4', duration: 10 },
      },
    };
    const providerInputs: any[] = [], deliveries: any[] = [], messages: string[] = [];
    const charges: number[] = [], refunds: number[] = [], stages: string[] = [], releases: number[] = [];
    let finishing = 0, audioRestores = 0, pipeline: Promise<void> | undefined;
    const ctx = {
      from: { id: 1 }, chat: { id: 2 },
      reply: async (text: string) => { messages.push(text); return { message_id: 3 }; },
    };
    const context = vm.createContext({
      Buffer, console, Date, createGenjutsuFlow,
      getSession: () => session,
      setSession: (_id: number, patch: any) => { session = { ...session, ...patch }; },
      MODEL_PRICES: { picsart_seedance_25_flash: 6000 }, MAX_PARALLEL_GENERATIONS_PER_USER: 3,
      formatRupiah: (value: number) => `Rp${value}`,
      validateSeedance25Prompt: (prompt: string) => prompt,
      getCooldownRemainingMs: () => 0,
      SEEDANCE25_MAX_MEDIA_BYTES: 19 * 1024 * 1024,
      SEEDANCE25_MAX_TOTAL_BYTES: 100 * 1024 * 1024,
      SEEDANCE25_MAX_REFERENCE_SECONDS: 30,
      retryTelegramFileRead: async (read: () => Promise<any>) => read(),
      retryTelegramRateLimit: async (read: () => Promise<any>) => read(),
      bot: { telegram: {
        getFileLink: async (id: string) => ({ href: `https://telegram.test/${id}` }),
        editMessageText: async (_chat: number, _id: number, _inline: unknown, text: string) => { messages.push(text); },
        sendMessage: async (_chat: number, text: string) => { messages.push(text); },
        deleteMessage: async () => {},
      } },
      telegramHttp: { get: async (url: string) => ({
        data: Buffer.from(url === 'https://telegram.test/image' ? 'identity-image'
          : url === 'https://telegram.test/source' ? 'original-performance-video' : 'finished-visual-video'),
      }) },
      restoreGenjutsuAudio: async (original: Buffer, generated: Buffer) => {
        audioRestores++;
        assert(original.equals(providerInputs[0].videos[0].buffer), 'Use the actual source video, not generated audio');
        assert.equal(generated.toString(), 'finished-visual-video');
        if (scenario === 'audio-fail') throw Error('GENJUTSU_AUDIO_FINISH_FAILED');
        return { buffer: Buffer.from('restored-original-audio'), hasAudio: scenario !== 'silent' };
      },
      publishMedia: async (bytes: Buffer) => {
        assert.equal(bytes.toString(), 'restored-original-audio');
        if (scenario === 'publish-fail') throw Error('PUBLISH_FAILED');
        return 'https://result.test/original-audio-1080.mp4';
      },
      detectMime: () => ({ mime: 'image/jpeg', ext: 'jpg' }),
      seedance25ReferenceName: () => 'video.mp4',
      inspectSeedance25Media: async () => 10,
      beginCharge: async (_id: number, amount: number) => { charges.push(amount); return { ok: true }; },
      addSaldo: async (_id: number, amount: number) => { refunds.push(amount); },
      releaseGenerating: (id: number) => { releases.push(id); },
      incrementKlingUsage: async () => 1, markGenSuccess: () => {},
      describeError: (error: Error) => error.message,
      notifyGenerationFailure: async (_chat: number, _id: number, _error: Error, stage: string) => { stages.push(stage); },
      picsart: { SEEDANCE25_FLASH_DURATION_SECONDS: 30, generateSeedance25Flash: async (input: any) => {
        providerInputs.push(input); input.onStatus('upload'); input.onStatus('quote'); input.onStatus('poll');
        return { url: 'https://result.test/native.mp4' };
      } },
      upscaleGeneratedVideo: async (_source: string, _user: number, _chat: number, _status: number, text: string) => {
        finishing++; messages.push(text);
        return { upscaled: upscale, url: upscale ? 'https://result.test/1080.mp4' : 'https://result.test/native.mp4' };
      },
      sendResult: async (...args: any[]) => { deliveries.push(args); return true; },
      runPicsartSeedance25Flash: (...args: any[]) => {
        pipeline = context.runActualFlash(...args);
        return pipeline;
      },
    });
    vm.runInContext(compile(
      declaration.getText(ast) + '\n' + functionCode('submitSeedance25FlashPrompt') + '\n' +
      functionCode('runPicsartSeedance25Flash').replace('function runPicsartSeedance25Flash(', 'function runActualFlash('),
    ), context);
    const flow = vm.runInContext('genjutsuFlow', context);
    await flow.callback(ctx, 'genjutsu_generate_confirmed-draft');
    assert(pipeline, 'Confirmation must reach the real generation runner');
    await pipeline;
    await flow.callback(ctx, 'genjutsu_generate_confirmed-draft');
    assert.deepEqual(charges, [6000], 'Genjutsu charges exactly once');
    assert.equal(providerInputs.length, 1);
    assert.equal(providerInputs[0].taskType, 'edit');
    assert.equal(providerInputs[0].generateAudio, false, 'Genjutsu must disable model audio explicitly');
    assert.equal(providerInputs[0].images.length, 1);
    assert.equal(providerInputs[0].videos.length, 1);
    assert.equal(providerInputs[0].images[0].buffer.toString(), 'identity-image');
    assert.equal(providerInputs[0].videos[0].buffer.toString(), 'original-performance-video');
    assert.equal(providerInputs[0].audios.length, 0);
    assert.equal(providerInputs[0].prompt, GENJUTSU_PROMPT);
    assert.equal(finishing, 1);
    assert.deepEqual(releases, [7]);
    assert.equal(audioRestores, upscale ? 1 : 0);
    if (['success', 'silent'].includes(scenario)) {
      assert.deepEqual(refunds, []);
      assert.equal(deliveries[0][1], 'https://result.test/original-audio-1080.mp4');
      assert.match(deliveries[0][2], /Genjutsu · Character Swap/);
      assert.match(deliveries[0][2], scenario === 'silent' ? /tanpa audio/ : /audio asli video/);
      messages.push(deliveries[0][2]);
    } else {
      assert.equal(deliveries.length, 0, 'Never send native video after finishing failure');
      assert.deepEqual(refunds, [6000]);
      assert.deepEqual(stages, ['finishing']);
    }
    assert.doesNotMatch(messages.join('\n'), /seedance|picsart|renderful|upscal|480p/i);
  }
}

async function checkIdentityReferenceGuards() {
  for (const refs of [
    { images: [], videos: ['source'], audios: [] },
    { images: ['identity'], videos: [], audios: [] },
    { images: ['identity', 'stale-image'], videos: ['source'], audios: [] },
    { images: ['identity'], videos: ['source', 'stale-video'], audios: [] },
    { images: ['identity'], videos: ['source'], audios: ['stale-audio'] },
  ]) {
    const messages: string[] = [];
    const session = {
      mode: 'seedance25_flash_wait_prompt', dbUserId: 7, seedance25FlashDraftId: 'identity-draft',
      seedance25FlashImageFileIds: refs.images,
      seedance25FlashVideos: refs.videos.map(fileId => ({ fileId, duration: 10 })),
      seedance25FlashAudios: refs.audios.map(fileId => ({ fileId, duration: 10 })),
    };
    const context = vm.createContext({
      validateSeedance25Prompt: (prompt: string) => prompt,
      getSession: () => session, getCooldownRemainingMs: () => 0,
      setSession: () => { throw Error('Invalid Genjutsu must not consume the draft'); },
      runPicsartSeedance25Flash: () => { throw Error('Invalid identity references must never charge or submit'); },
    });
    vm.runInContext(compile(functionCode('submitSeedance25FlashPrompt')), context);
    await context.submitSeedance25FlashPrompt({
      from: { id: 1 }, reply: async (text: string) => { messages.push(text); },
    }, GENJUTSU_PROMPT, 'Genjutsu · Character Swap', true);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /Saldo belum dipotong/);
  }
}

async function main() {
  await checkWizard();
  await checkCancellation();
  await checkTelegramRouting();
  await checkRealGenerationAdapter();
  await checkIdentityReferenceGuards();
  console.log('Genjutsu passed: mandatory video + photo, automatic prompt, explicit confirmation, cancellation, stale/double-click guards, actual Telegram media/document routing.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
