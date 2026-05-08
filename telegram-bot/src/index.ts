import { Telegraf } from 'telegraf';
import axios from 'axios';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RENDERFUL_API_KEY = process.env.RENDERFUL_API_KEY;
const RENDERFUL_BASE = 'https://api.renderful.ai/api/v1';

if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');
if (!RENDERFUL_API_KEY) throw new Error('RENDERFUL_API_KEY is required');

// Proxy configuration (Decodo residential rotating)
const PROXY_HOST = process.env.PROXY_HOST || 'gate.decodo.com';
const PROXY_PORT = parseInt(process.env.PROXY_PORT || '7000');
const PROXY_USER = process.env.PROXY_USER || 'spg18hu8zx';
const PROXY_PASS = process.env.PROXY_PASS || '16ktoBwP5Y8t_peuFc';

const http = axios.create({
  proxy: {
    protocol: 'http',
    host: PROXY_HOST,
    port: PROXY_PORT,
    auth: { username: PROXY_USER, password: PROXY_PASS },
  },
});

console.log(`✅ Proxy configured: ${PROXY_HOST}:${PROXY_PORT}`);

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

function extractOutputUrl(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output) && output.length > 0) return String(output[0]);
  if (output && typeof output === 'object') {
    const obj = output as Record<string, unknown>;
    if (obj.url) return String(obj.url);
    if (obj.video) return String(obj.video);
  }
  throw new Error(`Format output tidak dikenal: ${JSON.stringify(output)}`);
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
  const chatId = ctx.chat.id;

  const processingMsg = await ctx.reply('⏳ Mengirim ke Renderful.ai...\nMohon tunggu beberapa menit.');
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

    console.log(`[${userId}] Submitting generation...`);

    const genRes = await http.post(`${RENDERFUL_BASE}/generations`, payload, {
      headers: {
        Authorization: `Bearer ${RENDERFUL_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    const { id: taskId } = genRes.data;
    if (!taskId) throw new Error(`Tidak ada task ID: ${JSON.stringify(genRes.data)}`);

    console.log(`[${userId}] Task created: ${taskId}`);

    await ctx.telegram.editMessageText(
      chatId,
      processingMsg.message_id,
      undefined,
      `⏳ Video sedang diproses...\nBiasanya 2-5 menit, mohon tunggu.`
    );

    const outputUrl = await pollForResult(taskId, userId);
    console.log(`[${userId}] Output URL: ${outputUrl}`);

    await ctx.telegram.editMessageText(
      chatId,
      processingMsg.message_id,
      undefined,
      '✅ Selesai! Mengirim video...'
    );

    const caption = '🎬 Video berhasil dibuat dengan Kling 2.6 Pro Motion Control!\n\nKirim foto baru untuk membuat video lagi.';

    // Strategy 1: send via URL directly (fastest, no size limit from our side)
    let sent = false;
    try {
      await ctx.replyWithVideo({ url: outputUrl }, { caption });
      sent = true;
      console.log(`[${userId}] Video sent via URL`);
    } catch (urlErr: any) {
      console.log(`[${userId}] URL send failed: ${urlErr.message}, trying buffer...`);
    }

    // Strategy 2: download and send as buffer
    if (!sent) {
      try {
        const videoRes = await http.get(outputUrl, {
          responseType: 'arraybuffer',
          timeout: 120_000,
        });
        const videoBuffer = Buffer.from(videoRes.data);
        console.log(`[${userId}] Downloaded: ${(videoBuffer.length / 1024 / 1024).toFixed(1)} MB`);
        await ctx.replyWithVideo({ source: videoBuffer, filename: 'motion_video.mp4' }, { caption });
        sent = true;
        console.log(`[${userId}] Video sent via buffer`);
      } catch (bufErr: any) {
        console.log(`[${userId}] Buffer send failed: ${bufErr.message}, sending link...`);
      }
    }

    // Strategy 3: fallback — just send the URL as text
    if (!sent) {
      await ctx.reply(
        `✅ Video selesai dibuat!\n\n📥 Download di sini (link aktif ~1 jam):\n${outputUrl}\n\nKirim foto baru untuk membuat video lagi.`
      );
      console.log(`[${userId}] Sent as text link (fallback)`);
    }

    await ctx.telegram.deleteMessage(chatId, processingMsg.message_id).catch(() => {});
    console.log(`[${userId}] Done`);

  } catch (err: any) {
    const errData = err?.response?.data;
    const errMsg = errData ? JSON.stringify(errData) : err.message;
    console.error(`[${userId}] Error:`, errMsg);

    await ctx.telegram.editMessageText(
      chatId,
      processingMsg.message_id,
      undefined,
      `❌ Gagal: ${errMsg}\n\nGunakan /start untuk mencoba lagi.`
    ).catch(() => ctx.reply(`❌ Gagal: ${errMsg}\n\nGunakan /start untuk mencoba lagi.`));
  }
}

async function pollForResult(taskId: string, userId: number, maxAttempts = 60): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(10_000);

    const res = await http.get(`${RENDERFUL_BASE}/generations/${taskId}`, {
      headers: { Authorization: `Bearer ${RENDERFUL_API_KEY}` },
    });

    const { status, output, error } = res.data;
    console.log(`[${userId}] Poll ${i + 1}: status=${status}`);

    if (status === 'completed') {
      if (!output) throw new Error('Status completed tapi tidak ada output');
      return extractOutputUrl(output);
    }

    if (status === 'failed') {
      throw new Error(error || 'Generation gagal di sisi Renderful');
    }
  }

  throw new Error('Timeout: video terlalu lama diproses (>10 menit)');
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

bot.launch({ allowedUpdates: ['message'] });
console.log('✅ Bot berjalan...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
