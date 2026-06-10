import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import FormData from 'form-data';
import { Client, Pool } from 'pg';
import bcrypt from 'bcryptjs';
import { HttpsProxyAgent } from 'https-proxy-agent';
import sharp from 'sharp';
import express from 'express';
import * as picsart from './picsart';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RENDERFUL_API_KEY = process.env.RENDERFUL_API_KEY;
const RENDERFUL_BASE = 'https://api.renderful.ai/api/v1';
const DATABASE_URL = process.env.RAILWAY_DATABASE_URL;
const AIVIDEOAPI_BASE = 'https://api.aivideoapi.ai/v1';
const FREEPIK_API_KEY = process.env.FREEPIK_API_KEY;
const FREEPIK_BASE = 'https://api.freepik.com/v1';
const LEONARDO_BASE = 'https://cloud.leonardo.ai/api/rest/v1';

if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');
if (!DATABASE_URL) throw new Error('RAILWAY_DATABASE_URL is required');
if (!RENDERFUL_API_KEY) console.warn('⚠️ RENDERFUL_API_KEY tidak diset — backend Renderful nonaktif (Kling Motion Control kini pakai Picsart).');

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

const KLING_DAILY_LIMIT = 15;

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

// ─── Picsart backend ──────────────────────────────────────────────────────────
picsart.initPicsart(db, (msg: string) => {
  console.error('[picsart]', msg);
  const owner = process.env.PICSART_OWNER_CHAT_ID;
  if (owner) bot.telegram.sendMessage(owner, msg).catch(() => {});
});


// ─── Session state ────────────────────────────────────────────────────────────

type Mode =
  | 'idle'
  | 'login_wait_username'
  | 'login_wait_password'
  | 'kling_wait_model'
  | 'kling_wait_image'
  | 'kling_wait_video'
  | 'seedance_wait_image'
  | 'seedance_wait_prompt'
  | 'grok_wait_image'
  | 'grok_wait_prompt'
  | 'kv3_wait_image'
  | 'kv3_wait_start'
  | 'kv3_wait_end'
  | 'kv3_wait_prompt';

interface Session {
  mode: Mode;
  dbUserId?: number;
  dbUsername?: string;
  dbIsAdmin?: boolean;
  assignedKeys?: string[];
  keyIndex?: number;
  loginTempUsername?: string;
  characterUrl?: string;
  klingModel?: 'v3' | 'v26';
  // Seedance 2.0 wizard state
  seedanceInputMode?: 'i2v' | 't2v';
  seedanceDuration?: number;
  seedanceRatio?: string;
  seedanceResolution?: string;
  seedanceAudio?: boolean;
  seedanceImageUrl?: string;
  // Grok Imagine wizard state (image-to-video only)
  grokDuration?: number;
  grokRatio?: string;
  grokImageUrl?: string;
  // Kling V3 image-to-video wizard state
  kv3InputMode?: 'i2v' | 'se';
  kv3Duration?: number;
  kv3Ratio?: string;
  kv3StartImageUrl?: string;
  kv3EndImageUrl?: string;
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

// Detect a VIDEO container — detectMime() only handles images and defaults unknown to jpeg,
// which would mislabel Telegram video bytes. Falls back to the source URL extension, then mp4.
function detectVideoType(buf: Buffer, sourceUrl?: string): { mime: string; ext: string } {
  if (buf.slice(4, 8).toString('ascii') === 'ftyp') {
    const brand = buf.slice(8, 12).toString('ascii').toLowerCase();
    if (brand.startsWith('qt')) return { mime: 'video/quicktime', ext: 'mov' };
    return { mime: 'video/mp4', ext: 'mp4' };
  }
  if (buf[0] === 0x1A && buf[1] === 0x45 && buf[2] === 0xDF && buf[3] === 0xA3)
    return { mime: 'video/webm', ext: 'webm' };
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'AVI ')
    return { mime: 'video/x-msvideo', ext: 'avi' };
  const m = (sourceUrl ?? '').toLowerCase().split('?')[0].match(/\.(mp4|m4v|mov|webm|avi|mkv)$/);
  if (m) {
    const ext = m[1];
    const map: Record<string, string> = {
      mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime',
      webm: 'video/webm', avi: 'video/x-msvideo', mkv: 'video/x-matroska',
    };
    return { mime: map[ext] ?? 'video/mp4', ext };
  }
  return { mime: 'video/mp4', ext: 'mp4' };
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
    [Markup.button.callback('🕹️ Kling Motion Control', 'mode_kling')],
    [Markup.button.callback('🎬 Seedance 2.0', 'mode_seedance')],
    [Markup.button.callback('🤖 Grok Imagine', 'mode_grok')],
    [Markup.button.callback('🎞️ Kling V3 (Image to Video)', 'mode_kv3')],
  ]);
}

function klingModelKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🆕 Kling v3.0 Motion Control', 'kling_v3')],
    [Markup.button.callback('🕹️ Kling v2.6 Motion Control', 'kling_v26')],
    [Markup.button.callback('« Kembali', 'back_main')],
  ]);
}

// ─── Seedance 2.0 wizard keyboards ────────────────────────────────────────────

function seedanceInputKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🖼️ Foto + Prompt', 'sd_in_i2v')],
    [Markup.button.callback('✍️ Prompt Saja', 'sd_in_t2v')],
    [Markup.button.callback('« Kembali', 'back_main')],
  ]);
}

function seedanceDurationKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('5 detik', 'sd_dur_5'),
      Markup.button.callback('10 detik', 'sd_dur_10'),
      Markup.button.callback('15 detik', 'sd_dur_15'),
    ],
    [Markup.button.callback('« Kembali', 'mode_seedance')],
  ]);
}

function seedanceRatioKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📱 9:16', 'sd_ratio_916'),
      Markup.button.callback('🖥️ 16:9', 'sd_ratio_169'),
      Markup.button.callback('⬛ 1:1', 'sd_ratio_11'),
    ],
  ]);
}

function seedanceResolutionKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('720p', 'sd_res_720p'),
      Markup.button.callback('1080p (HD)', 'sd_res_1080p'),
    ],
  ]);
}

function seedanceAudioKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('🔊 Audio Nyala', 'sd_audio_on'),
      Markup.button.callback('🔇 Audio Mati', 'sd_audio_off'),
    ],
  ]);
}

const SD_RATIO_MAP: Record<string, string> = { '916': '9:16', '169': '16:9', '11': '1:1' };

// ─── Grok Imagine wizard keyboards (image-to-video only) ──────────────────────

function grokDurationKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('10 detik', 'gk_dur_10'),
      Markup.button.callback('15 detik', 'gk_dur_15'),
    ],
    [Markup.button.callback('« Kembali', 'back_main')],
  ]);
}

function grokRatioKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📱 9:16', 'gk_ratio_916'),
      Markup.button.callback('🖥️ 16:9', 'gk_ratio_169'),
      Markup.button.callback('⬛ 1:1', 'gk_ratio_11'),
    ],
    [Markup.button.callback('« Kembali', 'mode_grok')],
  ]);
}

// ─── Kling V3 image-to-video wizard keyboards ─────────────────────────────────

function kv3InputKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🖼️ Foto + Prompt', 'kv3_in_i2v')],
    [Markup.button.callback('🎬 Foto Awal & Akhir', 'kv3_in_se')],
    [Markup.button.callback('« Kembali', 'back_main')],
  ]);
}

function kv3DurationKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('5 detik', 'kv3_dur_5'),
      Markup.button.callback('10 detik', 'kv3_dur_10'),
      Markup.button.callback('15 detik', 'kv3_dur_15'),
    ],
    [Markup.button.callback('« Kembali', 'mode_kv3')],
  ]);
}

function kv3RatioKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📱 9:16', 'kv3_ratio_916'),
      Markup.button.callback('🖥️ 16:9', 'kv3_ratio_169'),
      Markup.button.callback('⬛ 1:1', 'kv3_ratio_11'),
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

// ─── Picsart admin commands ───────────────────────────────────────────────────
bot.command('addpicsartkey', async (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session.dbUserId) return ctx.reply('🔒 Belum login.');
  if (!session.dbIsAdmin) return ctx.reply('❌ Hanya admin yang bisa menggunakan perintah ini.');

  const raw = ctx.message.text.replace(/^\/addpicsartkey\s*/i, '').trim();
  if (!raw) {
    return ctx.reply(
      '📝 Format:\n' +
      '/addpicsartkey rt:xxxxx\n\n' +
      'Ambil dari picsart.com (sudah login):\n' +
      'F12 → Application → Cookies → nilai cookie REFRESH_TOKEN (diawali "rt:")'
    );
  }
  const ok = await picsart.addRefreshToken(raw);
  if (!ok) return ctx.reply('❌ Token tidak valid. Harus diawali "rt:".');
  try {
    const c = await picsart.getCredits();
    return ctx.reply(
      `✅ Token Picsart tersimpan & aktif!\n💳 Sisa kredit: ${c.credits}` +
      (c.renewDate ? `\n🔄 Reset: ${new Date(c.renewDate).toLocaleDateString('id-ID')}` : '')
    );
  } catch (e: any) {
    return ctx.reply(`⚠️ Token tersimpan, tapi verifikasi gagal:\n${String(e.message).slice(0, 280)}`);
  }
});

bot.command('picsartstatus', async (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session.dbUserId) return ctx.reply('🔒 Belum login.');
  if (!session.dbIsAdmin) return ctx.reply('❌ Hanya admin yang bisa menggunakan perintah ini.');
  const st = await picsart.getStatus();
  const counts = Object.entries(st.counts).map(([k, v]) => `• ${k}: ${v}`).join('\n') || '• (kosong)';
  return ctx.reply(
    `📊 *Status Picsart*\n\nToken aktif: ${st.hasActive ? '✅ ada' : '❌ tidak ada'}\n${counts}`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('picsartcredits', async (ctx) => {
  const session = getSession(ctx.from.id);
  if (!session.dbUserId) return ctx.reply('🔒 Belum login.');
  if (!session.dbIsAdmin) return ctx.reply('❌ Hanya admin yang bisa menggunakan perintah ini.');
  try {
    const c = await picsart.getCredits();
    return ctx.reply(
      `💳 Sisa kredit Picsart: *${c.credits}*` +
      (c.renewDate ? `\n🔄 Reset: ${new Date(c.renewDate).toLocaleDateString('id-ID')}` : ''),
      { parse_mode: 'Markdown' }
    );
  } catch (e: any) {
    return ctx.reply(`❌ Gagal cek kredit: ${String(e.message).slice(0, 150)}`);
  }
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
    '*🕹️ Kling Motion Control:*\n' +
    '• Transfer gerakan dari video referensi ke karakter dengan kualitas sinematik\n' +
    '• Langkah: pilih versi model → foto karakter → video referensi → tunggu hasil\n' +
    '• Syarat foto: tampak depan penuh, min. 300px, maks 10MB\n' +
    '• Syarat video: orang terlihat jelas, durasi 2–30 detik, maks ukuran 19MB',
    { parse_mode: 'Markdown' }
  );
});

// ─── Callback queries ─────────────────────────────────────────────────────────

bot.on('callback_query', async (ctx) => {
  const data = (ctx.callbackQuery as any).data as string;
  const userId = ctx.from.id;
  await ctx.answerCbQuery();

  if (data !== 'back_main') {
    if (!await requireLoginAndSub(ctx)) return;
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

  // ── Seedance 2.0 wizard ──
  if (data === 'mode_seedance') {
    setSession(userId, {
      mode: 'idle',
      seedanceInputMode: undefined,
      seedanceDuration: undefined,
      seedanceRatio: undefined,
      seedanceResolution: undefined,
      seedanceAudio: undefined,
      seedanceImageUrl: undefined,
    });
    return ctx.editMessageText(
      '🎬 *Seedance 2.0*\n\nPilih cara membuat video:',
      { parse_mode: 'Markdown', ...seedanceInputKeyboard() }
    );
  }

  if (data === 'sd_in_i2v' || data === 'sd_in_t2v') {
    setSession(userId, { seedanceInputMode: data === 'sd_in_i2v' ? 'i2v' : 't2v' });
    return ctx.editMessageText(
      '🎬 *Seedance 2.0*\n\n*Langkah 1:* Pilih durasi video:',
      { parse_mode: 'Markdown', ...seedanceDurationKeyboard() }
    );
  }

  if (data.startsWith('sd_dur_')) {
    const dur = parseInt(data.replace('sd_dur_', ''), 10);
    setSession(userId, { seedanceDuration: dur });
    return ctx.editMessageText(
      `🎬 *Seedance 2.0*\n\nDurasi: *${dur} detik*\n\n*Langkah 2:* Pilih rasio layar:`,
      { parse_mode: 'Markdown', ...seedanceRatioKeyboard() }
    );
  }

  if (data.startsWith('sd_ratio_')) {
    const ratio = SD_RATIO_MAP[data.replace('sd_ratio_', '')] ?? '9:16';
    setSession(userId, { seedanceRatio: ratio });
    return ctx.editMessageText(
      `🎬 *Seedance 2.0*\n\nRasio: *${ratio}*\n\n*Langkah 3:* Pilih resolusi:`,
      { parse_mode: 'Markdown', ...seedanceResolutionKeyboard() }
    );
  }

  if (data.startsWith('sd_res_')) {
    const res = data.replace('sd_res_', '');
    setSession(userId, { seedanceResolution: res });
    return ctx.editMessageText(
      `🎬 *Seedance 2.0*\n\nResolusi: *${res}*\n\n*Langkah 4:* Audio video?`,
      { parse_mode: 'Markdown', ...seedanceAudioKeyboard() }
    );
  }

  if (data === 'sd_audio_on' || data === 'sd_audio_off') {
    const audio = data === 'sd_audio_on';
    const session = getSession(userId);
    if (session.seedanceInputMode === 'i2v') {
      setSession(userId, { seedanceAudio: audio, mode: 'seedance_wait_image' });
      return ctx.editMessageText(
        `🎬 *Seedance 2.0*\n\nAudio: *${audio ? 'Nyala' : 'Mati'}*\n\n` +
        '*Langkah 5:* Kirim *foto acuan* untuk video kamu.',
        { parse_mode: 'Markdown' }
      );
    }
    setSession(userId, { seedanceAudio: audio, mode: 'seedance_wait_prompt' });
    return ctx.editMessageText(
      `🎬 *Seedance 2.0*\n\nAudio: *${audio ? 'Nyala' : 'Mati'}*\n\n` +
      '*Langkah 5:* Kirim *prompt teks* untuk video kamu (deskripsi adegan).',
      { parse_mode: 'Markdown' }
    );
  }

  // ── Grok Imagine wizard (image-to-video only) ──
  if (data === 'mode_grok') {
    setSession(userId, {
      mode: 'idle',
      grokDuration: undefined,
      grokRatio: undefined,
      grokImageUrl: undefined,
    });
    return ctx.editMessageText(
      '🤖 *Grok Imagine*\n\nVideo dibuat dari *foto + prompt*.\n\n*Langkah 1:* Pilih durasi video:',
      { parse_mode: 'Markdown', ...grokDurationKeyboard() }
    );
  }

  if (data.startsWith('gk_dur_')) {
    const dur = parseInt(data.replace('gk_dur_', ''), 10);
    setSession(userId, { grokDuration: dur });
    return ctx.editMessageText(
      `🤖 *Grok Imagine*\n\nDurasi: *${dur} detik*\n\n*Langkah 2:* Pilih rasio layar:`,
      { parse_mode: 'Markdown', ...grokRatioKeyboard() }
    );
  }

  if (data.startsWith('gk_ratio_')) {
    const ratio = SD_RATIO_MAP[data.replace('gk_ratio_', '')] ?? '9:16';
    setSession(userId, { grokRatio: ratio, mode: 'grok_wait_image' });
    return ctx.editMessageText(
      `🤖 *Grok Imagine*\n\nRasio: *${ratio}*\n\n*Langkah 3:* Kirim *foto acuan* untuk video kamu.`,
      { parse_mode: 'Markdown' }
    );
  }

  // ── Kling V3 image-to-video wizard ──
  if (data === 'mode_kv3') {
    setSession(userId, {
      mode: 'idle',
      kv3InputMode: undefined,
      kv3Duration: undefined,
      kv3Ratio: undefined,
      kv3StartImageUrl: undefined,
      kv3EndImageUrl: undefined,
    });
    return ctx.editMessageText(
      '🎞️ *Kling V3 — Image to Video*\n\nPilih cara buat video:\n\n🖼️ *Foto + Prompt* — 1 foto jadi video.\n🎬 *Foto Awal & Akhir* — 2 foto (frame awal & akhir).',
      { parse_mode: 'Markdown', ...kv3InputKeyboard() }
    );
  }

  if (data === 'kv3_in_i2v' || data === 'kv3_in_se') {
    const inputMode = data === 'kv3_in_se' ? 'se' : 'i2v';
    setSession(userId, { kv3InputMode: inputMode });
    const label = inputMode === 'se' ? 'Foto Awal & Akhir' : 'Foto + Prompt';
    return ctx.editMessageText(
      `🎞️ *Kling V3* — ${label}\n\n*Langkah 1:* Pilih durasi video:`,
      { parse_mode: 'Markdown', ...kv3DurationKeyboard() }
    );
  }

  if (data.startsWith('kv3_dur_')) {
    const dur = parseInt(data.replace('kv3_dur_', ''), 10);
    setSession(userId, { kv3Duration: dur });
    return ctx.editMessageText(
      `🎞️ *Kling V3*\n\nDurasi: *${dur} detik*\n\n*Langkah 2:* Pilih rasio layar:`,
      { parse_mode: 'Markdown', ...kv3RatioKeyboard() }
    );
  }

  if (data.startsWith('kv3_ratio_')) {
    const ratio = SD_RATIO_MAP[data.replace('kv3_ratio_', '')] ?? '9:16';
    const session = getSession(userId);
    if (session.kv3InputMode === 'se') {
      setSession(userId, { kv3Ratio: ratio, mode: 'kv3_wait_start' });
      return ctx.editMessageText(
        `🎞️ *Kling V3*\n\nRasio: *${ratio}*\n\n*Langkah 3:* Kirim *foto AWAL* (frame pertama video).`,
        { parse_mode: 'Markdown' }
      );
    }
    setSession(userId, { kv3Ratio: ratio, mode: 'kv3_wait_image' });
    return ctx.editMessageText(
      `🎞️ *Kling V3*\n\nRasio: *${ratio}*\n\n*Langkah 3:* Kirim *foto acuan* untuk video kamu.`,
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

  if (session.mode === 'seedance_wait_image') {
    setSession(userId, { seedanceImageUrl: fileUrl, mode: 'seedance_wait_prompt' });
    return ctx.reply(
      '✅ Foto acuan diterima!\n\n' +
      '*Langkah terakhir:* Kirim *prompt teks* untuk video kamu (deskripsi adegan).',
      { parse_mode: 'Markdown' }
    );
  }

  if (session.mode === 'grok_wait_image') {
    setSession(userId, { grokImageUrl: fileUrl, mode: 'grok_wait_prompt' });
    return ctx.reply(
      '✅ Foto acuan diterima!\n\n' +
      '*Langkah terakhir:* Kirim *prompt teks* untuk video kamu (deskripsi adegan).',
      { parse_mode: 'Markdown' }
    );
  }

  if (session.mode === 'kv3_wait_image') {
    setSession(userId, { kv3StartImageUrl: fileUrl, mode: 'kv3_wait_prompt' });
    return ctx.reply(
      '✅ Foto acuan diterima!\n\n' +
      '*Langkah terakhir:* Kirim *prompt teks* untuk video kamu (deskripsi adegan).',
      { parse_mode: 'Markdown' }
    );
  }

  if (session.mode === 'kv3_wait_start') {
    setSession(userId, { kv3StartImageUrl: fileUrl, mode: 'kv3_wait_end' });
    return ctx.reply(
      '✅ Foto awal diterima!\n\n' +
      '*Langkah berikutnya:* Kirim *foto AKHIR* (frame terakhir video).',
      { parse_mode: 'Markdown' }
    );
  }

  if (session.mode === 'kv3_wait_end') {
    setSession(userId, { kv3EndImageUrl: fileUrl, mode: 'kv3_wait_prompt' });
    return ctx.reply(
      '✅ Foto akhir diterima!\n\n' +
      '*Langkah terakhir:* Kirim *prompt teks* untuk video kamu (deskripsi adegan).',
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

  return ctx.reply('⚠️ Kirim foto karakter terlebih dahulu.', mainMenuKeyboard());
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

  // ── Seedance prompt ──
  if (session.mode === 'seedance_wait_prompt') {
    if (!await requireLoginAndSub(ctx)) return;
    const prompt = ctx.message.text.trim();
    if (!prompt) {
      return ctx.reply('⚠️ Prompt tidak boleh kosong. Kirim deskripsi adegan untuk video kamu.');
    }
    const used = await getKlingUsageToday(session.dbUserId!);
    if (used >= KLING_DAILY_LIMIT) {
      setSession(userId, { mode: 'idle' });
      return ctx.reply(`❌ Limit harian video sudah habis!\n\n📊 Terpakai: *${used}/${KLING_DAILY_LIMIT}* generate hari ini.\n🕛 Reset otomatis besok.`, { parse_mode: 'Markdown' });
    }
    const opts = {
      inputMode: session.seedanceInputMode ?? 't2v',
      imageUrl: session.seedanceImageUrl,
      duration: session.seedanceDuration ?? 5,
      ratio: session.seedanceRatio ?? '9:16',
      resolution: session.seedanceResolution ?? '1080p',
      audio: session.seedanceAudio ?? true,
    };
    setSession(userId, { mode: 'idle' });
    const statusMsg = await ctx.reply('⏳ Memproses Seedance 2.0...\nHasil dikirim otomatis (~3-8 menit).', { parse_mode: 'Markdown' });
    runSeedance(ctx.chat.id, userId, session.dbUserId!, statusMsg.message_id, prompt, opts)
      .catch(e => console.error(`[${userId}] Seedance gen error:`, e.message));
    return;
  }

  // ── Grok prompt ──
  if (session.mode === 'grok_wait_prompt') {
    if (!await requireLoginAndSub(ctx)) return;
    const prompt = ctx.message.text.trim();
    if (!prompt) {
      return ctx.reply('⚠️ Prompt tidak boleh kosong. Kirim deskripsi adegan untuk video kamu.');
    }
    const used = await getKlingUsageToday(session.dbUserId!);
    if (used >= KLING_DAILY_LIMIT) {
      setSession(userId, { mode: 'idle' });
      return ctx.reply(`❌ Limit harian video sudah habis!\n\n📊 Terpakai: *${used}/${KLING_DAILY_LIMIT}* generate hari ini.\n🕛 Reset otomatis besok.`, { parse_mode: 'Markdown' });
    }
    if (!session.grokImageUrl) {
      setSession(userId, { mode: 'idle' });
      return ctx.reply('⚠️ Foto acuan tidak ditemukan. Mulai lagi dari /menu.');
    }
    const opts = {
      imageUrl: session.grokImageUrl,
      duration: session.grokDuration ?? 10,
      ratio: session.grokRatio ?? '9:16',
    };
    setSession(userId, { mode: 'idle' });
    const statusMsg = await ctx.reply('⏳ Memproses Grok Imagine...\nHasil dikirim otomatis (~3-8 menit).', { parse_mode: 'Markdown' });
    runGrok(ctx.chat.id, userId, session.dbUserId!, statusMsg.message_id, prompt, opts)
      .catch(e => console.error(`[${userId}] Grok gen error:`, e.message));
    return;
  }

  // ── Kling V3 image-to-video prompt ──
  if (session.mode === 'kv3_wait_prompt') {
    if (!await requireLoginAndSub(ctx)) return;
    const prompt = ctx.message.text.trim();
    if (!prompt) {
      return ctx.reply('⚠️ Prompt tidak boleh kosong. Kirim deskripsi adegan untuk video kamu.');
    }
    const used = await getKlingUsageToday(session.dbUserId!);
    if (used >= KLING_DAILY_LIMIT) {
      setSession(userId, { mode: 'idle' });
      return ctx.reply(`❌ Limit harian video sudah habis!\n\n📊 Terpakai: *${used}/${KLING_DAILY_LIMIT}* generate hari ini.\n🕛 Reset otomatis besok.`, { parse_mode: 'Markdown' });
    }
    if (!session.kv3StartImageUrl) {
      setSession(userId, { mode: 'idle' });
      return ctx.reply('⚠️ Foto acuan tidak ditemukan. Mulai lagi dari /menu.');
    }
    if (session.kv3InputMode === 'se' && !session.kv3EndImageUrl) {
      setSession(userId, { mode: 'idle' });
      return ctx.reply('⚠️ Foto akhir tidak ditemukan. Mulai lagi dari /menu.');
    }
    const opts = {
      startImageUrl: session.kv3StartImageUrl,
      endImageUrl: session.kv3InputMode === 'se' ? session.kv3EndImageUrl : undefined,
      duration: session.kv3Duration ?? 5,
      ratio: session.kv3Ratio ?? '9:16',
    };
    setSession(userId, { mode: 'idle' });
    const statusMsg = await ctx.reply('⏳ Memproses Kling V3...\nHasil dikirim otomatis (~3-8 menit).', { parse_mode: 'Markdown' });
    runKlingI2V(ctx.chat.id, userId, session.dbUserId!, statusMsg.message_id, prompt, opts)
      .catch(e => console.error(`[${userId}] Kling V3 gen error:`, e.message));
    return;
  }

  // ── Guard: modes that expect a photo/video, not text ──
  if (session.mode === 'kv3_wait_image') {
    return ctx.reply('📸 Mode ini butuh *foto acuan*. Kirim foto, atau /menu untuk batal.', { parse_mode: 'Markdown' });
  }
  if (session.mode === 'kv3_wait_start') {
    return ctx.reply('📸 Kirim *foto AWAL* dulu ya, atau /menu untuk batal.', { parse_mode: 'Markdown' });
  }
  if (session.mode === 'kv3_wait_end') {
    return ctx.reply('📸 Kirim *foto AKHIR* ya, atau /menu untuk batal.', { parse_mode: 'Markdown' });
  }
  if (session.mode === 'seedance_wait_image') {
    return ctx.reply('📸 Mode ini butuh *foto acuan*. Kirim foto, atau /menu untuk batal.', { parse_mode: 'Markdown' });
  }
  if (session.mode === 'grok_wait_image') {
    return ctx.reply('📸 Mode ini butuh *foto acuan*. Kirim foto, atau /menu untuk batal.', { parse_mode: 'Markdown' });
  }
  if (session.mode === 'kling_wait_image') {
    return ctx.reply('📸 Kirim *foto karakter* dulu ya, atau /menu untuk batal.', { parse_mode: 'Markdown' });
  }
  if (session.mode === 'kling_wait_video') {
    return ctx.reply('🎥 Kirim *video referensi gerakan*, atau /menu untuk batal.', { parse_mode: 'Markdown' });
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

  return ctx.reply('⚠️ Pilih mode terlebih dahulu:', mainMenuKeyboard());
});

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

async function runKlingMotionControl(chatId: number, userId: number, dbUserId: number, statusMsgId: number, videoFileIdOrUrl: string, imageUrl: string, klingModel: 'v3' | 'v26' = 'v3') {
  const label = klingModel === 'v3' ? 'Kling v3.0' : 'Kling v2.6';

  // Support both Telegram file ID and direct URL
  const isDirectUrl = videoFileIdOrUrl.startsWith('http://') || videoFileIdOrUrl.startsWith('https://');
  const videoUrl = isDirectUrl
    ? videoFileIdOrUrl
    : (await bot.telegram.getFileLink(videoFileIdOrUrl)).href;
  console.log(`[${userId}] ${label} Motion Control (Picsart) started — img: ${imageUrl}, vid: ${videoUrl}`);

  try {
    await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
      `⏳ ${label} sedang diproses...\nBiasanya 5–8 menit.`
    ).catch(() => {});

    // Download both media via Telegram (no proxy — Telegram reachable directly)
    const [img, vid] = await Promise.all([
      downloadBuffer(imageUrl),
      downloadBuffer(videoUrl),
    ]);
    // downloadBuffer() uses detectMime() which only knows images and would mislabel the
    // video as image/jpeg — detect the real video container instead.
    const vidType = detectVideoType(vid.buf, videoUrl);
    console.log(`[${userId}] ${label} media — img: ${img.mime} ${(img.buf.length / 1024).toFixed(1)}KB, vid: ${vidType.mime} ${(vid.buf.length / 1024).toFixed(1)}KB`);

    const result = await picsart.generateKlingMotionControl({
      imageBuffer: img.buf, imageName: `character.${img.ext}`, imageMime: img.mime,
      videoBuffer: vid.buf, videoName: `driver.${vidType.ext}`, videoMime: vidType.mime,
      prompt: '',
      model: klingModel,
      onStatus: (stage) => {
        const text = stage === 'upload'
          ? `⏳ ${label}: mengunggah media ke server...`
          : stage === 'submit'
            ? `⏳ ${label}: mengirim job ke server...`
            : `⏳ ${label} sedang diproses...\nBiasanya 5–8 menit.`;
        bot.telegram.editMessageText(chatId, statusMsgId, undefined, text).catch(() => {});
      },
    });

    const newCount = await incrementKlingUsage(dbUserId);
    const remaining = Math.max(0, KLING_DAILY_LIMIT - newCount);
    const doneLabel = result.usedModel === 'v3' ? 'Kling v3.0' : 'Kling v2.6';
    const fallbackNote = result.usedModel !== klingModel ? ' (v2.6 belum tersedia — otomatis pakai v3.0)' : '';
    await sendResult(chatId, result.url, `🕹️ ${doneLabel} Motion Control${fallbackNote}\n📊 Generate hari ini: ${newCount}/${KLING_DAILY_LIMIT} (sisa: ${remaining})\n\n/menu untuk buat lagi`, true);
    await bot.telegram.deleteMessage(chatId, statusMsgId).catch(() => {});
    console.log(`[${userId}] ${label} done via Picsart as ${result.usedModel} (usage: ${newCount}/${KLING_DAILY_LIMIT}, credits used: ${result.credits ?? '?'})`);

  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error(`[${userId}] ${label} Picsart error: ${msg}`);
    let friendly: string;
    if (msg.includes('PICSART_TIMEOUT')) {
      friendly = '❌ Proses terlalu lama. Coba lagi nanti.';
    } else if (msg.includes('PICSART_UPLOAD_FAILED')) {
      friendly = '❌ Media tidak bisa diproses. Coba file lain.';
    } else {
      friendly = '❌ Gagal memproses. Coba lagi nanti.';
    }
    await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
      `${friendly}\n\n/menu untuk coba lagi`
    ).catch(() => bot.telegram.sendMessage(chatId, `${friendly}\n\n/menu untuk coba lagi`));
  }
}

// ─── Background: Seedance 2.0 ─────────────────────────────────────────────────

async function runSeedance(
  chatId: number,
  userId: number,
  dbUserId: number,
  statusMsgId: number,
  prompt: string,
  opts: {
    inputMode: 'i2v' | 't2v';
    imageUrl?: string;
    duration: number;
    ratio: string;
    resolution: string;
    audio: boolean;
  }
) {
  console.log(`[${userId}] Seedance started — mode: ${opts.inputMode}, dur: ${opts.duration}s, ratio: ${opts.ratio}, res: ${opts.resolution}, audio: ${opts.audio}`);

  try {
    let imageBuffer: Buffer | undefined;
    let imageName: string | undefined;
    let imageMime: string | undefined;
    if (opts.inputMode === 'i2v' && opts.imageUrl) {
      const img = await downloadBuffer(opts.imageUrl);
      imageBuffer = img.buf;
      imageName = `reference.${img.ext}`;
      imageMime = img.mime;
      console.log(`[${userId}] Seedance ref image — ${img.mime} ${(img.buf.length / 1024).toFixed(1)}KB`);
    }

    let lastEdit = 0;
    const result = await picsart.generateSeedance({
      prompt,
      imageBuffer,
      imageName,
      imageMime,
      duration: opts.duration,
      ratio: opts.ratio,
      resolution: opts.resolution,
      generateAudio: opts.audio,
      onStatus: (stage) => {
        const text = stage === 'upload'
          ? '⏳ Seedance 2.0: mengunggah foto ke server... (1/3)'
          : stage === 'submit'
            ? '⏳ Seedance 2.0: mengirim perintah ke server... (2/3)'
            : '⏳ Seedance 2.0: video sedang dibuat... (3/3)\n⏱️ Mohon tunggu, biasanya 3–8 menit. Jangan tutup chat ini.';
        lastEdit = Date.now();
        bot.telegram.editMessageText(chatId, statusMsgId, undefined, text).catch(() => {});
      },
      onPoll: (elapsedSec) => {
        // Heartbeat: refresh the status with a running timer every ~30s so the
        // user can see the bot is still working (not stuck).
        if (Date.now() - lastEdit < 30_000) return;
        lastEdit = Date.now();
        const mins = Math.floor(elapsedSec / 60);
        const secs = elapsedSec % 60;
        const timer = mins > 0 ? `${mins} menit ${secs} detik` : `${secs} detik`;
        bot.telegram.editMessageText(
          chatId, statusMsgId, undefined,
          `⏳ Seedance 2.0: video sedang dibuat... (3/3)\n⏱️ Sudah berjalan ${timer} (biasanya 3–8 menit).\nJangan tutup chat ini, video dikirim otomatis.`
        ).catch(() => {});
      },
    });

    const newCount = await incrementKlingUsage(dbUserId);
    const remaining = Math.max(0, KLING_DAILY_LIMIT - newCount);
    await sendResult(
      chatId,
      result.url,
      `🎬 Seedance 2.0 (${opts.duration}s · ${opts.ratio} · ${opts.resolution}${opts.audio ? ' · audio' : ''})\n📊 Generate hari ini: ${newCount}/${KLING_DAILY_LIMIT} (sisa: ${remaining})\n\n/menu untuk buat lagi`,
      true
    );
    await bot.telegram.deleteMessage(chatId, statusMsgId).catch(() => {});
    console.log(`[${userId}] Seedance done (usage: ${newCount}/${KLING_DAILY_LIMIT}, credits used: ${result.credits ?? '?'})`);

  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error(`[${userId}] Seedance error: ${msg}`);
    let friendly: string;
    if (msg.includes('PICSART_TIMEOUT')) {
      friendly = '❌ Proses terlalu lama. Coba lagi nanti.';
    } else if (msg.includes('PICSART_UPLOAD_FAILED')) {
      friendly = '❌ Foto tidak bisa diproses. Coba foto lain.';
    } else {
      friendly = '❌ Gagal memproses. Coba lagi nanti.';
    }
    await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
      `${friendly}\n\n/menu untuk coba lagi`
    ).catch(() => bot.telegram.sendMessage(chatId, `${friendly}\n\n/menu untuk coba lagi`));
  }
}

// ─── Background: Grok Imagine (image-to-video) ────────────────────────────────

async function runGrok(
  chatId: number,
  userId: number,
  dbUserId: number,
  statusMsgId: number,
  prompt: string,
  opts: {
    imageUrl: string;
    duration: number;
    ratio: string;
  }
) {
  console.log(`[${userId}] Grok started — dur: ${opts.duration}s, ratio: ${opts.ratio}`);

  try {
    const img = await downloadBuffer(opts.imageUrl);
    console.log(`[${userId}] Grok ref image — ${img.mime} ${(img.buf.length / 1024).toFixed(1)}KB`);

    let lastEdit = 0;
    const result = await picsart.generateGrok({
      prompt,
      imageBuffer: img.buf,
      imageName: `reference.${img.ext}`,
      imageMime: img.mime,
      duration: opts.duration,
      ratio: opts.ratio,
      onStatus: (stage) => {
        const text = stage === 'upload'
          ? '⏳ Grok Imagine: mengunggah foto ke server... (1/3)'
          : stage === 'submit'
            ? '⏳ Grok Imagine: mengirim perintah ke server... (2/3)'
            : '⏳ Grok Imagine: video sedang dibuat... (3/3)\n⏱️ Mohon tunggu, biasanya 3–8 menit. Jangan tutup chat ini.';
        lastEdit = Date.now();
        bot.telegram.editMessageText(chatId, statusMsgId, undefined, text).catch(() => {});
      },
      onPoll: (elapsedSec) => {
        if (Date.now() - lastEdit < 30_000) return;
        lastEdit = Date.now();
        const mins = Math.floor(elapsedSec / 60);
        const secs = elapsedSec % 60;
        const timer = mins > 0 ? `${mins} menit ${secs} detik` : `${secs} detik`;
        bot.telegram.editMessageText(
          chatId, statusMsgId, undefined,
          `⏳ Grok Imagine: video sedang dibuat... (3/3)\n⏱️ Sudah berjalan ${timer} (biasanya 3–8 menit).\nJangan tutup chat ini, video dikirim otomatis.`
        ).catch(() => {});
      },
    });

    const newCount = await incrementKlingUsage(dbUserId);
    const remaining = Math.max(0, KLING_DAILY_LIMIT - newCount);
    await sendResult(
      chatId,
      result.url,
      `🤖 Grok Imagine (${opts.duration}s · ${opts.ratio})\n📊 Generate hari ini: ${newCount}/${KLING_DAILY_LIMIT} (sisa: ${remaining})\n\n/menu untuk buat lagi`,
      true
    );
    await bot.telegram.deleteMessage(chatId, statusMsgId).catch(() => {});
    console.log(`[${userId}] Grok done (usage: ${newCount}/${KLING_DAILY_LIMIT}, credits used: ${result.credits ?? '?'})`);

  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error(`[${userId}] Grok error: ${msg}`);
    let friendly: string;
    if (msg.includes('PICSART_TIMEOUT')) {
      friendly = '❌ Proses terlalu lama. Coba lagi nanti.';
    } else if (msg.includes('PICSART_UPLOAD_FAILED')) {
      friendly = '❌ Foto tidak bisa diproses. Coba foto lain.';
    } else {
      friendly = '❌ Gagal memproses. Coba lagi nanti.';
    }
    await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
      `${friendly}\n\n/menu untuk coba lagi`
    ).catch(() => bot.telegram.sendMessage(chatId, `${friendly}\n\n/menu untuk coba lagi`));
  }
}

// ─── Background: Kling V3 image-to-video ──────────────────────────────────────

async function runKlingI2V(
  chatId: number,
  userId: number,
  dbUserId: number,
  statusMsgId: number,
  prompt: string,
  opts: {
    startImageUrl: string;
    endImageUrl?: string;
    duration: number;
    ratio: string;
  }
) {
  const isSE = !!opts.endImageUrl;
  console.log(`[${userId}] Kling V3 started — ${isSE ? 'start/end' : 'i2v'}, dur: ${opts.duration}s, ratio: ${opts.ratio}`);

  try {
    const startImg = await downloadBuffer(opts.startImageUrl);
    console.log(`[${userId}] Kling V3 start image — ${startImg.mime} ${(startImg.buf.length / 1024).toFixed(1)}KB`);
    let endImg: { buf: Buffer; mime: string; ext: string } | undefined;
    if (opts.endImageUrl) {
      endImg = await downloadBuffer(opts.endImageUrl);
      console.log(`[${userId}] Kling V3 end image — ${endImg.mime} ${(endImg.buf.length / 1024).toFixed(1)}KB`);
    }

    let lastEdit = 0;
    const result = await picsart.generateKlingI2V({
      prompt,
      imageBuffer: startImg.buf,
      imageName: `start.${startImg.ext}`,
      imageMime: startImg.mime,
      imageTailBuffer: endImg?.buf,
      imageTailName: endImg ? `end.${endImg.ext}` : undefined,
      imageTailMime: endImg?.mime,
      duration: opts.duration,
      ratio: opts.ratio,
      onStatus: (stage) => {
        const text = stage === 'upload'
          ? '⏳ Kling V3: mengunggah foto ke server... (1/3)'
          : stage === 'submit'
            ? '⏳ Kling V3: mengirim perintah ke server... (2/3)'
            : '⏳ Kling V3: video sedang dibuat... (3/3)\n⏱️ Mohon tunggu, biasanya 3–8 menit. Jangan tutup chat ini.';
        lastEdit = Date.now();
        bot.telegram.editMessageText(chatId, statusMsgId, undefined, text).catch(() => {});
      },
      onPoll: (elapsedSec) => {
        if (Date.now() - lastEdit < 30_000) return;
        lastEdit = Date.now();
        const mins = Math.floor(elapsedSec / 60);
        const secs = elapsedSec % 60;
        const timer = mins > 0 ? `${mins} menit ${secs} detik` : `${secs} detik`;
        bot.telegram.editMessageText(
          chatId, statusMsgId, undefined,
          `⏳ Kling V3: video sedang dibuat... (3/3)\n⏱️ Sudah berjalan ${timer} (biasanya 3–8 menit).\nJangan tutup chat ini, video dikirim otomatis.`
        ).catch(() => {});
      },
    });

    const newCount = await incrementKlingUsage(dbUserId);
    const remaining = Math.max(0, KLING_DAILY_LIMIT - newCount);
    const modeLabel = isSE ? 'Awal & Akhir' : 'Image to Video';
    await sendResult(
      chatId,
      result.url,
      `🎞️ Kling V3 · ${modeLabel} (${opts.duration}s · ${opts.ratio})\n📊 Generate hari ini: ${newCount}/${KLING_DAILY_LIMIT} (sisa: ${remaining})\n\n/menu untuk buat lagi`,
      true
    );
    await bot.telegram.deleteMessage(chatId, statusMsgId).catch(() => {});
    console.log(`[${userId}] Kling V3 done (usage: ${newCount}/${KLING_DAILY_LIMIT}, credits used: ${result.credits ?? '?'})`);

  } catch (err: any) {
    const msg = err?.message ?? String(err);
    console.error(`[${userId}] Kling V3 error: ${msg}`);
    let friendly: string;
    if (msg.includes('PICSART_TIMEOUT')) {
      friendly = '❌ Proses terlalu lama. Coba lagi nanti.';
    } else if (msg.includes('PICSART_UPLOAD_FAILED')) {
      friendly = '❌ Foto tidak bisa diproses. Coba foto lain.';
    } else {
      friendly = '❌ Gagal memproses. Coba lagi nanti.';
    }
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

// ─── Launch ───────────────────────────────────────────────────────────────────

const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (_req, res) => res.send('OK'));
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`✅ Health check server berjalan di port ${PORT}`);
});

// Ensure the Picsart schema exists BEFORE handlers go live, so an early
// /addpicsartkey can't hit a missing table on cold start.
(async () => {
  try {
    await picsart.ensurePicsartSchema();
    console.log('✅ Picsart schema siap');
    // Keep the refresh token alive forever on a dedicated account (seed once).
    picsart.startPicsartKeepalive();
    console.log('✅ Picsart keepalive aktif (refresh tiap 3 hari)');
  } catch (e: any) {
    console.error('❌ Picsart schema gagal:', e?.message ?? e);
  }
  bot.launch({ allowedUpdates: ['message', 'callback_query'] });
  console.log('✅ Bot berjalan...');
})();

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
