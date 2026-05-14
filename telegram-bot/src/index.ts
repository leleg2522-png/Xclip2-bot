import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import FormData from 'form-data';
import { Client, Pool } from 'pg';
import bcrypt from 'bcryptjs';
import { HttpsProxyAgent } from 'https-proxy-agent';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RENDERFUL_API_KEY = process.env.RENDERFUL_API_KEY;
const RENDERFUL_BASE = 'https://api.renderful.ai/api/v1';
const DATABASE_URL = process.env.RAILWAY_DATABASE_URL;

if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');
if (!RENDERFUL_API_KEY) throw new Error('RENDERFUL_API_KEY is required');
if (!DATABASE_URL) throw new Error('RAILWAY_DATABASE_URL is required');

// Decodo rotating proxy — set DECODO_PROXY_URL=http://user:pass@gate.decodo.com:port
const DECODO_PROXY_URL = process.env.DECODO_PROXY_URL;
const renderfulHttpsAgent = DECODO_PROXY_URL
  ? new HttpsProxyAgent(DECODO_PROXY_URL, { rejectUnauthorized: false })
  : undefined;
if (DECODO_PROXY_URL) {
  console.log(`🌐 Decodo rotating proxy aktif untuk Renderful: ${DECODO_PROXY_URL.replace(/:([^@]+)@/, ':****@')}`);
} else {
  console.log(`ℹ️ DECODO_PROXY_URL tidak diset — Renderful calls pakai IP Railway langsung`);
}

const renderfulHttp = axios.create({
  timeout: 30_000,
  ...(renderfulHttpsAgent ? { httpsAgent: renderfulHttpsAgent } : {}),
});

// Direct HTTP client for Telegram downloads — tidak pakai proxy
const telegramHttp = axios.create({ timeout: 60_000 });

// ─── Database ─────────────────────────────────────────────────────────────────

const db = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
console.log('✅ Database pool initialized');

async function findUserByUsernameOrEmail(input: string) {
  const res = await db.query(
    'SELECT * FROM users WHERE username = $1 OR email = $1 LIMIT 1',
    [input]
  );
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

// ─── Renderful Key Pool ───────────────────────────────────────────────────────

async function getUserKeys(dbUserId: number): Promise<string[]> {
  const res = await db.query(
    `SELECT api_key FROM renderful_key_pool WHERE assigned_to = $1 AND status = 'assigned' ORDER BY slot`,
    [dbUserId]
  );
  return res.rows.map((r: any) => r.api_key);
}

async function assignKeysToUser(dbUserId: number): Promise<string[]> {
  // Load existing assigned keys first — keys are permanent, not returned on logout
  const existing = await getUserKeys(dbUserId);
  const needed = 2 - existing.length;
  if (needed <= 0) return existing;

  const client = await db.connect();
  try {
    await client.query('BEGIN');

    // Determine next slot numbers
    const slotStart = existing.length + 1;
    const res = await client.query(
      `UPDATE renderful_key_pool SET status = 'assigned', assigned_to = $1, assigned_at = NOW(),
        slot = sub.rn + $2
       FROM (
         SELECT id, ROW_NUMBER() OVER (ORDER BY id) - 1 AS rn
         FROM renderful_key_pool WHERE status = 'available' LIMIT $3
       ) sub
       WHERE renderful_key_pool.id = sub.id
       RETURNING api_key`,
      [dbUserId, slotStart, needed]
    );

    await client.query('COMMIT');
    return [...existing, ...res.rows.map((r: any) => r.api_key)];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function replaceDeadKey(dbUserId: number, deadKey: string): Promise<string | null> {
  // Mark the dead key
  await db.query(
    `UPDATE renderful_key_pool SET status = 'dead', dead_at = NOW(), assigned_to = NULL, slot = NULL
     WHERE api_key = $1`,
    [deadKey]
  );

  // Get a new key from pool
  const res = await db.query(
    `UPDATE renderful_key_pool SET status = 'assigned', assigned_to = $1, assigned_at = NOW(), slot = (
       SELECT COALESCE(MAX(slot), 0) + 1 FROM renderful_key_pool WHERE assigned_to = $1
     )
     WHERE id = (
       SELECT id FROM renderful_key_pool WHERE status = 'available' LIMIT 1
     )
     RETURNING api_key`,
    [dbUserId]
  );
  return res.rows[0]?.api_key ?? null;
}

async function addKeyToPool(apiKey: string): Promise<boolean> {
  try {
    await db.query(
      `INSERT INTO renderful_key_pool (api_key, status) VALUES ($1, 'available') ON CONFLICT (api_key) DO NOTHING`,
      [apiKey]
    );
    return true;
  } catch {
    return false;
  }
}

async function getPoolStats(): Promise<{ available: number; assigned: number; dead: number }> {
  const res = await db.query(
    `SELECT status, COUNT(*) AS cnt FROM renderful_key_pool GROUP BY status`
  );
  const stats: any = { available: 0, assigned: 0, dead: 0 };
  for (const row of res.rows) stats[row.status] = parseInt(row.cnt);
  return stats;
}

async function isAdmin(dbUserId: number): Promise<boolean> {
  const res = await db.query('SELECT is_admin FROM users WHERE id = $1', [dbUserId]);
  return res.rows[0]?.is_admin === true;
}

const bot = new Telegraf(BOT_TOKEN);

// ─── Model definitions ────────────────────────────────────────────────────────

const IMAGE_MODELS: Record<string, { label: string; cost: string; apiId?: string }> = {
  'gpt-image-2':       { label: '🤖 GPT Image 2',     cost: '$0.03' },
  'nano-banana-2-i2i': { label: '🍌 Nano Banana 2',   cost: '$0.04' },
  'nano-banana-pro':   { label: '🍌 Nano Banana Pro',  cost: '$0.14' },
  'seedream-5.0-lite': { label: '🌱 Seedream 5 Lite',  cost: '$0.04' },
};

const TASK_PRESETS: Record<string, { label: string; prompt: string }> = {
  outfit: {
    label: '👗 Ganti Baju / Outfit',
    prompt:
      'Virtual try-on. ' +
      'Take the PERSON exactly as shown in image_url — keep their FACE, HAIR, SKIN TONE, BODY SHAPE, POSE, and BACKGROUND completely unchanged. ' +
      'From reference_image_url, extract ONLY the clothing/garment — ignore the person wearing it in that image. ' +
      'Dress the person from image_url in that exact garment: match the fabric texture, color, cut, pattern, and all design details precisely. ' +
      'DO NOT change face, hair, lower body, legs, shoes, or background. DO NOT copy accessories or other clothing items from the reference unless they are the main garment. ONLY replace the clothing.',
  },
  bag: {
    label: '👜 Ganti Tas / Aksesoris',
    prompt:
      'Accessory replacement task. ' +
      'The MAIN IMAGE (image_url) is the PERSON/CHARACTER — preserve everything about them (face, hair, body, clothes, pose) exactly as-is. ' +
      'The REFERENCE IMAGE (reference_image_url) contains the BAG or ACCESSORY to apply — extract only the item, ignore whoever is holding/wearing it. ' +
      'Place the exact bag/accessory from the reference onto the character in the main image, matching color, shape, size, and design precisely. ' +
      'Only add or replace the accessory. Nothing else changes.',
  },
  face: {
    label: '🧑 Ganti Wajah / Karakter',
    prompt:
      'Face swap task. ' +
      'The MAIN IMAGE (image_url) is the BASE SCENE — keep the pose, clothing, background, lighting, and body composition completely unchanged. ' +
      'The REFERENCE IMAGE (reference_image_url) contains the FACE/PERSON to use — extract their facial features and identity. ' +
      'Replace only the face in the main image with the face from the reference image. ' +
      'Blend naturally with the lighting and skin tone of the main image scene.',
  },
  style: {
    label: '🎨 Terapkan Style Referensi',
    prompt:
      'Visual style transfer task. ' +
      'The MAIN IMAGE (image_url) is the SOURCE — preserve the character identity, pose, composition, and scene elements. ' +
      'The REFERENCE IMAGE (reference_image_url) defines the TARGET STYLE — extract its color grading, lighting mood, rendering aesthetic, and visual tone. ' +
      'Re-render the main image in the exact style of the reference: apply the same color palette, lighting, and aesthetic. ' +
      'The character and scene content must remain the same, only the visual style changes.',
  },
  fullswap: {
    label: '🔄 Masukkan Karakter ke Gambar',
    prompt:
      'Character insertion task. ' +
      'The MAIN IMAGE (image_url) is the TARGET SCENE — keep the background, lighting, pose framing, and overall composition unchanged. ' +
      'The REFERENCE IMAGE (reference_image_url) contains the PERSON to insert — extract their appearance faithfully. ' +
      'Replace the character in the main image scene with the person from the reference image, keeping the same pose and position. ' +
      'The result should look natural and consistent with the scene in the main image.',
  },
  custom: {
    label: '✏️ Prompt Sendiri',
    prompt: '',
  },
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
  | 'img_wait_task'
  | 'img_wait_prompt';

interface Session {
  mode: Mode;
  dbUserId?: number;
  dbUsername?: string;
  dbIsAdmin?: boolean;
  assignedKeys?: string[];
  keyIndex?: number;
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

function getNextKey(userId: number): string {
  const session = getSession(userId);
  const keys = session.assignedKeys;
  if (!keys || keys.length === 0) return RENDERFUL_API_KEY!;
  const idx = (session.keyIndex ?? 0) % keys.length;
  setSession(userId, { keyIndex: idx + 1 });
  return keys[idx];
}

function isKeyExhaustedError(raw: string): boolean {
  const lower = raw.toLowerCase();
  // Renderful/fal.ai backend issues = their infrastructure, NOT the user's API key being bad.
  if (lower.includes('fal api account') || lower.includes('fal.ai') || lower.includes('user is locked')) return false;
  // "Unauthorized" alone is too broad — it can mean model access restriction (Kling not allowed for account tier),
  // not necessarily an invalid key. Only flag as dead if explicitly about the key itself.
  if (lower === 'unauthorized' || lower.trim() === 'unauthorized') return false;
  return lower.includes('quota') || lower.includes('exhausted') || lower.includes('limit exceeded')
    || lower.includes('rate limit') || lower.includes('insufficient') || lower.includes('402')
    || lower.includes('balance') || lower.includes('credit') || lower.includes('payment')
    || lower.includes('invalid key') || lower.includes('invalid api key') || lower.includes('invalid_api_key')
    || (lower.includes('unauthorized') && (lower.includes('key') || lower.includes('token') || lower.includes('api')));
}

function isNotFoundError(raw: string): boolean {
  const lower = raw.toLowerCase();
  return lower.includes('not found') || lower.includes('404') || lower.includes('no such');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function handleDeadKey(userId: number, deadKey: string): Promise<void> {
  const session = getSession(userId);
  if (!session.dbUserId) return;
  console.log(`[${userId}] Key exhausted, replacing: ${deadKey.slice(0, 10)}...`);
  const newKey = await replaceDeadKey(session.dbUserId, deadKey).catch(() => null);
  const updatedKeys = await getUserKeys(session.dbUserId).catch(() => session.assignedKeys ?? []);
  setSession(userId, { assignedKeys: updatedKeys, keyIndex: 0 });
  console.log(`[${userId}] Key replaced: ${newKey ? newKey.slice(0, 10) + '...' : 'no key available'}`);
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
  if (raw.includes('Exhausted balance') || raw.includes('fal.ai') || raw.includes('User is locked'))
    return '❌ *Error backend*: Layanan Renderful sedang bermasalah. Coba lagi beberapa saat.';
  if (raw.toLowerCase().includes('developer account is disabled') || raw.toLowerCase().includes('account is disabled'))
    return '❌ *Akun Renderful dinonaktifkan*: Akun yang terhubung ke API key ini dinonaktifkan oleh Renderful. Hubungi admin untuk ganti key.';
  if (raw.toLowerCase().includes('unauthorized'))
    return '❌ *Akses ditolak*: Model ini tidak tersedia untuk akun Renderful yang digunakan. Hubungi admin.';
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
  const TELEGRAM_MAX_BYTES = 48 * 1024 * 1024; // 48MB safe limit

  // Auto-detect type from URL extension if not forced
  const lowerUrl = outputUrl.toLowerCase().split('?')[0];
  const looksLikeVideo = isVideo
    || lowerUrl.endsWith('.mp4') || lowerUrl.endsWith('.mov')
    || lowerUrl.endsWith('.webm') || lowerUrl.endsWith('.avi');

  // Plain text opts — no Markdown to avoid parse errors from URLs with special chars
  const opts = { caption };

  // Step 1: download the file (Renderful CDN requires auth so Telegram can't fetch it directly)
  let buf: Buffer | null = null;
  try {
    const res = await telegramHttp.get(outputUrl, { responseType: 'arraybuffer', timeout: 300_000 });
    buf = Buffer.from(res.data);
    const sizeMB = (buf.length / 1024 / 1024).toFixed(1);
    console.log(`Downloaded result: ${sizeMB} MB, isVideo: ${looksLikeVideo}`);

    if (buf.length > TELEGRAM_MAX_BYTES) {
      console.log(`File too large (${sizeMB} MB), skipping to link fallback`);
      buf = null;
    }
  } catch (e: any) {
    console.log(`Download failed: ${e.message}`);
  }

  if (buf) {
    const sizeMB = (buf.length / 1024 / 1024).toFixed(1);

    // Strategy 1: send as video/photo
    try {
      if (looksLikeVideo) {
        await bot.telegram.sendVideo(chatId, { source: buf, filename: 'output.mp4' }, opts);
      } else {
        await bot.telegram.sendPhoto(chatId, { source: buf, filename: 'output.jpg' }, opts);
      }
      console.log(`Result sent via buffer (${sizeMB} MB)`);
      return;
    } catch (e: any) {
      console.log(`Buffer strategy failed: ${e.message}`);
    }

    // Strategy 2: send as document (fallback if video/photo fails)
    try {
      await bot.telegram.sendDocument(chatId,
        { source: buf, filename: looksLikeVideo ? 'output.mp4' : 'output.jpg' },
        opts
      );
      console.log(`Result sent as document (${sizeMB} MB)`);
      return;
    } catch (e: any) {
      console.log(`Document strategy failed: ${e.message}`);
    }
  }

  // Final fallback: send download link (plain text, no Markdown)
  await bot.telegram.sendMessage(chatId,
    `✅ Hasil selesai!\n\n📥 Download (link aktif ~1 jam):\n${outputUrl}\n\n${caption}`
  );
}

async function pollForResult(taskId: string, userId: number, apiKey: string, pollPath?: string, maxAttempts = 60): Promise<string> {
  // Use poll_url from response if provided, otherwise construct from taskId
  const pollUrl = pollPath
    ? (pollPath.startsWith('http') ? pollPath : `https://api.renderful.ai${pollPath}`)
    : `${RENDERFUL_BASE}/generations/${taskId}`;
  console.log(`[${userId}] Polling: ${pollUrl}`);
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(10_000);
    const res = await renderfulHttp.get(pollUrl, {
      headers: { Authorization: `Bearer ${apiKey}` },
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

function taskPresetKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback(TASK_PRESETS.outfit.label,   'task_outfit')],
    [Markup.button.callback(TASK_PRESETS.bag.label,      'task_bag')],
    [Markup.button.callback(TASK_PRESETS.face.label,     'task_face')],
    [Markup.button.callback(TASK_PRESETS.style.label,    'task_style')],
    [Markup.button.callback(TASK_PRESETS.fullswap.label, 'task_fullswap')],
    [Markup.button.callback(TASK_PRESETS.custom.label,   'task_custom')],
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
  return ctx.reply('🔐 *Login XclipAI*\n\nMasukkan *username atau email* kamu:', { parse_mode: 'Markdown' });
});

bot.command('logout', (ctx) => {
  const session = getSession(ctx.from.id);
  const name = session.dbUsername;
  // Keys are NOT returned to pool — they stay assigned to user in DB
  setSession(ctx.from.id, { mode: 'idle', dbUserId: undefined, dbUsername: undefined, dbIsAdmin: undefined, assignedKeys: undefined, keyIndex: undefined, loginTempUsername: undefined });
  return ctx.reply(`✅ Berhasil logout${name ? ` dari akun *${name}*` : ''}.\n\nKetik /login untuk masuk kembali.`, { parse_mode: 'Markdown' });
});

bot.command('status', async (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session.dbUserId) {
    return ctx.reply('🔒 Belum login. Ketik /login untuk masuk.');
  }
  const active = await checkActiveSubscription(session.dbUserId);
  const keys = session.assignedKeys ?? [];
  return ctx.reply(
    `👤 *Akun:* ${session.dbUsername}\n` +
    `📦 *Langganan:* ${active ? '✅ Aktif' : '❌ Tidak aktif / expired'}\n` +
    `🔑 *API Key:* ${keys.length} key ditetapkan`,
    { parse_mode: 'Markdown' }
  );
});

// ─── Admin commands ───────────────────────────────────────────────────────────

bot.command('addkey', async (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session.dbUserId) return ctx.reply('🔒 Belum login.');
  if (!session.dbIsAdmin) return ctx.reply('❌ Hanya admin yang bisa menggunakan perintah ini.');

  // Ambil semua teks setelah /addkey, pisah berdasarkan spasi atau baris baru
  const raw = ctx.message.text.replace(/^\/addkey\s*/i, '').trim();
  if (!raw) {
    return ctx.reply(
      '📝 Format (pisah dengan koma):\n' +
      '/addkey rf_abc123\n\n' +
      'Atau banyak sekaligus:\n' +
      '/addkey rf_abc123,rf_def456,rf_ghi789'
    );
  }

  const keys = raw.split(',').map(k => k.trim()).filter(k => k.length > 0);
  let added = 0;
  let skipped = 0;
  const failedKeys: string[] = [];

  for (const key of keys) {
    const ok = await addKeyToPool(key);
    if (ok) added++;
    else { skipped++; failedKeys.push(key.slice(0, 12) + '...'); }
  }

  const stats = await getPoolStats();
  let msg = `✅ Selesai menambahkan key!\n\n`;
  msg += `• Berhasil ditambah: ${added}\n`;
  if (skipped > 0) msg += `• Sudah ada / gagal: ${skipped}\n`;
  msg += `\n📊 Status pool sekarang:\n`;
  msg += `• Available: ${stats.available}\n`;
  msg += `• Assigned: ${stats.assigned}\n`;
  msg += `• Dead: ${stats.dead}`;

  return ctx.reply(msg);
});

bot.command('poolstatus', async (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session.dbUserId) return ctx.reply('🔒 Belum login.');
  if (!session.dbIsAdmin) return ctx.reply('❌ Hanya admin yang bisa menggunakan perintah ini.');

  const stats = await getPoolStats();
  const total = stats.available + stats.assigned + stats.dead;
  return ctx.reply(
    `📊 *Status Renderful Key Pool*\n\n` +
    `• ✅ Available: *${stats.available}*\n` +
    `• 🔒 Assigned: *${stats.assigned}*\n` +
    `• ❌ Dead: *${stats.dead}*\n` +
    `• 📦 Total: *${total}*\n\n` +
    `_Kapasitas user aktif: ~${Math.floor(stats.available / 2)} user baru_`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('removekey', async (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session.dbUserId) return ctx.reply('🔒 Belum login.');
  if (!session.dbIsAdmin) return ctx.reply('❌ Hanya admin yang bisa menggunakan perintah ini.');

  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) {
    return ctx.reply('📝 *Format:* `/removekey <api_key>`', { parse_mode: 'Markdown' });
  }

  const apiKey = parts[1].trim();
  const res = await db.query(
    `UPDATE renderful_key_pool SET status = 'dead', dead_at = NOW(), assigned_to = NULL WHERE api_key = $1 RETURNING id`,
    [apiKey]
  );
  if (res.rows.length === 0) return ctx.reply('❌ Key tidak ditemukan di pool.');
  return ctx.reply('✅ Key berhasil dinonaktifkan (dead).');
});

bot.command('restorekey', async (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session.dbUserId) return ctx.reply('🔒 Belum login.');
  if (!session.dbIsAdmin) return ctx.reply('❌ Hanya admin yang bisa menggunakan perintah ini.');

  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) {
    return ctx.reply('📝 *Format:* `/restorekey <api_key>`\n\nKey akan dikembalikan ke status `available`.', { parse_mode: 'Markdown' });
  }

  const apiKey = parts[1].trim();
  const res = await db.query(
    `UPDATE renderful_key_pool SET status = 'available', dead_at = NULL, assigned_to = NULL, slot = NULL WHERE api_key = $1 RETURNING id`,
    [apiKey]
  );
  if (res.rows.length === 0) return ctx.reply('❌ Key tidak ditemukan di pool.');
  return ctx.reply('✅ Key berhasil dipulihkan ke status *available*.', { parse_mode: 'Markdown' });
});

bot.command('restoredeadkeys', async (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session.dbUserId) return ctx.reply('🔒 Belum login.');
  if (!session.dbIsAdmin) return ctx.reply('❌ Hanya admin yang bisa menggunakan perintah ini.');

  const res = await db.query(
    `UPDATE renderful_key_pool SET status = 'available', dead_at = NULL, assigned_to = NULL, slot = NULL WHERE status = 'dead' RETURNING api_key`
  );
  if (res.rows.length === 0) return ctx.reply('ℹ️ Tidak ada key berstatus dead.');
  return ctx.reply(
    `✅ *${res.rows.length} key* berhasil dipulihkan ke status *available*.\n\n` +
    `_Key yang dipulihkan:_\n` +
    res.rows.map((r: any) => `• \`${r.api_key.slice(0, 12)}...\``).join('\n'),
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
    '• Langkah: pilih model → kirim gambar utama → kirim gambar referensi → pilih task (ganti baju, tas, wajah, dll) → tunggu hasil\n' +
    '• Model: GPT Image 2, Nano Banana 2, Nano Banana Pro, Seedream 5 Lite',
    { parse_mode: 'Markdown' }
  );
});

// ─── Callback queries ─────────────────────────────────────────────────────────

bot.on('callback_query', async (ctx) => {
  const data = (ctx.callbackQuery as any).data as string;
  const userId = ctx.from.id;
  await ctx.answerCbQuery();

  if (data !== 'back_main' && !['ratio_', 'res_', 'task_'].some(p => data.startsWith(p))) {
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
    setSession(userId, { resolution, mode: 'img_wait_task' });
    const resLabel: Record<string, string> = { '1k': '1K', '2k': '2K', '4k': '4K' };
    return ctx.editMessageText(
      `✅ Resolusi dipilih: *${resLabel[resolution] ?? resolution}*\n\n` +
      '*Langkah 5 dari 5:* Pilih *apa yang ingin dilakukan* dengan gambar referensi:',
      { parse_mode: 'Markdown', ...taskPresetKeyboard() }
    );
  }

  if (data.startsWith('task_')) {
    if (!await requireLoginAndSub(ctx)) return;
    const taskKey = data.replace('task_', '');

    if (taskKey === 'custom') {
      setSession(userId, { mode: 'img_wait_prompt' });
      return ctx.editMessageText(
        '✏️ Ketik prompt kamu — apa yang ingin dilakukan?\n\n' +
        '_Contoh: "ganti baju jadi merah", "ubah background jadi pantai"_',
        { parse_mode: 'Markdown' }
      );
    }

    const preset = TASK_PRESETS[taskKey];
    if (!preset) return ctx.editMessageText('❌ Task tidak dikenal.', mainMenuKeyboard());

    const session = getSession(userId);
    const model = session.imageModel!;
    const modelInfo = IMAGE_MODELS[model];
    const image1Url = session.image1Url!;
    const image2Url = session.image2Url!;
    const aspectRatio = session.aspectRatio ?? '1:1';
    const resolution = session.resolution ?? '1k';

    if (!image1Url || !image2Url) {
      return ctx.editMessageText('❌ Gambar tidak lengkap. Mulai ulang dari menu.', mainMenuKeyboard());
    }

    setSession(userId, { mode: 'idle' });

    const resLabel: Record<string, string> = { '1k': '1K', '2k': '2K', '4k': '4K' };
    const infoLabel = model === 'nano-banana-2-i2i'
      ? ` • Rasio: ${aspectRatio} • Resolusi: ${resLabel[resolution] ?? resolution}`
      : '';

    await ctx.editMessageText(
      `⏳ Memproses *${preset.label}* dengan *${modelInfo.label}*...${infoLabel}\nHasil dikirim otomatis setelah selesai.`,
      { parse_mode: 'Markdown' }
    );

    const statusMsgId = (ctx.callbackQuery as any).message?.message_id;
    runImageGeneration(ctx.chat!.id, userId, statusMsgId, image1Url, image2Url, preset.prompt, model, modelInfo.label, aspectRatio, resolution)
      .catch(e => console.error(`[${userId}] Image gen error:`, e.message));
    return;
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

    setSession(userId, { image2Url: fileUrl, mode: 'img_wait_task' });
    return ctx.reply(
      '✅ Gambar referensi diterima!\n\n' +
      '*Langkah 3 dari 3:* Pilih *apa yang ingin dilakukan* dengan gambar referensi:',
      { parse_mode: 'Markdown', ...taskPresetKeyboard() }
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
  const vid = ctx.message.video;
  const MAX_VIDEO_BYTES = 19 * 1024 * 1024; // 19MB — Telegram bot API limit is 20MB

  if (session.mode === 'kling_wait_video' && session.characterUrl) {
    if (vid.file_size && vid.file_size > MAX_VIDEO_BYTES) {
      return ctx.reply(`❌ Video terlalu besar (${(vid.file_size / 1024 / 1024).toFixed(1)} MB).\nMaksimal 19MB. Kompres dulu atau kirim file lebih kecil.`);
    }
    setSession(userId, { mode: 'idle' });
    const statusMsg = await ctx.reply('⏳ Memproses Kling Motion Control...\nHasil dikirim otomatis (~2-5 menit).');
    runKlingMotionControl(ctx.chat.id, userId, statusMsg.message_id, vid.file_id, session.characterUrl)
      .catch(e => console.error(`[${userId}] Kling gen error:`, e.message));
    return;
  }

  if (session.mode !== 'video_wait_video' || !session.characterUrl) {
    return ctx.reply('⚠️ Kirim foto karakter terlebih dahulu.', mainMenuKeyboard());
  }
  if (vid.file_size && vid.file_size > MAX_VIDEO_BYTES) {
    return ctx.reply(`❌ Video terlalu besar (${(vid.file_size / 1024 / 1024).toFixed(1)} MB).\nMaksimal 19MB. Kompres dulu atau kirim file lebih kecil.`);
  }
  setSession(userId, { mode: 'idle' });
  const statusMsg = await ctx.reply('⏳ Memproses animasi...\nHasil dikirim otomatis (~2-5 menit).');
  runVideoGeneration(ctx.chat.id, userId, statusMsg.message_id, vid.file_id, session.characterUrl)
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
      const user = await findUserByUsernameOrEmail(username);
      if (!user) {
        return ctx.reply('❌ Username/email tidak ditemukan. Coba lagi dengan /login');
      }
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        return ctx.reply('❌ Password salah. Coba lagi dengan /login');
      }
      const admin = user.is_admin === true;
      setSession(userId, { dbUserId: user.id, dbUsername: user.username, dbIsAdmin: admin });
      const active = await checkActiveSubscription(user.id);
      if (!active) {
        return ctx.reply(
          `✅ Login berhasil sebagai *${user.username}*!\n\n` +
          `⚠️ Tapi langganan kamu tidak aktif atau sudah expired.\n` +
          `Perpanjang langganan di dashboard XclipAI untuk bisa generate.`,
          { parse_mode: 'Markdown' }
        );
      }

      // Load or assign Renderful API keys — keys are permanent (not returned on logout)
      let keyInfo = '';
      try {
        const keys = await assignKeysToUser(user.id);
        setSession(userId, { assignedKeys: keys, keyIndex: 0 });
        keyInfo = keys.length >= 2
          ? `\n🔑 *${keys.length} API key* aktif.`
          : keys.length === 1
            ? `\n🔑 *1 API key* aktif (pool hampir habis).`
            : `\n⚠️ Belum ada API key — hubungi admin untuk isi pool.`;
      } catch (e) {
        console.error(`[${userId}] Key assign error:`, e);
      }

      return ctx.reply(
        `✅ Login berhasil! Selamat datang, *${user.username}*! 🎉\n\n` +
        `📦 Langganan: *Aktif*${keyInfo}\n\nPilih mode generasi:`,
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
    const MAX_VIDEO_BYTES = 19 * 1024 * 1024;
    if (doc.file_size && doc.file_size > MAX_VIDEO_BYTES) {
      return ctx.reply(`❌ Video terlalu besar (${(doc.file_size / 1024 / 1024).toFixed(1)} MB).\nMaksimal 19MB. Kompres dulu atau kirim file lebih kecil.`);
    }
    setSession(userId, { mode: 'idle' });
    const statusMsg = await ctx.reply('⏳ Memproses Kling Motion Control...\nHasil dikirim otomatis (~2-5 menit).');
    runKlingMotionControl(ctx.chat.id, userId, statusMsg.message_id, doc.file_id, session.characterUrl)
      .catch(console.error);
    return;
  }

  if (doc.mime_type?.startsWith('video/') && session.mode === 'video_wait_video' && session.characterUrl) {
    const MAX_VIDEO_BYTES = 19 * 1024 * 1024;
    if (doc.file_size && doc.file_size > MAX_VIDEO_BYTES) {
      return ctx.reply(`❌ Video terlalu besar (${(doc.file_size / 1024 / 1024).toFixed(1)} MB).\nMaksimal 19MB. Kompres dulu atau kirim file lebih kecil.`);
    }
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
  const apiKey = getNextKey(userId);
  try {
    const videoFileLink = await bot.telegram.getFileLink(videoFileId);
    console.log(`[${userId}] Video generation started — img: ${imageUrl}, vid: ${videoFileLink.href}`);

    const genRes = await renderfulHttp.post(`${RENDERFUL_BASE}/generations`, {
      type: 'video-to-video',
      model: 'wan-2.2-animate',
      image_url: imageUrl,
      video_url: videoFileLink.href,
      prompt: 'Transfer motion from reference video to character',
    }, { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });
    console.log(`[${userId}] WAN URL OK`);

    const { id: taskId, poll_url: pollUrl } = genRes.data;
    if (!taskId) throw new Error(`No task ID: ${JSON.stringify(genRes.data)}`);
    console.log(`[${userId}] Task: ${taskId}, poll_url: ${pollUrl}`);

    await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
      '⏳ Sedang diproses...\nBiasanya 2–5 menit.'
    );

    const outputUrl = await pollForResult(taskId, userId, apiKey, pollUrl);
    await sendResult(chatId, outputUrl, '🎬 WAN 2.2 Animate\n\n/menu untuk buat lagi', true);
    await bot.telegram.deleteMessage(chatId, statusMsgId).catch(() => {});
    console.log(`[${userId}] Video done`);
  } catch (err: any) {
    const rawMsg = err?.response?.data?.error ?? err?.response?.data ?? err.message ?? String(err);
    const raw = typeof rawMsg === 'string' ? rawMsg : JSON.stringify(rawMsg);
    console.error(`[${userId}] Video error: ${raw}`);
    if (isKeyExhaustedError(raw)) {
      await handleDeadKey(userId, apiKey);
      await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
        `⚠️ API key habis, sudah diganti otomatis. Coba lagi dengan /menu`
      ).catch(() => {});
      return;
    }
    const friendly = translateError(raw);
    await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
      `${friendly}\n\n/menu untuk coba lagi`
    ).catch(() => bot.telegram.sendMessage(chatId, `${friendly}\n\n/menu untuk coba lagi`));
  }
}

// ─── Background: Kling Motion Control ────────────────────────────────────────

async function runKlingMotionControl(chatId: number, userId: number, statusMsgId: number, videoFileId: string, imageUrl: string) {
  const apiKey = getNextKey(userId);
  try {
    const videoFileLink = await bot.telegram.getFileLink(videoFileId);
    console.log(`[${userId}] Kling Motion Control started — img: ${imageUrl}, vid: ${videoFileLink.href}`);

    const genRes = await renderfulHttp.post(`${RENDERFUL_BASE}/generations`, {
      type: 'video-to-video',
      model: 'kling-v2-6-motion-control',
      image_url: imageUrl,
      video_url: videoFileLink.href,
      prompt: 'Cinematic quality, smooth motion transfer, preserve character identity',
      character_orientation: 'video',
      keep_original_sound: true,
    }, { headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } });
    console.log(`[${userId}] Kling URL OK — ${JSON.stringify(genRes.data)}`);
    const { id: taskId, poll_url: pollUrl } = genRes.data;
    if (!taskId) throw new Error(`No task ID: ${JSON.stringify(genRes.data)}`);

    await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
      '⏳ Sedang diproses...\nBiasanya 2–5 menit.'
    );

    const outputUrl = await pollForResult(taskId, userId, apiKey, pollUrl);
    await sendResult(chatId, outputUrl, '🕹️ Kling 2.6 Pro Motion Control\n\n/menu untuk buat lagi', true);
    await bot.telegram.deleteMessage(chatId, statusMsgId).catch(() => {});
    console.log(`[${userId}] Kling Motion Control done`);
  } catch (err: any) {
    const rawMsg = err?.response?.data?.error ?? err?.response?.data ?? err.message ?? String(err);
    const raw = typeof rawMsg === 'string' ? rawMsg : JSON.stringify(rawMsg);
    console.error(`[${userId}] Kling error: ${raw}`);
    if (isKeyExhaustedError(raw)) {
      await handleDeadKey(userId, apiKey);
      await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
        `⚠️ API key habis, sudah diganti otomatis. Coba lagi dengan /menu`
      ).catch(() => {});
      return;
    }
    const friendly = translateError(raw);
    await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
      `${friendly}\n\n/menu untuk coba lagi`
    ).catch(() => bot.telegram.sendMessage(chatId, `${friendly}\n\n/menu untuk coba lagi`));
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
  const apiKey = getNextKey(userId);
  try {
    console.log(`[${userId}] Image generation: ${model}`);
    console.log(`[${userId}] image1: ${image1Url}`);
    console.log(`[${userId}] image2: ${image2Url}`);

    let taskId: string;
    let pollPath: string | undefined;

    // Determine model name variants to try
    const modelVariants = model === 'nano-banana-2-i2i'
      ? ['nano-banana-2-i2i', 'nano-banana-2']
      : [model];

    // All models use reference_image_url.
    // subject_reference was tested but causes the model to swap the character identity — wrong behavior.
    const refField = 'reference_image_url';

    // When proxy is active, large base64 payloads time out going through it.
    // Prefer URL mode first (only JSON goes through proxy, Renderful fetches images server-side).
    // When no proxy, prefer base64 first (more reliable than Telegram expiring URLs).
    const usingProxy = !!DECODO_PROXY_URL;

    // Download images only if we might need base64 (always pre-download so fallback is ready)
    console.log(`[${userId}] Downloading images for ${model}... (proxy: ${usingProxy})`);
    const [img1, img2] = await Promise.all([
      downloadBuffer(image1Url),
      downloadBuffer(image2Url),
    ]);
    console.log(`[${userId}] img1: ${img1.mime} ${(img1.buf.length / 1024).toFixed(1)}KB, img2: ${img2.mime} ${(img2.buf.length / 1024).toFixed(1)}KB`);

    const b64img1 = `data:${img1.mime};base64,${img1.buf.toString('base64')}`;
    const b64img2 = `data:${img2.mime};base64,${img2.buf.toString('base64')}`;

    let genRes: any;
    const urlFirst  = modelVariants.map(mn => ({ label: `url [${mn}]`,     modelName: mn, useBase64: false }));
    const b64First  = modelVariants.map(mn => ({ label: `b64 [${mn}]`,     modelName: mn, useBase64: true  }));
    const urlFallback = modelVariants.map(mn => ({ label: `url-fb [${mn}]`, modelName: mn, useBase64: false }));
    const b64Fallback = modelVariants.map(mn => ({ label: `b64-fb [${mn}]`, modelName: mn, useBase64: true  }));

    const strategies = usingProxy
      ? [...urlFirst,  ...b64Fallback]   // proxy: URL first, b64 as last resort
      : [...b64First,  ...urlFallback];  // no proxy: b64 first, URL as fallback

    let lastErr = '';
    for (const strat of strategies) {
      try {
        const imgVal1 = strat.useBase64 ? b64img1 : image1Url;
        const imgVal2 = strat.useBase64 ? b64img2 : image2Url;
        const body: Record<string, any> = {
          type: 'image-to-image',
          model: strat.modelName,
          prompt,
          image_url: imgVal1,
          [refField]: imgVal2,
        };
        genRes = await renderfulHttp.post(`${RENDERFUL_BASE}/generations`, body, {
          headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          maxBodyLength: Infinity,
        });
        console.log(`[${userId}] ${strat.label} OK: ${JSON.stringify(genRes.data)}`);
        break;
      } catch (e: any) {
        const status = e?.response?.status ?? 'no-status';
        const errBody = e?.response?.data ? JSON.stringify(e.response.data) : e.message;
        lastErr = errBody;
        console.log(`[${userId}] ${strat.label} FAILED [HTTP ${status}]: ${errBody}`);
        if (strat === strategies[strategies.length - 1]) {
          throw new Error(typeof e?.response?.data?.error === 'string' ? e.response.data.error : lastErr);
        }
      }
    }

    taskId = genRes.data?.id;
    pollPath = genRes.data?.poll_url;
    if (!taskId) throw new Error(`No task ID: ${JSON.stringify(genRes.data)}`);

    await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
      '⏳ Sedang diproses...\nMohon tunggu.'
    );

    const outputUrl = await pollForResult(taskId, userId, apiKey, pollPath);
    await sendResult(chatId, outputUrl, `🖼️ Dibuat dengan ${modelLabel}\n\n/menu untuk buat lagi`, false);
    await bot.telegram.deleteMessage(chatId, statusMsgId).catch(() => {});
    console.log(`[${userId}] Image done`);
  } catch (err: any) {
    const rawMsg = err?.response?.data?.error ?? err?.response?.data ?? err.message ?? String(err);
    const raw = typeof rawMsg === 'string' ? rawMsg : JSON.stringify(rawMsg);
    console.error(`[${userId}] Image error: ${raw}`);
    if (isKeyExhaustedError(raw)) {
      await handleDeadKey(userId, apiKey);
      await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
        `⚠️ API key habis, sudah diganti otomatis. Coba lagi dengan /menu`
      ).catch(() => {});
      return;
    }
    const friendly = translateError(raw);
    await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
      `${friendly}\n\n/menu untuk coba lagi`
    ).catch(() => bot.telegram.sendMessage(chatId, `${friendly}\n\n/menu untuk coba lagi`));
  }
}

// ─── Launch ───────────────────────────────────────────────────────────────────

bot.launch({ allowedUpdates: ['message', 'callback_query'] });
console.log('✅ Bot berjalan...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
