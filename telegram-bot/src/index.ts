import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import FormData from 'form-data';
import { Client, Pool } from 'pg';
import bcrypt from 'bcryptjs';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RENDERFUL_API_KEY = process.env.RENDERFUL_API_KEY;
const RENDERFUL_BASE = 'https://api.renderful.ai/api/v1';
const DATABASE_URL = process.env.RAILWAY_DATABASE_URL;

if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');
if (!RENDERFUL_API_KEY) throw new Error('RENDERFUL_API_KEY is required');
if (!DATABASE_URL) throw new Error('RAILWAY_DATABASE_URL is required');

const renderfulHttp = axios.create({ timeout: 30_000 });

// Direct HTTP client for Telegram downloads — no proxy needed, Railway can reach Telegram directly
const telegramHttp = axios.create({ timeout: 60_000 });

const PROXY_URL = process.env.PROXY_URL;
if (PROXY_URL) {
  console.log(`ℹ️ PROXY_URL set but not used for Telegram downloads (Railway can reach Telegram directly)`);
}

// ─── Database ─────────────────────────────────────────────────────────────────

const db = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
console.log('✅ Database pool initialized');

async function findUserByUsername(username: string) {
  const res = await db.query('SELECT * FROM users WHERE username = $1 LIMIT 1', [username]);
  return res.rows[0] || null;
}

async function checkActiveSubscription(userId: number): Promise<boolean> {
  const res = await db.query(
    `SELECT id FROM subscriptions 
     WHERE user_id = $1 AND status = 'active' AND expired_at > NOW()
     LIMIT 1`,
    [userId]
  );
  return res.rows.length > 0;
}

const bot = new Telegraf(BOT_TOKEN);

// ─── Model definitions ────────────────────────────────────────────────────────

const IMAGE_MODELS: Record<string, { label: string; cost: string; apiId?: string }> = {
  'gpt-image-2':       { label: '🤖 GPT Image 2',     cost: '$0.03' },
  'nano-banana-2-i2i': { label: '🍌 Nano Banana 2',   cost: '$0.04' },
  'nano-banana-pro':   { label: '🍌 Nano Banana Pro',  cost: '$0.14' },
  'seedream-5.0-lite': { label: '🌱 Seedream 5 Lite',  cost: '$0.04' },
};

// ─── Session state ────────────────────────────────────────────────────────────

type Mode =
  | 'idle'
  | 'login_wait_username'
  | 'login_wait_password'
  | 'video_wait_image'
  | 'video_wait_video'
  | 'kling_wait_image'
  | 'kling_wait_video'
  | 'img_wait_image1'
  | 'img_wait_image2'
  | 'img_wait_ratio'
  | 'img_wait_resolution'
  | 'img_wait_prompt';

interface Session {
  mode: Mode;
  dbUserId?: number;
  dbUsername?: string;
  loginTempUsername?: string;
  imageModel?: string;
  image1Url?: string;
  image2Url?: string;
  aspectRatio?: string;
  resolution?: string;
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

function isLoggedIn(userId: number): boolean {
  return !!getSession(userId).dbUserId;
}

async function requireLoginAndSub(ctx: any): Promise<boolean> {
  const userId = ctx.from.id;
  const session = getSession(userId);

  if (!session.dbUserId) {
    await ctx.reply(
      '🔒 Kamu belum login.\n\nKetik /login untuk masuk dengan akun XclipAI kamu.',
    );
    return false;
  }

  const active = await checkActiveSubscription(session.dbUserId);
  if (!active) {
    await ctx.reply(
      `❌ Langganan kamu tidak aktif atau sudah expired.\n\n` +
      `Silakan perpanjang langganan di dashboard XclipAI untuk bisa generate.\n\n` +
      `Login sebagai: *${session.dbUsername}*`,
      { parse_mode: 'Markdown' }
    );
    return false;
  }

  return true;
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
    return '❌ *File tidak dapat diakses*: Gagal mengunduh file. Coba kirim file langsung ke bot.';
  if (raw.includes('InternalError.Algo'))
    return '❌ *Error internal model*: Konten foto/video tidak kompatibel. Coba dengan foto atau video yang berbeda.';
  if (raw.includes('Exhausted balance') || raw.includes('fal.ai'))
    return '❌ *Error backend*: Layanan sedang bermasalah. Coba lagi beberapa saat.';
  const short = raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
  return `❌ Gagal: ${short}`;
}

// ─── Convert Telegram image URL to base64 data URI ───────────────────────────

function detectMime(buf: Buffer): { mime: string; ext: string } {
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47)
    return { mime: 'image/png', ext: 'png' };
  if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF)
    return { mime: 'image/jpeg', ext: 'jpg' };
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP')
    return { mime: 'image/webp', ext: 'webp' };
  return { mime: 'image/jpeg', ext: 'jpg' };
}

async function toDataUri(telegramUrl: string): Promise<string> {
  console.log(`Downloading from Telegram: ${telegramUrl}`);
  let res;
  try {
    res = await telegramHttp.get(telegramUrl, { responseType: 'arraybuffer', timeout: 60_000 });
  } catch (e: any) {
    console.error(`❌ Download gagal: ${e.message}`);
    throw new Error(`Gagal download dari Telegram: ${e.message}`);
  }
  const buf = Buffer.from(res.data);
  const { mime } = detectMime(buf);
  const b64 = buf.toString('base64');
  console.log(`  ✅ ${mime}, ${(buf.length / 1024).toFixed(1)} KB → base64 ${(b64.length / 1024).toFixed(0)} KB`);
  return `data:${mime};base64,${b64}`;
}

// ─── Result sender ────────────────────────────────────────────────────────────

async function sendResult(chatId: number, outputUrl: string, caption: string, isVideo: boolean) {
  try {
    const res = await telegramHttp.get(outputUrl, { responseType: 'arraybuffer', timeout: 180_000 });
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
    if (status === 'failed') throw new Error(error || 'Generation gagal');
  }
  throw new Error('Timeout: proses terlalu lama (>10 menit)');
}

// ─── Keyboards ────────────────────────────────────────────────────────────────

function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🎬 WAN Animate', 'mode_video')],
    [Markup.button.callback('🕹️ Kling Motion Control', 'mode_kling')],
    [Markup.button.callback('🖼️ Image to Image', 'mode_image')],
  ]);
}

function imageModelKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🤖 GPT Image 2 ($0.03)',      'model_gpt-image-2')],
    [Markup.button.callback('🍌 Nano Banana 2 ($0.04)',    'model_nano-banana-2-i2i')],
    [Markup.button.callback('🍌 Nano Banana Pro ($0.14)',  'model_nano-banana-pro')],
    [Markup.button.callback('🌱 Seedream 5 Lite ($0.04)', 'model_seedream-5.0-lite')],
    [Markup.button.callback('« Kembali',                  'back_main')],
  ]);
}

function aspectRatioKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('⬛ 1:1',  'ratio_1:1'),
      Markup.button.callback('🖥️ 16:9', 'ratio_16:9'),
      Markup.button.callback('📱 9:16', 'ratio_9:16'),
    ],
    [
      Markup.button.callback('🗾 4:3',  'ratio_4:3'),
      Markup.button.callback('📄 3:4',  'ratio_3:4'),
      Markup.button.callback('🌅 3:2',  'ratio_3:2'),
    ],
    [
      Markup.button.callback('📷 2:3',  'ratio_2:3'),
      Markup.button.callback('📸 4:5',  'ratio_4:5'),
      Markup.button.callback('🖼️ 5:4',  'ratio_5:4'),
    ],
    [
      Markup.button.callback('🎬 21:9', 'ratio_21:9'),
    ],
  ]);
}

function resolutionKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('🔹 1K  (cepat)',    'res_1k'),
      Markup.button.callback('🔷 2K  (standar)',  'res_2k'),
      Markup.button.callback('💠 4K  (terbaik)',  'res_4k'),
    ],
  ]);
}

// ─── Commands ─────────────────────────────────────────────────────────────────

bot.start((ctx) => {
  const session = getSession(ctx.from.id);
  setSession(ctx.from.id, { mode: 'idle' });
  if (session.dbUserId) {
    return ctx.reply(
      `👋 Selamat datang kembali, *${session.dbUsername}*!\n\nPilih mode generasi:`,
      { parse_mode: 'Markdown', ...mainMenuKeyboard() }
    );
  }
  return ctx.reply(
    '👋 Selamat datang di *XclipAI Bot*!\n\n' +
    '🔒 Kamu perlu login terlebih dahulu.\n\n' +
    'Ketik /login untuk masuk dengan akun XclipAI kamu.',
    { parse_mode: 'Markdown' }
  );
});

bot.command('menu', async (ctx) => {
  if (!await requireLoginAndSub(ctx)) return;
  setSession(ctx.from.id, { mode: 'idle' });
  return ctx.reply('Pilih mode generasi:', mainMenuKeyboard());
});

bot.command('login', (ctx) => {
  const session = getSession(ctx.from.id);
  if (session.dbUserId) {
    return ctx.reply(
      `✅ Kamu sudah login sebagai *${session.dbUsername}*.\n\nKetik /logout untuk keluar.`,
      { parse_mode: 'Markdown' }
    );
  }
  setSession(ctx.from.id, { mode: 'login_wait_username' });
  return ctx.reply('🔐 *Login XclipAI*\n\nMasukkan *username* kamu:', { parse_mode: 'Markdown' });
});

bot.command('logout', (ctx) => {
  const session = getSession(ctx.from.id);
  const name = session.dbUsername;
  setSession(ctx.from.id, { mode: 'idle', dbUserId: undefined, dbUsername: undefined, loginTempUsername: undefined });
  return ctx.reply(`✅ Berhasil logout${name ? ` dari akun *${name}*` : ''}.\n\nKetik /login untuk masuk kembali.`, { parse_mode: 'Markdown' });
});

bot.command('status', async (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session.dbUserId) {
    return ctx.reply('🔒 Belum login. Ketik /login untuk masuk.');
  }
  const active = await checkActiveSubscription(session.dbUserId);
  return ctx.reply(
    `👤 *Akun:* ${session.dbUsername}\n` +
    `📦 *Langganan:* ${active ? '✅ Aktif' : '❌ Tidak aktif / expired'}`,
    { parse_mode: 'Markdown' }
  );
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
    '*🕹️ Kling Motion Control:*\n' +
    '• Transfer gerakan dari video referensi ke karakter dengan kualitas sinematik\n' +
    '• Langkah: foto karakter → video referensi → tunggu hasil\n' +
    '• Syarat foto: tampak depan penuh, min. 300px, maks 10MB\n' +
    '• Syarat video: orang terlihat jelas, durasi 2–30 detik, maks 100MB\n\n' +
    '*🖼️ Image to Image:*\n' +
    '• Langkah: pilih model → kirim gambar 1 (sumber) → kirim gambar 2 (referensi/style) → ketik prompt → tunggu hasil\n' +
    '• Model: GPT Image 2, Nano Banana 2, Nano Banana Pro, Seedream 5 Lite',
    { parse_mode: 'Markdown' }
  );
});

// ─── Callback queries ─────────────────────────────────────────────────────────

bot.on('callback_query', async (ctx) => {
  const data = (ctx.callbackQuery as any).data as string;
  const userId = ctx.from.id;
  await ctx.answerCbQuery();

  if (data !== 'back_main' && !['ratio_', 'res_'].some(p => data.startsWith(p))) {
    if (!await requireLoginAndSub(ctx)) return;
  }

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

  if (data === 'mode_kling') {
    setSession(userId, { mode: 'kling_wait_image' });
    return ctx.editMessageText(
      '🕹️ *Kling Motion Control* — Transfer gerakan sinematik ke karakter\n\n' +
      '*Langkah 1:* Kirim *foto karakter* yang ingin dianimasikan.\n\n' +
      '⚠️ *Syarat foto:*\n' +
      '• Tampilkan seluruh tubuh dari depan\n' +
      '• Bukan close-up wajah\n' +
      '• Resolusi min. 300px, maks 10MB\n' +
      '• Format: JPG, PNG',
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
    const step1Text = model === 'nano-banana-2-i2i'
      ? `🖼️ *${modelInfo.label}* (${modelInfo.cost})\n\n` +
        '*Langkah 1 dari 5:* Kirim *gambar utama* (poster/foto yang ingin diedit karakternya).'
      : `🖼️ *${modelInfo.label}* (${modelInfo.cost})\n\n` +
        '*Langkah 1 dari 3:* Kirim *gambar pertama* (gambar sumber yang ingin diedit).';
    return ctx.editMessageText(step1Text, { parse_mode: 'Markdown' });
  }

  if (data.startsWith('ratio_')) {
    const ratio = data.replace('ratio_', '');
    setSession(userId, { aspectRatio: ratio, mode: 'img_wait_resolution' });
    return ctx.editMessageText(
      `✅ Rasio dipilih: *${ratio}*\n\n` +
      '*Langkah 4 dari 5:* Pilih *resolusi output*:',
      { parse_mode: 'Markdown', ...resolutionKeyboard() }
    );
  }

  if (data.startsWith('res_')) {
    const resolution = data.replace('res_', '');
    setSession(userId, { resolution, mode: 'img_wait_prompt' });
    const resLabel: Record<string, string> = { '1k': '1K', '2k': '2K', '4k': '4K' };
    return ctx.editMessageText(
      `✅ Resolusi dipilih: *${resLabel[resolution] ?? resolution}*\n\n` +
      '*Langkah 5 dari 5:* Ketik *prompt* — apa yang ingin dilakukan?\n\n' +
      '💡 *Tips prompt:*\n' +
      '• Ganti karakter: _"ganti karakter di gambar utama dengan orang dari foto referensi"_\n' +
      '• Ganti wajah saja: _"ganti wajah orang di gambar utama dengan wajah dari foto referensi, pertahankan pose, pakaian, dan background"_\n' +
      '• Ganti outfit: _"pakaikan outfit dari foto referensi ke orang di gambar utama"_',
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

  if (session.mode === 'kling_wait_image') {
    setSession(userId, { characterUrl: fileUrl, mode: 'kling_wait_video' });
    return ctx.reply(
      '✅ Foto karakter diterima!\n\n' +
      '*Langkah 2:* Kirim *video referensi gerakan*.\n\n' +
      '⚠️ *Syarat video:*\n' +
      '• Orang terlihat jelas dalam video\n' +
      '• Durasi 2–30 detik\n' +
      '• Maks ukuran file: 10MB',
      { parse_mode: 'Markdown' }
    );
  }

  if (session.mode === 'img_wait_image1') {
    const isNanoBanana2 = session.imageModel === 'nano-banana-2-i2i';
    setSession(userId, { image1Url: fileUrl, mode: 'img_wait_image2' });
    const step2Text = isNanoBanana2
      ? '✅ Gambar utama diterima!\n\n' +
        '*Langkah 2 dari 5:* Kirim *foto karakter referensi* (orang yang ingin dimasukkan ke gambar utama).'
      : '✅ Gambar pertama diterima!\n\n' +
        '*Langkah 2 dari 3:* Kirim *gambar kedua* (gambar referensi/style).';
    return ctx.reply(step2Text, { parse_mode: 'Markdown' });
  }

  if (session.mode === 'img_wait_image2') {
    const model = session.imageModel;
    const isNanoBanana2 = model === 'nano-banana-2-i2i';

    if (isNanoBanana2) {
      setSession(userId, { image2Url: fileUrl, mode: 'img_wait_ratio' });
      return ctx.reply(
        '✅ Gambar referensi diterima!\n\n' +
        '*Langkah 3 dari 5:* Pilih *rasio output*:',
        { parse_mode: 'Markdown', ...aspectRatioKeyboard() }
      );
    }

    setSession(userId, { image2Url: fileUrl, mode: 'img_wait_prompt' });
    return ctx.reply(
      '✅ Gambar kedua diterima!\n\n' +
      '*Langkah 3 dari 3:* Ketik *prompt* — apa yang ingin dilakukan?\n\n' +
      '_Contoh: "ganti baju jadi merah", "ubah background jadi pantai", "terapkan style gambar kedua"_',
      { parse_mode: 'Markdown' }
    );
  }

  return ctx.reply('Pilih mode terlebih dahulu:', mainMenuKeyboard());
}

// ─── Photo handler ────────────────────────────────────────────────────────────

bot.on('photo', async (ctx) => {
  if (!await requireLoginAndSub(ctx)) return;
  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  const fileLink = await ctx.telegram.getFileLink(photo.file_id);
  await handleImageInput(ctx, fileLink.href);
});

// ─── Video handler ────────────────────────────────────────────────────────────

bot.on('video', async (ctx) => {
  if (!await requireLoginAndSub(ctx)) return;
  const userId = ctx.from.id;
  const session = getSession(userId);

  if (session.mode === 'kling_wait_video' && session.characterUrl) {
    setSession(userId, { mode: 'idle' });
    const statusMsg = await ctx.reply('⏳ Memproses Kling Motion Control...\nHasil dikirim otomatis (~2-5 menit).');
    runKlingMotionControl(ctx.chat.id, userId, statusMsg.message_id, ctx.message.video.file_id, session.characterUrl)
      .catch(e => console.error(`[${userId}] Kling gen error:`, e.message));
    return;
  }

  if (session.mode !== 'video_wait_video' || !session.characterUrl) {
    return ctx.reply('⚠️ Kirim foto karakter terlebih dahulu.', mainMenuKeyboard());
  }
  setSession(userId, { mode: 'idle' });
  const statusMsg = await ctx.reply('⏳ Memproses animasi...\nHasil dikirim otomatis (~2-5 menit).');
  runVideoGeneration(ctx.chat.id, userId, statusMsg.message_id, ctx.message.video.file_id, session.characterUrl)
    .catch(e => console.error(`[${userId}] Video gen error:`, e.message));
});

// ─── Text handler ─────────────────────────────────────────────────────────────

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);

  // ── Login flow ──
  if (session.mode === 'login_wait_username') {
    const username = ctx.message.text.trim();
    setSession(userId, { loginTempUsername: username, mode: 'login_wait_password' });
    return ctx.reply('🔑 Masukkan *password* kamu:', { parse_mode: 'Markdown' });
  }

  if (session.mode === 'login_wait_password') {
    const password = ctx.message.text.trim();
    const username = session.loginTempUsername!;
    setSession(userId, { mode: 'idle', loginTempUsername: undefined });

    try {
      const user = await findUserByUsername(username);
      if (!user) {
        return ctx.reply('❌ Username tidak ditemukan. Coba lagi dengan /login');
      }
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        return ctx.reply('❌ Password salah. Coba lagi dengan /login');
      }
      setSession(userId, { dbUserId: user.id, dbUsername: user.username });
      const active = await checkActiveSubscription(user.id);
      if (!active) {
        return ctx.reply(
          `✅ Login berhasil sebagai *${user.username}*!\n\n` +
          `⚠️ Tapi langganan kamu tidak aktif atau sudah expired.\n` +
          `Perpanjang langganan di dashboard XclipAI untuk bisa generate.`,
          { parse_mode: 'Markdown' }
        );
      }
      return ctx.reply(
        `✅ Login berhasil! Selamat datang, *${user.username}*! 🎉\n\n` +
        `📦 Langganan: *Aktif*\n\nPilih mode generasi:`,
        { parse_mode: 'Markdown', ...mainMenuKeyboard() }
      );
    } catch (e: any) {
      console.error(`[${userId}] Login error:`, e.message);
      return ctx.reply('❌ Terjadi kesalahan saat login. Coba lagi nanti.');
    }
  }

  // ── Image prompt ──
  if (session.mode === 'img_wait_prompt') {
    if (!await requireLoginAndSub(ctx)) return;
    const prompt = ctx.message.text.trim();
    if (!prompt) return ctx.reply('Prompt tidak boleh kosong. Ketik apa yang ingin dilakukan:');

    const model = session.imageModel!;
    const modelInfo = IMAGE_MODELS[model];
    const image1Url = session.image1Url!;
    const image2Url = session.image2Url!;
    const aspectRatio = session.aspectRatio ?? '1:1';
    const resolution = session.resolution ?? '1k';
    setSession(userId, { mode: 'idle' });

    const resLabel: Record<string, string> = { '1k': '1K', '2k': '2K', '4k': '4K' };
    const infoLabel = model === 'nano-banana-2-i2i'
      ? ` • Rasio: ${aspectRatio} • Resolusi: ${resLabel[resolution] ?? resolution}`
      : '';
    const statusMsg = await ctx.reply(
      `⏳ Memproses dengan *${modelInfo.label}*...${infoLabel}\nHasil dikirim otomatis setelah selesai.`,
      { parse_mode: 'Markdown' }
    );

    runImageGeneration(ctx.chat.id, userId, statusMsg.message_id, image1Url, image2Url, prompt, model, modelInfo.label, aspectRatio, resolution)
      .catch(e => console.error(`[${userId}] Image gen error:`, e.message));
    return;
  }
});

// ─── Document handler ─────────────────────────────────────────────────────────

bot.on('document', async (ctx) => {
  if (!await requireLoginAndSub(ctx)) return;
  const userId = ctx.from.id;
  const session = getSession(userId);
  const doc = ctx.message.document;

  if (doc.mime_type?.startsWith('image/')) {
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    await handleImageInput(ctx, fileLink.href);
    return;
  }

  if (doc.mime_type?.startsWith('video/') && session.mode === 'kling_wait_video' && session.characterUrl) {
    setSession(userId, { mode: 'idle' });
    const statusMsg = await ctx.reply('⏳ Memproses Kling Motion Control...\nHasil dikirim otomatis (~2-5 menit).');
    runKlingMotionControl(ctx.chat.id, userId, statusMsg.message_id, doc.file_id, session.characterUrl)
      .catch(console.error);
    return;
  }

  if (doc.mime_type?.startsWith('video/') && session.mode === 'video_wait_video' && session.characterUrl) {
    setSession(userId, { mode: 'idle' });
    const statusMsg = await ctx.reply('⏳ Memproses animasi...\nHasil dikirim otomatis (~2-5 menit).');
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

// ─── Background: Kling Motion Control ────────────────────────────────────────

async function runKlingMotionControl(chatId: number, userId: number, statusMsgId: number, videoFileId: string, imageUrl: string) {
  try {
    const videoFileLink = await bot.telegram.getFileLink(videoFileId);
    console.log(`[${userId}] Kling Motion Control started`);
    console.log(`[${userId}] Image URL: ${imageUrl}`);
    console.log(`[${userId}] Video URL: ${videoFileLink.href}`);

    const payload = {
      type: 'video-to-video',
      model: 'kling-v2-6-motion-control',
      image_url: imageUrl,
      video_url: videoFileLink.href,
      prompt: 'Cinematic quality, smooth motion transfer, preserve character identity',
      character_orientation: 'video',
      keep_original_sound: false,
    };

    console.log(`[${userId}] Sending to Renderful: ${JSON.stringify(payload)}`);

    const genRes = await renderfulHttp.post(`${RENDERFUL_BASE}/generations`, payload,
      { headers: { Authorization: `Bearer ${RENDERFUL_API_KEY}`, 'Content-Type': 'application/json' } }
    );

    console.log(`[${userId}] Renderful Kling response: ${JSON.stringify(genRes.data)}`);
    const { id: taskId } = genRes.data;
    if (!taskId) throw new Error(`No task ID: ${JSON.stringify(genRes.data)}`);

    await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
      `⏳ Kling Motion Control diproses (${taskId.slice(0, 8)}...)\nBiasanya 2-5 menit.`
    );

    const outputUrl = await pollForResult(taskId, userId);
    await bot.telegram.editMessageText(chatId, statusMsgId, undefined, '✅ Selesai! Mengirim...');
    await sendResult(chatId, outputUrl, '🕹️ Kling 2.6 Pro Motion Control\n\n/menu untuk buat lagi', true);
    await bot.telegram.deleteMessage(chatId, statusMsgId).catch(() => {});
    console.log(`[${userId}] Kling Motion Control done`);
  } catch (err: any) {
    const rawMsg = err?.response?.data?.error ?? err?.response?.data ?? err.message ?? String(err);
    const raw = typeof rawMsg === 'string' ? rawMsg : JSON.stringify(rawMsg);
    console.error(`[${userId}] Kling error: ${raw}`);
    const friendly = translateError(raw);
    await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
      `${friendly}\n\n/menu untuk coba lagi`, { parse_mode: 'Markdown' }
    ).catch(() => bot.telegram.sendMessage(chatId, `${friendly}\n\n/menu untuk coba lagi`, { parse_mode: 'Markdown' }));
  }
}

// ─── Background: Image generation ────────────────────────────────────────────

async function downloadBuffer(url: string): Promise<{ buf: Buffer; mime: string; ext: string }> {
  const res = await telegramHttp.get(url, { responseType: 'arraybuffer', timeout: 60_000 });
  const buf = Buffer.from(res.data);
  const { mime, ext } = detectMime(buf);
  return { buf, mime, ext };
}

async function runImageGeneration(
  chatId: number, userId: number, statusMsgId: number,
  image1Url: string, image2Url: string, prompt: string,
  model: string, modelLabel: string, aspectRatio: string = '1:1', resolution: string = '1k'
) {
  try {
    console.log(`[${userId}] Image generation: ${model}`);
    console.log(`[${userId}] image1: ${image1Url}`);
    console.log(`[${userId}] image2: ${image2Url}`);

    let taskId: string;

    if (model === 'nano-banana-2-i2i') {
      console.log(`[${userId}] Downloading images for Nano Banana 2...`);
      const [img1, img2] = await Promise.all([
        downloadBuffer(image1Url),
        downloadBuffer(image2Url),
      ]);
      console.log(`[${userId}] img1: ${img1.mime} ${(img1.buf.length / 1024).toFixed(1)}KB`);
      console.log(`[${userId}] img2: ${img2.mime} ${(img2.buf.length / 1024).toFixed(1)}KB`);

      const enhancedPrompt = prompt.trim();
      console.log(`[${userId}] Prompt: ${enhancedPrompt}`);
      console.log(`[${userId}] Aspect ratio: ${aspectRatio}, Resolution: ${resolution}`);

      let genRes: any;

      // Strategy 1: image (source) + reference_images array (correct Nano Banana 2 params per docs)
      try {
        console.log(`[${userId}] Trying image + reference_images JSON...`);
        const b64img1 = `data:${img1.mime};base64,${img1.buf.toString('base64')}`;
        const b64img2 = `data:${img2.mime};base64,${img2.buf.toString('base64')}`;
        genRes = await renderfulHttp.post(`${RENDERFUL_BASE}/generations`, {
          type: 'image-to-image',
          model: 'nano-banana-2-i2i',
          prompt: enhancedPrompt,
          image: b64img1,
          reference_images: [b64img2],
          aspect_ratio: aspectRatio,
          resolution,
        }, { headers: { Authorization: `Bearer ${RENDERFUL_API_KEY}`, 'Content-Type': 'application/json' } });
        console.log(`[${userId}] reference_images strategy OK: ${JSON.stringify(genRes.data)}`);
      } catch (e1: any) {
        const e1msg = e1?.response?.data ? JSON.stringify(e1.response.data) : e1.message;
        console.log(`[${userId}] reference_images failed (${e1msg}), trying image_url + reference_image_url...`);

        // Strategy 2: image_url + reference_image_url fallback
        try {
          genRes = await renderfulHttp.post(`${RENDERFUL_BASE}/generations`, {
            type: 'image-to-image',
            model: 'nano-banana-2-i2i',
            prompt: enhancedPrompt,
            image_url: image1Url,
            reference_image_url: image2Url,
            aspect_ratio: aspectRatio,
            resolution,
          }, { headers: { Authorization: `Bearer ${RENDERFUL_API_KEY}`, 'Content-Type': 'application/json' } });
          console.log(`[${userId}] image_url strategy OK: ${JSON.stringify(genRes.data)}`);
        } catch (e2: any) {
          const e2msg = e2?.response?.data ? JSON.stringify(e2.response.data) : e2.message;
          console.log(`[${userId}] image_url failed (${e2msg}), trying multipart...`);

          // Strategy 3: multipart/form-data
          const form = new FormData();
          form.append('type', 'image-to-image');
          form.append('model', 'nano-banana-2-i2i');
          form.append('prompt', enhancedPrompt);
          form.append('aspect_ratio', aspectRatio);
          form.append('resolution', resolution);
          form.append('image', img1.buf, { filename: `source.${img1.ext}`, contentType: img1.mime });
          form.append('reference_images', img2.buf, { filename: `reference.${img2.ext}`, contentType: img2.mime });

          genRes = await renderfulHttp.post(`${RENDERFUL_BASE}/generations`, form, {
            headers: { Authorization: `Bearer ${RENDERFUL_API_KEY}`, ...form.getHeaders() },
            maxBodyLength: Infinity,
          });
          console.log(`[${userId}] Multipart OK: ${JSON.stringify(genRes.data)}`);
        }
      }

      taskId = genRes.data?.id;
      if (!taskId) throw new Error(`No task ID: ${JSON.stringify(genRes.data)}`);
    } else {
      // Other models use JSON with image URLs
      const payload = {
        type: 'image-to-image',
        model,
        image_url: image1Url,
        reference_image_url: image2Url,
        prompt,
      };

      console.log(`[${userId}] Payload: ${JSON.stringify(payload)}`);

      const genRes = await renderfulHttp.post(`${RENDERFUL_BASE}/generations`, payload,
        { headers: { Authorization: `Bearer ${RENDERFUL_API_KEY}`, 'Content-Type': 'application/json' } }
      );

      console.log(`[${userId}] Response:`, JSON.stringify(genRes.data));
      taskId = genRes.data?.id;
      if (!taskId) throw new Error(`No task ID: ${JSON.stringify(genRes.data)}`);
    }

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
