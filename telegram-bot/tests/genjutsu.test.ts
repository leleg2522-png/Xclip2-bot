import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { Telegraf, Markup } from 'telegraf';
import { createGenjutsuFlow, GENJUTSU_PRICES, GENJUTSU_PROMPT, GENJUTSU_NEGATIVE_PROMPT, type GenjutsuDraft } from '../src/genjutsu';

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
  let imageWork: ((file: any) => Promise<void>) | undefined;
  let blockVideo: Promise<void> | undefined;
  const messages: string[] = [], submitted: any[] = [];
  const ctx = {
    from: { id: 1 },
    reply: async (text: string, options?: any) => { messages.push(text); return { text, options }; },
    editMessageText: async (text: string) => { messages.push(text); },
  };
  const flow = createGenjutsuFlow({
    get: () => draft, set: (_id, value) => { draft = value; },
    price: seconds => `Rp${GENJUTSU_PRICES[seconds].toLocaleString('id-ID')}`,
    inspectVideo: async () => { await blockVideo; return duration; },
    inspectImage: async (_ctx, file) => { await imageWork?.(file); if (invalidImage) throw Error('broken'); },
    submit: async (_ctx, value, prompt) => { submitted.push({ value, prompt }); },
  });
  return {
    flow, ctx, messages, submitted,
    draft: () => draft,
    duration: (value: number) => { duration = value; },
    invalidImage: (value: boolean) => { invalidImage = value; },
    imageWork: (value: (file: any) => Promise<void>) => { imageWork = value; },
    cancel: () => { draft = undefined; },
    block: (value: Promise<void>) => { blockVideo = value; },
  };
}

async function checkWizard() {
  const h = harness();
  await h.flow.callback(h.ctx, 'mode_genjutsu');
  assert.equal(h.draft()?.step, 'package');
  await h.flow.callback(h.ctx, `genjutsu_duration_30_${h.draft()!.id}`);
  await h.flow.image(h.ctx, { file_id: 'early-photo' });
  assert.equal(h.draft()?.step, 'video', 'Photo cannot skip the mandatory video');
  for (const duration of [2.99, 30.01, NaN]) {
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
  assert.equal(h.draft()?.step, 'image', 'More references can be added before confirmation');
  await h.flow.callback(h.ctx, `genjutsu_images_done_${h.draft()!.id}`);
  assert.equal(h.draft()?.step, 'confirm');
  assert.equal(h.submitted.length, 0, 'Uploading media never charges or submits');
  const callback = `genjutsu_generate_${h.draft()!.id}`;
  await h.flow.callback(h.ctx, 'genjutsu_generate_old');
  assert.equal(h.submitted.length, 0);
  await Promise.all([h.flow.callback(h.ctx, callback), h.flow.callback(h.ctx, callback)]);
  assert.equal(h.submitted.length, 1, 'A double click can submit only once');
  assert.equal(h.submitted[0].value.video.fileId, 'video');
  assert.deepEqual(h.submitted[0].value.imageFileIds, ['character']);
  assert.equal(h.submitted[0].prompt, GENJUTSU_PROMPT);
  assert.equal(GENJUTSU_PROMPT,
    'Replace the character in the reference video with the character in the reference image.' +
    `\n\nAvoid: ${GENJUTSU_NEGATIVE_PROMPT}.`);
  assert.match(GENJUTSU_NEGATIVE_PROMPT, /original face/);
  assert.match(GENJUTSU_NEGATIVE_PROMPT, /blended faces/);
  assert.match(GENJUTSU_NEGATIVE_PROMPT, /changing identity/);
  assert.match(h.messages.join('\n'), /Kemiripan wajah tidak dijamin/);
  assert.match(h.messages.join('\n'), /sebagai file gambar/);
  assert.match(h.messages.join('\n'), /Harga: Rp8\.000/);
  assert.doesNotMatch(h.messages.join('\n'), /picsart|seedance|renderful|upscal|480p/i);
}

async function checkCancellation() {
  const h = harness();
  let release!: () => void;
  h.block(new Promise(resolve => { release = resolve; }));
  await h.flow.callback(h.ctx, 'mode_genjutsu');
  await h.flow.callback(h.ctx, `genjutsu_duration_30_${h.draft()!.id}`);
  const oldId = h.draft()!.id;
  const pending = h.flow.video(h.ctx, { file_id: 'old-video' });
  h.cancel();
  await h.flow.callback(h.ctx, 'mode_genjutsu');
  await h.flow.callback(h.ctx, `genjutsu_duration_15_${h.draft()!.id}`);
  const newId = h.draft()!.id;
  release();
  await pending;
  assert.notEqual(oldId, newId);
  assert.equal(h.draft()?.step, 'video');
  assert.equal(h.draft()?.video, undefined, 'Cancelled uploads cannot overwrite a new draft');
  await h.flow.callback(h.ctx, `genjutsu_generate_${oldId}`);
  assert.equal(h.submitted.length, 0);
}

async function checkDurationPackages() {
  for (const max of [15, 30] as const) {
    for (const duration of [2.99, 3, max, max + 0.01, NaN]) {
      const h = harness();
      await h.flow.callback(h.ctx, 'mode_genjutsu');
      const id = h.draft()!.id;
      await h.flow.video(h.ctx, { file_id: 'before-selection' });
      assert.equal(h.draft()?.step, 'package', 'A package is mandatory before upload');
      await h.flow.callback(h.ctx, `genjutsu_duration_${max}_stale`);
      assert.equal(h.draft()?.step, 'package');
      await h.flow.callback(h.ctx, `genjutsu_duration_${max}_${id}`);
      assert.equal(h.draft()?.maxReferenceSeconds, max);
      await h.flow.callback(h.ctx, `genjutsu_duration_${max === 15 ? 30 : 15}_${id}`);
      assert.equal(h.draft()?.maxReferenceSeconds, max, 'A stale package button cannot change an active upload');
      h.duration(duration);
      await h.flow.video(h.ctx, { file_id: 'source' });
      const valid = Number.isFinite(duration) && duration >= 3 && duration <= max;
      assert.equal(h.draft()?.step, valid ? 'image' : 'video');
      assert.equal(h.submitted.length, 0);
      if (valid) {
        await h.flow.image(h.ctx, { file_id: 'replacement' });
        await h.flow.callback(h.ctx, `genjutsu_images_done_${id}`);
        assert.match(h.messages.join('\n'), new RegExp(`Harga: Rp${max === 15 ? '4\\.500' : '8\\.000'}`));
        await h.flow.callback(h.ctx, `genjutsu_generate_${id}`);
        assert.equal(h.submitted[0].value.maxReferenceSeconds, max);
        assert.match(h.messages.join('\n'), new RegExp(`Paket: ${max} detik`));
      } else {
        assert.match(h.messages.join('\n'), new RegExp(`3–${max} detik`));
      }
    }
  }
}

async function checkMultipleImages() {
  const h = harness();
  await h.flow.callback(h.ctx, 'mode_genjutsu');
  const id = h.draft()!.id;
  await h.flow.callback(h.ctx, `genjutsu_duration_15_${id}`);
  await h.flow.video(h.ctx, { file_id: 'only-video' });
  await h.flow.callback(h.ctx, `genjutsu_images_done_${id}`);
  assert.equal(h.draft()?.step, 'image', 'Zero images cannot reach confirmation');
  const release = new Map<string, () => void>();
  h.imageWork(file => new Promise(resolve => release.set(file.file_id, resolve)));
  const ids = Array.from({ length: 10 }, (_, i) => `ref-${i}`);
  const uploads = ids.map(file_id => h.flow.image(h.ctx, { file_id }));
  assert.equal(h.draft()?.pendingImageFileIds?.length, 10);
  await h.flow.image(h.ctx, { file_id: 'eleventh' });
  await h.flow.image(h.ctx, { file_id: ids[0] });
  assert.equal(release.size, 10, 'Do not inspect duplicate or eleventh images');
  await h.flow.callback(h.ctx, `genjutsu_images_done_${id}`);
  await h.flow.callback(h.ctx, `genjutsu_generate_${id}`);
  assert.equal(h.draft()?.step, 'image', 'Cannot confirm or charge with pending images');
  assert.equal(h.submitted.length, 0);
  for (const ref of [...ids].reverse()) release.get(ref)!();
  await Promise.all(uploads);
  assert.deepEqual(h.draft()?.imageFileIds, ids, 'Album order survives out-of-order validation');
  assert.equal(h.draft()?.pendingImageFileIds?.length, 0);
  await h.flow.video(h.ctx, { file_id: 'second-video' });
  assert.equal(h.draft()?.video?.fileId, 'only-video', 'Still accepts exactly one video');
  await h.flow.callback(h.ctx, 'genjutsu_images_done_stale');
  assert.equal(h.draft()?.step, 'image');
  await h.flow.callback(h.ctx, `genjutsu_images_done_${id}`);
  assert.match(h.messages.join('\n'), /Gambar referensi: 10\/10/);
  await Promise.all([h.flow.callback(h.ctx, `genjutsu_generate_${id}`), h.flow.callback(h.ctx, `genjutsu_generate_${id}`)]);
  assert.equal(h.submitted.length, 1);
  assert.deepEqual(h.submitted[0].value.imageFileIds, ids);

  const cancelled = harness();
  await cancelled.flow.callback(cancelled.ctx, 'mode_genjutsu');
  await cancelled.flow.callback(cancelled.ctx, `genjutsu_duration_30_${cancelled.draft()!.id}`);
  await cancelled.flow.video(cancelled.ctx, { file_id: 'source' });
  let unblock!: () => void;
  cancelled.imageWork(() => new Promise(resolve => { unblock = resolve; }));
  const pending = cancelled.flow.image(cancelled.ctx, { file_id: 'old-image' });
  cancelled.cancel();
  await cancelled.flow.callback(cancelled.ctx, 'mode_genjutsu');
  const fresh = cancelled.draft()!.id;
  unblock();
  await pending;
  assert.equal(cancelled.draft()?.id, fresh);
  assert.equal(cancelled.draft()?.imageFileIds, undefined, 'Old image completions cannot overwrite a fresh draft');
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
    price: seconds => `Rp${GENJUTSU_PRICES[seconds].toLocaleString('id-ID')}`,
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
    await callback(`genjutsu_duration_${asDocument ? 30 : 15}_${session.genjutsuDraft.id}`);
    assert.equal(session.generationDraftKind, 'genjutsu');
    await message(asDocument
      ? { document: { file_id: 'source', file_unique_id: 'v', mime_type: 'video/mp4', file_name: 'source.mp4' } }
      : { video: { file_id: 'source', file_unique_id: 'v', duration: 10, width: 720, height: 1280 } });
    await message(asDocument
      ? { document: { file_id: 'character', file_unique_id: 'i', mime_type: 'image/jpeg', file_name: 'character.jpg' } }
      : { photo: [{ file_id: 'character', file_unique_id: 'i', width: 720, height: 1280 }] });
    await callback(`genjutsu_images_done_${session.genjutsuDraft.id}`);
    assert.equal(session.genjutsuDraft.step, 'confirm');
    const id = session.genjutsuDraft.id;
    await callback(`genjutsu_generate_${id}`);
    await callback(`genjutsu_generate_${id}`);
    await callback('back_main');
    assert.equal(session.mode, 'idle');
    await callback(`genjutsu_generate_${id}`);
  }
  assert.equal(submissions.length, 2);
  assert(submissions.every(s => s.draft.video.fileId === 'source' && s.draft.imageFileIds[0] === 'character'));
  assert.match(source, /'genjutsu',/);
  assert.match(source, /'mode_genjutsu'\)/);
}

async function checkRealGenerationAdapter() {
  const declaration = ast.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(d => d.name.getText(ast) === 'genjutsuFlow'));
  assert(declaration);
  for (const packageSeconds of [15, 30] as const) {
  const expectedPrice = packageSeconds === 15 ? 4500 : 8000;
  for (const scenario of ['success', 'upscale-fail', 'audio-fail', 'publish-fail', 'silent', 'actual-too-long', 'actual-too-short']) {
    const upscale = scenario !== 'upscale-fail';
    let session: any = {
      mode: 'genjutsu', dbUserId: 7, generationDraft: true, generationDraftKind: 'genjutsu',
      genjutsuDraft: {
        id: 'confirmed-draft', step: 'confirm', imageFileIds: Array.from({ length: 10 }, (_, i) => `image-${i}`),
        maxReferenceSeconds: packageSeconds,
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
      Buffer, console, Date, createGenjutsuFlow, GENJUTSU_PRICES,
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
        data: Buffer.from(url.startsWith('https://telegram.test/image-') ? `identity-${url.split('/').pop()}`
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
      inspectSeedance25Media: async () => scenario === 'actual-too-long' ? packageSeconds + 0.1 : scenario === 'actual-too-short' ? 2.99 : 10,
      beginCharge: async (_id: number, amount: number) => { charges.push(amount); return { ok: true }; },
      addSaldo: async (_id: number, amount: number) => { refunds.push(amount); },
      releaseGenerating: (id: number) => { releases.push(id); },
      incrementKlingUsage: async () => 1, markGenSuccess: () => {},
      describeError: (error: Error) => error.message,
      notifyGenerationFailure: async (_chat: number, _id: number, _error: Error, stage: string) => { stages.push(stage); },
      picsart: { SEEDANCE25_FLASH_DURATION_SECONDS: 30,
        generateSeedance25Flash: async () => { throw Error('Genjutsu must not use Flash'); },
        generateSeedance25Genjutsu: async (input: any) => {
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
    if (scenario.startsWith('actual-')) {
      assert.equal(pipeline, undefined, 'Probe the actual file against the selected package before charging');
      assert.equal(charges.length, 0);
      assert.equal(providerInputs.length, 0);
      assert.equal(session.mode, 'idle', 'Do not fall back to the ordinary Flash wizard');
      continue;
    }
    assert(pipeline, 'Confirmation must reach the real generation runner');
    await pipeline;
    await flow.callback(ctx, 'genjutsu_generate_confirmed-draft');
    assert.deepEqual(charges, [expectedPrice], 'Charge the selected package once, not the actual 10-second source length');
    assert.equal(providerInputs.length, 1);
    assert.equal(providerInputs[0].taskType, 'edit');
    assert.equal(providerInputs[0].maxReferenceSeconds, packageSeconds);
    assert.equal(providerInputs[0].generateAudio, false, 'Genjutsu must disable model audio explicitly');
    assert.equal(providerInputs[0].images.length, 10);
    assert.equal(providerInputs[0].videos.length, 1);
    assert.equal(providerInputs[0].images[0].buffer.toString(), 'identity-image-0');
    assert.equal(providerInputs[0].images[9].buffer.toString(), 'identity-image-9');
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
      assert.deepEqual(refunds, [expectedPrice]);
      assert.deepEqual(stages, ['finishing']);
    }
    assert.doesNotMatch(messages.join('\n'), /seedance|picsart|renderful|upscal|480p/i);
  }
  }
  assert.match(functionCode('upscaleGeneratedVideo'), /return generateRenderful1080\(sourceUrl,/,
    'Public Genjutsu finishing must use Renderful, not a native-resolution fallback');
}

async function checkIdentityReferenceGuards() {
  for (const refs of [
    { images: [], videos: ['source'], audios: [] },
    { images: ['identity'], videos: [], audios: [] },
    { images: Array.from({ length: 11 }, (_, i) => `image-${i}`), videos: ['source'], audios: [] },
    { images: ['identity', 'identity'], videos: ['source'], audios: [] },
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
  await checkDurationPackages();
  await checkMultipleImages();
  await checkCancellation();
  await checkTelegramRouting();
  await checkRealGenerationAdapter();
  await checkIdentityReferenceGuards();
  console.log('Genjutsu passed: mandatory video + photo, automatic prompt, explicit confirmation, cancellation, stale/double-click guards, actual Telegram media/document routing.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
