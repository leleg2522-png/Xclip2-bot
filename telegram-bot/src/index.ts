import { Telegraf } from 'telegraf';
import axios from 'axios';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RENDERFUL_API_KEY = process.env.RENDERFUL_API_KEY;
const RENDERFUL_BASE = 'https://api.renderful.ai/api/v1';

if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');
if (!RENDERFUL_API_KEY) throw new Error('RENDERFUL_API_KEY is required');

const bot = new Telegraf(BOT_TOKEN);

interface Session {
  imageUrl?: string;
  waitingFor: 'image' | 'video';
}

const sessions = new Map<number, Session>();

function getSession(userId: number): Session {
  if (!sessions.has(userId)) {
    sessions.set(userId, { waitingFor: 'image' });
  }
  return sessions.get(userId)!;
}

bot.start((ctx) => {
  const userId = ctx.from.id;
  sessions.set(userId, { waitingFor: 'image' });
  ctx.reply(
    '🎬 *Kling 2.6 Pro Motion Control Bot*\n\n' +
    'Transfer gerakan dari video referensi ke foto karakter!\n\n' +
    '*Cara pakai:*\n' +
    '1️⃣ Kirim *foto* karakter (sebagai foto, bukan file)\n' +
    '2️⃣ Kirim *video* referensi gerakan\n' +
    '3️⃣ Tunggu hasil (~2-5 menit)\n\n' +
    'Mulai dengan kirim foto karakter!',
    { parse_mode: 'Markdown' }
  );
});

bot.help((ctx) => {
  ctx.reply(
    '*Perintah:*\n' +
    '/start — Mulai ulang dari awal\n' +
    '/help — Tampilkan bantuan\n' +
    '/cancel — Batalkan proses saat ini\n\n' +
    '*Catatan:*\n' +
    '• Ukuran file max 10 MB\n' +
    '• Video mode: hingga 30 detik\n' +
    '• Biaya: $0.15 per video',
    { parse_mode: 'Markdown' }
  );
});

bot.command('cancel', (ctx) => {
  const userId = ctx.from.id;
  sessions.set(userId, { waitingFor: 'image' });
  ctx.reply('✅ Dibatalkan. Kirim foto karakter untuk memulai lagi.');
});

bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);

  const photos = ctx.message.photo;
  const photo = photos[photos.length - 1];
  const fileLink = await ctx.telegram.getFileLink(photo.file_id);

  session.imageUrl = fileLink.href;
  session.waitingFor = 'video';
  sessions.set(userId, session);

  await ctx.reply(
    '✅ Foto karakter diterima!\n\nSekarang kirim *video referensi gerakan* yang ingin ditransfer ke karakter.',
    { parse_mode: 'Markdown' }
  );
});

bot.on('document', async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);
  const doc = ctx.message.document;

  if (session.waitingFor === 'image' && doc.mime_type?.startsWith('image/')) {
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    session.imageUrl = fileLink.href;
    session.waitingFor = 'video';
    sessions.set(userId, session);
    await ctx.reply(
      '✅ Foto karakter diterima!\n\nSekarang kirim *video referensi gerakan*.',
      { parse_mode: 'Markdown' }
    );
  } else if (session.waitingFor === 'video' && doc.mime_type?.startsWith('video/')) {
    await handleVideoGeneration(ctx, doc.file_id, session);
  } else {
    await ctx.reply('⚠️ Kirim foto karakter terlebih dahulu dengan /start');
  }
});

bot.on('video', async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);

  if (session.waitingFor !== 'video' || !session.imageUrl) {
    await ctx.reply('⚠️ Kirim foto karakter terlebih dahulu!\nGunakan /start untuk memulai ulang.');
    return;
  }

  await handleVideoGeneration(ctx, ctx.message.video.file_id, session);
});

async function handleVideoGeneration(ctx: any, videoFileId: string, session: Session) {
  const userId = ctx.from.id;
  const processingMsg = await ctx.reply(
    '⏳ Mengirim ke Renderful.ai...\nMohon tunggu beberapa menit.'
  );

  sessions.set(userId, { waitingFor: 'image' });

  try {
    const videoFileLink = await ctx.telegram.getFileLink(videoFileId);

    const payload = {
      type: 'image-to-video',
      model: 'kling-v2-6-motion-control',
      image_url: session.imageUrl,
      video_url: videoFileLink.href,
      prompt: 'Transfer motion from reference video to character',
    };

    const genRes = await axios.post(`${RENDERFUL_BASE}/generations`, payload, {
      headers: {
        Authorization: `Bearer ${RENDERFUL_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    const { id: taskId } = genRes.data;
    if (!taskId) throw new Error(`Tidak ada task ID: ${JSON.stringify(genRes.data)}`);

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      processingMsg.message_id,
      undefined,
      `⏳ Video sedang diproses...\nBiasanya membutuhkan 2-5 menit.`
    );

    const outputUrl = await pollForResult(taskId);

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      processingMsg.message_id,
      undefined,
      '✅ Video selesai! Mengirim...'
    );

    await ctx.replyWithVideo(
      { url: outputUrl },
      { caption: '🎬 Video berhasil dibuat dengan Kling 2.6 Pro Motion Control!\n\nKirim foto baru untuk membuat video lagi.' }
    );
  } catch (err: any) {
    const errData = err?.response?.data;
    const errMsg = errData ? JSON.stringify(errData) : err.message;

    await ctx.telegram.editMessageText(
      ctx.chat.id,
      processingMsg.message_id,
      undefined,
      `❌ Gagal membuat video: ${errMsg}\n\nGunakan /start untuk mencoba lagi.`
    );
  }
}

async function pollForResult(taskId: string, maxAttempts = 60): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(10_000);

    const res = await axios.get(`${RENDERFUL_BASE}/generations/${taskId}`, {
      headers: { Authorization: `Bearer ${RENDERFUL_API_KEY}` },
    });

    const { status, output } = res.data;

    if (status === 'completed' && output) return output;
    if (status === 'failed') {
      throw new Error(res.data.error || 'Generation gagal di sisi Renderful');
    }
  }

  throw new Error('Timeout: Pembuatan video terlalu lama (>10 menit)');
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

bot.launch({ allowedUpdates: ['message'] });

console.log('✅ Bot berjalan...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
