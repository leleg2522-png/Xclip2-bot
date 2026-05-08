import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RENDERFUL_API_KEY = process.env.RENDERFUL_API_KEY;
const RENDERFUL_BASE = 'https://api.renderful.ai/api/v1';

if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');
if (!RENDERFUL_API_KEY) throw new Error('RENDERFUL_API_KEY is required');

// Direct HTTP client for Renderful API (no proxy needed)
const renderfulHttp = axios.create({
  timeout: 30_000,
});

// Proxy client for file downloads (optional, fallback to direct)
const PROXY_URL = process.env.PROXY_URL;
const http = PROXY_URL
  ? (() => {
      const { HttpsProxyAgent } = require('https-proxy-agent');
      const agent = new HttpsProxyAgent(PROXY_URL);
      console.log(`✅ Proxy aktif: ${new URL(PROXY_URL).hostname}:${new URL(PROXY_URL).port}`);
      return axios.create({ proxy: false, httpsAgent: agent, httpAgent: agent });
    })()
  : axios.create({ timeout: 60_000 });

const bot = new Telegraf(BOT_TOKEN);

// ─── Model definitions ────────────────────────────────────────────────────────

const IMAGE_MODELS: Record<string, { label: string; cost: string }> = {
  'gpt-image-1':  { label: '🤖 GPT Image 1',  cost: '$0.02' },
  'banana-2':     { label: '🍌 Banana 2',      cost: '$0.02' },
  'banana-pro':   { label: '🍌 Banana Pro',    cost: '$0.04' },
  'seedream-5':   { label: '🌱 Seedream 5',    cost: '$0.02' },
};

// ─── Session state ────────────────────────────────────────────────────────────

type Mode = 'idle' | 'video_wait_image' | 'video_wait_video' | 'img_wait_source';

interface Session {
  mode: Mode;
  imageModel?: string;
  characterUrl?: string; // for video mode
}

const sessions = new Map<number, Session>();

function getSession(userId: number): Session {
  if (!sessions.has(userId)) sessions.set(userId, { mode: 'idle' });
  return sessions.get(userId)!;
}

function setSession(userId: number, data: Partial<Session>) {
  sessions.set(userId, { ...getSession(userId), ...data });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

function extractOutputUrl(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output) && output.length > 0) return String(output[0]);
  if (output && typeof output === 'object') {
    const o = output as Record<string, unknown>;
    if (o.url) return String(o.url);
    if (o.image) return String(o.image);
    if (o.video) return String(o.video);
  }
  throw new Error(`Format output tidak dikenal: ${JSON.stringify(output)}`);
}

async function sendResult(chatId: number, outputUrl: string, caption: string, isVideo: boolean) {
  // Strategy 1: download via proxy → send as buffer
  try {
    const res = await http.get(outputUrl, { responseType: 'arraybuffer', timeout: 180_000 });
    const buf = Buffer.from(res.data);
    console.log(`Downloaded ${(buf.length / 1024 / 1024).toFixed(1)} MB`);
    if (isVideo) {
      await bot.telegram.sendVideo(chatId, { source: buf, filename: 'output.mp4' }, { caption });
    } else {
      await bot.telegram.sendPhoto(chatId, { source: buf, filename: 'output.jpg' }, { caption });
    }
    return;
  } catch (e: any) {
    console.log(`Buffer strategy failed: ${e.message}`);
  }

  // Strategy 2: direct URL
  try {
    if (isVideo) {
      await bot.telegram.sendVideo(chatId, outputUrl, { caption });
    } else {
      await bot.telegram.sendPhoto(chatId, outputUrl, { caption });
    }
    return;
  } catch (e: any) {
    console.log(`URL strategy failed: ${e.message}`);
  }

  // Strategy 3: text link fallback
  await bot.telegram.sendMessage(chatId,
    `✅ Hasil selesai!\n\n📥 Download (link aktif ~1 jam):\n${outputUrl}\n\n${caption}`
  );
}

async function pollForResult(taskId: string, userId: number, maxAttempts = 60): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(10_000);
    const res = await renderfulHttp.get(`${RENDERFUL_BASE}/generations/${taskId}`, {
      headers: { Authorization: `Bearer ${RENDERFUL_API_KEY}` },
    });
    const { status, output, error } = res.data;
    console.log(`[${userId}] Poll ${i + 1}: ${status}`);
    if (status === 'completed') {
      if (!output) throw new Error('Completed tapi tidak ada output');
      return extractOutputUrl(output);
    }
    if (status === 'failed') throw new Error(error || 'Generation gagal di Renderful');
  }
  throw new Error('Timeout: proses terlalu lama (>10 menit)');
}

// ─── Main menu keyboard ───────────────────────────────────────────────────────

function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🎬 Video Motion Control', 'mode_video')],
    [Markup.button.callback('🖼️ Image to Image', 'mode_image')],
  ]);
}

function imageModelKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🤖 GPT Image 1 ($0.02)',  'model_gpt-image-1')],
    [Markup.button.callback('🍌 Banana 2 ($0.02)',     'model_banana-2')],
    [Markup.button.callback('🍌 Banana Pro ($0.04)',   'model_banana-pro')],
    [Markup.button.callback('🌱 Seedream 5 ($0.02)',   'model_seedream-5')],
    [Markup.button.callback('« Kembali',               'back_main')],
  ]);
}

// ─── Commands ─────────────────────────────────────────────────────────────────

bot.start((ctx) => {
  setSession(ctx.from.id, { mode: 'idle' });
  return ctx.reply(
    '👋 Selamat datang di *XclipAI Bot*!\n\nPilih mode generasi:',
    { parse_mode: 'Markdown', ...mainMenuKeyboard() }
  );
});

bot.command('menu', (ctx) => {
  setSession(ctx.from.id, { mode: 'idle' });
  return ctx.reply('Pilih mode generasi:', mainMenuKeyboard());
});

bot.command('cancel', (ctx) => {
  setSession(ctx.from.id, { mode: 'idle' });
  return ctx.reply('✅ Dibatalkan.', mainMenuKeyboard());
});

bot.help((ctx) => {
  return ctx.reply(
    '*Perintah:*\n' +
    '/start — Menu utama\n' +
    '/menu — Tampilkan menu\n' +
    '/cancel — Batalkan proses\n\n' +
    '*Mode Video:*\n' +
    '• Kirim foto karakter → kirim video referensi → tunggu hasil\n' +
    '• Menggunakan Kling 2.6 Pro Motion Control ($0.15)\n\n' +
    '*Mode Image (i2i):*\n' +
    '• Pilih model → kirim foto → tunggu hasil\n' +
    '• GPT Image 1, Banana 2, Banana Pro, Seedream 5',
    { parse_mode: 'Markdown' }
  );
});

// ─── Callback queries (inline buttons) ───────────────────────────────────────

bot.on('callback_query', async (ctx) => {
  const data = (ctx.callbackQuery as any).data as string;
  const userId = ctx.from.id;

  await ctx.answerCbQuery();

  if (data === 'mode_video') {
    setSession(userId, { mode: 'video_wait_image' });
    return ctx.editMessageText(
      '🎬 *Video Motion Control*\n\nKirim *foto karakter* yang ingin dianimasikan.',
      { parse_mode: 'Markdown' }
    );
  }

  if (data === 'mode_image') {
    setSession(userId, { mode: 'idle' });
    return ctx.editMessageText(
      '🖼️ *Image to Image*\n\nPilih model:',
      { parse_mode: 'Markdown', ...imageModelKeyboard() }
    );
  }

  if (data.startsWith('model_')) {
    const model = data.replace('model_', '');
    const modelInfo = IMAGE_MODELS[model];
    if (!modelInfo) {
      return ctx.editMessageText(`❌ Model tidak dikenal: ${model}`, mainMenuKeyboard());
    }
    setSession(userId, { mode: 'img_wait_source', imageModel: model });
    return ctx.editMessageText(
      `🖼️ *${modelInfo.label}* dipilih (${modelInfo.cost}/gambar)\n\nSekarang kirim *foto* yang ingin diproses.`,
      { parse_mode: 'Markdown' }
    );
  }

  if (data === 'back_main') {
    setSession(userId, { mode: 'idle' });
    return ctx.editMessageText('Pilih mode generasi:', mainMenuKeyboard());
  }
});

// ─── Photo handler ────────────────────────────────────────────────────────────

bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);
  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  const fileLink = await ctx.telegram.getFileLink(photo.file_id);
  const fileUrl = fileLink.href;

  // Video mode: save character photo
  if (session.mode === 'video_wait_image') {
    setSession(userId, { characterUrl: fileUrl, mode: 'video_wait_video' });
    return ctx.reply(
      '✅ Foto karakter diterima!\n\nSekarang kirim *video referensi gerakan*.',
      { parse_mode: 'Markdown' }
    );
  }

  // Image-to-image mode: run generation
  if (session.mode === 'img_wait_source') {
    const model = session.imageModel!;
    const modelInfo = IMAGE_MODELS[model];
    setSession(userId, { mode: 'idle' });

    const statusMsg = await ctx.reply(`⏳ Memproses dengan *${modelInfo.label}*...\nHasil dikirim otomatis setelah selesai.`, { parse_mode: 'Markdown' });

    // Fire and forget
    runImageGeneration(ctx.chat.id, userId, statusMsg.message_id, fileUrl, model, modelInfo.label).catch(e =>
      console.error(`[${userId}] Image gen error:`, e.message)
    );
    return;
  }

  // Not in any mode
  return ctx.reply('Pilih mode terlebih dahulu:', mainMenuKeyboard());
});

// ─── Video handler ────────────────────────────────────────────────────────────

bot.on('video', async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);

  if (session.mode !== 'video_wait_video' || !session.characterUrl) {
    return ctx.reply('⚠️ Kirim foto karakter terlebih dahulu.', mainMenuKeyboard());
  }

  setSession(userId, { mode: 'idle' });
  const statusMsg = await ctx.reply('⏳ Mengirim ke Renderful.ai...\nHasil dikirim otomatis (~2-5 menit).');

  runVideoGeneration(ctx.chat.id, userId, statusMsg.message_id, ctx.message.video.file_id, session.characterUrl).catch(e =>
    console.error(`[${userId}] Video gen error:`, e.message)
  );
});

bot.on('document', async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);
  const doc = ctx.message.document;

  if (doc.mime_type?.startsWith('image/')) {
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    if (session.mode === 'video_wait_image') {
      setSession(userId, { characterUrl: fileLink.href, mode: 'video_wait_video' });
      return ctx.reply('✅ Foto diterima! Kirim *video referensi gerakan*.', { parse_mode: 'Markdown' });
    }
    if (session.mode === 'img_wait_source') {
      const model = session.imageModel!;
      const modelInfo = IMAGE_MODELS[model];
      setSession(userId, { mode: 'idle' });
      const statusMsg = await ctx.reply(`⏳ Memproses dengan *${modelInfo.label}*...`, { parse_mode: 'Markdown' });
      runImageGeneration(ctx.chat.id, userId, statusMsg.message_id, fileLink.href, model, modelInfo.label).catch(console.error);
      return;
    }
  }

  if (doc.mime_type?.startsWith('video/') && session.mode === 'video_wait_video' && session.characterUrl) {
    setSession(userId, { mode: 'idle' });
    const statusMsg = await ctx.reply('⏳ Mengirim ke Renderful.ai...');
    runVideoGeneration(ctx.chat.id, userId, statusMsg.message_id, doc.file_id, session.characterUrl).catch(console.error);
    return;
  }

  return ctx.reply('⚠️ Pilih mode terlebih dahulu:', mainMenuKeyboard());
});

// ─── Background: Video generation ────────────────────────────────────────────

async function runVideoGeneration(chatId: number, userId: number, statusMsgId: number, videoFileId: string, imageUrl: string) {
  try {
    const videoFileLink = await bot.telegram.getFileLink(videoFileId);
    console.log(`[${userId}] Video generation started`);

    const genRes = await renderfulHttp.post(`${RENDERFUL_BASE}/generations`, {
      type: 'image-to-video',
      model: 'kling-v2-6-motion-control',
      image_url: imageUrl,
      video_url: videoFileLink.href,
      prompt: 'Transfer motion from reference video to character',
    }, { headers: { Authorization: `Bearer ${RENDERFUL_API_KEY}`, 'Content-Type': 'application/json' } });

    const { id: taskId } = genRes.data;
    if (!taskId) throw new Error(`No task ID: ${JSON.stringify(genRes.data)}`);
    console.log(`[${userId}] Task: ${taskId}`);

    await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
      `⏳ Video diproses (${taskId.slice(0, 8)}...)\nBiasanya 2-5 menit.`
    );

    const outputUrl = await pollForResult(taskId, userId);
    await bot.telegram.editMessageText(chatId, statusMsgId, undefined, '✅ Selesai! Mengirim...');
    await sendResult(chatId, outputUrl, '🎬 Kling 2.6 Motion Control\n\n/menu untuk buat lagi', true);
    await bot.telegram.deleteMessage(chatId, statusMsgId).catch(() => {});
    console.log(`[${userId}] Video done`);
  } catch (err: any) {
    const msg = err?.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`[${userId}] Video error: ${msg}`);
    await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
      `❌ Gagal: ${msg}\n\n/menu untuk coba lagi`
    ).catch(() => bot.telegram.sendMessage(chatId, `❌ Gagal: ${msg}\n\n/menu untuk coba lagi`));
  }
}

// ─── Background: Image generation ────────────────────────────────────────────

async function runImageGeneration(chatId: number, userId: number, statusMsgId: number, imageUrl: string, model: string, modelLabel: string) {
  try {
    console.log(`[${userId}] Image generation: ${model}`);

    const payload = {
      type: 'image-to-image',
      model,
      image_url: imageUrl,
      prompt: 'high quality, photorealistic',
    };
    console.log(`[${userId}] Renderful payload:`, JSON.stringify(payload));

    const genRes = await renderfulHttp.post(`${RENDERFUL_BASE}/generations`, payload,
      { headers: { Authorization: `Bearer ${RENDERFUL_API_KEY}`, 'Content-Type': 'application/json' } }
    );

    console.log(`[${userId}] Renderful response status: ${genRes.status}`);
    console.log(`[${userId}] Renderful response data:`, JSON.stringify(genRes.data));

    const { id: taskId } = genRes.data;
    if (!taskId) throw new Error(`No task ID in response: ${JSON.stringify(genRes.data)}`);
    console.log(`[${userId}] Task: ${taskId}`);

    await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
      `⏳ Diproses dengan ${modelLabel}...\nMohon tunggu.`
    );

    const outputUrl = await pollForResult(taskId, userId);
    await bot.telegram.editMessageText(chatId, statusMsgId, undefined, '✅ Selesai! Mengirim...');
    await sendResult(chatId, outputUrl, `🖼️ Dibuat dengan ${modelLabel}\n\n/menu untuk buat lagi`, false);
    await bot.telegram.deleteMessage(chatId, statusMsgId).catch(() => {});
    console.log(`[${userId}] Image done`);
  } catch (err: any) {
    const msg = err?.response?.data ? JSON.stringify(err.response.data) : err.message;
    console.error(`[${userId}] Image error: ${msg}`);
    await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
      `❌ Gagal: ${msg}\n\n/menu untuk coba lagi`
    ).catch(() => bot.telegram.sendMessage(chatId, `❌ Gagal: ${msg}\n\n/menu untuk coba lagi`));
  }
}

// ─── Launch ───────────────────────────────────────────────────────────────────

bot.launch({ allowedUpdates: ['message', 'callback_query'] });
console.log('✅ Bot berjalan...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
