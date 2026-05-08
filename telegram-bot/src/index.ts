import { Telegraf } from 'telegraf';
import axios from 'axios';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RENDERFUL_API_KEY = process.env.RENDERFUL_API_KEY;
const RENDERFUL_BASE = 'https://api.renderful.ai/api/v1';

if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');
if (!RENDERFUL_API_KEY) throw new Error('RENDERFUL_API_KEY is required');

// Proxy configuration — format: http://user:pass@host:port
const PROXY_URL = process.env.PROXY_URL || 'http://spg18hu8zx:16ktoBwP5Y8t_peuFc@gate.decodo.com:7000';
const proxyParsed = new URL(PROXY_URL);

const http = axios.create({
  proxy: {
    protocol: proxyParsed.protocol.replace(':', ''),
    host: proxyParsed.hostname,
    port: parseInt(proxyParsed.port),
    auth: {
      username: decodeURIComponent(proxyParsed.username),
      password: decodeURIComponent(proxyParsed.password),
    },
  },
});

console.log(`✅ Proxy configured: ${proxyParsed.hostname}:${proxyParsed.port}`);

const bot = new Telegraf(BOT_TOKEN);

interface Session {
  imageUrl?: string;
  waitingFor: 'image' | 'video';
}

const sessions = new Map<number, Session>();

function getSession(userId: number): Session {
  if (!sessions.has(userId)) sessions.set(userId, { waitingFor: 'image' });
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

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Bot commands ────────────────────────────────────────────────────────────

bot.start((ctx) => {
  const userId = ctx.from.id;
  sessions.set(userId, { waitingFor: 'image' });
  return ctx.reply(
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
  return ctx.reply(
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
  sessions.set(ctx.from.id, { waitingFor: 'image' });
  return ctx.reply('✅ Dibatalkan. Kirim foto karakter untuk memulai lagi.');
});

// ─── Photo handler ───────────────────────────────────────────────────────────

bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);
  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  const fileLink = await ctx.telegram.getFileLink(photo.file_id);
  session.imageUrl = fileLink.href;
  session.waitingFor = 'video';
  sessions.set(userId, session);
  return ctx.reply(
    '✅ Foto karakter diterima!\n\nSekarang kirim *video referensi gerakan*.',
    { parse_mode: 'Markdown' }
  );
});

// ─── Document handler ─────────────────────────────────────────────────────────

bot.on('document', async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);
  const doc = ctx.message.document;
  if (session.waitingFor === 'image' && doc.mime_type?.startsWith('image/')) {
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    session.imageUrl = fileLink.href;
    session.waitingFor = 'video';
    sessions.set(userId, session);
    return ctx.reply('✅ Foto karakter diterima!\n\nSekarang kirim *video referensi gerakan*.', { parse_mode: 'Markdown' });
  } else if (session.waitingFor === 'video' && doc.mime_type?.startsWith('video/')) {
    return startGeneration(ctx, doc.file_id, session);
  } else {
    return ctx.reply('⚠️ Kirim foto karakter terlebih dahulu dengan /start');
  }
});

// ─── Video handler ────────────────────────────────────────────────────────────

bot.on('video', async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);
  if (session.waitingFor !== 'video' || !session.imageUrl) {
    return ctx.reply('⚠️ Kirim foto karakter terlebih dahulu!\nGunakan /start untuk memulai ulang.');
  }
  return startGeneration(ctx, ctx.message.video.file_id, session);
});

// ─── Fire-and-forget generation ───────────────────────────────────────────────

async function startGeneration(ctx: any, videoFileId: string, session: Session) {
  const userId = ctx.from.id;
  const chatId = ctx.chat.id;

  // Reset session immediately
  sessions.set(userId, { waitingFor: 'image' });

  // Send status message synchronously so Telegraf handler returns fast
  const statusMsg = await ctx.reply('⏳ Mengirim ke Renderful.ai...\nHasil akan dikirim otomatis setelah selesai (~2-5 menit).');

  // Run generation in background — do NOT await this
  runGeneration(chatId, userId, statusMsg.message_id, videoFileId, session.imageUrl!).catch((err) => {
    console.error(`[${userId}] Uncaught background error:`, err.message);
  });
}

async function runGeneration(
  chatId: number,
  userId: number,
  statusMsgId: number,
  videoFileId: string,
  imageUrl: string
) {
  try {
    const videoFileLink = await bot.telegram.getFileLink(videoFileId);

    const payload = {
      type: 'image-to-video',
      model: 'kling-v2-6-motion-control',
      image_url: imageUrl,
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

    await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
      `⏳ Video sedang diproses (${taskId.slice(0, 8)}...)\nBiasanya 2-5 menit, mohon tunggu.`
    );

    // Poll for result
    const outputUrl = await pollForResult(taskId, userId);
    console.log(`[${userId}] Output: ${outputUrl}`);

    await bot.telegram.editMessageText(chatId, statusMsgId, undefined, '✅ Selesai! Mengirim video...');

    const caption = '🎬 Video berhasil dibuat!\n\nKirim foto baru untuk membuat video lagi.';

    // Strategy 1: download via proxy, send as buffer (most reliable for large files)
    let sent = false;
    try {
      const videoRes = await http.get(outputUrl, { responseType: 'arraybuffer', timeout: 180_000 });
      const videoBuffer = Buffer.from(videoRes.data);
      const sizeMB = (videoBuffer.length / 1024 / 1024).toFixed(1);
      console.log(`[${userId}] Downloaded ${sizeMB} MB via proxy`);
      await bot.telegram.sendVideo(chatId, { source: videoBuffer, filename: 'motion_video.mp4' }, { caption });
      sent = true;
      console.log(`[${userId}] Sent via buffer`);
    } catch (e: any) {
      console.log(`[${userId}] Buffer failed: ${e.message}`);
    }

    // Strategy 2: direct URL (may fail for large files but worth trying)
    if (!sent) {
      try {
        await bot.telegram.sendVideo(chatId, outputUrl, { caption });
        sent = true;
        console.log(`[${userId}] Sent via URL`);
      } catch (e: any) {
        console.log(`[${userId}] URL failed: ${e.message}`);
      }
    }

    // Strategy 3: send link as text
    if (!sent) {
      await bot.telegram.sendMessage(
        chatId,
        `✅ Video selesai!\n\n📥 Download link (aktif ~1 jam):\n${outputUrl}\n\nKirim foto baru untuk membuat video lagi.`
      );
      console.log(`[${userId}] Sent as text link`);
    }

    await bot.telegram.deleteMessage(chatId, statusMsgId).catch(() => {});
    console.log(`[${userId}] Done`);

  } catch (err: any) {
    const errData = err?.response?.data;
    const errMsg = errData ? JSON.stringify(errData) : err.message;
    console.error(`[${userId}] Error: ${errMsg}`);
    await bot.telegram.editMessageText(
      chatId, statusMsgId, undefined,
      `❌ Gagal: ${errMsg}\n\nGunakan /start untuk mencoba lagi.`
    ).catch(() =>
      bot.telegram.sendMessage(chatId, `❌ Gagal: ${errMsg}\n\nGunakan /start untuk mencoba lagi.`)
    );
  }
}

async function pollForResult(taskId: string, userId: number, maxAttempts = 60): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(10_000);
    const res = await http.get(`${RENDERFUL_BASE}/generations/${taskId}`, {
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
  throw new Error('Timeout: video terlalu lama (>10 menit)');
}

// ─── Launch ───────────────────────────────────────────────────────────────────

bot.launch({ allowedUpdates: ['message'] });
console.log('✅ Bot berjalan...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
