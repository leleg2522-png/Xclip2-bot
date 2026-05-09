import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import express from 'express';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RENDERFUL_API_KEY = process.env.RENDERFUL_API_KEY;
const RENDERFUL_BASE = 'https://api.renderful.ai/api/v1';
const PORT = parseInt(process.env.PORT || '3000', 10);
// Railway provides RAILWAY_PUBLIC_DOMAIN as the public hostname (no protocol)
const PUBLIC_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN || '';

if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');
if (!RENDERFUL_API_KEY) throw new Error('RENDERFUL_API_KEY is required');
if (!PUBLIC_DOMAIN) console.warn('⚠️ RAILWAY_PUBLIC_DOMAIN not set — image proxy URLs will not work!');

const renderfulHttp = axios.create({ timeout: 30_000 });

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
  'gpt-image-2':      { label: '🤖 GPT Image 2',     cost: '$0.03' },
  'nano-banana-2':    { label: '🍌 Nano Banana 2',    cost: '$0.04' },
  'nano-banana-pro':  { label: '🍌 Nano Banana Pro',  cost: '$0.14' },
  'seedream-5.0-lite':{ label: '🌱 Seedream 5 Lite',  cost: '$0.04' },
};

// ─── Session state ────────────────────────────────────────────────────────────

type Mode =
  | 'idle'
  | 'video_wait_image'
  | 'video_wait_video'
  | 'img_wait_image1'
  | 'img_wait_image2'
  | 'img_wait_prompt';

interface Session {
  mode: Mode;
  imageModel?: string;
  image1Url?: string;
  image2Url?: string;
  characterUrl?: string;
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

function translateError(raw: string): string {
  if (!raw) return 'Error tidak diketahui';
  if (raw.includes('InvalidImage.FrontBody'))
    return '❌ *Foto tidak valid*: Pastikan foto menampilkan *seluruh tubuh dari depan* (bukan close-up wajah).';
  if (raw.includes('InvalidImage.Resolution'))
    return '❌ *Resolusi foto tidak valid*: Gunakan foto dengan resolusi antara 200–4096 piksel.';
  if (raw.includes('InvalidImage.'))
    return `❌ *Foto tidak valid*: ${raw.split(':').slice(1).join(':').trim() || raw}`;
  if (raw.includes('InvalidVideo.NoHuman'))
    return '❌ *Video tidak valid*: Video harus mengandung *manusia yang terlihat jelas*.';
  if (raw.includes('InvalidVideo.FrontBody'))
    return '❌ *Video tidak valid*: Orang dalam video harus *menghadap ke depan*.';
  if (raw.includes('InvalidVideo.Resolution'))
    return '❌ *Resolusi video tidak valid*: Pastikan resolusi video antara 200–2048 piksel.';
  if (raw.includes('InvalidVideo.Duration'))
    return '❌ *Durasi video tidak valid*: Video harus berdurasi *2–30 detik*.';
  if (raw.includes('InvalidVideo.'))
    return `❌ *Video tidak valid*: ${raw.split(':').slice(1).join(':').trim() || raw}`;
  if (raw.includes('InvalidURL'))
    return '❌ *URL tidak dapat diakses*: Renderful tidak bisa mengunduh file. Coba kirim file langsung ke bot.';
  if (raw.includes('InternalError.Algo'))
    return '❌ *Error internal model*: Konten foto/video tidak kompatibel. Coba dengan foto atau video yang berbeda.';
  if (raw.includes('Exhausted balance') || raw.includes('fal.ai'))
    return '❌ *Error backend*: Layanan Renderful sedang bermasalah. Coba lagi beberapa saat.';
  const short = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
  return `❌ Gagal: ${short}`;
}

// ─── Image proxy helpers ───────────────────────────────────────────────────────

function detectMime(buf: Buffer): { mime: string; ext: string } {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47)
    return { mime: 'image/png', ext: 'png' };
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF)
    return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP')
    return { mime: 'image/webp', ext: 'webp' };
  return { mime: 'image/jpeg', ext: 'jpg' };
}

// In-memory cache: token -> { buf, mime }
const imageCache = new Map<string, { buf: Buffer; mime: string; ext: string }>();

function buildProxyUrl(telegramUrl: string): string {
  const token = Buffer.from(telegramUrl).toString('base64url');
  return `https://${PUBLIC_DOMAIN}/imgproxy/${token}`;
}

async function cacheImage(telegramUrl: string): Promise<{ proxyUrl: string; mime: string; ext: string }> {
  const token = Buffer.from(telegramUrl).toString('base64url');
  if (!imageCache.has(token)) {
    const res = await http.get(telegramUrl, { responseType: 'arraybuffer', timeout: 60_000 });
    const buf = Buffer.from(res.data);
    const { mime, ext } = detectMime(buf);
    imageCache.set(token, { buf, mime, ext });
    console.log(`Cached image: ${mime}, ${(buf.length / 1024).toFixed(1)} KB, token=${token.slice(0, 12)}...`);
  }
  const cached = imageCache.get(token)!;
  const proxyUrl = `https://${PUBLIC_DOMAIN}/imgproxy/${token}`;
  return { proxyUrl, mime: cached.mime, ext: cached.ext };
}

// ─── Express proxy server ─────────────────────────────────────────────────────

const app = express();

app.get('/imgproxy/:token', (req, res) => {
  const { token } = req.params;
  const cached = imageCache.get(token);
  if (!cached) {
    res.status(404).send('Not found or expired');
    return;
  }
  res.setHeader('Content-Type', cached.mime);
  res.setHeader('Content-Length', cached.buf.length);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.end(cached.buf);
});

app.get('/health', (_req, res) => res.send('OK'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ HTTP proxy server berjalan di port ${PORT}`);
  if (PUBLIC_DOMAIN) console.log(`🌐 Public domain: https://${PUBLIC_DOMAIN}`);
});

// ─── Result sender ────────────────────────────────────────────────────────────

async function sendResult(chatId: number, outputUrl: string, caption: string, isVideo: boolean) {
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

// ─── Keyboards ────────────────────────────────────────────────────────────────

function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🎬 WAN Animate', 'mode_video')],
    [Markup.button.callback('🖼️ Image to Image', 'mode_image')],
  ]);
}

function imageModelKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🤖 GPT Image 2 ($0.03)',      'model_gpt-image-2')],
    [Markup.button.callback('🍌 Nano Banana 2 ($0.04)',    'model_nano-banana-2')],
    [Markup.button.callback('🍌 Nano Banana Pro ($0.14)',  'model_nano-banana-pro')],
    [Markup.button.callback('🌱 Seedream 5 Lite ($0.04)', 'model_seedream-5.0-lite')],
    [Markup.button.callback('« Kembali',                  'back_main')],
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
    '*🎬 WAN Animate:*\n' +
    '• Langkah: foto karakter → video referensi → tunggu hasil\n' +
    '• Syarat foto: tampak depan penuh, min. 200px\n' +
    '• Syarat video: orang menghadap depan, durasi 2–30 detik, resolusi 200–2048px\n\n' +
    '*🖼️ Image to Image:*\n' +
    '• Langkah: pilih model → kirim gambar 1 → kirim gambar 2 → ketik prompt → tunggu hasil\n' +
    '• Model: GPT Image 2, Banana 2, Banana Pro, Seedream 5',
    { parse_mode: 'Markdown' }
  );
});

// ─── Callback queries ─────────────────────────────────────────────────────────

bot.on('callback_query', async (ctx) => {
  const data = (ctx.callbackQuery as any).data as string;
  const userId = ctx.from.id;
  await ctx.answerCbQuery();

  if (data === 'mode_video') {
    setSession(userId, { mode: 'video_wait_image' });
    return ctx.editMessageText(
      '🎬 *WAN Animate* — Transfer gerakan ke karakter\n\n' +
      '*Langkah 1:* Kirim *foto karakter* yang ingin dianimasikan.\n\n' +
      '⚠️ *Syarat foto:*\n' +
      '• Tampilkan seluruh tubuh dari depan\n' +
      '• Bukan close-up wajah\n' +
      '• Resolusi minimal 200px',
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
    if (!modelInfo) return ctx.editMessageText(`❌ Model tidak dikenal: ${model}`, mainMenuKeyboard());
    setSession(userId, { mode: 'img_wait_image1', imageModel: model, image1Url: undefined, image2Url: undefined });
    return ctx.editMessageText(
      `🖼️ *${modelInfo.label}* (${modelInfo.cost})\n\n` +
      '*Langkah 1 dari 3:* Kirim *gambar pertama* (gambar yang ingin diedit).',
      { parse_mode: 'Markdown' }
    );
  }

  if (data === 'back_main') {
    setSession(userId, { mode: 'idle' });
    return ctx.editMessageText('Pilih mode generasi:', mainMenuKeyboard());
  }
});

// ─── Shared photo/image handler ───────────────────────────────────────────────

async function handleImageInput(ctx: any, fileUrl: string) {
  const userId = ctx.from.id;
  const session = getSession(userId);

  // WAN Animate: step 1 — save character photo
  if (session.mode === 'video_wait_image') {
    setSession(userId, { characterUrl: fileUrl, mode: 'video_wait_video' });
    return ctx.reply(
      '✅ Foto karakter diterima!\n\n' +
      '*Langkah 2:* Kirim *video referensi gerakan*.\n\n' +
      '⚠️ *Syarat video:*\n' +
      '• Ada orang menghadap ke depan\n' +
      '• Durasi 2–30 detik\n' +
      '• Resolusi 200–2048px',
      { parse_mode: 'Markdown' }
    );
  }

  // Image-to-image: step 1 — first image
  if (session.mode === 'img_wait_image1') {
    setSession(userId, { image1Url: fileUrl, mode: 'img_wait_image2' });
    return ctx.reply(
      `✅ Gambar 1 diterima!\n\n` +
      `*Langkah 2 dari 3:* Kirim *gambar kedua* (referensi/mask untuk edit).`,
      { parse_mode: 'Markdown' }
    );
  }

  // Image-to-image: step 2 — second image
  if (session.mode === 'img_wait_image2') {
    setSession(userId, { image2Url: fileUrl, mode: 'img_wait_prompt' });
    return ctx.reply(
      '✅ Gambar 2 diterima!\n\n' +
      '*Langkah 3 dari 3:* Ketik *prompt* — apa yang ingin diubah?\n\n' +
      '_Contoh: "ganti baju jadi merah" atau "ubah background jadi pantai"_',
      { parse_mode: 'Markdown' }
    );
  }

  return ctx.reply('Pilih mode terlebih dahulu:', mainMenuKeyboard());
}

// ─── Photo handler ────────────────────────────────────────────────────────────

bot.on('photo', async (ctx) => {
  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  const fileLink = await ctx.telegram.getFileLink(photo.file_id);
  await handleImageInput(ctx, fileLink.href);
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
  runVideoGeneration(ctx.chat.id, userId, statusMsg.message_id, ctx.message.video.file_id, session.characterUrl)
    .catch(e => console.error(`[${userId}] Video gen error:`, e.message));
});

// ─── Text handler (for prompt) ────────────────────────────────────────────────

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);

  if (session.mode === 'img_wait_prompt') {
    const prompt = ctx.message.text.trim();
    if (!prompt) return ctx.reply('Prompt tidak boleh kosong. Ketik apa yang ingin diubah:');

    const model = session.imageModel!;
    const modelInfo = IMAGE_MODELS[model];
    const image1Url = session.image1Url!;
    const image2Url = session.image2Url!;
    setSession(userId, { mode: 'idle' });

    const statusMsg = await ctx.reply(
      `⏳ Memproses dengan *${modelInfo.label}*...\nHasil dikirim otomatis setelah selesai.`,
      { parse_mode: 'Markdown' }
    );

    runImageGeneration(ctx.chat.id, userId, statusMsg.message_id, image1Url, image2Url, prompt, model, modelInfo.label)
      .catch(e => console.error(`[${userId}] Image gen error:`, e.message));
    return;
  }
});

// ─── Document handler ─────────────────────────────────────────────────────────

bot.on('document', async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);
  const doc = ctx.message.document;

  if (doc.mime_type?.startsWith('image/')) {
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    await handleImageInput(ctx, fileLink.href);
    return;
  }

  if (doc.mime_type?.startsWith('video/') && session.mode === 'video_wait_video' && session.characterUrl) {
    setSession(userId, { mode: 'idle' });
    const statusMsg = await ctx.reply('⏳ Mengirim ke Renderful.ai...');
    runVideoGeneration(ctx.chat.id, userId, statusMsg.message_id, doc.file_id, session.characterUrl)
      .catch(console.error);
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
      type: 'video-to-video',
      model: 'wan-2.2-animate',
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
    await sendResult(chatId, outputUrl, '🎬 WAN 2.2 Animate\n\n/menu untuk buat lagi', true);
    await bot.telegram.deleteMessage(chatId, statusMsgId).catch(() => {});
    console.log(`[${userId}] Video done`);
  } catch (err: any) {
    const rawMsg = err?.response?.data?.error ?? err?.response?.data ?? err.message ?? String(err);
    const raw = typeof rawMsg === 'string' ? rawMsg : JSON.stringify(rawMsg);
    console.error(`[${userId}] Video error: ${raw}`);
    const friendly = translateError(raw);
    await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
      `${friendly}\n\n/menu untuk coba lagi`, { parse_mode: 'Markdown' }
    ).catch(() => bot.telegram.sendMessage(chatId, `${friendly}\n\n/menu untuk coba lagi`, { parse_mode: 'Markdown' }));
  }
}

// ─── Background: Image generation ────────────────────────────────────────────

async function runImageGeneration(
  chatId: number, userId: number, statusMsgId: number,
  image1Url: string, image2Url: string, prompt: string,
  model: string, modelLabel: string
) {
  try {
    console.log(`[${userId}] Image generation: ${model}`);

    // Download & cache both images, serve via proxy with correct MIME type
    const [img1, img2] = await Promise.all([
      cacheImage(image1Url),
      cacheImage(image2Url),
    ]);
    console.log(`[${userId}] img1 proxy: ${img1.proxyUrl} (${img1.mime})`);
    console.log(`[${userId}] img2 proxy: ${img2.proxyUrl} (${img2.mime})`);

    const payload = {
      type: 'image-to-image',
      model,
      image_url: img1.proxyUrl,
      mask_url: img2.proxyUrl,
      prompt,
    };
    console.log(`[${userId}] Renderful payload:`, JSON.stringify(payload));

    const genRes = await renderfulHttp.post(`${RENDERFUL_BASE}/generations`, payload,
      { headers: { Authorization: `Bearer ${RENDERFUL_API_KEY}`, 'Content-Type': 'application/json' } }
    );

    console.log(`[${userId}] Response:`, JSON.stringify(genRes.data));
    const { id: taskId } = genRes.data;
    if (!taskId) throw new Error(`No task ID: ${JSON.stringify(genRes.data)}`);

    await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
      `⏳ Diproses dengan ${modelLabel}...\nMohon tunggu.`
    );

    const outputUrl = await pollForResult(taskId, userId);
    await bot.telegram.editMessageText(chatId, statusMsgId, undefined, '✅ Selesai! Mengirim...');
    await sendResult(chatId, outputUrl, `🖼️ Dibuat dengan ${modelLabel}\n\n/menu untuk buat lagi`, false);
    await bot.telegram.deleteMessage(chatId, statusMsgId).catch(() => {});
    console.log(`[${userId}] Image done`);
  } catch (err: any) {
    const rawMsg = err?.response?.data?.error ?? err?.response?.data ?? err.message ?? String(err);
    const raw = typeof rawMsg === 'string' ? rawMsg : JSON.stringify(rawMsg);
    console.error(`[${userId}] Image error: ${raw}`);
    const friendly = translateError(raw);
    await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
      `${friendly}\n\n/menu untuk coba lagi`, { parse_mode: 'Markdown' }
    ).catch(() => bot.telegram.sendMessage(chatId, `${friendly}\n\n/menu untuk coba lagi`, { parse_mode: 'Markdown' }));
  }
}

// ─── Launch ───────────────────────────────────────────────────────────────────

bot.launch({ allowedUpdates: ['message', 'callback_query'] });
console.log('✅ Bot berjalan...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
