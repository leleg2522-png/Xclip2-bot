import { Telegraf, Markup } from 'telegraf';
import axios from 'axios';
import FormData from 'form-data';
import { Client, Pool } from 'pg';
import { HttpsProxyAgent } from 'https-proxy-agent';
import sharp from 'sharp';
import express from 'express';
import { promises as fsp, createReadStream } from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import * as picsart from './picsart';
import * as klikqris from './klikqris';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const RENDERFUL_API_KEY = process.env.RENDERFUL_API_KEY;
const RENDERFUL_BASE = 'https://api.renderful.ai/api/v1';
const DATABASE_URL = process.env.RAILWAY_DATABASE_URL;
const AIVIDEOAPI_BASE = 'https://api.aivideoapi.ai/v1';
const FREEPIK_API_KEY = process.env.FREEPIK_API_KEY;
const FREEPIK_BASE = 'https://api.freepik.com/v1';
const LEONARDO_BASE = 'https://cloud.leonardo.ai/api/rest/v1';
const SNAPGEN_API_KEY = process.env.SNAPGEN_API_KEY;
const SNAPGEN_BASE = 'https://api.snapgen.ai/uapi/v1';

if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is required');
if (!DATABASE_URL) throw new Error('RAILWAY_DATABASE_URL is required');
if (!RENDERFUL_API_KEY) console.warn('⚠️ RENDERFUL_API_KEY tidak diset — backend Renderful nonaktif (Kling Motion Control kini pakai Picsart).');
if (!SNAPGEN_API_KEY) console.warn('⚠️ SNAPGEN_API_KEY tidak diset — backend SnapGen nonaktif (Veo 3.1 Fast/Lite).');

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

const db = new Pool({
  connectionString: DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  // Railway/managed Postgres silently drops idle TCP connections. keepAlive
  // keeps the socket warm so a long generation (poll loop hits the DB every 5s
  // for up to ~15 min) doesn't get "Connection terminated unexpectedly".
  keepAlive: true,
  keepAliveInitialDelayMillis: 10_000,
  // During an upstream network disruption a connect can hang for a long time.
  // Cap it so a bad attempt fails fast (as ETIMEDOUT) and the q() retry wrapper
  // can try again quickly, instead of one poll cycle stalling for minutes.
  connectionTimeoutMillis: 10_000,
});
// CRITICAL: a pooled client can error while idle (server closed the socket).
// The pg Pool emits 'error' for that; with NO listener Node treats it as an
// unhandled 'error' event and CRASHES the process — which wipes every
// in-memory login ("login mulu"). This listener downgrades it to a warning;
// the pool discards the bad client and hands out a fresh one on the next query.
db.on('error', (err: any) => {
  console.warn('⚠️ PG pool idle-client error (bot masih jalan):', err?.message ?? err);
});
console.log('✅ Database pool initialized');

async function checkActiveSubscription(userId: number): Promise<boolean> {
  const res = await db.query(
    `SELECT id FROM subscriptions 
     WHERE user_id = $1 AND status = 'active' AND expired_at > NOW()
     LIMIT 1`,
    [userId]
  );
  return res.rows.length > 0;
}

// ─── Saldo (pay-per-generate) ─────────────────────────────────────────────────

// Harga per generate dalam Rupiah (integer). Sumber kebenaran tunggal — semua
// handler generate baca dari sini, jangan hardcode angka di tempat lain.
const MODEL_PRICES = {
  sora: 2500,
  gemini_omni: 2500,
  kling_mc: 3500,      // Kling MC3.0 PRO (Picsart motion control)
  runway: 1500,        // Runway Gen-4.5 (image-to-video)
  veo_fast: 1500,      // Veo 3.1 Fast Full HD (SnapGen)
  veo_lite: 1500,      // Veo 3.1 Lite Full HD (SnapGen, with audio)
  nb_pro: 500,         // Nano Banana Pro (SnapGen image)
  nb_2: 500,           // Nano Banana 2 (SnapGen image)
  nb_2lite: 500,       // Nano Banana 2 Lite (SnapGen image)
} as const;
type ModelKey = keyof typeof MODEL_PRICES;

// Batas durasi video referensi Kling Motion Control (detik).
const KLING_MAX_REF_SECONDS = 16;

// Deskripsi error yang tahan banting untuk logging/notif admin: message kosong,
// axios error (status + body), atau nilai non-Error tetap menghasilkan info berguna.
function describeError(err: any): string {
  const parts: string[] = [];
  const msg = typeof err?.message === 'string' ? err.message : '';
  if (msg) parts.push(msg);
  if (!msg && err?.name) parts.push(String(err.name));
  if (err?.code && !msg.includes(String(err.code))) parts.push(`code=${err.code}`);
  if (err?.response?.status) {
    let body = '';
    try { body = JSON.stringify(err.response.data ?? '').slice(0, 200); } catch { /* ignore */ }
    parts.push(`http ${err.response.status} ${body}`);
  }
  if (!parts.length) {
    const stackLine = typeof err?.stack === 'string' ? err.stack.split('\n').slice(0, 2).join(' | ') : '';
    parts.push(stackLine || (typeof err === 'object' ? JSON.stringify(err).slice(0, 200) : String(err)) || 'unknown error (pesan kosong)');
  }
  return parts.join(' ');
}

function formatRupiah(n: number): string {
  return 'Rp' + Math.round(n).toLocaleString('id-ID');
}

async function getSaldo(dbUserId: number): Promise<number> {
  const res = await db.query('SELECT saldo FROM users WHERE id = $1', [dbUserId]);
  return Number(res.rows[0]?.saldo ?? 0);
}

// Potong saldo secara ATOMIK. Return true kalau berhasil (saldo cukup), false
// kalau kurang. `WHERE saldo >= $2` mencegah balapan: dua generate barengan tak
// bisa dua-duanya lolos kalau saldonya cuma cukup buat satu. Saldo tak akan minus.
async function deductSaldo(dbUserId: number, amount: number): Promise<boolean> {
  const res = await db.query(
    'UPDATE users SET saldo = saldo - $2 WHERE id = $1 AND saldo >= $2 RETURNING saldo',
    [dbUserId, amount]
  );
  return (res.rowCount ?? 0) > 0;
}

// Bonus referral: pengundang dapat 5% dari SETIAP top-up user undangannya,
// langsung masuk saldo utama. Anti-dobel via UNIQUE(order_id) di referral_bonuses.
const REFERRAL_RATE = 0.05;

// Tambah/kembalikan saldo (top-up sukses ATAU refund saat generate gagal).
async function addSaldo(dbUserId: number, amount: number): Promise<number> {
  const res = await db.query(
    'UPDATE users SET saldo = saldo + $2 WHERE id = $1 RETURNING saldo',
    [dbUserId, amount]
  );
  return Number(res.rows[0]?.saldo ?? 0);
}

// Idempotent — aman dipanggil tiap startup. Menambah kolom saldo & telegram_id,
// tabel topup_orders, lalu (SEKALI seumur hidup, dijaga bot_migrations) kredit
// Rp100.000 ke user yang langganannya MASIH aktif saat cutover. User yang
// langganannya sudah habis / belum pernah langganan mulai dari Rp0.
async function ensureBalanceSchema(): Promise<void> {
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS saldo BIGINT NOT NULL DEFAULT 0`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS telegram_id BIGINT`);
  await db.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS users_telegram_id_uq ON users (telegram_id) WHERE telegram_id IS NOT NULL`
  );
  await db.query(`
    CREATE TABLE IF NOT EXISTS topup_orders (
      order_id      TEXT PRIMARY KEY,
      db_user_id    INTEGER NOT NULL,
      telegram_id   BIGINT NOT NULL,
      amount        BIGINT NOT NULL,
      total_amount  BIGINT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'PENDING',
      qris_string   TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at    TIMESTAMPTZ,
      paid_at       TIMESTAMPTZ
    )
  `);
  await db.query(
    `CREATE TABLE IF NOT EXISTS bot_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`
  );
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by INTEGER`);
  await db.query(`
    CREATE TABLE IF NOT EXISTS referral_bonuses (
      id          SERIAL PRIMARY KEY,
      referrer_id INTEGER NOT NULL,
      referred_id INTEGER NOT NULL,
      order_id    TEXT NOT NULL UNIQUE,
      amount      BIGINT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);

  // One-time cutover credit — di-guard pakai bot_migrations biar TAK PERNAH
  // dobel walau bot restart berkali-kali.
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const done = await client.query(`SELECT 1 FROM bot_migrations WHERE name = 'cutover_credit_active_100k'`);
    if ((done.rowCount ?? 0) === 0) {
      const upd = await client.query(`
        UPDATE users SET saldo = 100000
        WHERE id IN (
          SELECT user_id FROM subscriptions WHERE status = 'active' AND expired_at > NOW()
        )
      `);
      await client.query(`INSERT INTO bot_migrations (name) VALUES ('cutover_credit_active_100k')`);
      await client.query('COMMIT');
      console.log(`✅ Cutover: kredit Rp100.000 ke ${upd.rowCount ?? 0} user langganan aktif`);
    } else {
      await client.query('COMMIT');
    }
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ─── Top-up (KlikQRIS) ────────────────────────────────────────────────────────

async function createTopupOrder(
  orderId: string,
  dbUserId: number,
  telegramId: number,
  amount: number,
  totalAmount: number,
  qrisString: string | undefined,
  expiresAt: Date | null
): Promise<void> {
  await db.query(
    `INSERT INTO topup_orders (order_id, db_user_id, telegram_id, amount, total_amount, status, qris_string, expires_at)
     VALUES ($1, $2, $3, $4, $5, 'PENDING', $6, $7)`,
    [orderId, dbUserId, telegramId, amount, totalAmount, qrisString ?? null, expiresAt]
  );
}

interface PendingTopup {
  order_id: string;
  db_user_id: number;
  telegram_id: string;
  amount: string;
  total_amount: string;
  created_at: Date;
  expires_at: Date | null;
}

async function getPendingTopupOrders(): Promise<PendingTopup[]> {
  const res = await db.query(
    `SELECT order_id, db_user_id, telegram_id, amount, total_amount, created_at, expires_at
     FROM topup_orders WHERE status = 'PENDING' ORDER BY created_at ASC LIMIT 200`
  );
  return res.rows;
}

// Tandai PAID + kredit saldo secara ATOMIK. Return data hanya kalau panggilan
// INI yang membalik status → PAID — mencegah dobel-kredit walau poller &
// /cekbayar jalan bersamaan.
async function markTopupPaidAndCredit(
  orderId: string
): Promise<{
  amount: number; dbUserId: number; telegramId: number; newSaldo: number;
  referral: { referrerTelegramId: number | null; bonus: number } | null;
} | null> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    // status <> 'PAID' (bukan cuma 'PENDING') supaya order yang sempat kita tandai
    // EXPIRED lokal tetap BISA dikreditkan kalau ternyata gateway bilang sudah
    // dibayar (pembayaran telat). Tetap anti-dobel: hanya sekali bisa jadi PAID.
    const upd = await client.query(
      `UPDATE topup_orders SET status = 'PAID', paid_at = NOW()
       WHERE order_id = $1 AND status <> 'PAID'
       RETURNING db_user_id, telegram_id, amount`,
      [orderId]
    );
    if ((upd.rowCount ?? 0) === 0) {
      await client.query('COMMIT');
      return null;
    }
    const row = upd.rows[0];
    const bal = await client.query(
      `UPDATE users SET saldo = saldo + $2 WHERE id = $1 RETURNING saldo`,
      [row.db_user_id, row.amount]
    );

    // Bonus referral 5% ke pengundang — dalam transaksi yang sama biar atomik.
    // UNIQUE(order_id) menjamin bonus per order cuma sekali walau ada balapan.
    let referral: { referrerTelegramId: number | null; bonus: number } | null = null;
    const ref = await client.query(`SELECT referred_by FROM users WHERE id = $1`, [row.db_user_id]);
    const referrerId = ref.rows[0]?.referred_by;
    if (referrerId && Number(referrerId) !== Number(row.db_user_id)) {
      const bonus = Math.floor(Number(row.amount) * REFERRAL_RATE);
      if (bonus > 0) {
        const ins = await client.query(
          `INSERT INTO referral_bonuses (referrer_id, referred_id, order_id, amount)
           VALUES ($1, $2, $3, $4) ON CONFLICT (order_id) DO NOTHING RETURNING id`,
          [referrerId, row.db_user_id, orderId, bonus]
        );
        if ((ins.rowCount ?? 0) > 0) {
          const r2 = await client.query(
            `UPDATE users SET saldo = saldo + $2 WHERE id = $1 RETURNING telegram_id`,
            [referrerId, bonus]
          );
          const tg = r2.rows[0]?.telegram_id;
          referral = { referrerTelegramId: tg ? Number(tg) : null, bonus };
        }
      }
    }

    await client.query('COMMIT');
    return {
      amount: Number(row.amount),
      dbUserId: Number(row.db_user_id),
      telegramId: Number(row.telegram_id),
      newSaldo: Number(bal.rows[0]?.saldo ?? 0),
      referral,
    };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function markTopupExpired(orderId: string): Promise<void> {
  await db.query(
    `UPDATE topup_orders SET status = 'EXPIRED' WHERE order_id = $1 AND status = 'PENDING'`,
    [orderId]
  );
}

async function getRecentTopups(
  dbUserId: number,
  limit = 10
): Promise<Array<{ order_id: string; amount: string; total_amount: string; status: string; created_at: Date; paid_at: Date | null }>> {
  const res = await db.query(
    `SELECT order_id, amount, total_amount, status, created_at, paid_at
     FROM topup_orders WHERE db_user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [dbUserId, limit]
  );
  return res.rows;
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

// ─── Generate Cooldown ────────────────────────────────────────────────────────

const GEN_COOLDOWN_MS = 0; // cooldown dinonaktifkan
const lastGenSuccessAt = new Map<number, number>();

function getCooldownRemainingMs(userId: number): number {
  const last = lastGenSuccessAt.get(userId);
  if (last === undefined) return 0;
  return Math.max(0, GEN_COOLDOWN_MS - (Date.now() - last));
}

function formatCooldown(ms: number): string {
  const totalSec = Math.ceil(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m} menit ${s} detik` : `${s} detik`;
}

function markGenSuccess(userId: number): void {
  lastGenSuccessAt.set(userId, Date.now());
}

// Escape characters that break Telegram's legacy Markdown parser. Labels are
// free text (often emails like "a_b@x.com") and an unescaped `_`/`*`/`[`/`` ` ``
// makes Telegram reject the whole message with a 400 "can't parse entities".
function mdEscape(s: string): string {
  return s.replace(/([_*\[\]`])/g, '\\$1');
}

// Telegram rejects any single message over 4096 chars. Long lists (e.g. a pool
// of 150+ accounts) must be split into several messages. Sends `header` first,
// then packs `lines` into chunks that stay under the limit.
async function replyLong(ctx: any, header: string, lines: string[]): Promise<void> {
  const MAX = 3500; // safe margin under Telegram's 4096 limit
  let buf = header;
  for (const line of lines) {
    if (buf.length + line.length + 1 > MAX) {
      await ctx.reply(buf, { parse_mode: 'Markdown' });
      buf = line;
    } else {
      buf = buf ? `${buf}\n${line}` : line;
    }
  }
  if (buf) await ctx.reply(buf, { parse_mode: 'Markdown' });
}

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

// Recognizes only genuine transient transport failures (DNS/socket/timeout).
// Kept deliberately narrow — matching by explicit error code, not free-text —
// so real upstream failures (Renderful/Freepik/DB "Network Error" strings) are
// NOT swallowed and still surface with a full stack trace.
const TRANSIENT_NET_CODES = new Set([
  'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED',
  'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
]);
function isTransientNetworkError(err: unknown): boolean {
  const e = err as any;
  if (!e) return false;
  if (typeof e.code === 'string' && TRANSIENT_NET_CODES.has(e.code)) return true;
  // node-fetch surfaces low-level socket failures as FetchError{type:'system'}
  // carrying the underlying errno in `code`; only treat those as transient.
  if (e.type === 'system' && typeof e.errno === 'string' && TRANSIENT_NET_CODES.has(e.errno)) return true;
  if (/socket hang up/i.test(e.message || '')) return true;
  return false;
}

// ─── Picsart backend ──────────────────────────────────────────────────────────
picsart.initPicsart(db, (msg: string) => {
  console.error('[picsart]', msg);
  const owner = process.env.PICSART_OWNER_CHAT_ID;
  if (owner) bot.telegram.sendMessage(owner, msg).catch(() => {});
});


// ─── Session state ────────────────────────────────────────────────────────────

type Mode =
  | 'idle'
  | 'kling_wait_image'
  | 'kling_wait_video'
  | 'kling_wait_prompt'
  | 'rw_wait_image'
  | 'rw_wait_prompt'
  | 'sora_wait_image'
  | 'sora_wait_prompt'
  | 'veofast_wait_image'
  | 'veofast_wait_prompt'
  | 'veolite_wait_image'
  | 'veolite_wait_prompt'
  | 'gomni_wait_image'
  | 'gomni_wait_video'
  | 'gomni_wait_prompt'
  | 'img_wait_image'
  | 'img_wait_prompt'
  | 'topup_wait_custom';

interface Session {
  mode: Mode;
  dbUserId?: number;
  dbUsername?: string;
  dbIsAdmin?: boolean;
  assignedKeys?: string[];
  keyIndex?: number;
  characterUrl?: string;
  klingCharacterFileId?: string;
  klingVideoFileId?: string;
  // Runway Gen-4.5 wizard state (image-to-video only)
  rwDuration?: number;
  rwRatio?: string;
  rwImageUrl?: string;
  // Sora 2 wizard state (text-to-video or image-to-video)
  soraInputMode?: 'i2v' | 't2v';
  soraDuration?: number;
  soraRatio?: string;
  soraImageUrl?: string;
  // Veo 3.1 Fast (SnapGen) wizard state (text-to-video or image-to-video)
  veofastInputMode?: 'i2v' | 't2v';
  veofastImageUrl?: string;
  veofastRatio?: string;
  // Veo 3.1 Lite (SnapGen) wizard state (text-to-video or image-to-video)
  veoliteInputMode?: 'i2v' | 't2v';
  veoliteImageUrl?: string;
  veoliteRatio?: string;
  // Gemini Omni wizard state (text-to-video, image-to-video, or image+video ref)
  gomniInputMode?: 'i2v' | 't2v' | 'v2v';
  gomniDuration?: number;
  gomniRatio?: string;
  gomniImageUrl?: string;
  gomniVideoUrl?: string;
  // Image generation wizard state (SnapGen: Nano Banana Pro / 2 / 2 Lite)
  imgModel?: 'nano-banana-pro' | 'nano-banana-2' | 'nano-banana-2-lite';
  imgPriceKey?: 'nb_pro' | 'nb_2' | 'nb_2lite';
  imgRatio?: string;
  imgInputMode?: 'i2i' | 't2i';
  imgImageUrl?: string;
}

const sessions = new Map<number, Session>();

// Jumlah generate yang sedang berjalan per dbUserId (anti balapan & double-charge).
// Model Picsart boleh sampai 3 job bersamaan per user. Limit ditentukan per
// pemanggilan beginCharge.
const generating = new Map<number, number>();

function releaseGenerating(dbUserId: number): void {
  const n = (generating.get(dbUserId) ?? 0) - 1;
  if (n <= 0) generating.delete(dbUserId);
  else generating.set(dbUserId, n);
}

type ChargeResult = { ok: true } | { ok: false; reason: 'busy' | 'insufficient' | 'error' };

// Kunci in-flight (SINKRON, sebelum await pertama → aman balapan) + potong saldo
// atomik. WAJIB dipanggil paling awal di tiap run*. Kalau gagal, kunci dilepas.
// `maxConcurrent` = berapa job bersamaan yang diizinkan untuk user ini (default 1).
async function beginCharge(dbUserId: number, price: number, maxConcurrent = 1): Promise<ChargeResult> {
  if ((generating.get(dbUserId) ?? 0) >= maxConcurrent) return { ok: false, reason: 'busy' };
  generating.set(dbUserId, (generating.get(dbUserId) ?? 0) + 1); // sinkron sebelum await pertama
  try {
    const ok = await deductSaldo(dbUserId, price);
    if (!ok) { releaseGenerating(dbUserId); return { ok: false, reason: 'insufficient' }; }
    return { ok: true };
  } catch (e) {
    releaseGenerating(dbUserId);
    return { ok: false, reason: 'error' };
  }
}

function chargeFailMsg(reason: 'busy' | 'insufficient' | 'error', price: number): string {
  return reason === 'busy'
    ? '⏳ Masih ada proses generate yang berjalan. Tunggu yang ini selesai dulu ya.'
    : reason === 'insufficient'
      ? `❌ Saldo kamu tidak cukup (butuh ${formatRupiah(price)}).\n\nKetik /topup untuk isi saldo, atau /saldo untuk cek.`
      : '⚠️ Gagal memproses saldo. Coba lagi sebentar ya.';
}

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

async function findUserByTelegramId(tgId: number) {
  const res = await db.query('SELECT * FROM users WHERE telegram_id = $1 LIMIT 1', [tgId]);
  return res.rows[0] || null;
}

// Auto-register: user Telegram yang belum pernah ada → bikin akun baru saldo Rp0.
// Dipakai saat /start atau generate pertama. Aman terhadap balapan /start ganda.
async function getOrCreateTelegramUser(ctx: any, refTgId?: number) {
  const tgId = ctx.from.id;
  const existing = await findUserByTelegramId(tgId);
  if (existing) return existing;
  // Referral: hanya di-set SEKALI saat akun dibuat, tak bisa refer diri sendiri.
  let referredBy: number | null = null;
  if (refTgId && refTgId !== tgId) {
    const refUser = await findUserByTelegramId(refTgId).catch(() => null);
    if (refUser) referredBy = refUser.id;
  }
  const uname = 'tg_' + tgId;
  const email = 'tg_' + tgId + '@telegram.local';
  try {
    const res = await db.query(
      `INSERT INTO users (username, email, password_hash, is_admin, saldo, telegram_id, referred_by)
       VALUES ($1, $2, '', false, 0, $3, $4) RETURNING *`,
      [uname, email, tgId, referredBy]
    );
    return res.rows[0];
  } catch (e) {
    // Balapan: baris sudah dibuat pemanggil lain. Ambil saja.
    const again = await findUserByTelegramId(tgId);
    if (again) return again;
    throw e;
  }
}

function hydrateSession(userId: number, user: any): void {
  setSession(userId, {
    dbUserId: user.id,
    dbUsername: user.username,
    dbIsAdmin: user.is_admin === true,
  });
}

// Pastikan user teridentifikasi (auto-register kalau perlu). Sistem sekarang
// pay-per-generate: TAK ada cek langganan di sini — saldo dicek & dipotong
// per-model di dalam tiap fungsi generate (run*).
async function requireLogin(ctx: any, refTgId?: number): Promise<boolean> {
  const userId = ctx.from.id;
  const session = getSession(userId);
  if (session.dbUserId) return true;
  try {
    const user = await getOrCreateTelegramUser(ctx, refTgId);
    if (!user) { await ctx.reply('⚠️ Gagal memuat akun kamu. Coba /start lagi.'); return false; }
    hydrateSession(userId, user);
    return true;
  } catch (e: any) {
    console.error(`[${userId}] requireLogin error:`, e?.message ?? e);
    await ctx.reply('⚠️ Gagal memuat akun. Coba lagi nanti.');
    return false;
  }
}

// Cek admin: auto-hydrate akun dari telegram_id (login sudah dihapus),
// lalu cek flag is_admin LANGSUNG dari DB (bukan cache sesi — supaya user yang
// baru dijadikan admin langsung bisa pakai perintah admin tanpa restart bot).
async function requireAdmin(ctx: any): Promise<boolean> {
  if (!(await requireLogin(ctx))) return false;
  const session = getSession(ctx.from.id);
  const admin = session.dbUserId ? await isAdmin(session.dbUserId) : false;
  setSession(ctx.from.id, { dbIsAdmin: admin });
  if (!admin) {
    await ctx.reply('❌ Hanya admin yang bisa menggunakan perintah ini.');
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

// ─── Self-hosted media links ────────────────────────────────────────────────
// When a result is too big to push through Telegram (or sending fails), we serve
// it from our own server and hand the user a link on OUR domain. This both hides
// the upstream provider (the user only ever sees our Railway URL) and sidesteps
// Telegram's ~50MB upload cap, since a download has no such limit.

const MEDIA_DIR = path.join(os.tmpdir(), 'tg-media');
const MEDIA_TTL_MS = 24 * 60 * 60 * 1000; // links live 24h
type MediaEntry = { filePath: string; filename: string; contentType: string; expiresAt: number };
const mediaStore = new Map<string, MediaEntry>();

// Base URL of our own server. Railway injects RAILWAY_PUBLIC_DOMAIN automatically;
// PUBLIC_BASE_URL lets you override it (e.g. a custom domain).
function publicBaseUrl(): string {
  const explicit = process.env.PUBLIC_BASE_URL;
  if (explicit) return explicit.replace(/\/+$/, '');
  const rw = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (rw) return `https://${rw}`;
  return `http://localhost:${process.env.PORT || 3000}`;
}

// Persist a result buffer to disk and return a public download link on our domain.
async function publishMedia(buf: Buffer, isVideo: boolean, sourceUrl?: string): Promise<string> {
  await fsp.mkdir(MEDIA_DIR, { recursive: true });
  // Derive the real format from the bytes (with the URL as a hint) so the link's
  // extension and Content-Type match the actual file (mp4/mov/webm/avi, jpg/png/…).
  const { mime, ext } = isVideo ? detectVideoType(buf, sourceUrl) : detectMime(buf);
  const token = crypto.randomBytes(16).toString('hex');
  const filePath = path.join(MEDIA_DIR, `${token}.${ext}`);
  await fsp.writeFile(filePath, buf);
  mediaStore.set(token, {
    filePath,
    filename: `output.${ext}`,
    contentType: mime,
    expiresAt: Date.now() + MEDIA_TTL_MS,
  });
  return `${publicBaseUrl()}/dl/${token}`;
}

// Sweep expired media off disk hourly so we don't leak storage.
setInterval(async () => {
  const now = Date.now();
  for (const [token, e] of mediaStore) {
    if (e.expiresAt < now) {
      mediaStore.delete(token);
      try { await fsp.rm(e.filePath, { force: true }); } catch {}
    }
  }
}, 60 * 60 * 1000).unref();

// ─── Result sender ────────────────────────────────────────────────────────────

// Mengembalikan true HANYA jika hasil benar-benar sampai ke user (inline / link).
// Dipakai run* untuk memutuskan refund kalau pengiriman gagal.
async function sendResult(chatId: number, outputUrl: string, caption: string, isVideo: boolean, forceDocument = false): Promise<boolean> {
  const TELEGRAM_MAX_BYTES = 48 * 1024 * 1024; // 48MB safe limit

  // Auto-detect type from URL extension if not forced
  const lowerUrl = outputUrl.toLowerCase().split('?')[0];
  const looksLikeVideo = isVideo
    || lowerUrl.endsWith('.mp4') || lowerUrl.endsWith('.mov')
    || lowerUrl.endsWith('.webm') || lowerUrl.endsWith('.avi');

  // Plain text opts — no Markdown to avoid parse errors from URLs with special chars
  const opts = { caption };

  // Download the file server-side. The user must NEVER see the upstream CDN URL,
  // so everything is fetched by us and re-delivered from our own side.
  let buf: Buffer | null = null;
  try {
    const res = await telegramHttp.get(outputUrl, { responseType: 'arraybuffer', timeout: 300_000 });
    buf = Buffer.from(res.data);
    console.log(`Downloaded result: ${(buf.length / 1024 / 1024).toFixed(1)} MB, isVideo: ${looksLikeVideo}`);
  } catch (e: any) {
    console.log(`Download failed: ${e.message}`);
  }

  if (!buf) {
    await bot.telegram.sendMessage(chatId,
      `✅ Hasil selesai, tapi gagal mengambil file. Coba lagi sebentar ya.\n\n${caption}`
    );
    return false;
  }

  const sizeMB = (buf.length / 1024 / 1024).toFixed(1);

  // Small enough for Telegram → send inline so it plays right in the chat. We
  // upload our own bytes (never a URL), so the upstream provider stays hidden.
  if (buf.length <= TELEGRAM_MAX_BYTES) {
    // For images we deliver as a document by default so the full-resolution PNG
    // is preserved (sendPhoto re-compresses and downscales).
    const sendAsDocument = forceDocument && !looksLikeVideo;
    if (!sendAsDocument) {
      try {
        if (looksLikeVideo) {
          await bot.telegram.sendVideo(chatId, { source: buf, filename: 'output.mp4' }, opts);
        } else {
          await bot.telegram.sendPhoto(chatId, { source: buf, filename: 'output.jpg' }, opts);
        }
        console.log(`Result sent via buffer (${sizeMB} MB)`);
        return true;
      } catch (e: any) {
        console.log(`Buffer strategy failed: ${e.message}`);
      }
    }

    try {
      await bot.telegram.sendDocument(chatId,
        { source: buf, filename: looksLikeVideo ? 'output.mp4' : 'output.png' },
        opts
      );
      console.log(`Result sent as document (${sizeMB} MB)`);
      return true;
    } catch (e: any) {
      console.log(`Document strategy failed: ${e.message}`);
    }
  }

  // Too big for Telegram (or the upload failed) → host it on our own server and
  // hand the user a download link on our domain. No size cap on a download, and
  // the link points at us, so the upstream provider is never exposed.
  try {
    const link = await publishMedia(buf, looksLikeVideo, outputUrl);
    await bot.telegram.sendMessage(chatId,
      `✅ Hasil selesai!\n\n📥 Download (${sizeMB} MB — segera simpan, link berlaku sementara):\n${link}\n\n${caption}`
    );
    console.log(`Result delivered via self-hosted link (${sizeMB} MB)`);
    return true;
  } catch (e: any) {
    console.log(`Self-hosted link failed: ${e.message}`);
    await bot.telegram.sendMessage(chatId,
      `✅ Hasil selesai, tapi gagal mengirim file. Coba lagi sebentar ya.\n\n${caption}`
    );
    return false;
  }
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
    // ── Akun & Saldo ──
    [
      Markup.button.callback('💳 Isi Saldo', 'menu_topup'),
      Markup.button.callback('💰 Cek Saldo', 'menu_saldo'),
    ],
    [
      Markup.button.callback('📋 Lihat Tarif', 'menu_harga'),
      Markup.button.callback('🧾 Riwayat Top-up', 'menu_riwayat'),
    ],
    [Markup.button.callback('🔍 Cek Status Pembayaran', 'menu_cekbayar')],
    // ── Generate Video ──
    [Markup.button.callback('── 🎬 Generate Video ──', 'noop')],
    [Markup.button.callback('🕹️ Kling Motion Control', 'mode_kling')],
    [Markup.button.callback('🚀 Runway Gen-4.5', 'mode_rw')],
    [Markup.button.callback('🎥 Sora 2 (OpenAI)', 'mode_sora')],
    [Markup.button.callback('⚡ Veo 3.1 Fast (Full HD)', 'mode_veofast')],
    [Markup.button.callback('🎞️ Veo 3.1 Lite (Full HD)', 'mode_veolite')],
    [Markup.button.callback('✨ Gemini Omni (Google)', 'mode_gomni')],
    // ── Generate Gambar ──
    [Markup.button.callback('── 🎨 Generate Gambar ──', 'noop')],
    [Markup.button.callback('🍌 Nano Banana Pro', 'mode_nbpro')],
    [Markup.button.callback('🍌 Nano Banana 2', 'mode_nb2')],
    [Markup.button.callback('🍌 Nano Banana 2 Lite', 'mode_nb2lite')],
  ]);
}

const SD_RATIO_MAP: Record<string, string> = {
  '916': '9:16', '169': '16:9', '11': '1:1',
  '34': '3:4', '43': '4:3', '23': '2:3', '32': '3:2', '219': '21:9',
};

// ─── Runway Gen-4.5 wizard keyboards (image-to-video) ─────────────────────────

function rwDurationKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('5 detik', 'rw_dur_5'),
      Markup.button.callback('10 detik', 'rw_dur_10'),
    ],
    [Markup.button.callback('« Kembali', 'back_main')],
  ]);
}

function rwRatioKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📱 9:16', 'rw_ratio_916'),
      Markup.button.callback('🖥️ 16:9', 'rw_ratio_169'),
      Markup.button.callback('⬛ 1:1', 'rw_ratio_11'),
    ],
    [Markup.button.callback('« Kembali', 'mode_rw')],
  ]);
}

// Runway pakai rasio format piksel (dari HAR: 9:16 = "720:1280").
const RW_RATIO_MAP: Record<string, { api: string; label: string }> = {
  '916': { api: '720:1280', label: '9:16' },
  '169': { api: '1280:720', label: '16:9' },
  '11': { api: '960:960', label: '1:1' },
};

// ─── Sora 2 wizard keyboards (text-to-video or image-to-video) ────────────────

function soraInputKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🖼️ Foto + Prompt', 'so_in_i2v')],
    [Markup.button.callback('✍️ Prompt Saja', 'so_in_t2v')],
    [Markup.button.callback('« Kembali', 'back_main')],
  ]);
}

function soraDurationKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('4 detik', 'so_dur_4'),
      Markup.button.callback('8 detik', 'so_dur_8'),
      Markup.button.callback('12 detik', 'so_dur_12'),
    ],
    [Markup.button.callback('« Kembali', 'mode_sora')],
  ]);
}

function soraRatioKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📱 9:16', 'so_ratio_916'),
      Markup.button.callback('🖥️ 16:9', 'so_ratio_169'),
    ],
  ]);
}

// Sora "size" strings (base sora-2 = 720p). Keyed by ratio code.
const SORA_SIZE_MAP: Record<string, string> = { '916': '720x1280', '169': '1280x720' };

// ─── Veo 3.1 Fast/Lite wizard keyboards (SnapGen, text-to-video or image-to-video)
// Durasi 8s, resolusi 1080p (Full HD) tetap. User pilih rasio (16:9 / 9:16) lalu
// input mode: prompt saja (t2v) atau foto + prompt (i2v).

function veofastRatioKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📺 16:9 (Landscape)', 'vf_ratio_169')],
    [Markup.button.callback('📱 9:16 (Portrait)', 'vf_ratio_916')],
    [Markup.button.callback('« Kembali', 'back_main')],
  ]);
}

function veoliteRatioKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📺 16:9 (Landscape)', 'vl_ratio_169')],
    [Markup.button.callback('📱 9:16 (Portrait)', 'vl_ratio_916')],
    [Markup.button.callback('« Kembali', 'back_main')],
  ]);
}

function veofastInputKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🖼️ Foto + Prompt', 'vf_in_i2v')],
    [Markup.button.callback('✍️ Prompt Saja', 'vf_in_t2v')],
    [Markup.button.callback('« Kembali', 'back_main')],
  ]);
}

function veoliteInputKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🖼️ Foto + Prompt', 'vl_in_i2v')],
    [Markup.button.callback('✍️ Prompt Saja', 'vl_in_t2v')],
    [Markup.button.callback('« Kembali', 'back_main')],
  ]);
}

// ─── Gemini Omni wizard keyboards (text-to-video or image-to-video) ───────────

function gomniInputKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🖼️ Foto + Prompt', 'go_in_i2v')],
    [Markup.button.callback('🎬 Foto + Video + Prompt', 'go_in_v2v')],
    [Markup.button.callback('✍️ Prompt Saja', 'go_in_t2v')],
    [Markup.button.callback('« Kembali', 'back_main')],
  ]);
}

function gomniDurationKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('8 detik', 'go_dur_8'),
      Markup.button.callback('10 detik', 'go_dur_10'),
    ],
    [Markup.button.callback('« Kembali', 'mode_gomni')],
  ]);
}

function gomniRatioKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('📱 9:16', 'go_ratio_916'),
      Markup.button.callback('🖥️ 16:9', 'go_ratio_169'),
    ],
  ]);
}

// ─── Nano Banana image wizard keyboards (SnapGen, text-to-image / image-to-image)
// Shared wizard untuk 3 model. Model tersimpan di session. User pilih rasio lalu
// input mode: prompt saja (t2i) atau foto + prompt (i2i).

function imgRatioKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('⬛ 1:1', 'img_ratio_11'),
      Markup.button.callback('🖥️ 16:9', 'img_ratio_169'),
      Markup.button.callback('📱 9:16', 'img_ratio_916'),
    ],
    [
      Markup.button.callback('🖼️ 4:3', 'img_ratio_43'),
      Markup.button.callback('🖼️ 3:4', 'img_ratio_34'),
    ],
    [Markup.button.callback('« Kembali', 'back_main')],
  ]);
}

function imgInputKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('🖼️ Foto + Prompt', 'img_in_i2i')],
    [Markup.button.callback('✍️ Prompt Saja', 'img_in_t2i')],
    [Markup.button.callback('« Kembali', 'back_main')],
  ]);
}

// Peta callback model → { model API, price key, label + emoji }
const IMG_MODELS: Record<string, {
  model: 'nano-banana-pro' | 'nano-banana-2' | 'nano-banana-2-lite';
  priceKey: 'nb_pro' | 'nb_2' | 'nb_2lite';
  label: string;
}> = {
  mode_nbpro: { model: 'nano-banana-pro', priceKey: 'nb_pro', label: '🍌 Nano Banana Pro' },
  mode_nb2: { model: 'nano-banana-2', priceKey: 'nb_2', label: '🍌 Nano Banana 2' },
  mode_nb2lite: { model: 'nano-banana-2-lite', priceKey: 'nb_2lite', label: '🍌 Nano Banana 2 Lite' },
};

const IMG_RATIO_MAP: Record<string, string> = {
  '11': '1:1', '169': '16:9', '916': '9:16', '43': '4:3', '34': '3:4',
};

// ─── Top-up helpers ───────────────────────────────────────────────────────────

const TOPUP_MIN = 5000;
const TOPUP_MAX = 2_000_000;

function hargaText(): string {
  return (
    '💵 *Tarif per generate:*\n\n' +
    '🎬 *Video*\n' +
    `• Sora 2 — ${formatRupiah(MODEL_PRICES.sora)}\n` +
    `• Veo 3.1 Fast (Full HD) — ${formatRupiah(MODEL_PRICES.veo_fast)}\n` +
    `• Veo 3.1 Lite (Full HD) — ${formatRupiah(MODEL_PRICES.veo_lite)}\n` +
    `• Gemini Omni — ${formatRupiah(MODEL_PRICES.gemini_omni)}\n` +
    `• Runway Gen-4.5 — ${formatRupiah(MODEL_PRICES.runway)}\n` +
    `• Kling MC3.0 PRO — ${formatRupiah(MODEL_PRICES.kling_mc)}\n\n` +
    '🎨 *Gambar*\n' +
    `• Nano Banana Pro — ${formatRupiah(MODEL_PRICES.nb_pro)}\n` +
    `• Nano Banana 2 — ${formatRupiah(MODEL_PRICES.nb_2)}\n` +
    `• Nano Banana 2 Lite — ${formatRupiah(MODEL_PRICES.nb_2lite)}\n\n` +
    'Saldo hanya dipotong kalau hasilnya *berhasil terkirim*. Gagal = saldo balik.\n\n' +
    'Ketik /topup untuk isi saldo · /saldo untuk cek.'
  );
}

function topupNominalKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('Rp20.000', 'topup_20000'),
      Markup.button.callback('Rp50.000', 'topup_50000'),
    ],
    [
      Markup.button.callback('Rp100.000', 'topup_100000'),
      Markup.button.callback('Rp200.000', 'topup_200000'),
    ],
    [Markup.button.callback('✏️ Nominal lain', 'topup_custom')],
  ]);
}

// Buat order QRIS, simpan ke DB, lalu kirim gambar QRIS ke user. Dipakai baik
// dari tombol nominal maupun dari input nominal custom.
async function startTopupFlow(
  ctx: any,
  dbUserId: number,
  telegramId: number,
  amount: number
): Promise<void> {
  if (!Number.isFinite(amount) || amount < TOPUP_MIN || amount > TOPUP_MAX) {
    await ctx.reply(`⚠️ Nominal harus antara ${formatRupiah(TOPUP_MIN)} dan ${formatRupiah(TOPUP_MAX)}.`);
    return;
  }

  const orderId = `XCLIP-${telegramId}-${Date.now()}`;
  let order: klikqris.QrisOrder;
  try {
    order = await klikqris.createQris(orderId, amount, `Top-up saldo XclipAI ${formatRupiah(amount)}`);
  } catch (e: any) {
    console.error(`[${telegramId}] KlikQRIS create error:`, e?.response?.data ?? e?.message ?? e);
    await ctx.reply('❌ Gagal membuat QRIS. Coba lagi sebentar lagi.');
    return;
  }

  const expiresAt = order.expiredAt ? new Date(order.expiredAt.replace(' ', 'T')) : null;
  const validExpires = expiresAt && !isNaN(expiresAt.getTime()) ? expiresAt : null;
  try {
    await createTopupOrder(orderId, dbUserId, telegramId, order.amount, order.totalAmount, order.qrisUrl ?? order.directUrl, validExpires);
  } catch (e: any) {
    console.error(`[${telegramId}] Simpan topup order gagal:`, e?.message ?? e);
    await ctx.reply('❌ Gagal menyimpan order. Coba lagi.');
    return;
  }

  const menit = order.expiredMinutes ?? 5;
  const caption =
    `💳 *Top-up ${formatRupiah(order.amount)}*\n\n` +
    `Bayar tepat *${formatRupiah(order.totalAmount)}* (sudah termasuk kode unik).\n` +
    `Scan QRIS di atas pakai aplikasi bank / e-wallet apa pun.\n\n` +
    `⏳ Berlaku *${menit} menit*.\n` +
    `Saldo otomatis masuk setelah dibayar. Cek manual: /cekbayar`;

  try {
    if (order.qrisImageBase64) {
      const buf = Buffer.from(order.qrisImageBase64, 'base64');
      await ctx.replyWithPhoto({ source: buf }, { caption, parse_mode: 'Markdown' });
    } else if (order.qrisUrl) {
      await ctx.replyWithPhoto(order.qrisUrl, { caption, parse_mode: 'Markdown' });
    } else {
      await ctx.reply(caption + (order.directUrl ? `\n\nLink bayar: ${order.directUrl}` : ''), { parse_mode: 'Markdown' });
    }
  } catch (e: any) {
    console.error(`[${telegramId}] Kirim QRIS gagal:`, e?.message ?? e);
    await ctx.reply(caption + (order.directUrl ? `\n\nLink bayar: ${order.directUrl}` : ''), { parse_mode: 'Markdown' }).catch(() => {});
  }
}

// Cek status 1 order ke KlikQRIS. Kalau PAID → kredit saldo (atomik, anti dobel)
// dan (opsional) kabari user. Kalau expired → tandai. Dipakai poller & /cekbayar.
async function reconcileTopupOrder(
  orderId: string,
  opts: { notify?: boolean } = {}
): Promise<'paid' | 'expired' | 'pending'> {
  let status: klikqris.QrisStatus;
  try {
    status = await klikqris.checkQrisStatus(orderId);
  } catch (e: any) {
    console.warn(`[topup] cek status gagal ${orderId}:`, e?.response?.status ?? e?.message ?? e);
    return 'pending';
  }

  if (klikqris.isPaidStatus(status.status)) {
    const credited = await markTopupPaidAndCredit(orderId);
    if (credited && opts.notify) {
      await bot.telegram.sendMessage(
        credited.telegramId,
        `✅ Pembayaran diterima!\n\n💰 Saldo +${formatRupiah(credited.amount)}\nSaldo sekarang: *${formatRupiah(credited.newSaldo)}*\n\nKetik /menu untuk mulai generate.`,
        { parse_mode: 'Markdown' }
      ).catch(() => {});
    }
    // Kabari pengundang kalau ada bonus referral cair.
    if (credited?.referral?.referrerTelegramId) {
      await bot.telegram.sendMessage(
        credited.referral.referrerTelegramId,
        `🎁 Bonus referral +${formatRupiah(credited.referral.bonus)} masuk ke saldo kamu!\n\nTeman undanganmu baru saja top-up. Cek /referral untuk statistik.`
      ).catch(() => {});
    }
    return 'paid';
  }

  if (klikqris.isExpiredStatus(status.status)) {
    await markTopupExpired(orderId).catch(() => {});
    return 'expired';
  }

  return 'pending';
}

// Poller: setiap ±15 detik cek semua order PENDING. Kredit yang sudah dibayar,
// tandai expired yang sudah lewat waktu (+grace) walau gateway masih PENDING.
let topupPollerRunning = false;
async function pollPendingTopups(): Promise<void> {
  if (topupPollerRunning) return;
  topupPollerRunning = true;
  try {
    const orders = await getPendingTopupOrders();
    for (const o of orders) {
      const result = await reconcileTopupOrder(o.order_id, { notify: true }).catch(() => 'pending' as const);
      if (result === 'pending') {
        // Berhenti polling kalau sudah jauh lewat masa berlaku QRIS. QRIS yang
        // sudah kedaluwarsa di gateway tak bisa dibayar lagi, jadi aman ditandai
        // EXPIRED. Grace 10 menit menutupi keterlambatan settlement gateway.
        // Fallback created_at+30m untuk kasus response tanpa expired_at (biar tak
        // PENDING selamanya). Kalau ternyata telat dibayar, /cekbayar tetap bisa
        // memulihkan karena markTopupPaidAndCredit menerima status <> 'PAID'.
        const graceMs = 10 * 60 * 1000;
        const base = o.expires_at
          ? new Date(o.expires_at).getTime()
          : new Date(o.created_at).getTime() + 30 * 60 * 1000;
        if (Number.isFinite(base) && Date.now() > base + graceMs) {
          await markTopupExpired(o.order_id).catch(() => {});
        }
      }
    }
  } catch (e: any) {
    console.error('[topup poller] error:', e?.message ?? e);
  } finally {
    topupPollerRunning = false;
  }
}


// ─── Commands ─────────────────────────────────────────────────────────────────

bot.start(async (ctx) => {
  setSession(ctx.from.id, { mode: 'idle' });
  // Deteksi link referral: t.me/<bot>?start=ref_<telegramId>
  const refMatch = ((ctx.message as any)?.text ?? '').match(/^\/start\s+ref_(\d+)/i);
  const refTgId = refMatch ? Number(refMatch[1]) : undefined;
  if (!await requireLogin(ctx, refTgId)) return;
  const dbUserId = getSession(ctx.from.id).dbUserId!;
  const saldo = await getSaldo(dbUserId).catch(() => 0);
  return ctx.reply(
    `👋 Selamat datang di *XclipAI Bot*!\n\n` +
    `💰 Saldo kamu: *${formatRupiah(saldo)}*\n\n` +
    (saldo <= 0
      ? `Saldomu masih kosong. Ketik /topup untuk isi saldo.\n\n`
      : ``) +
    `Ketik /harga untuk lihat tarif tiap model.\n\nPilih mode generasi:`,
    { parse_mode: 'Markdown', ...mainMenuKeyboard() }
  );
});

bot.command('menu', async (ctx) => {
  if (!await requireLogin(ctx)) return;
  setSession(ctx.from.id, { mode: 'idle' });
  return ctx.reply('Pilih mode generasi:', mainMenuKeyboard());
});

bot.command('status', async (ctx) => {
  if (!await requireLogin(ctx)) return;
  const session = getSession(ctx.from.id);
  const [saldo, klingUsed] = await Promise.all([
    getSaldo(session.dbUserId!),
    getKlingUsageToday(session.dbUserId!),
  ]);
  return ctx.reply(
    `👤 *Akun:* ${session.dbUsername}\n` +
    `💰 *Saldo:* ${formatRupiah(saldo)}\n` +
    `🕹️ *Generate hari ini:* ${klingUsed}\n\n` +
    `Ketik /topup untuk isi saldo · /harga untuk tarif.`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('saldo', async (ctx) => {
  if (!await requireLogin(ctx)) return;
  const session = getSession(ctx.from.id);
  const saldo = await getSaldo(session.dbUserId!);
  return ctx.reply(
    `💰 *Saldo kamu:* ${formatRupiah(saldo)}\n\n` +
    (saldo <= 0 ? `Saldo kosong. Ketik /topup untuk isi.\n` : `Ketik /topup untuk isi saldo.\n`) +
    `Ketik /harga untuk lihat tarif tiap model.`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('harga', async (ctx) => {
  if (!await requireLogin(ctx)) return;
  return ctx.reply(hargaText(), { parse_mode: 'Markdown' });
});

bot.command('referral', async (ctx) => {
  if (!await requireLogin(ctx)) return;
  const session = getSession(ctx.from.id);
  const botUsername = ctx.botInfo?.username ?? 'bot';
  const link = `https://t.me/${botUsername}?start=ref_${ctx.from.id}`;
  const [cnt, sum] = await Promise.all([
    db.query(`SELECT COUNT(*) AS n FROM users WHERE referred_by = $1`, [session.dbUserId]),
    db.query(`SELECT COALESCE(SUM(amount), 0) AS total FROM referral_bonuses WHERE referrer_id = $1`, [session.dbUserId]),
  ]);
  // Tanpa parse_mode: link mengandung underscore yang bisa merusak Markdown.
  return ctx.reply(
    `🎁 Program Referral\n\n` +
    `Ajak teman pakai link di bawah. Setiap mereka top-up, kamu dapat bonus 5% dari nominalnya — langsung masuk saldo, berlaku selamanya.\n\n` +
    `🔗 Link kamu:\n${link}\n\n` +
    `👥 Teman diundang: ${cnt.rows[0]?.n ?? 0}\n` +
    `💰 Total bonus diterima: ${formatRupiah(Number(sum.rows[0]?.total ?? 0))}`
  );
});

bot.command('riwayat', async (ctx) => {
  if (!await requireLogin(ctx)) return;
  const session = getSession(ctx.from.id);
  const rows = await getRecentTopups(session.dbUserId!, 10);
  if (rows.length === 0) {
    return ctx.reply('📭 Belum ada riwayat top-up.\n\nKetik /topup untuk isi saldo.');
  }
  const lines = rows.map((r) => {
    const icon = r.status === 'PAID' ? '✅' : r.status === 'PENDING' ? '⏳' : '❌';
    const when = new Date(r.created_at).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    return `${icon} ${formatRupiah(Number(r.amount))} · ${r.status} · ${when}`;
  });
  return ctx.reply(`🧾 *Riwayat top-up terakhir:*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
});

bot.command('topup', async (ctx) => {
  if (!await requireLogin(ctx)) return;
  if (!klikqris.klikqrisConfigured()) {
    return ctx.reply('⚠️ Top-up sedang tidak tersedia. Hubungi admin.');
  }
  setSession(ctx.from.id, { mode: 'idle' });
  return ctx.reply(
    '💳 *Isi Saldo (QRIS)*\n\nPilih nominal top-up:',
    { parse_mode: 'Markdown', ...topupNominalKeyboard() }
  );
});

bot.command('cekbayar', async (ctx) => {
  if (!await requireLogin(ctx)) return;
  const session = getSession(ctx.from.id);
  // Ambil order terbaru yang BELUM PAID (termasuk yang sudah EXPIRED lokal) dalam
  // 1 jam terakhir — supaya pembayaran yang telat masuk masih bisa dipulihkan.
  const pending = await db.query(
    `SELECT order_id FROM topup_orders
     WHERE db_user_id = $1 AND status <> 'PAID' AND created_at > NOW() - INTERVAL '1 hour'
     ORDER BY created_at DESC LIMIT 1`,
    [session.dbUserId!]
  );
  if (pending.rowCount === 0) {
    return ctx.reply('ℹ️ Tidak ada top-up yang menunggu pembayaran.\n\nKetik /topup untuk isi saldo.');
  }
  const orderId = pending.rows[0].order_id as string;
  await ctx.reply('🔄 Mengecek status pembayaran...');
  await reconcileTopupOrder(orderId).catch((e) => console.error('cekbayar reconcile error:', e?.message ?? e));
  const saldo = await getSaldo(session.dbUserId!);
  const still = await db.query(`SELECT status FROM topup_orders WHERE order_id = $1`, [orderId]);
  const st = still.rows[0]?.status;
  if (st === 'PAID') {
    return ctx.reply(`✅ Pembayaran diterima!\n\n💰 Saldo kamu sekarang: *${formatRupiah(saldo)}*`, { parse_mode: 'Markdown' });
  }
  if (st === 'EXPIRED') {
    return ctx.reply('❌ QRIS sudah kadaluarsa. Ketik /topup untuk buat baru.');
  }
  return ctx.reply('⏳ Belum terbayar. Selesaikan pembayaran QRIS-nya, lalu cek lagi dengan /cekbayar.');
});

// ─── Admin commands ───────────────────────────────────────────────────────────

bot.command('broadcast', async (ctx) => {
  if (!(await requireAdmin(ctx))) return;
  const session = getSession(ctx.from.id);

  const text = ctx.message.text.replace(/^\/broadcast\s*/i, '').trim();
  if (!text) {
    return ctx.reply('📢 Format:\n/broadcast <pesan>\n\nPesan dikirim ke semua user yang punya Telegram ID terdaftar.');
  }

  const res = await db.query(`SELECT DISTINCT telegram_id FROM users WHERE telegram_id IS NOT NULL`);
  const ids = res.rows.map((r: any) => Number(r.telegram_id)).filter((n: number) => Number.isFinite(n));
  await ctx.reply(`📤 Mengirim ke ${ids.length} user...`);

  let sent = 0;
  let failed = 0;
  // Kirim tanpa parse_mode — teks admin bebas, kalau di-Markdown bisa error format.
  for (const id of ids) {
    try {
      await bot.telegram.sendMessage(id, `📢 Pengumuman\n\n${text}`);
      sent++;
    } catch {
      failed++;
    }
    await new Promise((r) => setTimeout(r, 40)); // ~25 pesan/detik, hormati rate limit
  }

  return ctx.reply(`✅ Broadcast selesai.\n• Terkirim: ${sent}\n• Gagal: ${failed}`);
});

bot.command('addkey', async (ctx) => {
  if (!(await requireAdmin(ctx))) return;
  const session = getSession(ctx.from.id);

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
  if (!(await requireAdmin(ctx))) return;
  const session = getSession(ctx.from.id);

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
  if (!(await requireAdmin(ctx))) return;
  const session = getSession(ctx.from.id);

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
  if (!(await requireAdmin(ctx))) return;
  const session = getSession(ctx.from.id);

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
  if (!(await requireAdmin(ctx))) return;
  const session = getSession(ctx.from.id);

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
  if (!(await requireAdmin(ctx))) return;
  const session = getSession(ctx.from.id);

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
  if (!(await requireAdmin(ctx))) return;
  const session = getSession(ctx.from.id);

  const res = await db.query(`DELETE FROM renderful_key_pool RETURNING api_key`);
  if (res.rows.length === 0) return ctx.reply('ℹ️ Pool sudah kosong.');
  return ctx.reply(
    `🗑️ Pool dikosongkan — *${res.rows.length} key* dihapus.`,
    { parse_mode: 'Markdown' }
  );
});

// ─── Admin commands: aivideoapi key pool ─────────────────────────────────────

bot.command('addfreepikkey', async (ctx) => {
  if (!(await requireAdmin(ctx))) return;
  const session = getSession(ctx.from.id);

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
  if (!(await requireAdmin(ctx))) return;
  const session = getSession(ctx.from.id);

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
  if (!(await requireAdmin(ctx))) return;
  const session = getSession(ctx.from.id);

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
  if (!(await requireAdmin(ctx))) return;
  const session = getSession(ctx.from.id);

  const raw = ctx.message.text.replace(/^\/addpicsartkey\s*/i, '').trim();
  if (!raw) {
    return ctx.reply(
      '📝 Format:\n' +
      '/addpicsartkey rt:xxxxx\n\n' +
      'Ambil dari picsart.com (sudah login):\n' +
      'F12 → Application → Cookies → nilai cookie REFRESH_TOKEN (diawali "rt:")'
    );
  }
  // Optional label after the token: /addpicsartkey rt:xxx Akun Utama
  const parts = raw.split(/\s+/);
  const token = parts[0];
  const label = parts.slice(1).join(' ') || undefined;
  const credId = await picsart.addRefreshToken(token, label);
  if (credId == null) return ctx.reply('❌ Token tidak valid. Harus diawali "rt:".');
  try {
    const c = await picsart.getCredits(credId);
    return ctx.reply(
      `✅ Akun Picsart baru ditambahkan ke pool!${label ? `\n🏷️ Label: ${label}` : ''}\n💳 Sisa kredit: ${c.credits}` +
      (c.renewDate ? `\n🔄 Reset: ${new Date(c.renewDate).toLocaleDateString('id-ID')}` : '') +
      `\n\n🗂️ Lihat semua akun: /picsartpool`
    );
  } catch (e: any) {
    return ctx.reply(`⚠️ Akun tersimpan, tapi verifikasi gagal:\n${String(e.message).slice(0, 280)}`);
  }
});

bot.command('picsartstatus', async (ctx) => {
  if (!(await requireAdmin(ctx))) return;
  const session = getSession(ctx.from.id);
  const st = await picsart.getStatus();
  const counts = Object.entries(st.counts).map(([k, v]) => `• ${k}: ${v}`).join('\n') || '• (kosong)';
  return ctx.reply(
    `📊 *Status Picsart*\n\nAkun siap pakai: ${st.available}\nUser terdaftar: ${st.totalUsers}\n\n${counts}`,
    { parse_mode: 'Markdown' }
  );
});

bot.command('picsartcredits', async (ctx) => {
  if (!(await requireAdmin(ctx))) return;
  const session = getSession(ctx.from.id);
  try {
    const pool = await picsart.getPool();
    if (pool.length === 0) return ctx.reply('❌ Belum ada akun. Tambah dengan /addpicsartkey rt:...');
    const lines = await Promise.all(pool.map(async (acc) => {
      const name = mdEscape(acc.label ? acc.label : `#${acc.id}`);
      if (acc.status !== 'available' && acc.status !== 'exhausted') {
        return `• ${name}: ${acc.status}`;
      }
      try {
        const c = await picsart.getCredits(acc.id);
        return `• ${name}: 💳 ${c.credits} (${acc.status})`;
      } catch {
        return `• ${name}: ⚠️ gagal cek (${acc.status})`;
      }
    }));
    return replyLong(ctx, `💳 *Kredit per akun*\n`, lines);
  } catch (e: any) {
    return ctx.reply(`❌ Gagal cek kredit: ${String(e.message).slice(0, 150)}`);
  }
});

bot.command('picsartpool', async (ctx) => {
  if (!(await requireAdmin(ctx))) return;
  const session = getSession(ctx.from.id);
  try {
    const pool = await picsart.getPool();
    if (pool.length === 0) return ctx.reply('📭 Pool akun kosong. Tambah dengan /addpicsartkey rt:...');
    const icon: Record<string, string> = { available: '✅', exhausted: '🪫', dead: '💀', replaced: '🔁' };
    const lines = pool.map((acc) => {
      const name = mdEscape(acc.label ? acc.label : `#${acc.id}`);
      const badge = icon[acc.status] ?? '•';
      return `${badge} ${name} — ${acc.status} · 👤 ${acc.users} user`;
    });
    const totalUsers = pool.reduce((s, a) => s + a.users, 0);
    return replyLong(ctx, `🗂️ *Pool Akun Picsart* (${pool.length} akun · ${totalUsers} user)\n`, lines);
  } catch (e: any) {
    return ctx.reply(`❌ Gagal ambil pool: ${String(e.message).slice(0, 150)}`);
  }
});

bot.command('restorefreepikkey', async (ctx) => {
  if (!(await requireAdmin(ctx))) return;
  const session = getSession(ctx.from.id);

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
  if (!(await requireAdmin(ctx))) return;
  const session = getSession(ctx.from.id);

  const res = await db.query(`DELETE FROM freepik_key_pool RETURNING api_key`);
  if (res.rows.length === 0) return ctx.reply('ℹ️ Pool Freepik sudah kosong.');
  return ctx.reply(`🗑️ Pool Freepik dikosongkan — *${res.rows.length} key* dihapus.`, { parse_mode: 'Markdown' });
});

bot.command('addi2vkey', async (ctx) => {
  if (!(await requireAdmin(ctx))) return;
  const session = getSession(ctx.from.id);

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
  if (!(await requireAdmin(ctx))) return;
  const session = getSession(ctx.from.id);

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
  if (!(await requireAdmin(ctx))) return;
  const session = getSession(ctx.from.id);

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
  if (!(await requireAdmin(ctx))) return;
  const session = getSession(ctx.from.id);

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
  if (!(await requireAdmin(ctx))) return;
  const session = getSession(ctx.from.id);

  const res = await db.query(`DELETE FROM aivideoapi_key_pool RETURNING api_key`);
  if (res.rows.length === 0) return ctx.reply('ℹ️ Pool i2v sudah kosong.');
  return ctx.reply(`🗑️ Pool i2v dikosongkan — *${res.rows.length} key* dihapus.`, { parse_mode: 'Markdown' });
});

// ─── Admin: Leonardo AI Key Pool ─────────────────────────────────────────────

bot.command('addleonardokey', async (ctx) => {
  if (!(await requireAdmin(ctx))) return;
  const session = getSession(ctx.from.id);

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
  if (!(await requireAdmin(ctx))) return;
  const session = getSession(ctx.from.id);

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
  if (!(await requireAdmin(ctx))) return;
  const session = getSession(ctx.from.id);

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
  if (!(await requireAdmin(ctx))) return;
  const session = getSession(ctx.from.id);

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
  if (!(await requireAdmin(ctx))) return;
  const session = getSession(ctx.from.id);

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
    '/referral — Ajak teman, dapat bonus 5% tiap mereka top-up\n' +
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
  // answerCbQuery can time out on a flaky network (ETIMEDOUT). It's only a UI
  // loading-spinner ack, so a failure here must never abort the handler.
  await ctx.answerCbQuery().catch(() => {});

  if (data !== 'back_main') {
    if (!await requireLogin(ctx)) return;
  }

  if (data === 'menu_topup') {
    if (!klikqris.klikqrisConfigured()) {
      return ctx.reply('⚠️ Top-up sedang tidak tersedia. Hubungi admin.');
    }
    setSession(userId, { mode: 'idle' });
    return ctx.reply(
      '💳 *Isi Saldo (QRIS)*\n\nPilih nominal top-up:',
      { parse_mode: 'Markdown', ...topupNominalKeyboard() }
    );
  }

  if (data === 'menu_saldo') {
    const s = getSession(userId);
    const saldo = await getSaldo(s.dbUserId!);
    return ctx.reply(
      `💰 *Saldo kamu:* ${formatRupiah(saldo)}\n\n` +
      (saldo <= 0 ? 'Saldo kosong. Tekan 💳 Isi Saldo untuk top-up.\n' : 'Tekan 💳 Isi Saldo untuk top-up.\n') +
      'Tekan 📋 Lihat Tarif untuk cek harga tiap model.',
      { parse_mode: 'Markdown' }
    );
  }

  if (data === 'menu_harga') {
    return ctx.reply(hargaText(), { parse_mode: 'Markdown' });
  }

  if (data === 'menu_riwayat') {
    const s = getSession(userId);
    const rows = await getRecentTopups(s.dbUserId!, 10);
    if (rows.length === 0) {
      return ctx.reply('📭 Belum ada riwayat top-up.\n\nTekan 💳 Isi Saldo untuk top-up.');
    }
    const lines = rows.map((r) => {
      const icon = r.status === 'PAID' ? '✅' : r.status === 'PENDING' ? '⏳' : '❌';
      const when = new Date(r.created_at).toLocaleString('id-ID', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
      return `${icon} ${formatRupiah(Number(r.amount))} · ${r.status} · ${when}`;
    });
    return ctx.reply(`🧾 *Riwayat top-up terakhir:*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
  }

  if (data === 'menu_cekbayar') {
    const s = getSession(userId);
    const pending = await db.query(
      `SELECT order_id FROM topup_orders
       WHERE db_user_id = $1 AND status <> 'PAID' AND created_at > NOW() - INTERVAL '1 hour'
       ORDER BY created_at DESC LIMIT 1`,
      [s.dbUserId!]
    );
    if (pending.rowCount === 0) {
      return ctx.reply('ℹ️ Tidak ada top-up yang menunggu pembayaran.\n\nTekan 💳 Isi Saldo untuk top-up.');
    }
    const orderId = pending.rows[0].order_id as string;
    await ctx.reply('🔄 Mengecek status pembayaran...');
    await reconcileTopupOrder(orderId).catch((e) => console.error('menu_cekbayar reconcile error:', e?.message ?? e));
    const saldo = await getSaldo(s.dbUserId!);
    const still = await db.query(`SELECT status FROM topup_orders WHERE order_id = $1`, [orderId]);
    const st = still.rows[0]?.status;
    if (st === 'PAID') {
      return ctx.reply(`✅ Pembayaran diterima!\n\n💰 Saldo kamu sekarang: *${formatRupiah(saldo)}*`, { parse_mode: 'Markdown' });
    }
    if (st === 'EXPIRED') {
      return ctx.reply('❌ QRIS sudah kadaluarsa. Tekan 💳 Isi Saldo untuk buat baru.');
    }
    return ctx.reply('⏳ Belum terbayar. Selesaikan pembayaran QRIS-nya, lalu tekan 🔍 Cek Status Pembayaran lagi.');
  }

  if (data === 'noop') {
    return ctx.answerCbQuery();
  }

  if (data === 'topup_custom') {
    setSession(userId, { mode: 'topup_wait_custom' });
    return ctx.reply(`✏️ Ketik nominal top-up (angka saja), minimal ${formatRupiah(TOPUP_MIN)}.\n\nContoh: 30000`);
  }

  if (data.startsWith('topup_')) {
    const amount = parseInt(data.slice('topup_'.length), 10);
    if (!Number.isFinite(amount)) return;
    const session = getSession(userId);
    await ctx.editMessageText(`⏳ Membuat QRIS untuk ${formatRupiah(amount)}...`).catch(() => {});
    await startTopupFlow(ctx, session.dbUserId!, userId, amount);
    return;
  }

  if (data === 'mode_kling') {
    if (!await requireLogin(ctx)) return;
    setSession(userId, { mode: 'kling_wait_image', characterUrl: undefined, klingCharacterFileId: undefined, klingVideoFileId: undefined });
    return ctx.editMessageText(
      `🕹️ *Kling MC3.0 PRO*\n\n` +
      '*Langkah 1:* Kirim *foto karakter* yang ingin dianimasikan.\n\n' +
      '⚠️ *Syarat foto:*\n' +
      '• Tampilkan seluruh tubuh dari depan\n' +
      '• Bukan close-up wajah\n' +
      '• Resolusi min. 300px, maks 10MB\n' +
      '• Format: JPG, PNG\n\n' +
      `ℹ️ Nanti di langkah 2, video referensi gerakan *maksimal ${KLING_MAX_REF_SECONDS} detik*.`,
      { parse_mode: 'Markdown' }
    );
  }

  // ── Runway Gen-4.5 wizard (image-to-video only) ──
  if (data === 'mode_rw') {
    setSession(userId, {
      mode: 'idle',
      rwDuration: undefined,
      rwRatio: undefined,
      rwImageUrl: undefined,
    });
    return ctx.editMessageText(
      '🚀 *Runway Gen-4.5*\n\nVideo dibuat dari *foto + prompt*.\n\n*Langkah 1:* Pilih durasi video:',
      { parse_mode: 'Markdown', ...rwDurationKeyboard() }
    );
  }

  if (data.startsWith('rw_dur_')) {
    const dur = parseInt(data.replace('rw_dur_', ''), 10);
    setSession(userId, { rwDuration: dur });
    return ctx.editMessageText(
      `🚀 *Runway Gen-4.5*\n\nDurasi: *${dur} detik*\n\n*Langkah 2:* Pilih rasio layar:`,
      { parse_mode: 'Markdown', ...rwRatioKeyboard() }
    );
  }

  if (data.startsWith('rw_ratio_')) {
    const entry = RW_RATIO_MAP[data.replace('rw_ratio_', '')] ?? RW_RATIO_MAP['916'];
    setSession(userId, { rwRatio: entry.api, mode: 'rw_wait_image' });
    return ctx.editMessageText(
      `🚀 *Runway Gen-4.5*\n\nRasio: *${entry.label}*\n\n` +
      '*Langkah 3:* Kirim *foto acuan* untuk video kamu.',
      { parse_mode: 'Markdown' }
    );
  }

  // ── Sora 2 wizard (text-to-video or image-to-video) ──
  if (data === 'mode_sora') {
    setSession(userId, {
      mode: 'idle',
      soraInputMode: undefined,
      soraDuration: undefined,
      soraRatio: undefined,
      soraImageUrl: undefined,
    });
    return ctx.editMessageText(
      '🎥 *Sora 2 (OpenAI)*\n\nPilih cara membuat video:',
      { parse_mode: 'Markdown', ...soraInputKeyboard() }
    );
  }

  if (data === 'so_in_i2v' || data === 'so_in_t2v') {
    setSession(userId, { soraInputMode: data === 'so_in_i2v' ? 'i2v' : 't2v' });
    return ctx.editMessageText(
      '🎥 *Sora 2*\n\n*Langkah 1:* Pilih durasi video:',
      { parse_mode: 'Markdown', ...soraDurationKeyboard() }
    );
  }

  if (data.startsWith('so_dur_')) {
    const dur = parseInt(data.replace('so_dur_', ''), 10);
    setSession(userId, { soraDuration: dur });
    return ctx.editMessageText(
      `🎥 *Sora 2*\n\nDurasi: *${dur} detik*\n\n*Langkah 2:* Pilih rasio layar:`,
      { parse_mode: 'Markdown', ...soraRatioKeyboard() }
    );
  }

  if (data.startsWith('so_ratio_')) {
    const ratio = SD_RATIO_MAP[data.replace('so_ratio_', '')] ?? '9:16';
    const session = getSession(userId);
    if (session.soraInputMode === 'i2v') {
      setSession(userId, { soraRatio: ratio, mode: 'sora_wait_image' });
      return ctx.editMessageText(
        `🎥 *Sora 2*\n\nRasio: *${ratio}*\n\n*Langkah 3:* Kirim *foto acuan* untuk video kamu.`,
        { parse_mode: 'Markdown' }
      );
    }
    setSession(userId, { soraRatio: ratio, mode: 'sora_wait_prompt' });
    return ctx.editMessageText(
      `🎥 *Sora 2*\n\nRasio: *${ratio}*\n\n*Langkah 3:* Kirim *prompt teks* untuk video kamu (deskripsi adegan).`,
      { parse_mode: 'Markdown' }
    );
  }

  // ── Veo 3.1 Fast wizard (SnapGen, text-to-video or image-to-video) ──
  if (data === 'mode_veofast') {
    setSession(userId, {
      mode: 'idle',
      veofastInputMode: undefined,
      veofastImageUrl: undefined,
      veofastRatio: undefined,
    });
    return ctx.editMessageText(
      '⚡ *Veo 3.1 Fast (Full HD)*\n\nVideo 8 detik · 1080p.\n\nPilih rasio video:',
      { parse_mode: 'Markdown', ...veofastRatioKeyboard() }
    );
  }

  if (data === 'vf_ratio_169' || data === 'vf_ratio_916') {
    const ratio = data === 'vf_ratio_169' ? '16:9' : '9:16';
    setSession(userId, { veofastRatio: ratio });
    return ctx.editMessageText(
      `⚡ *Veo 3.1 Fast (Full HD)*\n\nVideo 8 detik · ${ratio} · 1080p.\n\nPilih cara membuat video:`,
      { parse_mode: 'Markdown', ...veofastInputKeyboard() }
    );
  }

  if (data === 'vf_in_i2v' || data === 'vf_in_t2v') {
    const inputMode = data === 'vf_in_i2v' ? 'i2v' : 't2v';
    const ratio = getSession(userId).veofastRatio ?? '16:9';
    if (inputMode === 'i2v') {
      setSession(userId, { veofastInputMode: 'i2v', mode: 'veofast_wait_image' });
      return ctx.editMessageText(
        `⚡ *Veo 3.1 Fast (Full HD)*\n\nRasio: ${ratio}\n\n*Langkah 1:* Kirim *foto acuan* untuk video kamu.`,
        { parse_mode: 'Markdown' }
      );
    }
    setSession(userId, { veofastInputMode: 't2v', mode: 'veofast_wait_prompt' });
    return ctx.editMessageText(
      `⚡ *Veo 3.1 Fast (Full HD)*\n\nRasio: ${ratio}\n\n*Langkah 1:* Kirim *prompt teks* untuk video kamu (deskripsi adegan).`,
      { parse_mode: 'Markdown' }
    );
  }

  // ── Veo 3.1 Lite wizard (SnapGen, text-to-video or image-to-video) ──
  if (data === 'mode_veolite') {
    setSession(userId, {
      mode: 'idle',
      veoliteInputMode: undefined,
      veoliteImageUrl: undefined,
      veoliteRatio: undefined,
    });
    return ctx.editMessageText(
      '🎞️ *Veo 3.1 Lite (Full HD)*\n\nVideo 8 detik · 1080p · 🔊 dengan audio tersinkron.\n\nPilih rasio video:',
      { parse_mode: 'Markdown', ...veoliteRatioKeyboard() }
    );
  }

  if (data === 'vl_ratio_169' || data === 'vl_ratio_916') {
    const ratio = data === 'vl_ratio_169' ? '16:9' : '9:16';
    setSession(userId, { veoliteRatio: ratio });
    return ctx.editMessageText(
      `🎞️ *Veo 3.1 Lite (Full HD)*\n\nVideo 8 detik · ${ratio} · 1080p · 🔊 dengan audio tersinkron.\n\nPilih cara membuat video:`,
      { parse_mode: 'Markdown', ...veoliteInputKeyboard() }
    );
  }

  if (data === 'vl_in_i2v' || data === 'vl_in_t2v') {
    const inputMode = data === 'vl_in_i2v' ? 'i2v' : 't2v';
    const ratio = getSession(userId).veoliteRatio ?? '16:9';
    if (inputMode === 'i2v') {
      setSession(userId, { veoliteInputMode: 'i2v', mode: 'veolite_wait_image' });
      return ctx.editMessageText(
        `🎞️ *Veo 3.1 Lite (Full HD)*\n\nRasio: ${ratio}\n\n*Langkah 1:* Kirim *foto acuan* untuk video kamu.`,
        { parse_mode: 'Markdown' }
      );
    }
    setSession(userId, { veoliteInputMode: 't2v', mode: 'veolite_wait_prompt' });
    return ctx.editMessageText(
      `🎞️ *Veo 3.1 Lite (Full HD)*\n\nRasio: ${ratio}\n\n*Langkah 1:* Kirim *prompt teks* untuk video kamu (deskripsi adegan).`,
      { parse_mode: 'Markdown' }
    );
  }

  // ── Gemini Omni wizard (text-to-video or image-to-video) ──
  if (data === 'mode_gomni') {
    setSession(userId, {
      mode: 'idle',
      gomniInputMode: undefined,
      gomniDuration: undefined,
      gomniRatio: undefined,
      gomniImageUrl: undefined,
      gomniVideoUrl: undefined,
    });
    return ctx.editMessageText(
      '✨ *Gemini Omni (Google)*\n\nPilih cara membuat video:',
      { parse_mode: 'Markdown', ...gomniInputKeyboard() }
    );
  }

  if (data === 'go_in_i2v' || data === 'go_in_t2v' || data === 'go_in_v2v') {
    const inputMode = data === 'go_in_i2v' ? 'i2v' : data === 'go_in_v2v' ? 'v2v' : 't2v';
    setSession(userId, { gomniInputMode: inputMode });
    return ctx.editMessageText(
      '✨ *Gemini Omni*\n\n*Langkah 1:* Pilih durasi video:',
      { parse_mode: 'Markdown', ...gomniDurationKeyboard() }
    );
  }

  if (data.startsWith('go_dur_')) {
    const dur = parseInt(data.replace('go_dur_', ''), 10);
    setSession(userId, { gomniDuration: dur });
    return ctx.editMessageText(
      `✨ *Gemini Omni*\n\nDurasi: *${dur} detik*\n\n*Langkah 2:* Pilih rasio layar:`,
      { parse_mode: 'Markdown', ...gomniRatioKeyboard() }
    );
  }

  if (data.startsWith('go_ratio_')) {
    const ratio = SD_RATIO_MAP[data.replace('go_ratio_', '')] ?? '9:16';
    const session = getSession(userId);
    if (session.gomniInputMode === 'i2v' || session.gomniInputMode === 'v2v') {
      setSession(userId, { gomniRatio: ratio, mode: 'gomni_wait_image' });
      return ctx.editMessageText(
        `✨ *Gemini Omni*\n\nRasio: *${ratio}*\n\n*Langkah 3:* Kirim *foto acuan* untuk video kamu.`,
        { parse_mode: 'Markdown' }
      );
    }
    setSession(userId, { gomniRatio: ratio, mode: 'gomni_wait_prompt' });
    return ctx.editMessageText(
      `✨ *Gemini Omni*\n\nRasio: *${ratio}*\n\n*Langkah 3:* Kirim *prompt teks* untuk video kamu (deskripsi adegan).`,
      { parse_mode: 'Markdown' }
    );
  }

  // ── Nano Banana image wizard (SnapGen, text-to-image or image-to-image) ──
  if (data === 'mode_nbpro' || data === 'mode_nb2' || data === 'mode_nb2lite') {
    const cfg = IMG_MODELS[data];
    setSession(userId, {
      mode: 'idle',
      imgModel: cfg.model,
      imgPriceKey: cfg.priceKey,
      imgRatio: undefined,
      imgInputMode: undefined,
      imgImageUrl: undefined,
    });
    return ctx.editMessageText(
      `${cfg.label}\n\nGenerate gambar (${formatRupiah(MODEL_PRICES[cfg.priceKey])}).\n\nPilih rasio gambar:`,
      { parse_mode: 'Markdown', ...imgRatioKeyboard() }
    );
  }

  if (data.startsWith('img_ratio_')) {
    const ratio = IMG_RATIO_MAP[data.replace('img_ratio_', '')] ?? '1:1';
    const label = imgLabelFor(userId);
    setSession(userId, { imgRatio: ratio });
    return ctx.editMessageText(
      `${label}\n\nRasio: ${ratio}\n\nPilih cara membuat gambar:`,
      { parse_mode: 'Markdown', ...imgInputKeyboard() }
    );
  }

  if (data === 'img_in_i2i' || data === 'img_in_t2i') {
    const inputMode = data === 'img_in_i2i' ? 'i2i' : 't2i';
    const label = imgLabelFor(userId);
    const ratio = getSession(userId).imgRatio ?? '1:1';
    if (inputMode === 'i2i') {
      setSession(userId, { imgInputMode: 'i2i', mode: 'img_wait_image' });
      return ctx.editMessageText(
        `${label}\n\nRasio: ${ratio}\n\n*Langkah 1:* Kirim *foto acuan* untuk gambar kamu.`,
        { parse_mode: 'Markdown' }
      );
    }
    setSession(userId, { imgInputMode: 't2i', mode: 'img_wait_prompt' });
    return ctx.editMessageText(
      `${label}\n\nRasio: ${ratio}\n\n*Langkah 1:* Kirim *prompt teks* untuk gambar kamu (deskripsi gambar).`,
      { parse_mode: 'Markdown' }
    );
  }

  if (data === 'back_main') {
    setSession(userId, { mode: 'idle' });
    return ctx.editMessageText('Pilih mode generasi:', mainMenuKeyboard());
  }
});

// Label model gambar berdasarkan session aktif (dipakai di beberapa langkah wizard).
function imgLabelFor(userId: number): string {
  const model = getSession(userId).imgModel;
  const entry = Object.values(IMG_MODELS).find((m) => m.model === model);
  return entry ? `*${entry.label}*` : '*Nano Banana*';
}

// ─── Shared photo/image handler ───────────────────────────────────────────────

async function handleImageInput(ctx: any, fileUrl: string, fileId?: string) {
  const userId = ctx.from.id;
  const session = getSession(userId);

  if (session.mode === 'kling_wait_prompt') {
    return ctx.reply(
      '⚠️ Sekarang giliran *prompt teks*. Kirim deskripsi gerakan/adegan, atau ketik *-* untuk lewati.',
      { parse_mode: 'Markdown' }
    );
  }

  if (session.mode === 'kling_wait_image') {
    setSession(userId, { characterUrl: fileUrl, klingCharacterFileId: fileId, mode: 'kling_wait_video' });
    return ctx.reply(
      '✅ Foto karakter diterima!\n\n' +
      '*Langkah 2:* Kirim *video referensi gerakan*.\n\n' +
      '⚠️ *Syarat video:*\n' +
      '• Orang terlihat jelas dalam video\n' +
      '• Durasi *maksimal 16 detik* (lebih dari itu ditolak)\n' +
      '• Maks ukuran file: 19MB',
      { parse_mode: 'Markdown' }
    );
  }

  if (session.mode === 'rw_wait_image') {
    setSession(userId, { rwImageUrl: fileUrl, mode: 'rw_wait_prompt' });
    return ctx.reply(
      '✅ Foto acuan diterima!\n\n' +
      '*Langkah terakhir:* Kirim *prompt teks* untuk video kamu (deskripsi adegan).',
      { parse_mode: 'Markdown' }
    );
  }

  if (session.mode === 'sora_wait_image') {
    setSession(userId, { soraImageUrl: fileUrl, mode: 'sora_wait_prompt' });
    return ctx.reply(
      '✅ Foto acuan diterima!\n\n' +
      '*Langkah terakhir:* Kirim *prompt teks* untuk video kamu (deskripsi adegan).',
      { parse_mode: 'Markdown' }
    );
  }

  if (session.mode === 'veofast_wait_image') {
    setSession(userId, { veofastImageUrl: fileUrl, mode: 'veofast_wait_prompt' });
    return ctx.reply(
      `✅ Foto acuan diterima! (Rasio: ${session.veofastRatio ?? '16:9'})\n\n` +
      '*Langkah terakhir:* Kirim *prompt teks* untuk video kamu (deskripsi adegan).',
      { parse_mode: 'Markdown' }
    );
  }

  if (session.mode === 'veolite_wait_image') {
    setSession(userId, { veoliteImageUrl: fileUrl, mode: 'veolite_wait_prompt' });
    return ctx.reply(
      `✅ Foto acuan diterima! (Rasio: ${session.veoliteRatio ?? '16:9'})\n\n` +
      '*Langkah terakhir:* Kirim *prompt teks* untuk video kamu (deskripsi adegan).',
      { parse_mode: 'Markdown' }
    );
  }

  if (session.mode === 'img_wait_image') {
    setSession(userId, { imgImageUrl: fileUrl, mode: 'img_wait_prompt' });
    return ctx.reply(
      `✅ Foto acuan diterima! (Rasio: ${session.imgRatio ?? '1:1'})\n\n` +
      '*Langkah terakhir:* Kirim *prompt teks* untuk gambar kamu (deskripsi gambar).',
      { parse_mode: 'Markdown' }
    );
  }

  if (session.mode === 'gomni_wait_image') {
    if (session.gomniInputMode === 'v2v') {
      setSession(userId, { gomniImageUrl: fileUrl, mode: 'gomni_wait_video' });
      return ctx.reply(
        '✅ Foto acuan diterima!\n\n' +
        '*Langkah berikutnya:* Kirim *video referensi* (untuk acuan gerakan/gaya).',
        { parse_mode: 'Markdown' }
      );
    }
    setSession(userId, { gomniImageUrl: fileUrl, mode: 'gomni_wait_prompt' });
    return ctx.reply(
      '✅ Foto acuan diterima!\n\n' +
      '*Langkah terakhir:* Kirim *prompt teks* untuk video kamu (deskripsi adegan).',
      { parse_mode: 'Markdown' }
    );
  }

  return ctx.reply('Pilih mode terlebih dahulu:', mainMenuKeyboard());
}

// ─── Photo handler ────────────────────────────────────────────────────────────

bot.on('photo', async (ctx) => {
  if (!await requireLogin(ctx)) return;
  const photo = ctx.message.photo[ctx.message.photo.length - 1];
  const fileLink = await ctx.telegram.getFileLink(photo.file_id);
  await handleImageInput(ctx, fileLink.href, photo.file_id);
});

// ─── Video handler ────────────────────────────────────────────────────────────

bot.on('video', async (ctx) => {
  if (!await requireLogin(ctx)) return;
  const userId = ctx.from.id;
  const session = getSession(userId);
  const vid = ctx.message.video;
  const MAX_VIDEO_BYTES = 19 * 1024 * 1024; // 19MB — Telegram bot API limit is 20MB

  if (session.mode === 'kling_wait_video' && session.characterUrl) {
    if (vid.file_size && vid.file_size > MAX_VIDEO_BYTES) {
      return ctx.reply(`❌ Video terlalu besar (${(vid.file_size / 1024 / 1024).toFixed(1)} MB).\nMaksimal 19MB. Kompres dulu atau kirim file lebih kecil.`);
    }
    if (vid.duration && vid.duration > KLING_MAX_REF_SECONDS) {
      return ctx.reply(
        `❌ Video referensi terlalu panjang (${vid.duration} detik).\n` +
        `Maksimal *${KLING_MAX_REF_SECONDS} detik*. Potong videonya dulu lalu kirim ulang.`,
        { parse_mode: 'Markdown' }
      );
    }
    setSession(userId, { klingVideoFileId: vid.file_id, mode: 'kling_wait_prompt' });
    return ctx.reply(
      '✅ Video referensi diterima!\n\n' +
      '*Langkah 3:* Kirim *prompt teks* (deskripsi gerakan/adegan) untuk mengarahkan hasil video.\n\n' +
      'Contoh: _buat dia mengikuti referensi tanpa kamera goyang_\n\n' +
      'Atau ketik *-* untuk lewati (tanpa prompt).',
      { parse_mode: 'Markdown' }
    );
  }

  if (session.mode === 'kling_wait_prompt') {
    return ctx.reply(
      '⚠️ Video referensi sudah diterima. Sekarang kirim *prompt teks*, atau ketik *-* untuk lewati.',
      { parse_mode: 'Markdown' }
    );
  }

  if (session.mode === 'gomni_wait_video' && session.gomniImageUrl) {
    if (vid.file_size && vid.file_size > MAX_VIDEO_BYTES) {
      return ctx.reply(`❌ Video terlalu besar (${(vid.file_size / 1024 / 1024).toFixed(1)} MB).\nMaksimal 19MB. Kompres dulu atau kirim file lebih kecil.`);
    }
    const fileLink = await ctx.telegram.getFileLink(vid.file_id);
    setSession(userId, { gomniVideoUrl: fileLink.href, mode: 'gomni_wait_prompt' });
    return ctx.reply(
      '✅ Video referensi diterima!\n\n' +
      '*Langkah terakhir:* Kirim *prompt teks* untuk video kamu (deskripsi adegan).',
      { parse_mode: 'Markdown' }
    );
  }

  return ctx.reply('⚠️ Kirim foto karakter terlebih dahulu.', mainMenuKeyboard());
});

// ─── Text handler ─────────────────────────────────────────────────────────────

bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const session = getSession(userId);

  // ── Top-up nominal custom ──
  if (session.mode === 'topup_wait_custom') {
    if (!await requireLogin(ctx)) return;
    const raw = ctx.message.text.replace(/[^0-9]/g, '');
    const amount = parseInt(raw, 10);
    setSession(userId, { mode: 'idle' });
    if (!Number.isFinite(amount) || amount <= 0) {
      return ctx.reply('⚠️ Nominal tidak valid. Ketik angka saja, misal 30000. Ulangi dengan /topup.');
    }
    await startTopupFlow(ctx, getSession(userId).dbUserId!, userId, amount);
    return;
  }

  // ── Kling MC3.0 PRO (Picsart) prompt ──
  if (session.mode === 'kling_wait_prompt') {
    if (!await requireLogin(ctx)) return;
    if (!session.characterUrl || !session.klingVideoFileId) {
      setSession(userId, { mode: 'idle' });
      return ctx.reply('⚠️ Sesi tidak lengkap. Ulangi dari /menu ya.');
    }
    const raw = ctx.message.text.trim();
    const prompt = raw === '-' ? '' : raw;
    const cooldownMs = getCooldownRemainingMs(userId);
    if (cooldownMs > 0) {
      setSession(userId, { mode: 'idle' });
      return ctx.reply(`⏳ Sabar ya, lagi cooldown!\n\nKamu baru aja generate. Tunggu *${formatCooldown(cooldownMs)}* lagi sebelum generate berikutnya.`, { parse_mode: 'Markdown' });
    }
    const videoFileId = session.klingVideoFileId;
    // Prefer file_id (fresh link resolved at generation time) over the possibly-expired URL.
    const characterRef = session.klingCharacterFileId ?? session.characterUrl;
    setSession(userId, { mode: 'idle', klingVideoFileId: undefined });
    const statusMsg = await ctx.reply(`⏳ Memproses Kling Motion Control...\nHasil dikirim otomatis (~2-5 menit).`);
    runKlingMotionControl(ctx.chat.id, userId, session.dbUserId!, statusMsg.message_id, videoFileId, characterRef, prompt)
      .catch(e => console.error(`[${userId}] Kling gen error:`, e.message));
    return;
  }

  // ── Runway Gen-4.5 prompt ──
  if (session.mode === 'rw_wait_prompt') {
    if (!await requireLogin(ctx)) return;
    const prompt = ctx.message.text.trim();
    if (!prompt) {
      return ctx.reply('⚠️ Prompt tidak boleh kosong. Kirim deskripsi adegan untuk video kamu.');
    }
    const cooldownMs = getCooldownRemainingMs(userId);
    if (cooldownMs > 0) {
      setSession(userId, { mode: 'idle' });
      return ctx.reply(`⏳ Sabar ya, lagi cooldown!\n\nKamu baru aja generate. Tunggu *${formatCooldown(cooldownMs)}* lagi sebelum generate berikutnya.`, { parse_mode: 'Markdown' });
    }
    if (!session.rwImageUrl) {
      setSession(userId, { mode: 'idle' });
      return ctx.reply('⚠️ Foto acuan tidak ditemukan. Mulai lagi dari /menu.');
    }
    const opts = {
      imageUrl: session.rwImageUrl,
      duration: session.rwDuration ?? 10,
      ratio: session.rwRatio ?? '720:1280',
    };
    setSession(userId, { mode: 'idle' });
    const statusMsg = await ctx.reply('⏳ Memproses Runway Gen-4.5...\nHasil dikirim otomatis (~3-8 menit).', { parse_mode: 'Markdown' });
    runRunway(ctx.chat.id, userId, session.dbUserId!, statusMsg.message_id, prompt, opts)
      .catch(e => console.error(`[${userId}] Runway gen error:`, e.message));
    return;
  }

  // ── Sora 2 prompt ──
  if (session.mode === 'sora_wait_prompt') {
    if (!await requireLogin(ctx)) return;
    const prompt = ctx.message.text.trim();
    if (!prompt) {
      return ctx.reply('⚠️ Prompt tidak boleh kosong. Kirim deskripsi adegan untuk video kamu.');
    }
    const cooldownMs = getCooldownRemainingMs(userId);
    if (cooldownMs > 0) {
      setSession(userId, { mode: 'idle' });
      return ctx.reply(`⏳ Sabar ya, lagi cooldown!\n\nKamu baru aja generate. Tunggu *${formatCooldown(cooldownMs)}* lagi sebelum generate berikutnya.`, { parse_mode: 'Markdown' });
    }
    const opts = {
      inputMode: session.soraInputMode ?? 't2v',
      imageUrl: session.soraImageUrl,
      duration: session.soraDuration ?? 8,
      ratio: session.soraRatio ?? '9:16',
    };
    setSession(userId, { mode: 'idle' });
    const statusMsg = await ctx.reply('⏳ Memproses Sora 2...\nHasil dikirim otomatis (~3-8 menit).', { parse_mode: 'Markdown' });
    runSora(ctx.chat.id, userId, session.dbUserId!, statusMsg.message_id, prompt, opts)
      .catch(e => console.error(`[${userId}] Sora gen error:`, e.message));
    return;
  }

  // ── Veo 3.1 Fast prompt (SnapGen) ──
  if (session.mode === 'veofast_wait_prompt') {
    if (!await requireLogin(ctx)) return;
    const prompt = ctx.message.text.trim();
    if (!prompt) {
      return ctx.reply('⚠️ Prompt tidak boleh kosong. Kirim deskripsi adegan untuk video kamu.');
    }
    const cooldownMs = getCooldownRemainingMs(userId);
    if (cooldownMs > 0) {
      setSession(userId, { mode: 'idle' });
      return ctx.reply(`⏳ Sabar ya, lagi cooldown!\n\nKamu baru aja generate. Tunggu *${formatCooldown(cooldownMs)}* lagi sebelum generate berikutnya.`, { parse_mode: 'Markdown' });
    }
    const opts = {
      inputMode: session.veofastInputMode ?? 't2v',
      imageUrl: session.veofastImageUrl,
      ratio: session.veofastRatio ?? '16:9',
    };
    setSession(userId, { mode: 'idle' });
    const statusMsg = await ctx.reply('⏳ Memproses Veo 3.1 Fast...\nHasil dikirim otomatis (~3-15 menit).', { parse_mode: 'Markdown' });
    runVeo(ctx.chat.id, userId, session.dbUserId!, statusMsg.message_id, prompt, { ...opts, variant: 'fast' })
      .catch(e => console.error(`[${userId}] Veo Fast gen error:`, e.message));
    return;
  }

  // ── Veo 3.1 Lite prompt (SnapGen) ──
  if (session.mode === 'veolite_wait_prompt') {
    if (!await requireLogin(ctx)) return;
    const prompt = ctx.message.text.trim();
    if (!prompt) {
      return ctx.reply('⚠️ Prompt tidak boleh kosong. Kirim deskripsi adegan untuk video kamu.');
    }
    const cooldownMs = getCooldownRemainingMs(userId);
    if (cooldownMs > 0) {
      setSession(userId, { mode: 'idle' });
      return ctx.reply(`⏳ Sabar ya, lagi cooldown!\n\nKamu baru aja generate. Tunggu *${formatCooldown(cooldownMs)}* lagi sebelum generate berikutnya.`, { parse_mode: 'Markdown' });
    }
    const opts = {
      inputMode: session.veoliteInputMode ?? 't2v',
      imageUrl: session.veoliteImageUrl,
      ratio: session.veoliteRatio ?? '16:9',
    };
    setSession(userId, { mode: 'idle' });
    const statusMsg = await ctx.reply('⏳ Memproses Veo 3.1 Lite...\nHasil dikirim otomatis (~3-15 menit).', { parse_mode: 'Markdown' });
    runVeo(ctx.chat.id, userId, session.dbUserId!, statusMsg.message_id, prompt, { ...opts, variant: 'lite' })
      .catch(e => console.error(`[${userId}] Veo Lite gen error:`, e.message));
    return;
  }

  // ── Gemini Omni prompt ──
  if (session.mode === 'gomni_wait_prompt') {
    if (!await requireLogin(ctx)) return;
    const prompt = ctx.message.text.trim();
    if (!prompt) {
      return ctx.reply('⚠️ Prompt tidak boleh kosong. Kirim deskripsi adegan untuk video kamu.');
    }
    const cooldownMs = getCooldownRemainingMs(userId);
    if (cooldownMs > 0) {
      setSession(userId, { mode: 'idle' });
      return ctx.reply(`⏳ Sabar ya, lagi cooldown!\n\nKamu baru aja generate. Tunggu *${formatCooldown(cooldownMs)}* lagi sebelum generate berikutnya.`, { parse_mode: 'Markdown' });
    }
    if (session.gomniInputMode === 'v2v' && (!session.gomniImageUrl || !session.gomniVideoUrl)) {
      setSession(userId, { mode: 'idle' });
      return ctx.reply('⚠️ Mode ini butuh *foto* dan *video referensi*. Ulangi dari /menu.', { parse_mode: 'Markdown' });
    }
    const opts = {
      inputMode: session.gomniInputMode ?? 't2v',
      imageUrl: session.gomniImageUrl,
      videoUrl: session.gomniVideoUrl,
      duration: session.gomniDuration ?? 10,
      ratio: session.gomniRatio ?? '9:16',
    };
    setSession(userId, { mode: 'idle' });
    const statusMsg = await ctx.reply('⏳ Memproses Gemini Omni...\nHasil dikirim otomatis (~3-8 menit).', { parse_mode: 'Markdown' });
    runGeminiOmni(ctx.chat.id, userId, session.dbUserId!, statusMsg.message_id, prompt, opts)
      .catch(e => console.error(`[${userId}] Gemini Omni gen error:`, e.message));
    return;
  }

  // ── Nano Banana image prompt (SnapGen) ──
  if (session.mode === 'img_wait_prompt') {
    if (!await requireLogin(ctx)) return;
    const prompt = ctx.message.text.trim();
    if (!prompt) {
      return ctx.reply('⚠️ Prompt tidak boleh kosong. Kirim deskripsi gambar yang kamu mau.');
    }
    const cooldownMs = getCooldownRemainingMs(userId);
    if (cooldownMs > 0) {
      setSession(userId, { mode: 'idle' });
      return ctx.reply(`⏳ Sabar ya, lagi cooldown!\n\nKamu baru aja generate. Tunggu *${formatCooldown(cooldownMs)}* lagi sebelum generate berikutnya.`, { parse_mode: 'Markdown' });
    }
    const model = session.imgModel ?? 'nano-banana-pro';
    const priceKey = session.imgPriceKey ?? 'nb_pro';
    const opts = {
      model,
      priceKey,
      inputMode: session.imgInputMode ?? 't2i',
      imageUrl: session.imgImageUrl,
      ratio: session.imgRatio ?? '1:1',
    } as const;
    setSession(userId, { mode: 'idle' });
    const statusMsg = await ctx.reply('⏳ Memproses gambar...\nHasil dikirim otomatis (~1-3 menit).', { parse_mode: 'Markdown' });
    runImage(ctx.chat.id, userId, session.dbUserId!, statusMsg.message_id, prompt, opts)
      .catch(e => console.error(`[${userId}] Image gen error:`, e.message));
    return;
  }

  // ── Guard: modes that expect a photo/video, not text ──
  if (session.mode === 'sora_wait_image') {
    return ctx.reply('📸 Mode ini butuh *foto acuan*. Kirim foto, atau /menu untuk batal.', { parse_mode: 'Markdown' });
  }
  if (session.mode === 'veofast_wait_image' || session.mode === 'veolite_wait_image') {
    return ctx.reply('📸 Mode ini butuh *foto acuan*. Kirim foto, atau /menu untuk batal.', { parse_mode: 'Markdown' });
  }
  if (session.mode === 'img_wait_image') {
    return ctx.reply('📸 Mode ini butuh *foto acuan*. Kirim foto, atau /menu untuk batal.', { parse_mode: 'Markdown' });
  }
  if (session.mode === 'gomni_wait_image') {
    return ctx.reply('📸 Mode ini butuh *foto acuan*. Kirim foto, atau /menu untuk batal.', { parse_mode: 'Markdown' });
  }
  if (session.mode === 'gomni_wait_video') {
    return ctx.reply('🎥 Mode ini butuh *video referensi*. Kirim video, atau /menu untuk batal.', { parse_mode: 'Markdown' });
  }
  if (session.mode === 'kling_wait_image') {
    return ctx.reply('📸 Kirim *foto karakter* dulu ya, atau /menu untuk batal.', { parse_mode: 'Markdown' });
  }
  if (session.mode === 'kling_wait_video') {
    return ctx.reply(
      `🎥 Kirim *video referensi gerakan* (durasi maksimal *${KLING_MAX_REF_SECONDS} detik*), atau /menu untuk batal.`,
      { parse_mode: 'Markdown' }
    );
  }

});

// ─── Document handler ─────────────────────────────────────────────────────────

bot.on('document', async (ctx) => {
  if (!await requireLogin(ctx)) return;
  const userId = ctx.from.id;
  const session = getSession(userId);
  const doc = ctx.message.document;

  if (doc.mime_type?.startsWith('image/')) {
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    await handleImageInput(ctx, fileLink.href, doc.file_id);
    return;
  }

  if (doc.mime_type?.startsWith('video/') && session.mode === 'gomni_wait_video' && session.gomniImageUrl) {
    const MAX_VIDEO_BYTES = 19 * 1024 * 1024;
    if (doc.file_size && doc.file_size > MAX_VIDEO_BYTES) {
      return ctx.reply(`❌ Video terlalu besar (${(doc.file_size / 1024 / 1024).toFixed(1)} MB).\nMaksimal 19MB. Kompres dulu atau kirim file lebih kecil.`);
    }
    const fileLink = await ctx.telegram.getFileLink(doc.file_id);
    setSession(userId, { gomniVideoUrl: fileLink.href, mode: 'gomni_wait_prompt' });
    return ctx.reply(
      '✅ Video referensi diterima!\n\n' +
      '*Langkah terakhir:* Kirim *prompt teks* untuk video kamu (deskripsi adegan).',
      { parse_mode: 'Markdown' }
    );
  }

  if (doc.mime_type?.startsWith('video/') && session.mode === 'kling_wait_prompt') {
    return ctx.reply(
      '⚠️ Video referensi sudah diterima. Sekarang kirim *prompt teks*, atau ketik *-* untuk lewati.',
      { parse_mode: 'Markdown' }
    );
  }

  if (doc.mime_type?.startsWith('video/') && session.mode === 'kling_wait_video' && session.characterUrl) {
    const MAX_VIDEO_BYTES = 19 * 1024 * 1024;
    if (doc.file_size && doc.file_size > MAX_VIDEO_BYTES) {
      return ctx.reply(`❌ Video terlalu besar (${(doc.file_size / 1024 / 1024).toFixed(1)} MB).\nMaksimal 19MB. Kompres dulu atau kirim file lebih kecil.`);
    }
    setSession(userId, { klingVideoFileId: doc.file_id, mode: 'kling_wait_prompt' });
    return ctx.reply(
      `⚠️ Ingat: durasi video referensi *maksimal ${KLING_MAX_REF_SECONDS} detik* — kalau lebih, generate akan gagal.\n\n` +
      '✅ Video referensi diterima!\n\n' +
      '*Langkah 3:* Kirim *prompt teks* (deskripsi gerakan/adegan) untuk mengarahkan hasil video.\n\n' +
      'Contoh: _buat dia mengikuti referensi tanpa kamera goyang_\n\n' +
      'Atau ketik *-* untuk lewati (tanpa prompt).',
      { parse_mode: 'Markdown' }
    );
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

async function runKlingMotionControl(chatId: number, userId: number, dbUserId: number, statusMsgId: number, videoFileIdOrUrl: string, imageFileIdOrUrl: string, prompt: string = '') {
  const label = 'Kling MC3.0 PRO';
  const PRICE = MODEL_PRICES.kling_mc;
  const charge = await beginCharge(dbUserId, PRICE, 3);
  if (!charge.ok) {
    await bot.telegram.editMessageText(chatId, statusMsgId, undefined, chargeFailMsg(charge.reason, PRICE)).catch(() => {});
    return;
  }
  let refund = true;

  try {
    // Support both Telegram file ID and direct URL (file ID preferred — links expire)
    const isDirectVideoUrl = videoFileIdOrUrl.startsWith('http://') || videoFileIdOrUrl.startsWith('https://');
    const videoUrl = isDirectVideoUrl
      ? videoFileIdOrUrl
      : (await bot.telegram.getFileLink(videoFileIdOrUrl)).href;
    const isDirectImageUrl = imageFileIdOrUrl.startsWith('http://') || imageFileIdOrUrl.startsWith('https://');
    const imageUrl = isDirectImageUrl
      ? imageFileIdOrUrl
      : (await bot.telegram.getFileLink(imageFileIdOrUrl)).href;
    console.log(`[${userId}] ${label} Motion Control (Picsart) started — img: ${imageUrl}, vid: ${videoUrl}, prompt: "${prompt}"`);

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
      userId: dbUserId,
      imageBuffer: img.buf, imageName: `character.${img.ext}`, imageMime: img.mime,
      videoBuffer: vid.buf, videoName: `driver.${vidType.ext}`, videoMime: vidType.mime,
      prompt,
      model: 'v26',
      onStatus: (stage) => {
        const text = stage === 'upload'
          ? `⏳ ${label}: mengunggah media ke server...`
          : stage === 'submit'
            ? `⏳ ${label}: mengirim job ke server...`
            : `⏳ ${label} sedang diproses...\nBiasanya 5–8 menit.`;
        bot.telegram.editMessageText(chatId, statusMsgId, undefined, text).catch(() => {});
      },
    });

    const delivered = await sendResult(chatId, result.url, `🕹️ Kling MC3.0 PRO\n\n/menu untuk buat lagi`, true);
    if (delivered) {
      refund = false;
      const newCount = await incrementKlingUsage(dbUserId);
      markGenSuccess(userId);
      await bot.telegram.deleteMessage(chatId, statusMsgId).catch(() => {});
      console.log(`[${userId}] ${label} done via Picsart (usage: ${newCount}, credits used: ${result.credits ?? '?'})`);
    }

  } catch (err: any) {
    const msg = describeError(err);
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
  } finally {
    if (refund) {
      await addSaldo(dbUserId, PRICE).catch(() => {});
      await bot.telegram.sendMessage(chatId, `↩️ Saldo ${formatRupiah(PRICE)} dikembalikan (generate tidak berhasil).`).catch(() => {});
    }
    releaseGenerating(dbUserId);
  }
}

// ─── Background: Runway Gen-4.5 (image-to-video) ──────────────────────────────

async function runRunway(
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
  console.log(`[${userId}] Runway started — dur: ${opts.duration}s, ratio: ${opts.ratio}`);

  const PRICE = MODEL_PRICES.runway;
  const charge = await beginCharge(dbUserId, PRICE, 3);
  if (!charge.ok) {
    await bot.telegram.editMessageText(chatId, statusMsgId, undefined, chargeFailMsg(charge.reason, PRICE)).catch(() => {});
    return;
  }
  let refund = true;

  try {
    const img = await downloadBuffer(opts.imageUrl);
    console.log(`[${userId}] Runway ref image — ${img.mime} ${(img.buf.length / 1024).toFixed(1)}KB`);

    let lastEdit = 0;
    const result = await picsart.generateRunway({
      userId: dbUserId,
      prompt,
      imageBuffer: img.buf,
      imageName: `reference.${img.ext}`,
      imageMime: img.mime,
      duration: opts.duration,
      ratio: opts.ratio,
      onStatus: (stage) => {
        const text = stage === 'upload'
          ? '⏳ Runway Gen-4.5: mengunggah foto ke server... (1/3)'
          : stage === 'submit'
            ? '⏳ Runway Gen-4.5: mengirim perintah ke server... (2/3)'
            : '⏳ Runway Gen-4.5: video sedang dibuat... (3/3)\n⏱️ Mohon tunggu, biasanya 3–8 menit. Jangan tutup chat ini.';
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
          `⏳ Runway Gen-4.5: video sedang dibuat... (3/3)\n⏱️ Sudah berjalan ${timer} (biasanya 3–8 menit).\nJangan tutup chat ini, video dikirim otomatis.`
        ).catch(() => {});
      },
    });

    const ratioLabel = Object.values(RW_RATIO_MAP).find(v => v.api === opts.ratio)?.label ?? opts.ratio;
    const delivered = await sendResult(
      chatId,
      result.url,
      `🚀 Runway Gen-4.5 (${opts.duration}s · ${ratioLabel})\n\n/menu untuk buat lagi`,
      true
    );
    if (delivered) {
      refund = false;
      const newCount = await incrementKlingUsage(dbUserId);
      markGenSuccess(userId);
      await bot.telegram.deleteMessage(chatId, statusMsgId).catch(() => {});
      console.log(`[${userId}] Runway done (usage: ${newCount}, credits used: ${result.credits ?? '?'})`);
    }

  } catch (err: any) {
    const msg = describeError(err);
    console.error(`[${userId}] Runway error: ${msg}`);
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
  } finally {
    if (refund) {
      await addSaldo(dbUserId, PRICE).catch(() => {});
      await bot.telegram.sendMessage(chatId, `↩️ Saldo ${formatRupiah(PRICE)} dikembalikan (generate tidak berhasil).`).catch(() => {});
    }
    releaseGenerating(dbUserId);
  }
}

// ─── Background: Sora 2 (text-to-video or image-to-video) ─────────────────────

async function runSora(
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
  }
) {
  console.log(`[${userId}] Sora started — mode: ${opts.inputMode}, dur: ${opts.duration}s, ratio: ${opts.ratio}`);
  const size = SORA_SIZE_MAP[opts.ratio === '16:9' ? '169' : '916'] ?? '720x1280';

  const PRICE = MODEL_PRICES.sora;
  const charge = await beginCharge(dbUserId, PRICE, 3);
  if (!charge.ok) {
    await bot.telegram.editMessageText(chatId, statusMsgId, undefined, chargeFailMsg(charge.reason, PRICE)).catch(() => {});
    return;
  }
  let refund = true;

  try {
    let imageBuffer: Buffer | undefined;
    let imageName: string | undefined;
    let imageMime: string | undefined;
    if (opts.inputMode === 'i2v' && opts.imageUrl) {
      const img = await downloadBuffer(opts.imageUrl);
      imageBuffer = img.buf;
      imageName = `reference.${img.ext}`;
      imageMime = img.mime;
      console.log(`[${userId}] Sora ref image — ${img.mime} ${(img.buf.length / 1024).toFixed(1)}KB`);
    }

    let lastEdit = 0;
    const result = await picsart.generateSora({
      userId: dbUserId,
      prompt,
      imageBuffer,
      imageName,
      imageMime,
      seconds: opts.duration,
      size,
      onStatus: (stage) => {
        const text = stage === 'upload'
          ? '⏳ Sora 2: mengunggah foto ke server... (1/3)'
          : stage === 'submit'
            ? '⏳ Sora 2: mengirim perintah ke server... (2/3)'
            : '⏳ Sora 2: video sedang dibuat... (3/3)\n⏱️ Mohon tunggu, biasanya 3–8 menit. Jangan tutup chat ini.';
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
          `⏳ Sora 2: video sedang dibuat... (3/3)\n⏱️ Sudah berjalan ${timer} (biasanya 3–8 menit).\nJangan tutup chat ini, video dikirim otomatis.`
        ).catch(() => {});
      },
    });

    const delivered = await sendResult(
      chatId,
      result.url,
      `🎥 Sora 2 (${opts.duration}s · ${opts.ratio})\n\n/menu untuk buat lagi`,
      true
    );
    if (delivered) {
      refund = false;
      const newCount = await incrementKlingUsage(dbUserId);
      markGenSuccess(userId);
      await bot.telegram.deleteMessage(chatId, statusMsgId).catch(() => {});
      console.log(`[${userId}] Sora done (usage: ${newCount}, credits used: ${result.credits ?? '?'})`);
    }

  } catch (err: any) {
    const msg = describeError(err);
    console.error(`[${userId}] Sora error: ${msg}`);
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
  } finally {
    if (refund) {
      await addSaldo(dbUserId, PRICE).catch(() => {});
      await bot.telegram.sendMessage(chatId, `↩️ Saldo ${formatRupiah(PRICE)} dikembalikan (generate tidak berhasil).`).catch(() => {});
    }
    releaseGenerating(dbUserId);
  }
}

// ─── SnapGen AI (Veo 3.1 Fast / Lite) ─────────────────────────────────────────
// Provider terpisah dari Picsart. Auth pakai header x-api-key.
//   Submit: POST {SNAPGEN_BASE}/video-gen/veo  (multipart/form-data)
//     fields: prompt, model, resolution '1080p', duration '8', aspect_ratio (16:9 / 9:16)
//     image-to-video: mode_image 'frame' + ref_images (file buffer)
//     → { uuid, status (1 processing, 2 completed, 3 failed), error_message, estimated_credit }
//   Poll:   GET {SNAPGEN_BASE}/history/{uuid}  tiap ~10s hingga ~15 menit
//     status 2 = selesai → generated_video[0].video_url; status 3 = gagal → error_message
const snapgenHttp = axios.create({ timeout: 120_000 });

interface SnapgenSubmitResult { uuid: string; }

async function snapgenSubmitVeo(input: {
  prompt: string;
  model: 'veo-3.1-fast' | 'veo-3.1-lite';
  imageBuffer?: Buffer;
  imageName?: string;
  imageMime?: string;
  aspectRatio?: string;
}): Promise<SnapgenSubmitResult> {
  if (!SNAPGEN_API_KEY) throw new Error('SNAPGEN_KEY_MISSING: SNAPGEN_API_KEY tidak diset');
  const fd = new FormData();
  fd.append('prompt', input.prompt);
  fd.append('model', input.model);
  fd.append('resolution', '1080p');
  fd.append('duration', '8');
  fd.append('aspect_ratio', input.aspectRatio ?? '16:9');
  if (input.imageBuffer) {
    // Foto diunduh sendiri lalu dilampirkan sebagai file — URL Telegram memuat
    // bot token jadi jangan diteruskan ke pihak ketiga.
    fd.append('mode_image', 'frame');
    fd.append('ref_images', input.imageBuffer, {
      filename: input.imageName ?? 'reference.jpg',
      contentType: input.imageMime ?? 'image/jpeg',
    });
  }
  const r = await snapgenHttp.post(`${SNAPGEN_BASE}/video-gen/veo`, fd, {
    headers: { ...fd.getHeaders(), 'x-api-key': SNAPGEN_API_KEY },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true,
  });
  const body = r.data;
  const uuid = body?.uuid;
  const status = Number(body?.status);
  if (r.status < 200 || r.status >= 300 || !uuid) {
    throw new Error(`SNAPGEN_SUBMIT_FAILED status ${r.status}: ${JSON.stringify(body ?? '').slice(0, 300)}`);
  }
  if (status === 3) {
    throw new Error(`SNAPGEN_SUBMIT_FAILED: ${body?.error_message ?? 'ditolak server'}`);
  }
  return { uuid };
}

async function snapgenPollVeo(
  uuid: string,
  opts?: { maxAttempts?: number; intervalMs?: number; onTick?: (elapsedSec: number) => void }
): Promise<{ url: string }> {
  if (!SNAPGEN_API_KEY) throw new Error('SNAPGEN_KEY_MISSING: SNAPGEN_API_KEY tidak diset');
  const maxAttempts = opts?.maxAttempts ?? 90; // ~15 min at 10s
  const intervalMs = opts?.intervalMs ?? 10_000;
  const start = Date.now();
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(intervalMs);
    opts?.onTick?.(Math.round((Date.now() - start) / 1000));
    const r = await snapgenHttp.get(`${SNAPGEN_BASE}/history/${uuid}`, {
      headers: { 'x-api-key': SNAPGEN_API_KEY },
      validateStatus: () => true,
    });
    if (r.status < 200 || r.status >= 300) continue;
    const body = r.data;
    const status = Number(body?.status);
    const gen = Array.isArray(body?.generated_video) ? body.generated_video[0] : undefined;
    const genStatus = gen?.status !== undefined ? Number(gen.status) : undefined;
    if (status === 2 || genStatus === 2) {
      const url = gen?.video_url;
      if (!url) throw new Error('SNAPGEN_NO_RESULT_URL');
      return { url };
    }
    if (status === 3 || genStatus === 3) {
      const errMsg = body?.error_message ?? gen?.error_message ?? 'generate gagal';
      throw new Error(`SNAPGEN_GEN_FAILED: ${String(errMsg).slice(0, 200)}`);
    }
  }
  throw new Error(`SNAPGEN_TIMEOUT: proses melebihi ${Math.round((maxAttempts * intervalMs) / 60000)} menit`);
}

// ─── Background: Veo 3.1 Fast / Lite (SnapGen, text-to-video or image-to-video) ─

async function runVeo(
  chatId: number,
  userId: number,
  dbUserId: number,
  statusMsgId: number,
  prompt: string,
  opts: {
    variant: 'fast' | 'lite';
    inputMode: 'i2v' | 't2v';
    imageUrl?: string;
    ratio?: string;
  }
) {
  const isFast = opts.variant === 'fast';
  const ratio = opts.ratio ?? '16:9';
  const label = isFast ? 'Veo 3.1 Fast' : 'Veo 3.1 Lite';
  const emoji = isFast ? '⚡' : '🎞️';
  const model = isFast ? 'veo-3.1-fast' : 'veo-3.1-lite';
  const PRICE = isFast ? MODEL_PRICES.veo_fast : MODEL_PRICES.veo_lite;
  console.log(`[${userId}] ${label} started — mode: ${opts.inputMode}`);

  const charge = await beginCharge(dbUserId, PRICE, 3);
  if (!charge.ok) {
    await bot.telegram.editMessageText(chatId, statusMsgId, undefined, chargeFailMsg(charge.reason, PRICE)).catch(() => {});
    return;
  }
  let refund = true;

  try {
    let imageBuffer: Buffer | undefined;
    let imageName: string | undefined;
    let imageMime: string | undefined;
    if (opts.inputMode === 'i2v' && opts.imageUrl) {
      const img = await downloadBuffer(opts.imageUrl);
      imageBuffer = img.buf;
      imageName = `reference.${img.ext}`;
      imageMime = img.mime;
      console.log(`[${userId}] ${label} ref image — ${img.mime} ${(img.buf.length / 1024).toFixed(1)}KB`);
    }

    let lastEdit = 0;
    await bot.telegram.editMessageText(
      chatId, statusMsgId, undefined,
      `${emoji} ${label}: mengirim perintah ke server... (1/2)`
    ).catch(() => {});
    const submitted = await snapgenSubmitVeo({ prompt, model, imageBuffer, imageName, imageMime, aspectRatio: ratio });

    lastEdit = Date.now();
    await bot.telegram.editMessageText(
      chatId, statusMsgId, undefined,
      `${emoji} ${label}: video sedang dibuat... (2/2)\n⏱️ Mohon tunggu, biasanya 3–15 menit. Jangan tutup chat ini.`
    ).catch(() => {});

    const result = await snapgenPollVeo(submitted.uuid, {
      onTick: (elapsedSec) => {
        if (Date.now() - lastEdit < 30_000) return;
        lastEdit = Date.now();
        const mins = Math.floor(elapsedSec / 60);
        const secs = elapsedSec % 60;
        const timer = mins > 0 ? `${mins} menit ${secs} detik` : `${secs} detik`;
        bot.telegram.editMessageText(
          chatId, statusMsgId, undefined,
          `${emoji} ${label}: video sedang dibuat... (2/2)\n⏱️ Sudah berjalan ${timer} (biasanya 3–15 menit).\nJangan tutup chat ini, video dikirim otomatis.`
        ).catch(() => {});
      },
    });

    const audioNote = isFast ? '' : ' · 🔊 audio';
    const delivered = await sendResult(
      chatId,
      result.url,
      `${emoji} ${label} (8s · ${ratio} · 1080p${audioNote})\n\n/menu untuk buat lagi`,
      true
    );
    if (delivered) {
      refund = false;
      const newCount = await incrementKlingUsage(dbUserId);
      markGenSuccess(userId);
      await bot.telegram.deleteMessage(chatId, statusMsgId).catch(() => {});
      console.log(`[${userId}] ${label} done (usage: ${newCount})`);
    }

  } catch (err: any) {
    const msg = describeError(err);
    console.error(`[${userId}] ${label} error: ${msg}`);
    let friendly: string;
    if (msg.includes('SNAPGEN_TIMEOUT')) {
      friendly = '❌ Proses terlalu lama. Coba lagi nanti.';
    } else if (msg.includes('SNAPGEN_KEY_MISSING')) {
      friendly = '❌ Layanan sedang tidak tersedia. Coba lagi nanti.';
    } else {
      friendly = '❌ Gagal memproses. Coba lagi nanti.';
    }
    await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
      `${friendly}\n\n/menu untuk coba lagi`
    ).catch(() => bot.telegram.sendMessage(chatId, `${friendly}\n\n/menu untuk coba lagi`));
    // Notifikasi admin (sejalan dengan pola notify owner di backend lain).
    const owner = process.env.PICSART_OWNER_CHAT_ID;
    if (owner) bot.telegram.sendMessage(owner, `⚠️ ${label} gagal untuk user ${userId}: ${msg.slice(0, 300)}`).catch(() => {});
  } finally {
    if (refund) {
      await addSaldo(dbUserId, PRICE).catch(() => {});
      await bot.telegram.sendMessage(chatId, `↩️ Saldo ${formatRupiah(PRICE)} dikembalikan (generate tidak berhasil).`).catch(() => {});
    }
    releaseGenerating(dbUserId);
  }
}

// ─── SnapGen AI (Nano Banana image generation) ────────────────────────────────
// Submit: POST {SNAPGEN_BASE}/generate_image  (multipart/form-data), header x-api-key
//   fields: prompt, model, aspect_ratio, resolution '4K', output 'jpeg'
//   image-to-image: files (array field) — buffer foto acuan yang kita unduh sendiri
//   → { uuid, status (1 processing, 2 completed, 3 failed), generate_result (URL), error_message }
// Poll:   GET {SNAPGEN_BASE}/history/{uuid} tiap 5s hingga 5 menit
//   status 2 = selesai → generate_result / generated_image[0].image_url / file_download_url
//   status 3 = gagal → error_message

async function snapgenSubmitImage(input: {
  prompt: string;
  model: 'nano-banana-pro' | 'nano-banana-2' | 'nano-banana-2-lite';
  aspectRatio?: string;
  imageBuffer?: Buffer;
  imageName?: string;
  imageMime?: string;
}): Promise<{ uuid: string; url?: string }> {
  if (!SNAPGEN_API_KEY) throw new Error('SNAPGEN_KEY_MISSING: SNAPGEN_API_KEY tidak diset');
  const fd = new FormData();
  fd.append('prompt', input.prompt);
  fd.append('model', input.model);
  fd.append('aspect_ratio', input.aspectRatio ?? '1:1');
  fd.append('resolution', '4K');
  fd.append('output', 'jpeg');
  if (input.imageBuffer) {
    // Foto diunduh sendiri lalu dilampirkan sebagai file — URL Telegram memuat
    // bot token jadi jangan diteruskan ke pihak ketiga lewat file_urls.
    fd.append('files', input.imageBuffer, {
      filename: input.imageName ?? 'reference.jpg',
      contentType: input.imageMime ?? 'image/jpeg',
    });
  }
  const r = await snapgenHttp.post(`${SNAPGEN_BASE}/generate_image`, fd, {
    headers: { ...fd.getHeaders(), 'x-api-key': SNAPGEN_API_KEY },
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true,
  });
  const body = r.data;
  const uuid = body?.uuid;
  const status = Number(body?.status);
  if (r.status < 200 || r.status >= 300 || !uuid) {
    throw new Error(`SNAPGEN_SUBMIT_FAILED status ${r.status}: ${JSON.stringify(body ?? '').slice(0, 300)}`);
  }
  if (status === 3) {
    throw new Error(`SNAPGEN_SUBMIT_FAILED: ${body?.error_message ?? 'ditolak server'}`);
  }
  // Kadang server langsung selesai (status 2) — ambil URL kalau ada.
  if (status === 2) {
    const url = extractSnapgenImageUrl(body);
    if (url) return { uuid, url };
  }
  return { uuid };
}

function extractSnapgenImageUrl(body: any): string | undefined {
  if (!body) return undefined;
  if (typeof body.generate_result === 'string' && body.generate_result) return body.generate_result;
  const gen = Array.isArray(body.generated_image) ? body.generated_image[0] : undefined;
  return gen?.image_url ?? gen?.file_download_url ?? undefined;
}

async function snapgenPollImage(
  uuid: string,
  opts?: { maxAttempts?: number; intervalMs?: number; onTick?: (elapsedSec: number) => void }
): Promise<{ url: string }> {
  if (!SNAPGEN_API_KEY) throw new Error('SNAPGEN_KEY_MISSING: SNAPGEN_API_KEY tidak diset');
  const maxAttempts = opts?.maxAttempts ?? 60; // ~5 min at 5s
  const intervalMs = opts?.intervalMs ?? 5_000;
  const start = Date.now();
  for (let i = 0; i < maxAttempts; i++) {
    await sleep(intervalMs);
    opts?.onTick?.(Math.round((Date.now() - start) / 1000));
    const r = await snapgenHttp.get(`${SNAPGEN_BASE}/history/${uuid}`, {
      headers: { 'x-api-key': SNAPGEN_API_KEY },
      validateStatus: () => true,
    });
    if (r.status < 200 || r.status >= 300) continue;
    const body = r.data;
    const status = Number(body?.status);
    if (status === 2) {
      const url = extractSnapgenImageUrl(body);
      if (!url) throw new Error('SNAPGEN_NO_RESULT_URL');
      return { url };
    }
    if (status === 3) {
      const errMsg = body?.error_message ?? 'generate gagal';
      throw new Error(`SNAPGEN_GEN_FAILED: ${String(errMsg).slice(0, 200)}`);
    }
  }
  throw new Error(`SNAPGEN_TIMEOUT: proses melebihi ${Math.round((maxAttempts * intervalMs) / 60000)} menit`);
}

// ─── Background: Nano Banana image (SnapGen, text-to-image or image-to-image) ──

async function runImage(
  chatId: number,
  userId: number,
  dbUserId: number,
  statusMsgId: number,
  prompt: string,
  opts: {
    model: 'nano-banana-pro' | 'nano-banana-2' | 'nano-banana-2-lite';
    priceKey: 'nb_pro' | 'nb_2' | 'nb_2lite';
    inputMode: 'i2i' | 't2i';
    imageUrl?: string;
    ratio: string;
  }
) {
  const entry = Object.values(IMG_MODELS).find((m) => m.model === opts.model);
  const label = entry ? entry.label : '🍌 Nano Banana';
  const ratio = opts.ratio ?? '1:1';
  const PRICE = MODEL_PRICES[opts.priceKey];
  console.log(`[${userId}] ${label} started — mode: ${opts.inputMode}, ratio: ${ratio}`);

  const charge = await beginCharge(dbUserId, PRICE, 3);
  if (!charge.ok) {
    await bot.telegram.editMessageText(chatId, statusMsgId, undefined, chargeFailMsg(charge.reason, PRICE)).catch(() => {});
    return;
  }
  let refund = true;

  try {
    let imageBuffer: Buffer | undefined;
    let imageName: string | undefined;
    let imageMime: string | undefined;
    if (opts.inputMode === 'i2i' && opts.imageUrl) {
      const img = await downloadBuffer(opts.imageUrl);
      imageBuffer = img.buf;
      imageName = `reference.${img.ext}`;
      imageMime = img.mime;
      console.log(`[${userId}] ${label} ref image — ${img.mime} ${(img.buf.length / 1024).toFixed(1)}KB`);
    }

    let lastEdit = 0;
    await bot.telegram.editMessageText(
      chatId, statusMsgId, undefined,
      `🎨 ${label}: mengirim perintah ke server... (1/2)`
    ).catch(() => {});
    const submitted = await snapgenSubmitImage({ prompt, model: opts.model, aspectRatio: ratio, imageBuffer, imageName, imageMime });

    let resultUrl = submitted.url;
    if (!resultUrl) {
      lastEdit = Date.now();
      await bot.telegram.editMessageText(
        chatId, statusMsgId, undefined,
        `🎨 ${label}: gambar sedang dibuat... (2/2)\n⏱️ Mohon tunggu, biasanya 1–3 menit. Jangan tutup chat ini.`
      ).catch(() => {});
      const result = await snapgenPollImage(submitted.uuid, {
        onTick: (elapsedSec) => {
          if (Date.now() - lastEdit < 15_000) return;
          lastEdit = Date.now();
          const mins = Math.floor(elapsedSec / 60);
          const secs = elapsedSec % 60;
          const timer = mins > 0 ? `${mins} menit ${secs} detik` : `${secs} detik`;
          bot.telegram.editMessageText(
            chatId, statusMsgId, undefined,
            `🎨 ${label}: gambar sedang dibuat... (2/2)\n⏱️ Sudah berjalan ${timer}.\nJangan tutup chat ini, gambar dikirim otomatis.`
          ).catch(() => {});
        },
      });
      resultUrl = result.url;
    }

    const caption = `🎨 ${label} (${ratio} · 4K)\n\n/menu untuk buat lagi`;
    const delivered = await sendImageResult(chatId, resultUrl, caption);
    if (delivered) {
      refund = false;
      const newCount = await incrementKlingUsage(dbUserId);
      markGenSuccess(userId);
      await bot.telegram.deleteMessage(chatId, statusMsgId).catch(() => {});
      console.log(`[${userId}] ${label} done (usage: ${newCount})`);
    }

  } catch (err: any) {
    const msg = describeError(err);
    console.error(`[${userId}] ${label} error: ${msg}`);
    let friendly: string;
    if (msg.includes('SNAPGEN_TIMEOUT')) {
      friendly = '❌ Proses terlalu lama. Coba lagi nanti.';
    } else if (msg.includes('SNAPGEN_KEY_MISSING')) {
      friendly = '❌ Layanan sedang tidak tersedia. Coba lagi nanti.';
    } else {
      friendly = '❌ Gagal memproses. Coba lagi nanti.';
    }
    await bot.telegram.editMessageText(chatId, statusMsgId, undefined,
      `${friendly}\n\n/menu untuk coba lagi`
    ).catch(() => bot.telegram.sendMessage(chatId, `${friendly}\n\n/menu untuk coba lagi`));
    const owner = process.env.PICSART_OWNER_CHAT_ID;
    if (owner) bot.telegram.sendMessage(owner, `⚠️ ${label} gagal untuk user ${userId}: ${msg.slice(0, 300)}`).catch(() => {});
  } finally {
    if (refund) {
      await addSaldo(dbUserId, PRICE).catch(() => {});
      await bot.telegram.sendMessage(chatId, `↩️ Saldo ${formatRupiah(PRICE)} dikembalikan (generate tidak berhasil).`).catch(() => {});
    }
    releaseGenerating(dbUserId);
  }
}

// Kirim gambar hasil via replyWithPhoto; fallback ke document jika gagal. Kita
// unduh sendiri lalu upload bytes-nya supaya URL upstream tidak pernah terlihat.
async function sendImageResult(chatId: number, outputUrl: string, caption: string): Promise<boolean> {
  let buf: Buffer | null = null;
  try {
    const res = await telegramHttp.get(outputUrl, { responseType: 'arraybuffer', timeout: 120_000 });
    buf = Buffer.from(res.data);
    console.log(`Downloaded image result: ${(buf.length / 1024).toFixed(1)} KB`);
  } catch (e: any) {
    console.log(`Image download failed: ${e.message}`);
  }
  if (!buf) {
    await bot.telegram.sendMessage(chatId,
      `✅ Gambar selesai, tapi gagal mengambil file. Coba lagi sebentar ya.\n\n${caption}`
    );
    return false;
  }
  const opts = { caption };
  // Batas foto Telegram 10MB — hasil 4K sering lebih besar; langsung kirim
  // sebagai dokumen (kualitas penuh, tanpa kompresi) tanpa buang waktu coba foto.
  const PHOTO_MAX_BYTES = 10 * 1024 * 1024;
  if (buf.length <= PHOTO_MAX_BYTES) {
    try {
      await bot.telegram.sendPhoto(chatId, { source: buf, filename: 'output.jpg' }, opts);
      return true;
    } catch (e: any) {
      console.log(`sendPhoto failed, fallback to document: ${e.message}`);
    }
  } else {
    console.log(`Image ${(buf.length / 1048576).toFixed(1)} MB > 10 MB, sending as document`);
  }
  try {
    await bot.telegram.sendDocument(chatId, { source: buf, filename: 'output.jpg' }, opts);
    return true;
  } catch (e: any) {
    console.log(`sendDocument failed: ${e.message}`);
    await bot.telegram.sendMessage(chatId,
      `✅ Gambar selesai, tapi gagal mengirim file. Coba lagi sebentar ya.\n\n${caption}`
    );
    return false;
  }
}

// ─── Background: Gemini Omni (text-to-video or image-to-video) ────────────────

async function runGeminiOmni(
  chatId: number,
  userId: number,
  dbUserId: number,
  statusMsgId: number,
  prompt: string,
  opts: {
    inputMode: 'i2v' | 't2v' | 'v2v';
    imageUrl?: string;
    videoUrl?: string;
    duration: number;
    ratio: string;
  }
) {
  console.log(`[${userId}] Gemini Omni started — mode: ${opts.inputMode}, dur: ${opts.duration}s, ratio: ${opts.ratio}`);

  const PRICE = MODEL_PRICES.gemini_omni;
  const charge = await beginCharge(dbUserId, PRICE, 3);
  if (!charge.ok) {
    await bot.telegram.editMessageText(chatId, statusMsgId, undefined, chargeFailMsg(charge.reason, PRICE)).catch(() => {});
    return;
  }
  let refund = true;

  try {
    let imageBuffer: Buffer | undefined;
    let imageName: string | undefined;
    let imageMime: string | undefined;
    if ((opts.inputMode === 'i2v' || opts.inputMode === 'v2v') && opts.imageUrl) {
      const img = await downloadBuffer(opts.imageUrl);
      imageBuffer = img.buf;
      imageName = `reference.${img.ext}`;
      imageMime = img.mime;
      console.log(`[${userId}] Gemini Omni ref image — ${img.mime} ${(img.buf.length / 1024).toFixed(1)}KB`);
    }

    let videoBuffer: Buffer | undefined;
    let videoName: string | undefined;
    let videoMime: string | undefined;
    if (opts.inputMode === 'v2v' && opts.videoUrl) {
      const vid = await downloadBuffer(opts.videoUrl);
      videoBuffer = vid.buf;
      videoName = `reference.${vid.ext}`;
      videoMime = vid.mime;
      console.log(`[${userId}] Gemini Omni ref video — ${vid.mime} ${(vid.buf.length / 1024 / 1024).toFixed(1)}MB`);
    }

    let lastEdit = 0;
    const result = await picsart.generateGeminiOmni({
      userId: dbUserId,
      prompt,
      imageBuffer,
      imageName,
      imageMime,
      videoBuffer,
      videoName,
      videoMime,
      durationSeconds: opts.duration,
      aspectRatio: opts.ratio,
      onStatus: (stage) => {
        const text = stage === 'upload'
          ? '⏳ Gemini Omni: mengunggah foto/video ke server... (1/3)'
          : stage === 'submit'
            ? '⏳ Gemini Omni: mengirim perintah ke server... (2/3)'
            : '⏳ Gemini Omni: video sedang dibuat... (3/3)\n⏱️ Mohon tunggu, biasanya 3–8 menit. Jangan tutup chat ini.';
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
          `⏳ Gemini Omni: video sedang dibuat... (3/3)\n⏱️ Sudah berjalan ${timer} (biasanya 3–8 menit).\nJangan tutup chat ini, video dikirim otomatis.`
        ).catch(() => {});
      },
    });

    const delivered = await sendResult(
      chatId,
      result.url,
      `✨ Gemini Omni (${opts.duration}s · ${opts.ratio})\n\n/menu untuk buat lagi`,
      true
    );
    if (delivered) {
      refund = false;
      const newCount = await incrementKlingUsage(dbUserId);
      markGenSuccess(userId);
      await bot.telegram.deleteMessage(chatId, statusMsgId).catch(() => {});
      console.log(`[${userId}] Gemini Omni done (usage: ${newCount}, credits used: ${result.credits ?? '?'})`);
    }

  } catch (err: any) {
    const msg = describeError(err);
    console.error(`[${userId}] Gemini Omni error: ${msg}`);
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
  } finally {
    if (refund) {
      await addSaldo(dbUserId, PRICE).catch(() => {});
      await bot.telegram.sendMessage(chatId, `↩️ Saldo ${formatRupiah(PRICE)} dikembalikan (generate tidak berhasil).`).catch(() => {});
    }
    releaseGenerating(dbUserId);
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

// Serve self-hosted result files. The token is an unguessable random id mapped to
// a file we wrote ourselves — it is never used to build a path, so there's no way
// to traverse the filesystem with it.
app.get('/dl/:token', (req, res) => {
  const entry = mediaStore.get(req.params.token);
  if (!entry || entry.expiresAt < Date.now()) {
    res.status(404).send('Link sudah tidak berlaku.');
    return;
  }
  res.setHeader('Content-Type', entry.contentType);
  res.setHeader('Content-Disposition', `inline; filename="${entry.filename}"`);
  const stream = createReadStream(entry.filePath);
  stream.on('error', () => { if (!res.headersSent) res.status(404).end(); });
  stream.pipe(res);
});

app.listen(PORT, () => {
  console.log(`✅ Health check server berjalan di port ${PORT}`);
});

// Ensure the Picsart schema exists BEFORE handlers go live, so an early
// /addpicsartkey can't hit a missing table on cold start.
(async () => {
  try {
    await picsart.ensurePicsartSchema();
    console.log('✅ Picsart schema siap');
    await ensureBalanceSchema();
    console.log('✅ Saldo schema siap');
    // Keep the refresh token alive forever on a dedicated account (seed once).
    picsart.startPicsartKeepalive();
    console.log('✅ Picsart keepalive aktif (refresh tiap 3 hari)');
  } catch (e: any) {
    console.error('❌ Picsart schema gagal:', e?.message ?? e);
  }
  bot.launch({ allowedUpdates: ['message', 'callback_query'] });
  console.log('✅ Bot berjalan...');

  // Poller top-up QRIS (mode polling, tanpa webhook). Cek order PENDING tiap 15s.
  if (klikqris.klikqrisConfigured()) {
    void pollPendingTopups(); // sekali langsung saat startup — pulihkan order tertunda
    setInterval(() => { void pollPendingTopups(); }, 15_000);
    console.log('✅ Poller top-up KlikQRIS aktif (cek tiap 15 detik)');
  } else {
    console.warn('⚠️ KLIKQRIS_API_KEY / KLIKQRIS_MERCHANT_ID belum diset — fitur /topup nonaktif');
  }
})();

// Global guard: a thrown error inside any command must NOT crash the whole bot
// (a crash restarts the process and wipes all in-memory logins → "login mulu").
bot.catch((err, ctx) => {
  const anyErr = err as any;
  const desc: string = anyErr?.response?.description || anyErr?.message || '';

  // Expected & harmless: user tapped the same button, so the edit produces an
  // identical message. Telegram rejects it with 400 "message is not modified".
  // Nothing is broken — swallow it silently so it doesn't spam the logs.
  if (desc.includes('message is not modified')) return;

  // Transient network blip talking to api.telegram.org (ETIMEDOUT / socket
  // hang up). The update is lost but the bot stays up; log a one-liner instead
  // of a full stack trace and don't try to reply (that would time out too).
  if (isTransientNetworkError(err)) {
    console.warn(`⚠️ Network timeout on ${ctx?.updateType} (code=${anyErr?.code ?? 'n/a'}, bot masih jalan)`);
    return;
  }

  console.error(`⚠️ Bot error on update ${ctx?.updateType}:`, err);
  try {
    ctx?.reply('⚠️ Terjadi error sebentar, coba lagi ya.');
  } catch {
    /* ignore reply failures */
  }
});

// Last-resort guards so an unhandled async error keeps the bot alive instead of
// killing the process (which would log everyone out on restart).
process.on('unhandledRejection', (reason) => {
  if (isTransientNetworkError(reason)) {
    console.warn(`⚠️ Network timeout ke Telegram (code=${(reason as any)?.code ?? 'n/a'}, bot masih jalan)`);
    return;
  }
  console.error('⚠️ Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️ Uncaught exception:', err);
});

// Telegraf's bot.stop() throws "Bot is not running!" if launch never fully
// completed (e.g. startup was delayed by a network/DB outage) or if it was
// already stopped. Thrown from inside a signal handler that becomes an
// uncaughtException, so guard it — a shutdown attempt must never crash noisily.
function stopBot(signal: string) {
  try {
    bot.stop(signal);
  } catch (e: any) {
    console.warn(`Bot stop (${signal}) skipped: ${e?.message ?? e}`);
  }
}
process.once('SIGINT', () => stopBot('SIGINT'));
process.once('SIGTERM', () => stopBot('SIGTERM'));
