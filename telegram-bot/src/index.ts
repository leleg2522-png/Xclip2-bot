import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import FormData from 'form-data';
import { Client, Pool } from 'pg';
import bcrypt from 'bcryptjs';
import { HttpsProxyAgent } from 'https-proxy-agent';
import sharp from 'sharp';
import express from 'express';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RENDERFUL_API_KEY = process.env.RENDERFUL_API_KEY;
const RENDERFUL_BASE = 'https://api.renderful.ai/api/v1';
const DATABASE_URL = process.env.RAILWAY_DATABASE_URL;
const AIVIDEOAPI_BASE = 'https://api.aivideoapi.ai/v1';
const FREEPIK_API_KEY = process.env.FREEPIK_API_KEY;
const FREEPIK_BASE = 'https://api.freepik.com/v1';
const LEONARDO_BASE = 'https://cloud.leonardo.ai/api/rest/v1';

if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');
if (!RENDERFUL_API_KEY) throw new Error('RENDERFUL_API_KEY is required');
if (!DATABASE_URL) throw new Error('RAILWAY_DATABASE_URL is required');

// Decodo rotating proxy — set DECODO_PROXY_URL=http://user:pass@gate.decodo.com:port
const DECODO_PROXY_URL = process.env.DECODO_PROXY_URL;
if (DECODO_PROXY_URL) {
  // Decodo does SSL interception — disable Node TLS verification globally for this process.
  // Safe: Railway is a controlled environment and we only call known trusted APIs.
  process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
  console.log(`🌐 Decodo rotating proxy aktif untuk Renderful: ${DECODO_PROXY_URL.replace(/:([^@]+)@/, ':****@')}`);
  console.log(`⚠️  NODE_TLS_REJECT_UNAUTHORIZED=0 (SSL verification disabled for proxy compatibility)`);
} else {
  console.log(`ℹ️ DECODO_PROXY_URL tidak diset — Renderful calls pakai IP Railway langsung`);
}

const renderfulHttpsAgent = DECODO_PROXY_URL
  ? new HttpsProxyAgent(DECODO_PROXY_URL, { rejectUnauthorized: false })
  : undefined;

const renderfulHttp = axios.create({
  // Longer timeout when proxy is active — base64 payloads take more time through proxy tunnel
  timeout: DECODO_PROXY_URL ? 120_000 : 30_000,
  ...(renderfulHttpsAgent ? { httpsAgent: renderfulHttpsAgent } : {}),
});

// Freepik HTTP client — untuk Kling Motion Control (pakai proxy Decodo jika aktif)
const freepikHttpsAgent = DECODO_PROXY_URL
  ? new HttpsProxyAgent(DECODO_PROXY_URL, { rejectUnauthorized: false })
  : undefined;

const freepikHttp = axios.create({
  timeout: 120_000,
  ...(freepikHttpsAgent ? { httpsAgent: freepikHttpsAgent } : {}),
});

// Leonardo AI HTTP client — untuk Kling 2.1 Pro dan Kling 2.6 Pro
const leonardoHttp = axios.create({ timeout: 120_000 });

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

// ─── Freepik Key Pool ─────────────────────────────────────────────────────────

let freepikKeyRoundRobinIndex = 0;

async function getNextFreepikKey(skipKeys?: Set<string>): Promise<string | null> {
  const res = await db.query(
    `SELECT id, api_key FROM freepik_key_pool WHERE status = 'available' ORDER BY id`
  );
  if (res.rows.length === 0) return null;
  const available = skipKeys && skipKeys.size > 0
    ? res.rows.filter((r: any) => !skipKeys.has(r.api_key))
    : res.rows;
  if (available.length === 0) return null;
  const idx = freepikKeyRoundRobinIndex % available.length;
  freepikKeyRoundRobinIndex = (freepikKeyRoundRobinIndex + 1) % available.length;
  return available[idx].api_key;
}

async function markFreepikKeyDead(apiKey: string): Promise<void> {
  await db.query(
    `UPDATE freepik_key_pool SET status = 'dead', dead_at = NOW() WHERE api_key = $1`,
    [apiKey]
  );
}

async function addFreepikKeyToPool(apiKey: string): Promise<boolean> {
  try {
    await db.query(
      `INSERT INTO freepik_key_pool (api_key, status) VALUES ($1, 'available') ON CONFLICT (api_key) DO NOTHING`,
      [apiKey]
    );
    return true;
  } catch {
    return false;
  }
}

async function getFreepikPoolStats(): Promise<{ available: number; dead: number }> {
  const res = await db.query(
    `SELECT status, COUNT(*) AS cnt FROM freepik_key_pool GROUP BY status`
  );
  const stats: any = { available: 0, dead: 0 };
  for (const row of res.rows) stats[row.status] = parseInt(row.cnt);
  return stats;
}

// ─── aivideoapi Key Pool ──────────────────────────────────────────────────────

let i2vKeyRoundRobinIndex = 0;

async function getNextI2vKey(skipKeys?: Set<string>): Promise<string | null> {
  const res = await db.query(
    `SELECT id, api_key FROM aivideoapi_key_pool WHERE status = 'available' ORDER BY id`
  );
  if (res.rows.length === 0) return null;
  const available = skipKeys && skipKeys.size > 0
    ? res.rows.filter((r: any) => !skipKeys.has(r.api_key))
    : res.rows;
  if (available.length === 0) return null;
  const idx = i2vKeyRoundRobinIndex % available.length;
  i2vKeyRoundRobinIndex = (i2vKeyRoundRobinIndex + 1) % available.length;
  return available[idx].api_key;
}

async function markI2vKeyDead(apiKey: string): Promise<void> {
  await db.query(
    `UPDATE aivideoapi_key_pool SET status = 'dead', dead_at = NOW() WHERE api_key = $1`,
    [apiKey]
  );
}

async function addI2vKeyToPool(apiKey: string): Promise<boolean> {
  try {
    await db.query(
      `INSERT INTO aivideoapi_key_pool (api_key, status) VALUES ($1, 'available') ON CONFLICT (api_key) DO NOTHING`,
      [apiKey]
    );
    return true;
  } catch {
    return false;
  }
}

async function getI2vPoolStats(): Promise<{ available: number; dead: number }> {
  const res = await db.query(
    `SELECT status, COUNT(*) AS cnt FROM aivideoapi_key_pool GROUP BY status`
  );
  const stats: any = { available: 0, dead: 0 };
  for (const row of res.rows) stats[row.status] = parseInt(row.cnt);
  return stats;
}

// ─── Leonardo AI Key Pool ─────────────────────────────────────────────────────

let leonardoKeyRoundRobinIndex = 0;

async function getNextLeonardoKey(skipKeys?: Set<string>): Promise<string | null> {
  const res = await db.query(
    `SELECT id, api_key FROM leonardo_key_pool WHERE status = 'available' ORDER BY id`
  );
  if (res.rows.length === 0) return null;
  const available = skipKeys && skipKeys.size > 0
    ? res.rows.filter((r: any) => !skipKeys.has(r.api_key))
    : res.rows;
  if (available.length === 0) return null;
  const idx = leonardoKeyRoundRobinIndex % available.length;
  leonardoKeyRoundRobinIndex = (leonardoKeyRoundRobinIndex + 1) % available.length;
  return available[idx].api_key;
}

async function markLeonardoKeyDead(apiKey: string): Promise<void> {
  await db.query(
    `UPDATE leonardo_key_pool SET status = 'dead', dead_at = NOW() WHERE api_key = $1`,
    [apiKey]
  );
}

async function addLeonardoKeyToPool(apiKey: string): Promise<boolean> {
  try {
    await db.query(
      `INSERT INTO leonardo_key_pool (api_key, status) VALUES ($1, 'available') ON CONFLICT (api_key) DO NOTHING`,
      [apiKey]
    );
    return true;
  } catch {
    return false;
  }
}

async function getLeonardoPoolStats(): Promise<{ available: number; dead: number }> {
  const res = await db.query(
    `SELECT status, COUNT(*) AS cnt FROM leonardo_key_pool GROUP BY status`
  );
  const stats: any = { available: 0, dead: 0 };
  for (const row of res.rows) stats[row.status] = parseInt(row.cnt);
  return stats;
}

function isLeonardoKeyExhaustedError(raw: string): boolean {
  const lower = raw.toLowerCase();
  return lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid api key')
    || lower.includes('quota') || lower.includes('exhausted') || lower.includes('limit exceeded')
    || lower.includes('insufficient') || lower.includes('402') || lower.includes('payment required')
    || lower.includes('forbidden') || lower.includes('403') || lower.includes('token limit');
}

// ─── Kling Daily Limit ────────────────────────────────────────────────────────

const KLING_DAILY_LIMIT = 10;

async function getKlingUsageToday(dbUserId: number): Promise<number> {
  const res = await db.query(
    `SELECT count FROM kling_daily_usage WHERE user_id = $1 AND usage_date = CURRENT_DATE`,
    [dbUserId]
  );
  return parseInt(res.rows[0]?.count ?? '0');
}

async function incrementKlingUsage(dbUserId: number): Promise<number> {
  const res = await db.query(
    `INSERT INTO kling_daily_usage (user_id, usage_date, count)
     VALUES ($1, CURRENT_DATE, 1)
     ON CONFLICT (user_id, usage_date) DO UPDATE
       SET count = kling_daily_usage.count + 1
     RETURNING count`,
    [dbUserId]
  );
  return parseInt(res.rows[0]?.count ?? '1');
}

const bot = new Telegraf(BOT_TOKEN);

// ─── Model definitions ────────────────────────────────────────────────────────

const IMAGE_MODELS: Record<string, { label: string; cost: string }> = {
  'gpt-image-2':    { label: '🤖 GPT Image 2',    cost: '$0.03' },
  'nano-banana-2':  { label: '🍌 Nano Banana 2',  cost: '$0.04' },
};

const TASK_PRESETS: Record<string, { label: string; prompt: string }> = {
  outfit: {
    label: '👗 Ganti Baju / Outfit',
    prompt:
      'Virtual try-on task. This image shows two panels side by side. ' +
      'LEFT PANEL = the PERSON. Preserve their face, hair, skin tone, glasses, body shape, pose, and background EXACTLY — do not change anything. ' +
      'RIGHT PANEL = the CLOTHING REFERENCE. Extract the garment: fabric texture, color, cut, buttons, pattern, all design details. Ignore whoever is wearing/holding it. ' +
      'Output: the LEFT PANEL person wearing the RIGHT PANEL garment. Show ONLY the single person result, not the two-panel layout. ' +
      'Replace ONLY the clothing. Do not change face, hair, accessories, lower body, shoes, or background.',
  },
  bag: {
    label: '👜 Ganti Tas / Aksesoris',
    prompt:
      'Accessory replacement task. This image shows two panels side by side. ' +
      'LEFT PANEL = the PERSON. Preserve everything about them — face, hair, skin tone, clothes, pose, background — exactly as-is. ' +
      'RIGHT PANEL = the BAG or ACCESSORY. Extract the item precisely: color, shape, size, brand details. Ignore whoever is holding/wearing it. ' +
      'Output: the LEFT PANEL person holding/wearing the RIGHT PANEL accessory. Show ONLY the single person result, not the two-panel layout. ' +
      'Only replace/add the accessory. Nothing else changes.',
  },
  face: {
    label: '🧑 Ganti Wajah / Karakter',
    prompt:
      'Face swap task. This image shows two panels side by side. ' +
      'LEFT PANEL = the BASE SCENE. Keep the pose, clothing, body, background, and lighting completely unchanged. ' +
      'RIGHT PANEL = the FACE REFERENCE. Extract facial identity, features, and likeness. ' +
      'Output: the LEFT PANEL scene with the RIGHT PANEL face. Show ONLY the single result, not the two-panel layout. ' +
      'Replace only the face. Blend naturally with the lighting and skin tone of the base scene.',
  },
  style: {
    label: '🎨 Terapkan Style Referensi',
    prompt:
      'Visual style transfer task. This image shows two panels side by side. ' +
      'LEFT PANEL = the SOURCE IMAGE. Preserve the character identity, pose, composition, and all scene content. ' +
      'RIGHT PANEL = the STYLE REFERENCE. Extract the color grading, lighting mood, rendering aesthetic, and visual tone. ' +
      'Output: the LEFT PANEL content re-rendered in the RIGHT PANEL style. Show ONLY the single result, not the two-panel layout. ' +
      'Content stays the same — only the visual style, colors, and lighting change.',
  },
  fullswap: {
    label: '🔄 Masukkan Karakter ke Gambar',
    prompt:
      'Character insertion task. This image shows two panels side by side. ' +
      'LEFT PANEL = the TARGET SCENE. Keep the background, environment, lighting, and pose framing exactly unchanged. ' +
      'RIGHT PANEL = the PERSON to insert. Extract their appearance, clothing, and identity faithfully. ' +
      'Output: the LEFT PANEL scene with the RIGHT PANEL person placed naturally into it. Show ONLY the single result, not the two-panel layout. ' +
      'The person should look natural and consistent with the scene lighting and composition.',
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
  | 'kling_wait_model'
  | 'kling_wait_image'
  | 'kling_wait_video'
  | 'img_wait_image1'
  | 'img_wait_image2'
  | 'img_wait_ratio'
  | 'img_wait_resolution'
  | 'img_wait_task'
  | 'img_wait_prompt'
  | 'upscale_wait_video'
  | 'upscale_wait_resolution'
  | 'i2v_sora2_wait_image'
  | 'i2v_sora2_wait_prompt'
  | 'i2v_sora2_wait_ratio'
  | 'i2v_veo3_wait_image'
  | 'i2v_veo3_wait_prompt'
  | 'i2v_veo3_wait_ratio'
  | 'i2v_seedance2_wait_image'
  | 'i2v_seedance2_wait_prompt'
  | 'i2v_seedance2_wait_ratio'
  | 'i2v_seedance2_wait_duration'
  | 'i2v_kling21pro_wait_image'
  | 'i2v_kling21pro_wait_prompt'
  | 'i2v_kling21pro_wait_ratio'
  | 'i2v_kling21pro_wait_duration'
  | 'i2v_kling26pro_wait_image'
  | 'i2v_kling26pro_wait_prompt'
  | 'i2v_kling26pro_wait_ratio'
  | 'i2v_kling26pro_wait_duration';

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
  upscaleVideoFileId?: string;
  upscaleResolution?: string;
  i2vImageUrl?: string;
  i2vPrompt?: string;
  i2vAspectRatio?: string;
  i2vDuration?: number;
  i2vCurrentKey?: string;
  klingModel?: 'v3' | 'v26';
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
  // 401 from Renderful = key invalid/revoked, rotate it out
  if (lower.includes('status code 401') || lower.includes('401')) return true;
  return lower.includes('quota') || lower.includes('exhausted') || lower.includes('limit exceeded')
    || lower.includes('rate limit') || lower.includes('insufficient') || lower.includes('402')
    || lower.includes('balance') || lower.includes('credit') || lower.includes('payment')
    || lower.includes('invalid key') || lower.includes('invalid api key') || lower.includes('invalid_api_key')
    || lower.includes('unauthorized');
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
    return '❌ *Error*: Layanan AI sedang bermasalah. Coba lagi beberapa saat.';
  if (raw.toLowerCase().includes('developer account is disabled') || raw.toLowerCase().includes('account is disabled'))
    return '❌ *Error*: API key tidak aktif. Hubungi admin.';
  if (raw.includes('401') || raw.toLowerCase().includes('unauthorized'))
    return '❌ *API key tidak valid*: Key sudah diganti otomatis. Coba lagi dengan /menu';
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
    [Markup.button.callback('🎥 Image to Video', 'mode_i2v')],
    [Markup.button.callback('🖼️ Image to Image', 'mode_image')],
    [Markup.button.callback('🔺 ByteDance Video Upscaler', 'mode_upscale')],
  ]);
}

function klingModelKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🆕 Kling v3.0 Motion Control', 'kling_v3')],
    [Markup.button.callback('🕹️ Kling v2.6 Motion Control', 'kling_v26')],
    [Markup.button.callback('« Kembali', 'back_main')],
  ]);
}

function i2vModelKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🌟 Sora 2 (8 detik)', 'i2v_sora2')],
    [Markup.button.callback('⚡ Veo 3 Fast 4K', 'i2v_veo3')],
    [Markup.button.callback('🌱 Seedance 2 (480p)', 'i2v_seedance2')],
    [Markup.button.callback('🎬 Kling 2.1 Pro (Leonardo)', 'i2v_kling21pro')],
    [Markup.button.callback('🎬 Kling 2.5 Pro (Leonardo)', 'i2v_kling26pro')],
    [Markup.button.callback('« Kembali', 'back_main')],
  ]);
}

function seedanceDurationKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('⏱ 5 detik', 'i2v_seedance2_dur_5'),
      Markup.button.callback('⏱ 10 detik', 'i2v_seedance2_dur_10'),
    ],
    [Markup.button.callback('« Kembali', 'mode_i2v')],
  ]);
}

function klingDurationKeyboard(model: 'kling21pro' | 'kling26pro') {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('⏱ 5 detik', `i2v_kling_dur_${model}_5`),
      Markup.button.callback('⏱ 10 detik', `i2v_kling_dur_${model}_10`),
    ],
    [Markup.button.callback('« Kembali', 'mode_i2v')],
  ]);
}

function i2vAspectRatioKeyboard(model: 'sora2' | 'veo3' | 'seedance2' | 'kling21pro' | 'kling26pro') {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📺 16:9', `i2v_ratio_${model}_16_9`),
      Markup.button.callback('📱 9:16', `i2v_ratio_${model}_9_16`),
      Markup.button.callback('⬜ 1:1', `i2v_ratio_${model}_1_1`),
    ],
  ]);
}

function upscaleResolutionKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('🖥️ 1080p', 'upscale_res_1080p'),
      Markup.button.callback('🔷 2K', 'upscale_res_2k'),
      Markup.button.callback('💠 4K', 'upscale_res_4k'),
    ],
    [Markup.button.callback('« Kembali', 'back_main')],
  ]);
}

function imageModelKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🤖 GPT Image 2 ($0.03)',   'model_gpt-image-2')],
    [Markup.button.callback('🍌 Nano Banana 2 ($0.04)', 'model_nano-banana-2')],
    [Markup.button.callback('« Kembali',                'back_main')],
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
  const [active, klingUsed] = await Promise.all([
    checkActiveSubscription(session.dbUserId),
    getKlingUsageToday(session.dbUserId),
  ]);
  const keys = session.assignedKeys ?? [];
  const klingRemaining = Math.max(0, KLING_DAILY_LIMIT - klingUsed);
  return ctx.reply(
    `👤 *Akun:* ${session.dbUsername}\n` +
    `📦 *Langganan:* ${active ? '✅ Aktif' : '❌ Tidak aktif / expired'}\n` +
    `🔑 *API Key:* ${keys.length} key ditetapkan\n` +
    `🕹️ *Kling hari ini:* ${klingUsed}/${KLING_DAILY_LIMIT} (sisa: ${klingRemaining})`,
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

bot.command('validatekeys', async (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session.dbUserId) return ctx.reply('🔒 Belum login.');
  if (!session.dbIsAdmin) return ctx.reply('❌ Hanya admin yang bisa menggunakan perintah ini.');

  const res = await db.query(
    `SELECT api_key, status FROM renderful_key_pool WHERE status != 'dead' ORDER BY status, id`
  );
  if (res.rows.length === 0) return ctx.reply('ℹ️ Tidak ada key aktif di pool.');

  const total = res.rows.length;
  const statusMsg = await ctx.reply(`🔍 Memvalidasi *${total}* key... Harap tunggu.`, { parse_mode: 'Markdown' });

  const results: { key: string; status: string; valid: boolean; code?: number }[] = [];

  // Validate 5 keys at a time (avoid rate limit)
  const BATCH = 5;
  for (let i = 0; i < res.rows.length; i += BATCH) {
    const batch = res.rows.slice(i, i + BATCH);
    await Promise.all(batch.map(async (row: any) => {
      try {
        await renderfulHttp.get(`${RENDERFUL_BASE}/generations?limit=1`, {
          headers: { Authorization: `Bearer ${row.api_key}` },
        });
        results.push({ key: row.api_key, status: row.status, valid: true });
      } catch (e: any) {
        const code = e?.response?.status ?? 0;
        results.push({ key: row.api_key, status: row.status, valid: false, code });
      }
    }));
  }

  // Auto-mark invalid keys as dead
  const invalid = results.filter(r => !r.valid);
  const valid = results.filter(r => r.valid);

  if (invalid.length > 0) {
    await db.query(
      `UPDATE renderful_key_pool SET status = 'dead', dead_at = NOW(), assigned_to = NULL, slot = NULL
       WHERE api_key = ANY($1)`,
      [invalid.map(r => r.key)]
    );
  }

  const poolStats = await getPoolStats();

  let msg = `✅ *Validasi selesai!*\n\n`;
  msg += `• ✅ Valid: *${valid.length}*\n`;
  msg += `• ❌ Invalid (auto-dead): *${invalid.length}*\n`;
  msg += `• 📦 Pool tersisa: available=${poolStats.available}, assigned=${poolStats.assigned}\n\n`;

  if (valid.length > 0) {
    msg += `*Key valid:*\n`;
    for (const r of valid) {
      msg += `  ✅ \`${r.key.slice(0, 16)}...\` _(${r.status})_\n`;
    }
  }
  if (invalid.length > 0) {
    msg += `\n*Key invalid (sudah di-dead):*\n`;
    for (const r of invalid) {
      msg += `  ❌ \`${r.key.slice(0, 16)}...\` _(HTTP ${r.code || '?'})_\n`;
    }
  }

  await bot.telegram.editMessageText(ctx.chat.id, statusMsg.message_id, undefined, msg, { parse_mode: 'Markdown' }).catch(() =>
    ctx.reply(msg, { parse_mode: 'Markdown' })
  );
});

bot.command('clearpool', async (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session.dbUserId) return ctx.reply('🔒 Belum login.');
  if (!session.dbIsAdmin) return ctx.reply('❌ Hanya admin yang bisa menggunakan perintah ini.');

  const res = await db.query(`DELETE FROM renderful_key_pool RETURNING api_key`);
  if (res.rows.length === 0) return ctx.reply('ℹ️ Pool sudah kosong.');
  return ctx.reply(
    `🗑️ Pool dikosongkan — *${res.rows.length} key* dihapus.`,
    { parse_mode: 'Markdown' }
  );
});

// ─── Admin commands: aivideoapi key pool ─────────────────────────────────────

bot.command('addfreepikkey', async (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session.dbUserId) return ctx.reply('🔒 Belum login.');
  if (!session.dbIsAdmin) return ctx.reply('❌ Hanya admin yang bisa menggunakan perintah ini.');

  const raw = ctx.message.text.replace(/^\/addfreepikkey\s*/i, '').trim();
  if (!raw) {
    return ctx.reply(
      '📝 Format (pisah dengan koma):\n' +
      '/addfreepikkey fpk_abc123\n\n' +
      'Atau banyak sekaligus:\n' +
      '/addfreepikkey fpk_abc123,fpk_def456,fpk_ghi789'
    );
  }

  const keys = raw.split(',').map((k: string) => k.trim()).filter((k: string) => k.length > 0);
  let added = 0, skipped = 0;

  for (const key of keys) {
    const ok = await addFreepikKeyToPool(key);
    if (ok) added++; else skipped++;
  }

  const stats = await getFreepikPoolStats();
  let msg = `✅ Selesai menambahkan key Freepik!\n\n`;
  msg += `• Berhasil ditambah: ${added}\n`;
  if (skipped > 0) msg += `• Sudah ada / gagal: ${skipped}\n`;
  msg += `\n📊 Status pool Freepik sekarang:\n`;
  msg += `• Available: ${stats.available}\n`;
  msg += `• Dead: ${stats.dead}`;
  return ctx.reply(msg);
});

bot.command('freepikpoolstatus', async (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session.dbUserId) return ctx.reply('🔒 Belum login.');
  if (!session.dbIsAdmin) return ctx.reply('❌ Hanya admin yang bisa menggunakan perintah ini.');

  const stats = await getFreepikPoolStats();
  const total = stats.available + stats.dead;
  return ctx.reply(
    `📊 *Status Freepik Key Pool*\n\n` +
    `• ✅ Available: *${stats.available}*\n` +
    `• ❌ Dead: *${stats.dead}*\n` +
    `• 📦 Total: *${total}*`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('removefreepikkey', async (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session.dbUserId) return ctx.reply('🔒 Belum login.');
  if (!session.dbIsAdmin) return ctx.reply('❌ Hanya admin yang bisa menggunakan perintah ini.');

  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply('📝 *Format:* `/removefreepikkey <api_key>`', { parse_mode: 'Markdown' });

  const apiKey = parts[1].trim();
  const res = await db.query(
    `UPDATE freepik_key_pool SET status = 'dead', dead_at = NOW() WHERE api_key = $1 RETURNING id`,
    [apiKey]
  );
  if (res.rows.length === 0) return ctx.reply('❌ Key tidak ditemukan di pool Freepik.');
  return ctx.reply('✅ Key Freepik berhasil dinonaktifkan (dead).');
});

bot.command('restorefreepikkey', async (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session.dbUserId) return ctx.reply('🔒 Belum login.');
  if (!session.dbIsAdmin) return ctx.reply('❌ Hanya admin yang bisa menggunakan perintah ini.');

  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply('📝 *Format:* `/restorefreepikkey <api_key>`', { parse_mode: 'Markdown' });

  const apiKey = parts[1].trim();
  const res = await db.query(
    `UPDATE freepik_key_pool SET status = 'available', dead_at = NULL WHERE api_key = $1 RETURNING id`,
    [apiKey]
  );
  if (res.rows.length === 0) return ctx.reply('❌ Key tidak ditemukan di pool Freepik.');
  return ctx.reply('✅ Key Freepik berhasil dipulihkan ke status *available*.', { parse_mode: 'Markdown' });
});

bot.command('clearfreepikpool', async (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session.dbUserId) return ctx.reply('🔒 Belum login.');
  if (!session.dbIsAdmin) return ctx.reply('❌ Hanya admin yang bisa menggunakan perintah ini.');

  const res = await db.query(`DELETE FROM freepik_key_pool RETURNING api_key`);
  if (res.rows.length === 0) return ctx.reply('ℹ️ Pool Freepik sudah kosong.');
  return ctx.reply(`🗑️ Pool Freepik dikosongkan — *${res.rows.length} key* dihapus.`, { parse_mode: 'Markdown' });
});

bot.command('addi2vkey', async (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session.dbUserId) return ctx.reply('🔒 Belum login.');
  if (!session.dbIsAdmin) return ctx.reply('❌ Hanya admin yang bisa menggunakan perintah ini.');

  const raw = ctx.message.text.replace(/^\/addi2vkey\s*/i, '').trim();
  if (!raw) {
    return ctx.reply(
      '📝 Format (pisah dengan koma):\n' +
      '/addi2vkey aiv_abc123\n\n' +
      'Atau banyak sekaligus:\n' +
      '/addi2vkey aiv_abc123,aiv_def456,aiv_ghi789'
    );
  }

  const keys = raw.split(',').map(k => k.trim()).filter(k => k.length > 0);
  let added = 0, skipped = 0;

  for (const key of keys) {
    const ok = await addI2vKeyToPool(key);
    if (ok) added++; else skipped++;
  }

  const stats = await getI2vPoolStats();
  let msg = `✅ Selesai menambahkan key i2v!\n\n`;
  msg += `• Berhasil ditambah: ${added}\n`;
  if (skipped > 0) msg += `• Sudah ada / gagal: ${skipped}\n`;
  msg += `\n📊 Status pool i2v sekarang:\n`;
  msg += `• Available: ${stats.available}\n`;
  msg += `• Dead: ${stats.dead}`;
  return ctx.reply(msg);
});

bot.command('i2vpoolstatus', async (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session.dbUserId) return ctx.reply('🔒 Belum login.');
  if (!session.dbIsAdmin) return ctx.reply('❌ Hanya admin yang bisa menggunakan perintah ini.');

  const stats = await getI2vPoolStats();
  const total = stats.available + stats.dead;
  return ctx.reply(
    `📊 *Status aivideoapi Key Pool (i2v)*\n\n` +
    `• ✅ Available: *${stats.available}*\n` +
    `• ❌ Dead: *${stats.dead}*\n` +
    `• 📦 Total: *${total}*`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('removei2vkey', async (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session.dbUserId) return ctx.reply('🔒 Belum login.');
  if (!session.dbIsAdmin) return ctx.reply('❌ Hanya admin yang bisa menggunakan perintah ini.');

  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply('📝 *Format:* `/removei2vkey <api_key>`', { parse_mode: 'Markdown' });

  const apiKey = parts[1].trim();
  const res = await db.query(
    `UPDATE aivideoapi_key_pool SET status = 'dead', dead_at = NOW() WHERE api_key = $1 RETURNING id`,
    [apiKey]
  );
  if (res.rows.length === 0) return ctx.reply('❌ Key tidak ditemukan di pool i2v.');
  return ctx.reply('✅ Key i2v berhasil dinonaktifkan (dead).');
});

bot.command('restorei2vkey', async (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session.dbUserId) return ctx.reply('🔒 Belum login.');
  if (!session.dbIsAdmin) return ctx.reply('❌ Hanya admin yang bisa menggunakan perintah ini.');

  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply('📝 *Format:* `/restorei2vkey <api_key>`', { parse_mode: 'Markdown' });

  const apiKey = parts[1].trim();
  const res = await db.query(
    `UPDATE aivideoapi_key_pool SET status = 'available', dead_at = NULL WHERE api_key = $1 RETURNING id`,
    [apiKey]
  );
  if (res.rows.length === 0) return ctx.reply('❌ Key tidak ditemukan di pool i2v.');
  return ctx.reply('✅ Key i2v berhasil dipulihkan ke status *available*.', { parse_mode: 'Markdown' });
});

bot.command('cleari2vpool', async (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session.dbUserId) return ctx.reply('🔒 Belum login.');
  if (!session.dbIsAdmin) return ctx.reply('❌ Hanya admin yang bisa menggunakan perintah ini.');

  const res = await db.query(`DELETE FROM aivideoapi_key_pool RETURNING api_key`);
  if (res.rows.length === 0) return ctx.reply('ℹ️ Pool i2v sudah kosong.');
  return ctx.reply(`🗑️ Pool i2v dikosongkan — *${res.rows.length} key* dihapus.`, { parse_mode: 'Markdown' });
});

// ─── Admin: Leonardo AI Key Pool ─────────────────────────────────────────────

bot.command('addleonardokey', async (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session.dbUserId) return ctx.reply('🔒 Belum login.');
  if (!session.dbIsAdmin) return ctx.reply('❌ Hanya admin yang bisa menggunakan perintah ini.');

  const raw = ctx.message.text.replace(/^\/addleonardokey\s*/i, '').trim();
  if (!raw) {
    return ctx.reply(
      '📝 Format (pisah dengan koma):\n' +
      '/addleonardokey abc123key\n\n' +
      'Atau banyak sekaligus:\n' +
      '/addleonardokey key1,key2,key3'
    );
  }

  const keys = raw.split(',').map(k => k.trim()).filter(k => k.length > 0);
  let added = 0, skipped = 0;
  for (const key of keys) {
    const ok = await addLeonardoKeyToPool(key);
    if (ok) added++; else skipped++;
  }

  const stats = await getLeonardoPoolStats();
  let msg = `✅ Selesai menambahkan key Leonardo AI!\n\n`;
  msg += `• Berhasil ditambah: ${added}\n`;
  if (skipped > 0) msg += `• Sudah ada / gagal: ${skipped}\n`;
  msg += `\n📊 Status pool Leonardo AI sekarang:\n`;
  msg += `• Available: ${stats.available}\n`;
  msg += `• Dead: ${stats.dead}`;
  return ctx.reply(msg);
});

bot.command('leonardopoolstatus', async (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session.dbUserId) return ctx.reply('🔒 Belum login.');
  if (!session.dbIsAdmin) return ctx.reply('❌ Hanya admin yang bisa menggunakan perintah ini.');

  const stats = await getLeonardoPoolStats();
  const total = stats.available + stats.dead;
  return ctx.reply(
    `📊 *Status Leonardo AI Key Pool*\n\n` +
    `• ✅ Available: *${stats.available}*\n` +
    `• ❌ Dead: *${stats.dead}*\n` +
    `• 📦 Total: *${total}*`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('removeleonardokey', async (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session.dbUserId) return ctx.reply('🔒 Belum login.');
  if (!session.dbIsAdmin) return ctx.reply('❌ Hanya admin yang bisa menggunakan perintah ini.');

  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply('📝 *Format:* `/removeleonardokey <api_key>`', { parse_mode: 'Markdown' });

  const apiKey = parts[1].trim();
  const res = await db.query(
    `UPDATE leonardo_key_pool SET status = 'dead', dead_at = NOW() WHERE api_key = $1 RETURNING id`,
    [apiKey]
  );
  if (res.rows.length === 0) return ctx.reply('❌ Key tidak ditemukan di pool Leonardo AI.');
  return ctx.reply('✅ Key Leonardo AI berhasil dinonaktifkan (dead).');
});

bot.command('restoreleonardokey', async (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session.dbUserId) return ctx.reply('🔒 Belum login.');
  if (!session.dbIsAdmin) return ctx.reply('❌ Hanya admin yang bisa menggunakan perintah ini.');

  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply('📝 *Format:* `/restoreleonardokey <api_key>`', { parse_mode: 'Markdown' });

  const apiKey = parts[1].trim();
  const res = await db.query(
    `UPDATE leonardo_key_pool SET status = 'available', dead_at = NULL WHERE api_key = $1 RETURNING id`,
    [apiKey]
  );
  if (res.rows.length === 0) return ctx.reply('❌ Key tidak ditemukan di pool Leonardo AI.');
  return ctx.reply('✅ Key Leonardo AI berhasil dipulihkan ke status *available*.', { parse_mode: 'Markdown' });
});

bot.command('clearleonardopool', async (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session.dbUserId) return ctx.reply('🔒 Belum login.');
  if (!session.dbIsAdmin) return ctx.reply('❌ Hanya admin yang bisa menggunakan perintah ini.');

  const res = await db.query(`DELETE FROM leonardo_key_pool RETURNING api_key`);
  if (res.rows.length === 0) return ctx.reply('ℹ️ Pool Leonardo AI sudah kosong.');
  return ctx.reply(`🗑️ Pool Leonardo AI dikosongkan — *${res.rows.length} key* dihapus.`, { parse_mode: 'Markdown' });
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
    setSession(userId, { mode: 'kling_wait_model' });
    return ctx.editMessageText(
      '🕹️ *Kling Motion Control*\n\nPilih versi model:',
      { parse_mode: 'Markdown', ...klingModelKeyboard() }
    );
  }

  if (data === 'kling_v3' || data === 'kling_v26') {
    if (!await requireLoginAndSub(ctx)) return;
    const model = data === 'kling_v3' ? 'v3' : 'v26';
    const label = model === 'v3' ? 'Kling v3.0' : 'Kling v2.6';
    setSession(userId, { mode: 'kling_wait_image', klingModel: model });
    return ctx.editMessageText(
      `🕹️ *${label} Motion Control*\n\n` +
      '*Langkah 1:* Kirim *foto karakter* yang ingin dianimasikan.\n\n' +
      '⚠️ *Syarat foto:*\n' +
      '• Tampilkan seluruh tubuh dari depan\n' +
      '• Bukan close-up wajah\n' +
      '• Resolusi min. 300px, maks 10MB\n' +
      '• Format: JPG, PNG',
      { parse_mode: 'Markdown' }
    );
  }

  if (data === 'mode_i2v') {
    setSession(userId, { mode: 'idle' });
    return ctx.editMessageText(
      '🎥 *Image to Video*\n\nPilih model:',
      { parse_mode: 'Markdown', ...i2vModelKeyboard() }
    );
  }

  if (data === 'i2v_sora2') {
    if (!await requireLoginAndSub(ctx)) return;
    setSession(userId, { mode: 'i2v_sora2_wait_image' });
    return ctx.editMessageText(
      '🌟 *Sora 2 — Image to Video (8 detik)*\n\n' +
      'Kirim *foto/gambar* yang ingin dijadikan video.\n\n' +
      '⚠️ *Syarat:*\n• Format: JPG, PNG\n• Maks 10MB',
      { parse_mode: 'Markdown' }
    );
  }

  if (data === 'i2v_veo3') {
    if (!await requireLoginAndSub(ctx)) return;
    setSession(userId, { mode: 'i2v_veo3_wait_image' });
    return ctx.editMessageText(
      '⚡ *Veo 3 Fast 4K — Image to Video*\n\n' +
      'Kirim *foto/gambar* yang ingin dijadikan video.\n\n' +
      '⚠️ *Syarat:*\n• Format: JPG, PNG\n• Maks 10MB',
      { parse_mode: 'Markdown' }
    );
  }

  if (data === 'i2v_seedance2') {
    if (!await requireLoginAndSub(ctx)) return;
    setSession(userId, { mode: 'i2v_seedance2_wait_image' });
    return ctx.editMessageText(
      '🌱 *Seedance 2 — Image to Video (480p)*\n\n' +
      'Kirim *foto/gambar* yang ingin dijadikan video.\n\n' +
      '⚠️ *Syarat:*\n• Format: JPG, PNG\n• Maks 10MB',
      { parse_mode: 'Markdown' }
    );
  }

  if (data === 'i2v_kling21pro') {
    if (!await requireLoginAndSub(ctx)) return;
    setSession(userId, { mode: 'i2v_kling21pro_wait_image' });
    return ctx.editMessageText(
      '🎬 *Kling 2.1 Pro — Image to Video (Leonardo AI)*\n\n' +
      'Kirim *foto/gambar* yang ingin dijadikan video.\n\n' +
      '⚠️ *Syarat:*\n• Format: JPG, PNG\n• Maks 10MB',
      { parse_mode: 'Markdown' }
    );
  }

  if (data === 'i2v_kling26pro') {
    if (!await requireLoginAndSub(ctx)) return;
    setSession(userId, { mode: 'i2v_kling26pro_wait_image' });
    return ctx.editMessageText(
      '🎬 *Kling 2.5 Pro — Image to Video (Leonardo AI)*\n\n' +
      'Kirim *foto/gambar* yang ingin dijadikan video.\n\n' +
      '⚠️ *Syarat:*\n• Format: JPG, PNG\n• Maks 10MB',
      { parse_mode: 'Markdown' }
    );
  }

  // ── i2v aspect ratio callbacks ──
  if (data.startsWith('i2v_ratio_')) {
    if (!await requireLoginAndSub(ctx)) return;
    const session = getSession(userId);
    const ratioMap: Record<string, string> = {
      '16_9': '16:9', '9_16': '9:16', '1_1': '1:1',
    };
    if (data.startsWith('i2v_ratio_sora2_')) {
      const ratioKey = data.replace('i2v_ratio_sora2_', '');
      const ratio = ratioMap[ratioKey] ?? '16:9';
      if (!session.i2vImageUrl || !session.i2vPrompt) {
        return ctx.editMessageText('❌ Data tidak ditemukan. Mulai ulang dari /menu', mainMenuKeyboard());
      }
      const { i2vImageUrl, i2vPrompt } = session;
      setSession(userId, { mode: 'idle', i2vAspectRatio: ratio });
      const statusMsg = await ctx.editMessageText('⏳ Memproses Sora 2 (8 detik)...\nBiasanya 2–5 menit.');
      runSora2Generation(ctx.chat!.id, userId, (statusMsg as any).message_id, i2vImageUrl, i2vPrompt, ratio)
        .catch(e => console.error(`[${userId}] Sora2 error:`, e.message));
      return;
    }
    if (data.startsWith('i2v_ratio_veo3_')) {
      const ratioKey = data.replace('i2v_ratio_veo3_', '');
      const ratio = ratioMap[ratioKey] ?? '16:9';
      if (!session.i2vImageUrl || !session.i2vPrompt) {
        return ctx.editMessageText('❌ Data tidak ditemukan. Mulai ulang dari /menu', mainMenuKeyboard());
      }
      const { i2vImageUrl, i2vPrompt } = session;
      setSession(userId, { mode: 'idle', i2vAspectRatio: ratio });
      const statusMsg = await ctx.editMessageText('⏳ Memproses Veo 3 Fast 4K...\nBiasanya 2–5 menit.');
      runVeo3Generation(ctx.chat!.id, userId, (statusMsg as any).message_id, i2vImageUrl, i2vPrompt, ratio)
        .catch(e => console.error(`[${userId}] Veo3 error:`, e.message));
      return;
    }
    if (data.startsWith('i2v_ratio_seedance2_')) {
      const ratioKey = data.replace('i2v_ratio_seedance2_', '');
      const ratio = ratioMap[ratioKey] ?? '16:9';
      if (!session.i2vImageUrl || !session.i2vPrompt) {
        return ctx.editMessageText('❌ Data tidak ditemukan. Mulai ulang dari /menu', mainMenuKeyboard());
      }
      setSession(userId, { mode: 'i2v_seedance2_wait_duration', i2vAspectRatio: ratio });
      return ctx.editMessageText(
        '✅ Rasio diterima!\n\n*Langkah 4:* Pilih *durasi video*:',
        { parse_mode: 'Markdown', ...seedanceDurationKeyboard() }
      );
    }
    if (data.startsWith('i2v_ratio_kling21pro_')) {
      const ratioKey = data.replace('i2v_ratio_kling21pro_', '');
      const ratio = ratioMap[ratioKey] ?? '16:9';
      if (!session.i2vImageUrl || !session.i2vPrompt) {
        return ctx.editMessageText('❌ Data tidak ditemukan. Mulai ulang dari /menu', mainMenuKeyboard());
      }
      setSession(userId, { mode: 'i2v_kling21pro_wait_duration', i2vAspectRatio: ratio });
      return ctx.editMessageText(
        '✅ Rasio dipilih!\n\n*Langkah 4:* Pilih *durasi video*:',
        { parse_mode: 'Markdown', ...klingDurationKeyboard('kling21pro') }
      );
    }
    if (data.startsWith('i2v_ratio_kling26pro_')) {
      const ratioKey = data.replace('i2v_ratio_kling26pro_', '');
      const ratio = ratioMap[ratioKey] ?? '16:9';
      if (!session.i2vImageUrl || !session.i2vPrompt) {
        return ctx.editMessageText('❌ Data tidak ditemukan. Mulai ulang dari /menu', mainMenuKeyboard());
      }
      setSession(userId, { mode: 'i2v_kling26pro_wait_duration', i2vAspectRatio: ratio });
      return ctx.editMessageText(
        '✅ Rasio dipilih!\n\n*Langkah 4:* Pilih *durasi video*:',
        { parse_mode: 'Markdown', ...klingDurationKeyboard('kling26pro') }
      );
    }
    return;
  }

  // ── Kling duration callbacks ──
  if (data.startsWith('i2v_kling_dur_')) {
    if (!await requireLoginAndSub(ctx)) return;
    const session = getSession(userId);
    // format: i2v_kling_dur_{kling21pro|kling26pro}_{5|10}
    const parts = data.replace('i2v_kling_dur_', '').split('_');
    // model can be 'kling21pro' or 'kling26pro' — last part is duration
    const duration = parseInt(parts[parts.length - 1], 10) || 5;
    const model = parts.slice(0, -1).join('_') as 'kling21pro' | 'kling26pro';
    const label = model === 'kling21pro' ? 'Kling 2.1 Pro' : 'Kling 2.5 Pro';
    if (!session.i2vImageUrl || !session.i2vPrompt || !session.i2vAspectRatio) {
      return ctx.editMessageText('❌ Data tidak ditemukan. Mulai ulang dari /menu', mainMenuKeyboard());
    }
    const { i2vImageUrl, i2vPrompt, i2vAspectRatio } = session;
    setSession(userId, { mode: 'idle' });
    const statusMsg = await ctx.editMessageText(`⏳ Memproses ${label} (${duration}s, ${i2vAspectRatio})...\nBiasanya 2–5 menit.`);
    runLeonardoKlingGeneration(ctx.chat!.id, userId, (statusMsg as any).message_id, i2vImageUrl, i2vPrompt, i2vAspectRatio, model, duration)
      .catch(e => console.error(`[${userId}] ${label} error:`, e.message));
    return;
  }

  if (data === 'i2v_seedance2_dur_5' || data === 'i2v_seedance2_dur_10') {
    if (!await requireLoginAndSub(ctx)) return;
    const duration = data === 'i2v_seedance2_dur_5' ? 5 : 10;
    const session = getSession(userId);
    if (!session.i2vImageUrl || !session.i2vPrompt) {
      return ctx.editMessageText('❌ Gambar/prompt tidak ditemukan. Mulai ulang dari /menu', mainMenuKeyboard());
    }
    const prompt = session.i2vPrompt;
    const ratio = session.i2vAspectRatio ?? '16:9';
    setSession(userId, { mode: 'idle', i2vDuration: duration });
    const statusMsg = await ctx.editMessageText(
      `⏳ Memproses Seedance 2 (480p, ${duration} detik)...\nBiasanya 2–5 menit.`
    );
    runSeedance2Generation(ctx.chat!.id, userId, (statusMsg as any).message_id, session.i2vImageUrl, duration, prompt, ratio)
      .catch(e => console.error(`[${userId}] Seedance2 error:`, e.message));
    return;
  }

  if (data === 'mode_image') {
    setSession(userId, { mode: 'idle' });
    return ctx.editMessageText(
      '🖼️ *Image to Image*\n\nPilih model:',
      { parse_mode: 'Markdown', ...imageModelKeyboard() }
    );
  }

  if (data === 'mode_upscale') {
    setSession(userId, { mode: 'upscale_wait_video', upscaleVideoFileId: undefined, upscaleResolution: undefined });
    return ctx.editMessageText(
      '🔺 *ByteDance Video Upscaler*\n\nUpscale video ke resolusi 1080p, 2K, atau 4K menggunakan AI ByteDance.\n\n' +
      '*Langkah 1:* Kirim *video* yang ingin di-upscale.\n\n' +
      '⚠️ *Syarat video:*\n' +
      '• Format: MP4, WebM, MOV\n' +
      '• Durasi: maks 10 menit\n' +
      '• Maksimal ukuran: 19MB',
      { parse_mode: 'Markdown' }
    );
  }

  if (data.startsWith('upscale_res_')) {
    if (!await requireLoginAndSub(ctx)) return;
    const resolution = data.replace('upscale_res_', '');
    const session = getSession(userId);
    const videoFileId = session.upscaleVideoFileId;
    if (!videoFileId) {
      return ctx.editMessageText('❌ Video tidak ditemukan. Mulai ulang dari menu.', mainMenuKeyboard());
    }
    setSession(userId, { upscaleResolution: resolution, mode: 'idle' });
    const resLabel: Record<string, string> = { '1080p': '1080p Full HD', '2k': '2K', '4k': '4K Ultra HD' };
    await ctx.editMessageText(
      `⏳ Memproses *ByteDance Video Upscaler* ke *${resLabel[resolution] ?? resolution}*...\nHasil dikirim otomatis setelah selesai.`,
      { parse_mode: 'Markdown' }
    );
    const statusMsgId = (ctx.callbackQuery as any).message?.message_id;
    runUpscaleGeneration(ctx.chat!.id, userId, statusMsgId, videoFileId, resolution)
      .catch(e => console.error(`[${userId}] Upscale gen error:`, e.message));
    return;
  }

  if (data.startsWith('model_')) {
    const model = data.replace('model_', '');
    const modelInfo = IMAGE_MODELS[model];
    if (!modelInfo) return ctx.editMessageText(`❌ Model tidak dikenal: ${model}`, mainMenuKeyboard());
    setSession(userId, { mode: 'img_wait_image1', imageModel: model, image1Url: undefined, image2Url: undefined });
    const step1Text = `🖼️ *${modelInfo.label}* (${modelInfo.cost})\n\n` +
      '*Langkah 1 dari 4:* Kirim *gambar pertama* (gambar sumber yang ingin diedit).';
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
      '*Langkah 4 dari 4:* Pilih *apa yang ingin dilakukan* dengan gambar referensi:',
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

    await ctx.editMessageText(
      `⏳ Memproses *${preset.label}* dengan *${modelInfo.label}*...\nHasil dikirim otomatis setelah selesai.`,
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
      '• Maks ukuran file: 19MB',
      { parse_mode: 'Markdown' }
    );
  }

  if (session.mode === 'img_wait_image1') {
    setSession(userId, { image1Url: fileUrl, mode: 'img_wait_image2' });
    return ctx.reply(
      '✅ Gambar pertama diterima!\n\n' +
      '*Langkah 2 dari 4:* Kirim *gambar kedua* (gambar referensi/style).',
      { parse_mode: 'Markdown' }
    );
  }

  if (session.mode === 'img_wait_image2') {
    setSession(userId, { image2Url: fileUrl, mode: 'img_wait_resolution' });
    return ctx.reply(
      '✅ Gambar referensi diterima!\n\n' +
      '*Langkah 3 dari 4:* Pilih *resolusi output*:',
      { parse_mode: 'Markdown', ...resolutionKeyboard() }
    );
  }

  if (session.mode === 'i2v_sora2_wait_image') {
    setSession(userId, { mode: 'i2v_sora2_wait_prompt', i2vImageUrl: fileUrl });
    return ctx.reply(
      '✅ Gambar diterima!\n\n*Langkah 2:* Ketik *prompt* untuk video ini.\n\n' +
      '💡 _Contoh: "The character waves hello and smiles, cinematic lighting"_',
      { parse_mode: 'Markdown' }
    );
  }

  if (session.mode === 'i2v_veo3_wait_image') {
    setSession(userId, { mode: 'i2v_veo3_wait_prompt', i2vImageUrl: fileUrl });
    return ctx.reply(
      '✅ Gambar diterima!\n\n*Langkah 2:* Ketik *prompt* untuk video ini.\n\n' +
      '💡 _Contoh: "The character walks forward slowly, 4K cinematic"_',
      { parse_mode: 'Markdown' }
    );
  }

  if (session.mode === 'i2v_seedance2_wait_image') {
    setSession(userId, { mode: 'i2v_seedance2_wait_prompt', i2vImageUrl: fileUrl });
    return ctx.reply(
      '✅ Gambar diterima!\n\n*Langkah 2:* Ketik *prompt* untuk video ini.\n\n' +
      '💡 _Contoh: "The character smiles and blinks naturally"_',
      { parse_mode: 'Markdown' }
    );
  }

  if (session.mode === 'i2v_kling21pro_wait_image') {
    setSession(userId, { mode: 'i2v_kling21pro_wait_prompt', i2vImageUrl: fileUrl });
    return ctx.reply(
      '✅ Gambar diterima!\n\n*Langkah 2:* Ketik *prompt* untuk video ini.\n\n' +
      '💡 _Contoh: "The character walks forward confidently, cinematic"_',
      { parse_mode: 'Markdown' }
    );
  }

  if (session.mode === 'i2v_kling26pro_wait_image') {
    setSession(userId, { mode: 'i2v_kling26pro_wait_prompt', i2vImageUrl: fileUrl });
    return ctx.reply(
      '✅ Gambar diterima!\n\n*Langkah 2:* Ketik *prompt* untuk video ini.\n\n' +
      '💡 _Contoh: "The character waves and smiles naturally, 4K cinematic"_',
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
  const vid = ctx.message.video;
  const MAX_VIDEO_BYTES = 19 * 1024 * 1024; // 19MB — Telegram bot API limit is 20MB

  if (session.mode === 'upscale_wait_video') {
    if (vid.file_size && vid.file_size > MAX_VIDEO_BYTES) {
      return ctx.reply(`❌ Video terlalu besar (${(vid.file_size / 1024 / 1024).toFixed(1)} MB).\nMaksimal 19MB. Kompres dulu atau kirim file lebih kecil.`);
    }
    setSession(userId, { upscaleVideoFileId: vid.file_id, mode: 'upscale_wait_resolution' });
    return ctx.reply(
      '✅ Video diterima!\n\n*Langkah 2:* Pilih *resolusi output*:',
      { parse_mode: 'Markdown', ...upscaleResolutionKeyboard() }
    );
  }

  if (session.mode === 'kling_wait_video' && session.characterUrl) {
    if (vid.file_size && vid.file_size > MAX_VIDEO_BYTES) {
      return ctx.reply(`❌ Video terlalu besar (${(vid.file_size / 1024 / 1024).toFixed(1)} MB).\nMaksimal 19MB. Kompres dulu atau kirim file lebih kecil.`);
    }
    const used = await getKlingUsageToday(session.dbUserId!);
    if (used >= KLING_DAILY_LIMIT) {
      setSession(userId, { mode: 'idle' });
      return ctx.reply(`❌ Limit harian Kling Motion Control sudah habis!\n\n📊 Terpakai: *${used}/${KLING_DAILY_LIMIT}* generate hari ini.\n🕛 Reset otomatis besok.`, { parse_mode: 'Markdown' });
    }
    const klingModel = session.klingModel ?? 'v3';
    setSession(userId, { mode: 'idle' });
    const statusMsg = await ctx.reply(`⏳ Memproses Kling Motion Control...\nHasil dikirim otomatis (~2-5 menit).`, { parse_mode: 'Markdown' });
    runKlingMotionControl(ctx.chat.id, userId, session.dbUserId!, statusMsg.message_id, vid.file_id, session.characterUrl, klingModel)
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

    const statusMsg = await ctx.reply(
      `⏳ Memproses dengan *${modelInfo.label}*...\nHasil dikirim otomatis setelah selesai.`,
      { parse_mode: 'Markdown' }
    );

    runImageGeneration(ctx.chat.id, userId, statusMsg.message_id, image1Url, image2Url, prompt, model, modelInfo.label, aspectRatio, resolution)
      .catch(e => console.error(`[${userId}] Image gen error:`, e.message));
    return;
  }

  // ── i2v prompt ──
  if (session.mode === 'i2v_sora2_wait_prompt') {
    if (!await requireLoginAndSub(ctx)) return;
    const prompt = ctx.message.text.trim();
    if (!prompt) return ctx.reply('Prompt tidak boleh kosong. Ketik deskripsi untuk videonya:');
    if (!session.i2vImageUrl) return ctx.reply('❌ Gambar tidak ditemukan. Mulai ulang dari /menu', mainMenuKeyboard());
    setSession(userId, { mode: 'i2v_sora2_wait_ratio', i2vPrompt: prompt });
    return ctx.reply(
      '✅ Prompt diterima!\n\n*Langkah 3:* Pilih *rasio aspek video*:',
      { parse_mode: 'Markdown', ...i2vAspectRatioKeyboard('sora2') }
    );
  }

  if (session.mode === 'i2v_veo3_wait_prompt') {
    if (!await requireLoginAndSub(ctx)) return;
    const prompt = ctx.message.text.trim();
    if (!prompt) return ctx.reply('Prompt tidak boleh kosong. Ketik deskripsi untuk videonya:');
    if (!session.i2vImageUrl) return ctx.reply('❌ Gambar tidak ditemukan. Mulai ulang dari /menu', mainMenuKeyboard());
    setSession(userId, { mode: 'i2v_veo3_wait_ratio', i2vPrompt: prompt });
    return ctx.reply(
      '✅ Prompt diterima!\n\n*Langkah 3:* Pilih *rasio aspek video*:',
      { parse_mode: 'Markdown', ...i2vAspectRatioKeyboard('veo3') }
    );
  }

  if (session.mode === 'i2v_seedance2_wait_prompt') {
    if (!await requireLoginAndSub(ctx)) return;
    const prompt = ctx.message.text.trim();
    if (!prompt) return ctx.reply('Prompt tidak boleh kosong. Ketik deskripsi untuk videonya:');
    if (!session.i2vImageUrl) return ctx.reply('❌ Gambar tidak ditemukan. Mulai ulang dari /menu', mainMenuKeyboard());
    setSession(userId, { mode: 'i2v_seedance2_wait_ratio', i2vPrompt: prompt });
    return ctx.reply(
      '✅ Prompt diterima!\n\n*Langkah 3:* Pilih *rasio aspek video*:',
      { parse_mode: 'Markdown', ...i2vAspectRatioKeyboard('seedance2') }
    );
  }

  if (session.mode === 'i2v_kling21pro_wait_prompt') {
    if (!await requireLoginAndSub(ctx)) return;
    const prompt = ctx.message.text.trim();
    if (!prompt) return ctx.reply('Prompt tidak boleh kosong. Ketik deskripsi untuk videonya:');
    if (!session.i2vImageUrl) return ctx.reply('❌ Gambar tidak ditemukan. Mulai ulang dari /menu', mainMenuKeyboard());
    setSession(userId, { mode: 'i2v_kling21pro_wait_ratio', i2vPrompt: prompt });
    return ctx.reply(
      '✅ Prompt diterima!\n\n*Langkah 3:* Pilih *rasio aspek video*:',
      { parse_mode: 'Markdown', ...i2vAspectRatioKeyboard('kling21pro') }
    );
  }

  if (session.mode === 'i2v_kling26pro_wait_prompt') {
    if (!await requireLoginAndSub(ctx)) return;
    const prompt = ctx.message.text.trim();
    if (!prompt) return ctx.reply('Prompt tidak boleh kosong. Ketik deskripsi untuk videonya:');
    if (!session.i2vImageUrl) return ctx.reply('❌ Gambar tidak ditemukan. Mulai ulang dari /menu', mainMenuKeyboard());
    setSession(userId, { mode: 'i2v_kling26pro_wait_ratio', i2vPrompt: prompt });
    return ctx.reply(
      '✅ Prompt diterima!\n\n*Langkah 3:* Pilih *rasio aspek video*:',
      { parse_mode: 'Markdown', ...i2vAspectRatioKeyboard('kling26pro') }
    );
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

  if (doc.mime_type?.startsWith('video/') && session.mode === 'upscale_wait_video') {
    const MAX_VIDEO_BYTES = 19 * 1024 * 1024;
    if (doc.file_size && doc.file_size > MAX_VIDEO_BYTES) {
      return ctx.reply(`❌ Video terlalu besar (${(doc.file_size / 1024 / 1024).toFixed(1)} MB).\nMaksimal 19MB.`);
    }
    setSession(userId, { upscaleVideoFileId: doc.file_id, mode: 'upscale_wait_resolution' });
    return ctx.reply(
      '✅ Video diterima!\n\n*Langkah 2:* Pilih *resolusi output*:',
      { parse_mode: 'Markdown', ...upscaleResolutionKeyboard() }
    );
  }

  if (doc.mime_type?.startsWith('video/') && session.mode === 'kling_wait_video' && session.characterUrl) {
    const MAX_VIDEO_BYTES = 19 * 1024 * 1024;
    if (doc.file_size && doc.file_size > MAX_VIDEO_BYTES) {
      return ctx.reply(`❌ Video terlalu besar (${(doc.file_size / 1024 / 1024).toFixed(1)} MB).\nMaksimal 19MB. Kompres dulu atau kirim file lebih kecil.`);
    }
    const used = await getKlingUsageToday(session.dbUserId!);
    if (used >= KLING_DAILY_LIMIT) {
      setSession(userId, { mode: 'idle' });
      return ctx.reply(`❌ Limit harian Kling Motion Control sudah habis!\n\n📊 Terpakai: *${used}/${KLING_DAILY_LIMIT}* generate hari ini.\n🕛 Reset otomatis besok.`, { parse_mode: 'Markdown' });
    }
    const klingModel = session.klingModel ?? 'v3';
    setSession(userId, { mode: 'idle' });
    const statusMsg = await ctx.reply(`⏳ Memproses Kling Motion Control...\nHasil dikirim otomatis (~2-5 menit).`);
    runKlingMotionControl(ctx.chat.id, userId, session.dbUserId!, statusMsg.message_id, doc.file_id, session.characterUrl, klingModel)
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

async function pollFreepikKling(taskId: string, endpoint: string, apiKey: string, userId: number, maxAttempts = 60): Promise<string> {
  const pollUrl = `${FREEPIK_BASE}${endpoint}/${taskId}`;
  console.log(`[${userId}] Freepik polling: ${pollUrl}`);
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(10_000);
    const res = await freepikHttp.get(pollUrl, {
      headers: { 'x-freepik-api-key': apiKey },
    });

    // Log raw response structure for debugging
    const raw = res.data;
    const d = raw?.data ?? raw;
    const status = (d?.status ?? '').toLowerCase();
    console.log(`[${userId}] Freepik poll ${i + 1}: ${d?.status} | raw keys: ${Object.keys(raw ?? {}).join(',')} | d keys: ${Object.keys(d ?? {}).join(',')}`);

    if (status === 'completed' || status === 'succeed' || status === 'succeeded') {
      console.log(`[${userId}] Completed — raw.data: ${JSON.stringify(raw?.data)?.slice(0, 200)} | d.generated: ${JSON.stringify(d?.generated)?.slice(0, 200)} | d.output: ${JSON.stringify(d?.output)?.slice(0, 200)}`);

      // Try every possible location Freepik might put the video URL
      let url: string | undefined;
      if (typeof d?.output?.video_url === 'string' && d.output.video_url) url = d.output.video_url;
      else if (typeof d?.output?.url === 'string' && d.output.url) url = d.output.url;
      else if (Array.isArray(d?.generated) && d.generated.length > 0) {
        const first = d.generated[0];
        // generated can be array of strings OR array of objects {url: "..."}
        if (typeof first === 'string' && first) url = first;
        else if (first?.url) url = String(first.url);
      }
      if (!url && typeof d?.video_url === 'string' && d.video_url) url = d.video_url;
      if (!url && typeof d?.url === 'string' && d.url) url = d.url;
      // Also check top-level raw in case no nesting
      if (!url && Array.isArray(raw?.generated) && raw.generated.length > 0) {
        const first = raw.generated[0];
        if (typeof first === 'string' && first) url = first;
        else if (first?.url) url = String(first.url);
      }
      if (!url && typeof raw?.video_url === 'string' && raw.video_url) url = raw.video_url;
      if (!url && typeof raw?.url === 'string' && raw.url) url = raw.url;

      if (!url) throw new Error(`Completed tapi tidak ada URL video. Full response: ${JSON.stringify(raw)?.slice(0, 500)}`);
      console.log(`[${userId}] Video URL found: ${url.slice(0, 80)}...`);
      return url;
    }
    if (status === 'failed' || status === 'error') {
      throw new Error(d?.error?.message ?? d?.error ?? 'Generation gagal');
    }
  }
  throw new Error('Timeout: proses terlalu lama (>10 menit)');
}

function isFreepikKeyExhaustedError(raw: string): boolean {
  return /quota|rate.?limit|limit.?exceeded|insufficient|unauthorized|401|403|429|free.?trial|upgrade.?to.?a.?paid|reached.?the.?limit|trial.?usage|billing/i.test(raw);
}

async function runKlingMotionControl(chatId: number, userId: number, dbUserId: number, statusMsgId: number, videoFileIdOrUrl: string, imageUrl: string, klingModel: 'v3' | 'v26' = 'v3', maxKeyRetries = 10) {
  const endpoint = klingModel === 'v3'
    ? '/ai/video/kling-v3-motion-control-std'
    : '/ai/video/kling-v2-6-motion-control-std';
  const label = klingModel === 'v3' ? 'Kling v3.0' : 'Kling v2.6';

  const usedKeys = new Set<string>();

  // Support both Telegram file ID and direct URL
  const isDirectUrl = videoFileIdOrUrl.startsWith('http://') || videoFileIdOrUrl.startsWith('https://');
  const videoUrl = isDirectUrl
    ? videoFileIdOrUrl
    : (await bot.telegram.getFileLink(videoFileIdOrUrl)).href;
  console.log(`[${userId}] ${label} Motion Control started — img: ${imageUrl}, vid: ${videoUrl}`);

  for (let attempt = 1; attempt <= maxKeyRetries; attempt++) {
    const apiKey = await getNextFreepikKey(usedKeys);
    if (!apiKey) {
      await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
        '❌ Semua API key Freepik habis. Hubungi admin untuk mengisi key.\n\n/menu untuk kembali'
      ).catch(() => {});
      return;
    }
    usedKeys.add(apiKey);

    try {
      console.log(`[${userId}] ${label} attempt ${attempt} — key: ${apiKey.slice(0, 10)}...`);
      await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
        `⏳ ${label} sedang diproses...\nBiasanya 2–5 menit.`
      ).catch(() => {});

      const genRes = await freepikHttp.post(`${FREEPIK_BASE}${endpoint}`, {
        image_url: imageUrl,
        video_url: videoUrl,
        character_orientation: 'video',
        cfg_scale: 0.5,
      }, { headers: { 'x-freepik-api-key': apiKey, 'Content-Type': 'application/json' } });

      console.log(`[${userId}] ${label} attempt ${attempt} queued — ${JSON.stringify(genRes.data)}`);

      // Cek apakah response body mengandung pesan limit/quota (HTTP 200 tapi key habis)
      const resBodyStr = typeof genRes.data === 'string' ? genRes.data : JSON.stringify(genRes.data ?? '');
      if (isFreepikKeyExhaustedError(resBodyStr) && !genRes.data?.data?.task_id && !genRes.data?.task_id && !genRes.data?.id) {
        throw new Error(resBodyStr);
      }

      const taskId = genRes.data?.data?.task_id ?? genRes.data?.task_id ?? genRes.data?.id;
      if (!taskId) throw new Error(`No task ID: ${JSON.stringify(genRes.data)}`);

      const outputUrl = await pollFreepikKling(taskId, endpoint, apiKey, userId);

      // Key sudah dipakai sekali — langsung nonaktifkan dari pool
      await markFreepikKeyDead(apiKey);
      console.log(`[${userId}] Freepik key consumed & removed: ${apiKey.slice(0, 10)}...`);

      const newCount = await incrementKlingUsage(dbUserId);
      const remaining = Math.max(0, KLING_DAILY_LIMIT - newCount);
      await sendResult(chatId, outputUrl, `🕹️ ${label} Motion Control\n📊 Generate hari ini: ${newCount}/${KLING_DAILY_LIMIT} (sisa: ${remaining})\n\n/menu untuk buat lagi`, true);
      await bot.telegram.deleteMessage(chatId, statusMsgId).catch(() => {});
      console.log(`[${userId}] ${label} done (usage: ${newCount}/${KLING_DAILY_LIMIT})`);
      return;

    } catch (err: any) {
      const httpStatus = err?.response?.status;
      const rawMsg = err?.response?.data?.message ?? err?.response?.data?.error ?? err?.response?.data ?? err.message ?? String(err);
      const raw = typeof rawMsg === 'string' ? rawMsg : JSON.stringify(rawMsg);
      console.error(`[${userId}] ${label} error (attempt ${attempt}) HTTP ${httpStatus ?? 'N/A'}: ${raw}`);

      // 429 = rate limit, 401/403 = key invalid — buang key & retry otomatis dengan key baru
      const isRateLimit = httpStatus === 429 || httpStatus === 401 || httpStatus === 403;
      if (isRateLimit || isFreepikKeyExhaustedError(raw)) {
        await markFreepikKeyDead(apiKey);
        console.log(`[${userId}] Key 429/limit — dibuang, auto-retry dengan key baru (attempt ${attempt + 1}): ${apiKey.slice(0, 10)}...`);
        await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
          `⏳ ${label} sedang diproses...\nBiasanya 2–5 menit.`
        ).catch(() => {});
        continue;
      }

      const friendly = translateError(raw);
      await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
        `${friendly}\n\n/menu untuk coba lagi`
      ).catch(() => bot.telegram.sendMessage(chatId, `${friendly}\n\n/menu untuk coba lagi`));
      return;
    }
  }

  await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
    '❌ Semua API key Freepik habis setelah beberapa percobaan. Hubungi admin.\n\n/menu untuk kembali'
  ).catch(() => {});
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
  const usedKeys = new Set<string>();
  const MAX_RETRIES = 10;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const apiKey = await getNextI2vKey(usedKeys);
    if (!apiKey) {
      await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
        '❌ Semua API key image generation habis. Hubungi admin untuk mengisi key.\n\n/menu untuk kembali'
      ).catch(() => {});
      return;
    }
    usedKeys.add(apiKey);

    try {
      console.log(`[${userId}] Image generation aivideoapi: ${model} attempt ${attempt}`);
      console.log(`[${userId}] image1: ${image1Url}`);
      console.log(`[${userId}] image2: ${image2Url}`);

      // Download both images
      const [img1, img2] = await Promise.all([
        downloadBuffer(image1Url),
        downloadBuffer(image2Url),
      ]);
      console.log(`[${userId}] img1: ${img1.mime} ${(img1.buf.length / 1024).toFixed(1)}KB, img2: ${img2.mime} ${(img2.buf.length / 1024).toFixed(1)}KB`);

      // Build side-by-side composite: LEFT = main image, RIGHT = reference.
      // Single composite image lets the model see both simultaneously.
      const W = 512, H = 640;
      const [left, right] = await Promise.all([
        sharp(img1.buf).resize(W, H, { fit: 'cover', position: 'top' }).jpeg({ quality: 85 }).toBuffer(),
        sharp(img2.buf).resize(W, H, { fit: 'cover', position: 'top' }).jpeg({ quality: 85 }).toBuffer(),
      ]);
      const compositeBuf = await sharp({
        create: { width: W * 2, height: H, channels: 3, background: '#ffffff' },
      })
        .composite([
          { input: left,  left: 0, top: 0 },
          { input: right, left: W, top: 0 },
        ])
        .jpeg({ quality: 85 })
        .toBuffer();
      const compositeB64 = `data:image/jpeg;base64,${compositeBuf.toString('base64')}`;
      console.log(`[${userId}] composite: ${(compositeBuf.length / 1024).toFixed(1)}KB`);

      // Map resolution label to pixel count for aivideoapi
      const resolutionMap: Record<string, number> = { '1k': 1024, '2k': 2048, '4k': 4096 };
      const outputSize = resolutionMap[resolution] ?? 1024;

      // Call aivideoapi image generation
      const genRes = await telegramHttp.post(`${AIVIDEOAPI_BASE}/images/generations`, {
        model,
        input: {
          prompt,
          image_url: compositeB64,
          aspect_ratio: aspectRatio,
          output_quality: outputSize,
        },
      }, {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        maxBodyLength: Infinity,
        timeout: 60_000,
      });

      console.log(`[${userId}] aivideoapi image response: ${JSON.stringify(genRes.data)?.slice(0, 200)}`);

      await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
        '⏳ Sedang diproses...\nMohon tunggu.'
      );

      // Check if response is async (has taskId) or synchronous (has URL directly)
      const taskId = genRes.data?.data?.taskId ?? genRes.data?.data?.id ?? genRes.data?.taskId ?? genRes.data?.id;
      let outputUrl: string;

      if (taskId) {
        console.log(`[${userId}] Image task id: ${taskId}, polling...`);
        outputUrl = await pollAivideoapi(taskId, apiKey);
      } else {
        // Synchronous response — URL is returned immediately
        const d = genRes.data?.data ?? genRes.data;
        const url = d?.urls?.[0] ?? d?.url ?? d?.image_url ?? d?.output?.url ?? d?.output?.urls?.[0];
        if (!url) throw new Error(`No output URL in response: ${JSON.stringify(genRes.data)}`);
        outputUrl = url;
      }

      await sendResult(chatId, outputUrl, `🖼️ Dibuat dengan ${modelLabel}\n\n/menu untuk buat lagi`, false);
      await bot.telegram.deleteMessage(chatId, statusMsgId).catch(() => {});
      console.log(`[${userId}] Image done`);
      return;

    } catch (err: any) {
      const rawMsg = err?.response?.data?.error ?? err?.response?.data ?? err.message ?? String(err);
      const raw = typeof rawMsg === 'string' ? rawMsg : JSON.stringify(rawMsg);
      console.error(`[${userId}] Image error (attempt ${attempt}): ${raw}`);

      if (isI2vKeyExhaustedError(raw)) {
        await markI2vKeyDead(apiKey);
        console.log(`[${userId}] i2v key dead, retry dengan key lain: ${apiKey.slice(0, 10)}...`);
        continue;
      }

      const friendly = translateError(raw);
      await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
        `${friendly}\n\n/menu untuk coba lagi`
      ).catch(() => bot.telegram.sendMessage(chatId, `${friendly}\n\n/menu untuk coba lagi`));
      return;
    }
  }

  await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
    '❌ Semua API key image generation habis setelah beberapa percobaan. Hubungi admin.\n\n/menu untuk kembali'
  ).catch(() => {});
}

// ─── Background: ByteDance Video Upscale ─────────────────────────────────────

async function runUpscaleGeneration(chatId: number, userId: number, statusMsgId: number, videoFileId: string, resolution: string) {
  const apiKey = getNextKey(userId);
  const resLabel: Record<string, string> = { '1080p': '1080p Full HD', '2k': '2K', '4k': '4K Ultra HD' };

  try {
    const videoFileLink = await bot.telegram.getFileLink(videoFileId);
    console.log(`[${userId}] ByteDance Upscale started — res: ${resolution}, vid: ${videoFileLink.href}`);

    await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
      `⏳ Sedang di-upscale ke ${resLabel[resolution] ?? resolution}...\nBiasanya 2–5 menit.`
    ).catch(() => {});

    const genRes = await renderfulHttp.post(`${RENDERFUL_BASE}/generations`, {
      type: 'video-to-video',
      model: 'bytedance-video-upscaler',
      video_url: videoFileLink.href,
      target_resolution: resolution,
    }, {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 600_000,
    });

    console.log(`[${userId}] Upscale queued: ${JSON.stringify(genRes.data)}`);
    const { id: taskId, poll_url: pollUrl } = genRes.data;
    if (!taskId) throw new Error(`No task ID: ${JSON.stringify(genRes.data)}`);

    const outputUrl = await pollForResult(taskId, userId, apiKey, pollUrl);
    await sendResult(chatId, outputUrl, `🔺 ByteDance Video Upscaler — ${resLabel[resolution] ?? resolution}\n\n/menu untuk buat lagi`, true);
    await bot.telegram.deleteMessage(chatId, statusMsgId).catch(() => {});
    console.log(`[${userId}] Upscale done`);
  } catch (err: any) {
    const rawMsg = err?.response?.data?.error ?? err?.response?.data ?? err.message ?? String(err);
    const raw = typeof rawMsg === 'string' ? rawMsg : JSON.stringify(rawMsg);
    console.error(`[${userId}] Upscale error: ${raw}`);
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

// ─── Background: aivideoapi.ai polling ───────────────────────────────────────

async function pollAivideoapi(taskId: string, apiKey: string): Promise<string> {
  const POLL_INTERVAL = 10_000;
  const MAX_ATTEMPTS = 60; // 10 min max
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
    const res = await telegramHttp.get(`${AIVIDEOAPI_BASE}/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 30_000,
    });
    const { status, output, error } = res.data;
    console.log(`[pollAivideoapi] attempt ${i + 1}: status=${status}`);
    if (status === 'completed' || status === 'succeed' || status === 'success') {
      const url = output?.urls?.[0] ?? output?.url ?? output?.video_url ?? output?.[0]?.url ?? output?.videos?.[0]?.url;
      if (!url) throw new Error(`Selesai tapi URL kosong: ${JSON.stringify(res.data)}`);
      return url;
    }
    if (status === 'failed' || status === 'error') {
      const errMsg = typeof error === 'string' ? error : (error?.message ?? JSON.stringify(error) ?? 'Generation gagal di aivideoapi');
      throw new Error(errMsg);
    }
  }
  throw new Error('Timeout: proses terlalu lama (>10 menit)');
}

function isI2vKeyExhaustedError(raw: string): boolean {
  const lower = raw.toLowerCase();
  return lower.includes('401') || lower.includes('unauthorized') || lower.includes('invalid api key')
    || lower.includes('quota') || lower.includes('exhausted') || lower.includes('limit exceeded')
    || lower.includes('insufficient') || lower.includes('402') || lower.includes('payment required');
}

// ─── Helper: run i2v generation with automatic key retry ─────────────────────

async function runI2vWithRetry(
  userId: number,
  chatId: number,
  statusMsgId: number,
  label: string,
  buildBody: () => object,
  statusMsg: string,
  resultCaption: string,
  maxRetries = 10,
): Promise<void> {
  const usedKeys = new Set<string>();

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const apiKey = await getNextI2vKey(usedKeys);
    if (!apiKey) {
      await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
        '❌ Semua API key i2v habis. Hubungi admin untuk mengisi key.\n\n/menu untuk kembali'
      ).catch(() => {});
      return;
    }
    usedKeys.add(apiKey);

    try {
      console.log(`[${userId}] ${label} attempt ${attempt} — key: ${apiKey.slice(0, 10)}...`);
      const genRes = await telegramHttp.post(`${AIVIDEOAPI_BASE}/videos/generations`, buildBody(), {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 60_000,
      });

      const taskId = genRes.data?.data?.taskId ?? genRes.data?.data?.id ?? genRes.data?.taskId ?? genRes.data?.id;
      if (!taskId) throw new Error(`No task ID: ${JSON.stringify(genRes.data)}`);
      console.log(`[${userId}] ${label} task: ${taskId}`);

      await bot.telegram.editMessageText(chatId, statusMsgId, undefined, statusMsg).catch(() => {});

      const outputUrl = await pollAivideoapi(taskId, apiKey);
      await sendResult(chatId, outputUrl, resultCaption, true);
      await bot.telegram.deleteMessage(chatId, statusMsgId).catch(() => {});
      console.log(`[${userId}] ${label} done`);
      return;

    } catch (err: any) {
      const raw = typeof err?.response?.data === 'string'
        ? err.response.data
        : JSON.stringify(err?.response?.data ?? err.message ?? String(err));
      console.error(`[${userId}] ${label} error (attempt ${attempt}): ${raw}`);

      if (isI2vKeyExhaustedError(raw)) {
        await markI2vKeyDead(apiKey);
        console.log(`[${userId}] i2v key dead, retry dengan key lain: ${apiKey.slice(0, 10)}...`);
        continue;
      }

      const friendly = translateError(raw);
      await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
        `${friendly}\n\n/menu untuk coba lagi`
      ).catch(() => bot.telegram.sendMessage(chatId, `${friendly}\n\n/menu untuk coba lagi`));
      return;
    }
  }

  await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
    '❌ Semua API key i2v habis setelah beberapa percobaan. Hubungi admin.\n\n/menu untuk kembali'
  ).catch(() => {});
}

// ─── Background: Sora 2 Image to Video ───────────────────────────────────────

async function runSora2Generation(chatId: number, userId: number, statusMsgId: number, imageUrl: string, prompt: string, aspectRatio = '16:9') {
  await runI2vWithRetry(
    userId, chatId, statusMsgId,
    'Sora2',
    () => ({
      model: 'sora-2',
      input: {
        prompt,
        duration: 8,
        aspect_ratio: aspectRatio,
        image_urls: [imageUrl],
      },
    }),
    '⏳ Sora 2 sedang generate video...\nBiasanya 2–5 menit.',
    '🌟 Sora 2 — Image to Video\n\n/menu untuk buat lagi',
  );
}

// ─── Background: Veo 3 Fast 4K Image to Video ────────────────────────────────

async function runVeo3Generation(chatId: number, userId: number, statusMsgId: number, imageUrl: string, prompt: string, aspectRatio = '16:9') {
  await runI2vWithRetry(
    userId, chatId, statusMsgId,
    'Veo3',
    () => ({
      model: 'veo-3',
      input: {
        prompt,
        mode: 'fast',
        resolution: '4k',
        aspect_ratio: aspectRatio,
        generation_type: 'REFERENCE_2_VIDEO',
        image_urls: [imageUrl],
      },
    }),
    '⏳ Veo 3 Fast 4K sedang generate video...\nBiasanya 2–5 menit.',
    '⚡ Veo 3 Fast 4K — Image to Video\n\n/menu untuk buat lagi',
  );
}

// ─── Background: Leonardo AI Kling 2.1 Pro / 2.5 Pro Image to Video ──────────

async function runLeonardoKlingGeneration(
  chatId: number,
  userId: number,
  statusMsgId: number,
  imageUrl: string,
  prompt: string,
  aspectRatio = '16:9',
  model: 'kling21pro' | 'kling26pro' = 'kling26pro',
  duration = 5,
  maxKeyRetries = 10,
) {
  const label = model === 'kling21pro' ? 'Kling 2.1 Pro' : 'Kling 2.5 Pro';
  // Leonardo AI model token strings (confirmed via API validation)
  const leonardoModel = model === 'kling21pro' ? 'KLING2_1' : 'KLING2_5';

  // Map aspect ratio to width/height for RESOLUTION_1080
  const dimensionMap: Record<string, { width: number; height: number }> = {
    '16:9': { width: 1920, height: 1080 },
    '9:16': { width: 1080, height: 1920 },
    '1:1':  { width: 1080, height: 1080 },
  };
  const { width, height } = dimensionMap[aspectRatio] ?? { width: 1920, height: 1080 };

  const usedKeys = new Set<string>();

  for (let attempt = 1; attempt <= maxKeyRetries; attempt++) {
    const apiKey = await getNextLeonardoKey(usedKeys);
    if (!apiKey) {
      await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
        '❌ Semua API key Leonardo AI habis. Hubungi admin untuk mengisi key.\n\n/menu untuk kembali'
      ).catch(() => {});
      return;
    }
    usedKeys.add(apiKey);

    try {
      console.log(`[${userId}] ${label} attempt ${attempt} — key: ${apiKey.slice(0, 10)}...`);
      await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
        `⏳ ${label} sedang diproses...\nBiasanya 2–5 menit.`
      ).catch(() => {});

      // Step 1: Download the image
      const imgData = await downloadBuffer(imageUrl);
      console.log(`[${userId}] ${label} image downloaded: ${imgData.mime} ${(imgData.buf.length / 1024).toFixed(1)}KB`);

      // Step 2: Get presigned S3 URL from Leonardo AI
      const initRes = await leonardoHttp.post(`${LEONARDO_BASE}/init-image`, {
        extension: imgData.ext === 'png' ? 'png' : 'jpg',
      }, {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 30_000,
      });

      const uploadData = initRes.data?.uploadInitImage;
      if (!uploadData?.url || !uploadData?.id) {
        throw new Error(`Init-image gagal: ${JSON.stringify(initRes.data)}`);
      }
      const { url: s3Url, fields: rawFields, id: imageId } = uploadData;
      console.log(`[${userId}] ${label} init-image OK — imageId: ${imageId} fields type: ${typeof rawFields}`);

      // Step 3: Upload image to S3 via presigned URL
      // fields can be a JSON string or an object depending on Leonardo API response
      let parsedFields: Record<string, string> = {};
      if (rawFields && typeof rawFields === 'string') {
        try { parsedFields = JSON.parse(rawFields); } catch { parsedFields = {}; }
      } else if (rawFields && typeof rawFields === 'object') {
        parsedFields = rawFields as Record<string, string>;
      }
      console.log(`[${userId}] ${label} S3 fields keys: ${Object.keys(parsedFields).join(', ')}`);

      const formData = new FormData();
      // S3 requires 'key' to be first — append it explicitly before other fields
      if (parsedFields['key']) formData.append('key', parsedFields['key']);
      for (const [k, v] of Object.entries(parsedFields)) {
        if (k !== 'key') formData.append(k, String(v));
      }
      formData.append('file', imgData.buf, {
        filename: `image.${imgData.ext === 'png' ? 'png' : 'jpg'}`,
        contentType: imgData.mime,
      });
      await telegramHttp.post(s3Url, formData, {
        headers: { ...formData.getHeaders() },
        timeout: 60_000,
        maxBodyLength: Infinity,
      });
      console.log(`[${userId}] ${label} S3 upload OK`);

      // Step 4: Create image-to-video generation via confirmed endpoint
      const genRes = await leonardoHttp.post(`${LEONARDO_BASE}/generations-image-to-video`, {
        prompt,
        imageId,
        imageType: 'UPLOADED',
        resolution: 'RESOLUTION_1080',
        duration,
        height,
        width,
        model: leonardoModel,
      }, {
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        timeout: 60_000,
      });

      const generationId = genRes.data?.motionVideoGenerationJob?.generationId
        ?? genRes.data?.generationId
        ?? genRes.data?.id;
      if (!generationId) throw new Error(`No generation ID: ${JSON.stringify(genRes.data)}`);
      console.log(`[${userId}] ${label} generation queued — ID: ${generationId}`);

      // Step 5: Poll for result (uses GET /generations/{id} → generated_images[0].motionMP4URL)
      const outputUrl = await pollLeonardoGeneration(generationId, apiKey, userId, label);
      await sendResult(chatId, outputUrl, `🎬 ${label} — Image to Video\n\n/menu untuk buat lagi`, true);
      await bot.telegram.deleteMessage(chatId, statusMsgId).catch(() => {});
      console.log(`[${userId}] ${label} done`);
      return;

    } catch (err: any) {
      const rawMsg = err?.response?.data ? JSON.stringify(err.response.data) : (err.message ?? String(err));
      const raw = typeof rawMsg === 'string' ? rawMsg : JSON.stringify(rawMsg);
      console.error(`[${userId}] ${label} error (attempt ${attempt}): ${raw}`);

      if (isLeonardoKeyExhaustedError(raw)) {
        await markLeonardoKeyDead(apiKey);
        console.log(`[${userId}] Leonardo key dead, retry: ${apiKey.slice(0, 10)}...`);
        continue;
      }

      const friendly = translateError(raw);
      await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
        `${friendly}\n\n/menu untuk coba lagi`
      ).catch(() => bot.telegram.sendMessage(chatId, `${friendly}\n\n/menu untuk coba lagi`));
      return;
    }
  }

  await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
    '❌ Semua API key Leonardo AI habis setelah beberapa percobaan. Hubungi admin.\n\n/menu untuk kembali'
  ).catch(() => {});
}

async function pollLeonardoGeneration(generationId: string, apiKey: string, userId: number, label: string): Promise<string> {
  const MAX_ATTEMPTS = 60;
  const POLL_INTERVAL = 10_000;
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    await sleep(POLL_INTERVAL);
    const res = await leonardoHttp.get(`${LEONARDO_BASE}/generations/${generationId}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      timeout: 30_000,
    });
    const gen = res.data?.generations_by_pk ?? res.data?.generation ?? res.data;
    const status = (gen?.status ?? '').toLowerCase();
    console.log(`[${userId}] ${label} poll ${i + 1}: status=${status}`);

    if (status === 'complete' || status === 'completed' || status === 'success' || status === 'finished') {
      const images = gen?.generated_images ?? gen?.generatedImages ?? gen?.outputs ?? gen?.videos;
      let url: string | undefined;
      // Prioritize motionMP4URL (Kling/video generations) over static image URL
      if (Array.isArray(images) && images.length > 0) {
        const first = images[0];
        url = typeof first === 'string'
          ? first
          : (first?.motionMP4URL ?? first?.url ?? first?.video_url);
      }
      if (!url && typeof gen?.motionMP4URL === 'string') url = gen.motionMP4URL;
      if (!url && typeof gen?.url === 'string') url = gen.url;
      if (!url && typeof gen?.video_url === 'string') url = gen.video_url;
      if (!url) throw new Error(`Selesai tapi URL kosong. Response: ${JSON.stringify(res.data)?.slice(0, 300)}`);
      console.log(`[${userId}] ${label} URL found: ${url.slice(0, 80)}...`);
      return url;
    }
    if (status === 'failed' || status === 'error') {
      throw new Error(gen?.error ?? gen?.reason ?? 'Generation gagal di Leonardo AI');
    }
  }
  throw new Error('Timeout: proses terlalu lama (>10 menit)');
}

// ─── Background: Seedance 2 Image to Video ───────────────────────────────────

async function runSeedance2Generation(chatId: number, userId: number, statusMsgId: number, imageUrl: string, duration: number, prompt: string, aspectRatio = '16:9') {
  await runI2vWithRetry(
    userId, chatId, statusMsgId,
    'Seedance2',
    () => ({
      model: 'doubao-seedance-2.0',
      input: {
        prompt,
        generation_type: 'omni_reference',
        image_urls: [imageUrl],
        duration,
        resolution: '480p',
        aspect_ratio: aspectRatio,
      },
    }),
    `⏳ Seedance 2 (480p, ${duration} detik) sedang generate video...\nBiasanya 2–5 menit.`,
    `🌱 Seedance 2 — Image to Video (480p, ${duration}s)\n\n/menu untuk buat lagi`,
  );
}

// ─── Launch ───────────────────────────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (_req, res) => res.send('OK'));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`✅ Health check server berjalan di port ${PORT}`);
});

bot.launch({ allowedUpdates: ['message', 'callback_query'] });
console.log('✅ Bot berjalan...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
