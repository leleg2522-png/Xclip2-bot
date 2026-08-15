// ─────────────────────────────────────────────────────────────────────────────
// Picsart AI Playground backend client
//
// Reverse-engineered + live-verified internal API used by picsart.com/ai-playground.
// Auth flow (verified):
//   POST https://api.picsart.com/oauth2/refresh
//     body: {"refresh_token":"rt:..."}   header: x-app-authorization: Bearer <static app token>
//   -> { response: { access_token, expires_in:1799, ... } }
//   -> a NEW rotated refresh token is returned via Set-Cookie `REFRESH_TOKEN=rt:...`
//      (the body's refresh_token field is empty). The old rt is still reusable, but we
//      ALWAYS advance to the rotated one to mirror the browser and avoid reuse-detection.
//   Normal API calls use: authorization: Bearer <access_token>
//
// Kling Motion Control generation:
//   1. upload image + video  -> POST https://upload.picsart.com/v2/files (file, type=editing-temp)
//   2. submit                -> POST /workflows/kling-motion-control/submit
//   3. poll                  -> GET  /workflows/kling-motion-control/{id}/result  (ACCEPTED -> COMPLETED)
//   4. download result.url
// ─────────────────────────────────────────────────────────────────────────────

import axios from 'axios';
import FormData from 'form-data';
import type { Pool, QueryResult, QueryResultRow } from 'pg';

const API_BASE = 'https://api.picsart.com';
const UPLOAD_BASE = 'https://upload.picsart.com';

// Static, PUBLIC app-level JWT (iat 2023, no exp, empty scope) — identical for every user,
// only used on /oauth2/refresh. Not a user secret. Override via env if it ever rotates.
const X_APP_AUTHORIZATION = process.env.PICSART_APP_AUTH || "Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCIsImtpZCI6Ijk3MjFiZTM2LWIyNzAtNDlkNS05NzU2LTlkNTk3Yzg2YjA1MSJ9.eyJzdWIiOiJhdXRoLXNlcnZpY2Utd2ViIiwiYXVkIjoiYXV0aC1zZXJ2aWNlLXdlYiIsIm5iZiI6MTY4NzQyOTgyOCwic2NvcGUiOltdLCJpYXQiOjE2ODc0NDA2MjgsImlzcyI6Imh0dHBzOi8vcGEtYXV0aG9yaXphdGlvbi1zZXJ2ZXIuc3RhZ2UucGljc2FydC50b29scy9hcGkvb2F1dGgyIiwianRpIjoiYjRkYzU1MzAtYzEzOC00MzBmLWFiNjUtYTMyNDZlYmMwNWU3In0.UpUJB5QBuQKekvSWcBiA_lH0YdB6wKGXu2VscIK3hNYfzCDvvu-jKF7hnVgbX-REE1fAO3CY68eKBthJU1cC48UqLmQHQk8imPIUdPfARRXnH_6y2Qc7FgP3-Go2hLPwTxPXcTX0_AvAt6nviLPnvbfhKrqB6bCp6W4nmVWakrE-PLCJtZ-KuCa5-b6MIsRz_tqNeDXP-TLZhjjdfjIk0hrqr86WIQOH2MsrwLibSpJyKBhNDh314T7fsV4pHx3uQj_NhchsDBATf6vF0x74VjHO1Y6r5XSi6zgBEm-zfdqPOVitC-J-nnQNlOwAEmgFL_Ho49mkgWKjFKmXvm4bFw";
// A stable browser-style device id. Any value of this shape works; override via env.
const DEVICE_ID = process.env.PICSART_DEVICE_ID || "a.c.mq6gtspz.7f0f162c-5ab2-48f8-aecc-870332b3bb65";
const USER_AGENT = process.env.PICSART_UA ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const http = axios.create({ timeout: 120_000 });

// Picsart returns any 2xx (e.g. 200 OK or 201 Created) on success.
const ok2xx = (s: number) => s >= 200 && s < 300;

// Poll diagnostics: melacak status HTTP terakhir selama polling supaya
// PICSART_TIMEOUT membawa konteks (bukan cuma "timeout" tanpa penjelasan).
// Juga fail-fast kalau polling terus-menerus kena 401/403 (akun/token mati)
// daripada buang 15-30 menit lalu timeout tanpa alasan jelas.
class PollDiag {
  private lastStatus?: number;
  private lastBody?: string;
  private authFails = 0;
  private polls = 0;
  private readonly start = Date.now();

  /** Catat hasil satu poll; return true kalau respons 2xx (boleh diproses). */
  note(r: { status: number; data: unknown }): boolean {
    this.polls++;
    this.lastStatus = r.status;
    try {
      this.lastBody = JSON.stringify(r.data ?? '').slice(0, 200);
    } catch {
      this.lastBody = String(r.data).slice(0, 200);
    }
    if (r.status === 401 || r.status === 403) {
      this.authFails++;
      if (this.authFails >= 3) {
        throw new Error(
          `PICSART_AUTH_DEAD: poll kena ${r.status} ${this.authFails}x beruntun setelah ${this.elapsed()} — access token/akun Picsart kemungkinan mati`
        );
      }
    } else {
      this.authFails = 0;
    }
    return ok2xx(r.status);
  }

  private elapsed(): string {
    const s = Math.round((Date.now() - this.start) / 1000);
    return `${Math.floor(s / 60)}m${s % 60}s`;
  }

  /** Buat error PICSART_TIMEOUT yang membawa konteks poll terakhir. */
  timeoutError(): Error {
    return new Error(
      `PICSART_TIMEOUT (setelah ${this.elapsed()}, ${this.polls} polls, respons terakhir: ${this.lastStatus ?? 'tidak ada'} ${this.lastBody ?? ''})`
    );
  }
}

// Kling model_name mapping. v26 (kling-v2-6, mode pro) live-verified via HAR Jul 2026.
export const KLING_MODELS = {
  v26: { modelName: 'kling-v2-6', modelLabel: 'kling-motion-control' },
} as const;
export type KlingModelKey = keyof typeof KLING_MODELS;

let db: Pool;
let notifyOwner: (msg: string) => void = () => {};

// Transient Postgres connection drops (managed DBs recycle idle sockets, and a
// generation's poll loop hits the DB every 5s for up to ~15 min). These are NOT
// query/logic errors — retrying the exact same statement is safe because every
// query in this file is idempotent (SELECT / token UPDATE / ON CONFLICT upsert /
// DELETE-by-id). We deliberately DO NOT touch account-deletion logic here: a
// dropped connection must never look like a credit/auth failure.
const TRANSIENT_DB_ERR =
  /Connection terminated|stream has been aborted|connection is closed|ECONNRESET|ETIMEDOUT|EPIPE|terminating connection|server closed the connection|Client has encountered a connection error/i;

// Drop-in replacement for `db.query` with retry on transient connection loss.
// Typed as QueryResult so every call site keeps the same `.rows` typing it had
// with the raw `db.query`.
// How many times a transient connection drop is retried before giving up. A
// generation runs 5–8 min, so spending ~15s riding out a network blip (e.g. an
// upstream fiber/provider hiccup causing connect ETIMEDOUT) is far better UX
// than failing the whole generation. This does NOT ride out multi-minute
// outages — nothing reasonably can — but it survives the common seconds-long
// blips. It never risks accounts: a transient error is retried, never treated
// as a credit/auth failure.
const DB_MAX_RETRIES = 8;
async function q<R extends QueryResultRow = any>(text: string, params?: any[]): Promise<QueryResult<R>> {
  let lastErr: any;
  for (let attempt = 0; attempt < DB_MAX_RETRIES; attempt++) {
    try {
      return params === undefined ? await db.query<R>(text) : await db.query<R>(text, params);
    } catch (e: any) {
      lastErr = e;
      if (!TRANSIENT_DB_ERR.test(String(e?.message ?? ''))) throw e; // real error → surface immediately
      if (attempt === DB_MAX_RETRIES - 1) break; // last attempt failed → don't sleep, just throw
      const backoff = Math.min(500 * (attempt + 1), 3000); // 0.5s → 1s → … capped at 3s
      console.warn(`[picsart] DB connection blip (attempt ${attempt + 1}/${DB_MAX_RETRIES}), retry in ${backoff}ms: ${e?.message ?? e}`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr;
}

// Absolute safety ceiling on failover attempts, so a logic error can never spin
// forever. The real bound is the pool size (see runWithAccount): failover keeps
// moving to the next available account until every account has been tried.
const MAX_ACCOUNT_ATTEMPTS = 50;

export function initPicsart(pool: Pool, notify?: (msg: string) => void) {
  db = pool;
  if (notify) notifyOwner = notify;
}

export async function ensurePicsartSchema(): Promise<void> {
  await q(`
    CREATE TABLE IF NOT EXISTS picsart_credentials (
      id SERIAL PRIMARY KEY,
      refresh_token TEXT NOT NULL,
      access_token TEXT,
      access_expires_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'available',
      label TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      dead_at TIMESTAMPTZ
    )
  `);
  // Pool tag by seller/tier. Set only for NEW accounts at add-time from the
  // account's tierCredits ('p500' when tier is 500, else 'p100'). Existing
  // accounts stay NULL = uncategorized, and NULL is treated as a WILDCARD
  // usable by any pool request so nothing that already works breaks.
  await q(`ALTER TABLE picsart_credentials ADD COLUMN IF NOT EXISTS pool TEXT`);
  await q(`ALTER TABLE picsart_credentials ADD COLUMN IF NOT EXISTS tier_credits INTEGER`);

  // Sticky mapping: each user gets ONE dedicated account PER pool key so
  // concurrent users never share an account, and a user pinned to a p100
  // account for Runway can still get a separate account for another pool.
  await q(`
    CREATE TABLE IF NOT EXISTS picsart_user_accounts (
      user_id BIGINT,
      credential_id INTEGER NOT NULL REFERENCES picsart_credentials(id) ON DELETE CASCADE,
      assigned_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  // Migrate the sticky table to a composite (user_id, pool) key. Idempotent:
  // DROP ... IF EXISTS clears whatever pkey exists (single- or multi-column),
  // then we re-add the composite. Existing rows default to the 'any' pool key,
  // which is exactly the key used by pool-agnostic models (e.g. Kling).
  await q(`ALTER TABLE picsart_user_accounts ADD COLUMN IF NOT EXISTS pool TEXT NOT NULL DEFAULT 'any'`);
  // Migrate the PK to composite (user_id, pool) ONCE. The guard checks the live
  // primary-key columns and only performs the heavyweight DROP/ADD DDL when the
  // PK isn't already (user_id, pool). This avoids taking an exclusive table lock
  // and rebuilding the unique index on every process start, and avoids two
  // instances racing the DROP/ADD during concurrent boots.
  await q(`
    DO $$
    DECLARE cols text;
    BEGIN
      SELECT string_agg(a.attname, ',' ORDER BY array_position(i.indkey, a.attnum))
        INTO cols
        FROM pg_index i
        JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = 'picsart_user_accounts'::regclass AND i.indisprimary;
      IF cols IS DISTINCT FROM 'user_id,pool' THEN
        ALTER TABLE picsart_user_accounts DROP CONSTRAINT IF EXISTS picsart_user_accounts_pkey;
        ALTER TABLE picsart_user_accounts ADD PRIMARY KEY (user_id, pool);
      END IF;
    END $$;
  `);
}

function commonHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    accept: '*/*',
    deviceid: DEVICE_ID,
    platform: 'website',
    'x-touchpoint': 'com.picsart.ai-playground',
    origin: 'https://picsart.com',
    referer: 'https://picsart.com/',
    'user-agent': USER_AGENT,
    ...extra,
  };
}

interface CredRow {
  id: number;
  refresh_token: string;
  access_token: string | null;
  access_expires_at: string | null;
  status: string;
  label: string | null;
}

async function loadCredential(credId: number): Promise<CredRow | null> {
  const r = await q(
    `SELECT id, refresh_token, access_token, access_expires_at, status, label
       FROM picsart_credentials WHERE id = $1`,
    [credId]
  );
  return r.rows[0] ?? null;
}

// Which pool of accounts a model draws from. `null` = any pool (no restriction).
//  • 'p500'  → premium accounts (tierCredits === 500)
//  • 'p100'  → low-tier accounts (tierCredits !== 500)
// Uncategorized accounts (pool IS NULL, i.e. all pre-existing accounts) are a
// WILDCARD: they match every pool request, so routing never starves them.
export type PicsartPool = 'p500' | 'p100';

// Pick the account for a user (sticky 1-user-1-account, now PER pool key).
//  • If the user already has an assignment for this pool to an available,
//    pool-matching account → reuse it.
//  • Otherwise assign the available pool-matching account with the FEWEST users.
//  • `exclude` lets the failover loop skip accounts that just failed.
// Returns the credential id, or null when no usable account exists.
async function acquireAccount(
  userId: number,
  poolFilter: PicsartPool | null = null,
  exclude: number[] = []
): Promise<number | null> {
  const stickyKey = poolFilter ?? 'any';
  // Wildcard (pool IS NULL = legacy accounts) match every pool request so that
  // Seedance (p500) can still run even when no explicitly-tagged p500 account
  // exists yet. The pre-submit credit check in generateSeedance will skip any
  // wildcard account that doesn't have enough credits, so low-credit legacy
  // accounts are filtered at runtime, not at selection time.
  const existing = await q(
    `SELECT a.credential_id AS id
       FROM picsart_user_accounts a
       JOIN picsart_credentials c ON c.id = a.credential_id
      WHERE a.user_id = $1 AND a.pool = $2 AND c.status = 'available'
        AND NOT (a.credential_id = ANY($3::int[]))
        AND ($4::text IS NULL OR c.pool = $4 OR c.pool IS NULL)`,
    [userId, stickyKey, exclude, poolFilter]
  );
  if (existing.rows[0]) return existing.rows[0].id as number;

  const pick = await q(
    `SELECT c.id
       FROM picsart_credentials c
       LEFT JOIN picsart_user_accounts a ON a.credential_id = c.id
      WHERE c.status = 'available' AND NOT (c.id = ANY($1::int[]))
        AND ($2::text IS NULL OR c.pool = $2 OR c.pool IS NULL)
      GROUP BY c.id
      ORDER BY COUNT(a.user_id) ASC, c.updated_at ASC
      LIMIT 1`,
    [exclude, poolFilter]
  );
  const credId = pick.rows[0]?.id as number | undefined;
  if (credId == null) return null;

  await q(
    `INSERT INTO picsart_user_accounts (user_id, pool, credential_id, assigned_at)
       VALUES ($1, $2, $3, NOW())
     ON CONFLICT (user_id, pool)
       DO UPDATE SET credential_id = EXCLUDED.credential_id, assigned_at = NOW()`,
    [userId, stickyKey, credId]
  );
  return credId;
}

// Account is out of credits — discard it entirely (per owner's request: a
// credit-exhausted account is thrown away, not kept around). The ON DELETE
// CASCADE on picsart_user_accounts unpins any users, so they get reassigned to
// another account on their next request.
async function discardAccount(credId: number): Promise<void> {
  const cred = await loadCredential(credId);
  await q(`DELETE FROM picsart_credentials WHERE id = $1`, [credId]);
  const who = cred?.label ? `"${cred.label}" (#${credId})` : `#${credId}`;
  notifyOwner(
    `🗑️ Akun Picsart ${who} kehabisan kredit dan sudah dibuang dari pool.\n` +
    `Tambahkan akun baru bila perlu:\n/addpicsartkey rt:...`
  );
}

function isCreditError(msg: string): boolean {
  return /\b402\b|insufficient|not[_\s-]?enough|credit|quota|payment|balance|limit.?exceeded/i.test(msg);
}

// Minimum credits below which an account is truly considered exhausted and can
// be discarded. Above this level the account still has value for cheaper models
// so we skip it for the current (expensive) request without deleting it.
const MIN_USABLE_CREDITS = 25;

// Called when a submit returns a credit error. Checks how many credits actually
// remain on the account and decides whether to discard it (truly empty) or just
// skip it for this attempt so it can still serve cheaper models later.
async function handleCreditError(credId: number): Promise<'discard' | 'skip'> {
  try {
    const { credits } = await getCredits(credId);
    if (credits <= MIN_USABLE_CREDITS) {
      await discardAccount(credId);
      return 'discard';
    }
    // Account still has usable credits — just not enough for THIS model.
    // Leave it alive; it will serve cheaper models or other users.
    console.log(`[picsart] Credit error on #${credId} but still has ${credits} credits — skipping without discard`);
    return 'skip';
  } catch {
    // Cannot verify credits (network error, transient auth issue, etc.) —
    // skip for this attempt rather than discarding. We never throw away an
    // account unless we have confirmed evidence it is truly empty.
    console.log(`[picsart] Could not verify credits on #${credId} after credit error — skipping without discard`);
    return 'skip';
  }
}

// Run a generation for `userId` on its assigned account. If that account is
// dead (token rejected) or out of credits, transparently move the user to
// another available account and retry — so a single exhausted account never
// fails the user while others still have credits.
async function runWithAccount<T>(
  userId: number,
  poolFilter: PicsartPool | null,
  fn: (credId: number) => Promise<T>
): Promise<T> {
  const tried: number[] = [];
  let lastErr: unknown = null;
  // Try every account in the pool before giving up (acquireAccount returns null
  // once all available accounts are excluded). MAX_ACCOUNT_ATTEMPTS is only a
  // hard safety ceiling against an unexpected infinite loop.
  const poolCount = await q(`SELECT COUNT(*)::int AS n FROM picsart_credentials`);
  const ceiling = Math.min(MAX_ACCOUNT_ATTEMPTS, Math.max(1, poolCount.rows[0]?.n ?? 1));
  for (let attempt = 0; attempt < ceiling; attempt++) {
    const credId = await acquireAccount(userId, poolFilter, tried);
    if (credId == null) break;
    tried.push(credId);
    try {
      return await fn(credId);
    } catch (e: any) {
      lastErr = e;
      const msg = String(e?.message ?? '');
      if (msg.includes('PICSART_REFRESH_DEAD')) {
        // Account already marked 'dead' inside doRefresh — move to next account.
        continue;
      }
      if (msg.includes('PICSART_AUTH_DEAD')) {
        // Polling kena 401/403 beruntun: access token akun ini ditolak API.
        // Tandai dead lalu failover ke akun lain (paritas dengan REFRESH_DEAD),
        // supaya satu akun mati tidak langsung menggagalkan user.
        await q(
          `UPDATE picsart_credentials SET status = 'dead', dead_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [credId]
        );
        notifyOwner(
          `⚠️ Akun Picsart #${credId} DITOLAK saat polling (${msg.slice(0, 150)}). ` +
          `Sudah ditandai dead; user dialihkan ke akun lain.\nTambahkan token baru bila perlu:\n/addpicsartkey rt:...`
        );
        continue;
      }
      if (msg === ERR_INSUFFICIENT_CREDITS || msg.includes(ERR_INSUFFICIENT_CREDITS)) {
        // Pre-submit credit check failed — account alive but not enough credits
        // for this model. Skip to the next account, never discard.
        continue;
      }
      if (msg.includes('PICSART_SUBMIT_FAILED') && isCreditError(msg)) {
        // Submit returned a credit error. Verify actual remaining credits before
        // deciding whether to discard — don't throw away a partially-used account.
        await handleCreditError(credId);
        continue;
      }
      // Any other error (bad input, timeout, transient network) is not an
      // account problem — surface it instead of burning through the pool.
      throw e;
    }
  }
  throw lastErr ?? new Error('PICSART_NO_CREDENTIAL');
}

// Admin: register a refresh token (rt:...) as a NEW account in the pool.
// Unlike before, this does NOT replace existing accounts — all stay active so
// the bot can spread users across them. Returns the new credential id, or null
// when the token is malformed.
export async function addRefreshToken(rt: string, label?: string): Promise<number | null> {
  let token = rt.trim();
  // Cookie values copied from the browser are URL-encoded, so the leading
  // colon arrives as `rt%3A...`. Decode so `rt:` validation passes.
  if (/%[0-9a-f]{2}/i.test(token)) {
    try { token = decodeURIComponent(token); } catch { /* keep raw */ }
  }
  if (!token.startsWith('rt:')) return null;
  // NOTE: this INSERT is the one non-idempotent write in this file (no unique
  // guard on refresh_token). It deliberately bypasses the q() retry wrapper: if
  // a connection drops *after* the row commits but *before* we get the result,
  // an automatic retry would create a DUPLICATE account row. This is an
  // admin-only command, so on a rare transient failure the owner simply re-runs
  // /addpicsartkey rather than risking a silent duplicate.
  // Provisional pool 'p100' (the conservative low tier). categorizeAccount()
  // upgrades it to 'p500' right after when the account's tier is 500. Seeding a
  // concrete pool here (instead of NULL) means a NEW account whose categorization
  // fails stays scoped to p100 rather than becoming an all-pools wildcard — the
  // wildcard exception is reserved for pre-existing legacy accounts only.
  const r = await db.query(
    `INSERT INTO picsart_credentials (refresh_token, label, status, pool) VALUES ($1, $2, 'available', 'p100') RETURNING id`,
    [token, label ?? null]
  );
  return r.rows[0].id as number;
}

export async function getStatus(): Promise<{
  counts: Record<string, number>;
  pools: Record<string, number>;
  available: number;
  totalUsers: number;
}> {
  const r = await q(`SELECT status, COUNT(*)::int AS cnt FROM picsart_credentials GROUP BY status`);
  const counts: Record<string, number> = {};
  for (const row of r.rows) counts[row.status] = row.cnt;
  const u = await q(`SELECT COUNT(*)::int AS cnt FROM picsart_user_accounts`);
  // Pool breakdown of the available accounts (NULL = uncategorized/wildcard).
  const p = await q(
    `SELECT COALESCE(pool, 'uncategorized') AS pool, COUNT(*)::int AS cnt
       FROM picsart_credentials WHERE status = 'available' GROUP BY COALESCE(pool, 'uncategorized')`
  );
  const pools: Record<string, number> = {};
  for (const row of p.rows) pools[row.pool] = row.cnt;
  return { counts, pools, available: counts['available'] ?? 0, totalUsers: u.rows[0]?.cnt ?? 0 };
}

// Admin: full view of the account pool, with how many users are pinned to each.
export async function getPool(): Promise<Array<{
  id: number;
  label: string | null;
  status: string;
  pool: string | null;
  tierCredits: number | null;
  users: number;
  accessValidUntil: string | null;
  createdAt: string;
}>> {
  const r = await q(
    `SELECT c.id, c.label, c.status, c.pool, c.tier_credits, c.access_expires_at, c.created_at,
            COUNT(a.user_id)::int AS users
       FROM picsart_credentials c
       LEFT JOIN picsart_user_accounts a ON a.credential_id = c.id
      GROUP BY c.id
      ORDER BY c.id ASC`
  );
  return r.rows.map((row) => ({
    id: row.id,
    label: row.label,
    status: row.status,
    pool: row.pool,
    tierCredits: row.tier_credits,
    users: row.users,
    accessValidUntil: row.access_expires_at,
    createdAt: row.created_at,
  }));
}

function extractRotatedRefreshToken(setCookie: unknown): string | null {
  if (!Array.isArray(setCookie)) return null;
  for (const c of setCookie) {
    if (typeof c !== 'string') continue;
    const m = c.match(/^REFRESH_TOKEN=([^;]+)/i);
    if (m) {
      const val = decodeURIComponent(m[1]);
      if (val.startsWith('rt:')) return val;
    }
  }
  return null;
}

// One in-flight refresh promise PER account, so concurrent calls on the same
// account dedupe but different accounts refresh independently.
const refreshInFlight = new Map<number, Promise<string>>();

async function doRefresh(credId: number, force = false): Promise<string> {
  const cred = await loadCredential(credId);
  if (!cred) throw new Error('PICSART_NO_CREDENTIAL');

  // Re-use cached access token while it has >2 min of life left.
  // `force` (used by the keepalive) skips the cache to actually roll the
  // refresh-token's 30-day window forward.
  if (!force && cred.access_token && cred.access_expires_at) {
    const msLeft = new Date(cred.access_expires_at).getTime() - Date.now();
    if (msLeft > 120_000) return cred.access_token;
  }

  const resp = await http.post(
    `${API_BASE}/oauth2/refresh`,
    { refresh_token: cred.refresh_token },
    {
      headers: commonHeaders({ 'content-type': 'application/json', 'x-app-authorization': X_APP_AUTHORIZATION }),
      validateStatus: () => true,
    }
  );

  const access = resp.data?.response?.access_token;
  if (!ok2xx(resp.status) || !access) {
    const detail = `status ${resp.status}: ${JSON.stringify(resp.data).slice(0, 200)}`;
    if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
      await q(
        `UPDATE picsart_credentials SET status = 'dead', dead_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [cred.id]
      );
      const who = cred.label ? `"${cred.label}" (#${cred.id})` : `#${cred.id}`;
      notifyOwner(
        `⚠️ Akun Picsart ${who} DITOLAK (${detail}). Tambahkan token baru:\n/addpicsartkey rt:...`
      );
      throw new Error(`PICSART_REFRESH_DEAD ${detail}`);
    }
    throw new Error(`PICSART_REFRESH_FAILED ${detail}`);
  }

  const expiresIn = resp.data?.response?.expires_in ?? 1799;
  const accessExpiresAt = new Date(Date.now() + expiresIn * 1000);
  const rotated = extractRotatedRefreshToken(resp.headers?.['set-cookie']);

  await q(
    `UPDATE picsart_credentials
        SET access_token = $1, access_expires_at = $2,
            refresh_token = COALESCE($3, refresh_token), updated_at = NOW()
      WHERE id = $4`,
    [access, accessExpiresAt, rotated, cred.id]
  );

  return access;
}

export async function getAccessToken(credId: number): Promise<string> {
  const existing = refreshInFlight.get(credId);
  if (existing) return existing;
  const p = doRefresh(credId, false).finally(() => { refreshInFlight.delete(credId); });
  refreshInFlight.set(credId, p);
  return p;
}

// Keepalive: periodically force a refresh on EVERY available account so each
// refresh-token's ~30-day window keeps rolling forward even when nobody
// generates. Credit-exhausted accounts are discarded on use, so there is
// nothing to self-heal here.
export function startPicsartKeepalive(intervalMs = 3 * 24 * 60 * 60 * 1000): NodeJS.Timeout {
  const tick = async () => {
    let rows: Array<{ id: number; status: string }> = [];
    try {
      const r = await q(
        `SELECT id, status FROM picsart_credentials WHERE status = 'available'`
      );
      rows = r.rows;
    } catch (e: any) {
      console.warn('[picsart] keepalive query failed:', e?.message ?? e);
      return;
    }
    for (const row of rows) {
      try {
        const inflight = refreshInFlight.get(row.id);
        if (inflight) {
          await inflight;
        } else {
          const p = doRefresh(row.id, true).finally(() => { refreshInFlight.delete(row.id); });
          refreshInFlight.set(row.id, p);
          await p;
        }
        console.log(`[picsart] keepalive refresh ok for #${row.id}`);
      } catch (e: any) {
        // PICSART_REFRESH_DEAD (owner already notified) — just skip this account.
        console.warn(`[picsart] keepalive skip #${row.id}:`, e?.message ?? e);
      }
    }
  };
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

export async function getCredits(
  credId: number
): Promise<{ credits: number; tierCredits?: number; renewDate?: string }> {
  const access = await getAccessToken(credId);
  const r = await http.get(`${API_BASE}/guard/credits`, {
    headers: commonHeaders({ authorization: `Bearer ${access}` }),
    validateStatus: () => true,
  });
  if (!ok2xx(r.status)) throw new Error(`PICSART_CREDITS_FAILED status ${r.status}`);
  return {
    credits: r.data?.response?.credits ?? r.data?.credits,
    tierCredits: r.data?.response?.tierCredits,
    renewDate: r.data?.response?.renewDate,
  };
}

// Credit threshold that separates the two pools. The two sellers deliver very
// different amounts (~500 vs 5-100), so anything at/above this cutoff is the
// premium 500 pool and anything below is the low 5-100 pool. An account that
// arrives with only ~50 credits therefore lands in p100 as expected.
export const POOL_500_MIN_CREDITS = 200;

// Derive a pool tag from the account's CURRENT credit balance at add-time:
// credits >= POOL_500_MIN_CREDITS → 'p500', else → 'p100'. This is captured
// ONCE when the account is added and does not move afterward as credits deplete.
export function poolFromCredits(credits: number | undefined | null): PicsartPool {
  return (credits ?? 0) >= POOL_500_MIN_CREDITS ? 'p500' : 'p100';
}

// Admin add-time: fetch credits, derive the pool from the credit balance AT ADD,
// persist the pool tag (and tier for reference). Returns what was captured so
// the add command can report it. Called only for NEW accounts.
export async function categorizeAccount(
  credId: number
): Promise<{ credits: number; tierCredits?: number; pool: PicsartPool; renewDate?: string }> {
  const c = await getCredits(credId);
  const pool = poolFromCredits(c.credits);
  await q(
    `UPDATE picsart_credentials SET pool = $1, tier_credits = $2, updated_at = NOW() WHERE id = $3`,
    [pool, c.tierCredits ?? null, credId]
  );
  return { credits: c.credits, tierCredits: c.tierCredits, pool, renewDate: c.renewDate };
}

export async function uploadFile(credId: number, buf: Buffer, filename: string, contentType: string): Promise<string> {
  const access = await getAccessToken(credId);
  const fd = new FormData();
  fd.append('file', buf, { filename, contentType });
  fd.append('type', 'editing-temp');
  const r = await http.post(`${UPLOAD_BASE}/v2/files`, fd, {
    headers: commonHeaders({ ...fd.getHeaders(), authorization: `Bearer ${access}` }),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
    validateStatus: () => true,
  });
  const url = r.data?.response?.url;
  if (!ok2xx(r.status) || !url) {
    throw new Error(`PICSART_UPLOAD_FAILED status ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  }
  return url;
}

export async function submitKlingMotionControl(credId: number, input: {
  prompt: string;
  imageUrl: string;
  videoUrl: string;
  model: KlingModelKey;
  outputName?: string;
}): Promise<string> {
  const access = await getAccessToken(credId);
  const { modelName, modelLabel } = KLING_MODELS[input.model];
  const params = {
    prompt: input.prompt ?? '',
    image_url: input.imageUrl,
    video_url: input.videoUrl,
    character_orientation: 'video',
    mode: 'pro',
    keep_original_sound: 'yes',
    model_name: modelName,
    options: {
      drive: {
        name: input.outputName || 'animation.mp4',
        attributes: {
          model: modelLabel,
          aiSDKPayload: JSON.stringify({
            prompt: input.prompt ?? '',
            resolution: '1080p',
            renderingSpeed: 'pro',
            characterOrientation: 'video',
            keepOriginalSound: 'yes',
            imageUrls: [input.imageUrl],
            videoUrl: input.videoUrl,
          }),
          appId: 'com.picsart.ai-playground',
          appType: 'miniapp',
        },
        folder: { path: 'AI Playground' },
      },
    },
  };
  const r = await http.post(`${API_BASE}/workflows/kling-motion-control/submit`, { params }, {
    headers: commonHeaders({ 'content-type': 'application/json', authorization: `Bearer ${access}` }),
    validateStatus: () => true,
  });
  const id = r.data?.response?.id;
  if (!ok2xx(r.status) || !id) {
    throw new Error(`PICSART_SUBMIT_FAILED status ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
  }
  return id;
}

export async function pollKlingResult(
  credId: number,
  id: string,
  opts?: { maxAttempts?: number; intervalMs?: number }
): Promise<{ url: string; duration?: string; credits?: number }> {
  const maxAttempts = opts?.maxAttempts ?? 180; // ~15 min at 5s
  const intervalMs = opts?.intervalMs ?? 5000;
  const diag = new PollDiag();
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((res) => setTimeout(res, intervalMs));
    const access = await getAccessToken(credId);
    const r = await http.get(`${API_BASE}/workflows/kling-motion-control/${id}/result`, {
      headers: commonHeaders({ authorization: `Bearer ${access}` }),
      validateStatus: () => true,
    });
    if (!diag.note(r)) continue;
    const resp = r.data?.response;
    const status = String(resp?.status ?? '').toUpperCase();
    if (status === 'COMPLETED') {
      const url = resp?.result?.url;
      if (!url) throw new Error('PICSART_NO_RESULT_URL');
      return { url, duration: resp.result?.duration, credits: resp.usage?.credits };
    }
    if (status === 'FAILED' || status === 'ERROR' || status === 'CANCELLED') {
      throw new Error(`PICSART_GEN_FAILED: ${JSON.stringify(resp).slice(0, 200)}`);
    }
  }
  throw diag.timeoutError();
}

// High-level orchestrator: upload media -> submit -> poll -> return result URL.
// `userId` selects the user's dedicated account (with automatic failover to
// another account if this one is dead or out of credits).
export async function generateKlingMotionControl(input: {
  userId: number;
  imageBuffer: Buffer;
  imageName: string;
  imageMime: string;
  videoBuffer: Buffer;
  videoName: string;
  videoMime: string;
  prompt: string;
  model: KlingModelKey;
  pool?: PicsartPool | null;
  onStatus?: (stage: 'upload' | 'submit' | 'poll') => void;
}): Promise<{ url: string; credits?: number; duration?: string; usedModel: KlingModelKey }> {
  return runWithAccount(input.userId, input.pool ?? null, async (credId) => {
    input.onStatus?.('upload');
    const imageUrl = await uploadFile(credId, input.imageBuffer, input.imageName, input.imageMime);
    const videoUrl = await uploadFile(credId, input.videoBuffer, input.videoName, input.videoMime);
    input.onStatus?.('submit');

    const id = await submitKlingMotionControl(credId, {
      prompt: input.prompt, imageUrl, videoUrl, model: input.model, outputName: input.videoName,
    });

    input.onStatus?.('poll');
    const res = await pollKlingResult(credId, id);
    return { ...res, usedModel: input.model };
  });
}

// ─── Generic workflow poll (result at response.result.url) ───────────────────
// Dipakai Runway Gen-4.5, yang mengembalikan
// {response:{status, result:{url}, usage:{credits}}}.

async function pollWorkflowUrl(
  credId: number,
  resultPath: (id: string) => string,
  id: string,
  opts?: { maxAttempts?: number; intervalMs?: number; onTick?: (elapsedMs: number) => void }
): Promise<{ url: string; credits?: number }> {
  const maxAttempts = opts?.maxAttempts ?? 180; // ~15 min at 5s
  const intervalMs = opts?.intervalMs ?? 5000;
  const start = Date.now();
  const diag = new PollDiag();
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((res) => setTimeout(res, intervalMs));
    opts?.onTick?.(Date.now() - start);
    const access = await getAccessToken(credId);
    const r = await http.get(`${API_BASE}${resultPath(id)}`, {
      headers: commonHeaders({ authorization: `Bearer ${access}` }),
      validateStatus: () => true,
    });
    if (!diag.note(r)) continue;
    const resp = r.data?.response;
    const status = String(resp?.status ?? '').toUpperCase();
    if (status === 'COMPLETED') {
      const url = resp?.result?.url;
      if (!url) throw new Error('PICSART_NO_RESULT_URL');
      return { url, credits: resp.usage?.credits };
    }
    if (status === 'FAILED' || status === 'ERROR' || status === 'CANCELLED') {
      throw new Error(`PICSART_GEN_FAILED: ${JSON.stringify(resp).slice(0, 200)}`);
    }
  }
  throw diag.timeoutError();
}

// ─── Runway Gen-4.5 (image-to-video) ──────────────────────────────────────────
// POST /workflows/runway-gen4-5-image-to-video/submit
//   {params:{promptText, promptImage:[{uri,position:"first"}], ratio:"720:1280", duration}}
// ratio dalam format piksel: 9:16→"720:1280", 16:9→"1280:720", 1:1→"960:960".
// Result: GET /workflows/runway-gen4-5-image-to-video/{id}/result → response.result.url

export async function submitRunway(credId: number, input: {
  prompt: string;
  imageUrl: string;
  duration: number;
  ratio: string; // format piksel, mis. "720:1280"
}): Promise<string> {
  const access = await getAccessToken(credId);
  const params = {
    promptText: input.prompt ?? '',
    promptImage: [{ uri: input.imageUrl, position: 'first' }],
    ratio: input.ratio,
    duration: input.duration,
  };
  const r = await http.post(`${API_BASE}/workflows/runway-gen4-5-image-to-video/submit`, { params }, {
    headers: commonHeaders({ 'content-type': 'application/json', authorization: `Bearer ${access}` }),
    validateStatus: () => true,
  });
  const id = r.data?.response?.id;
  if (!ok2xx(r.status) || !id) {
    throw new Error(`PICSART_SUBMIT_FAILED status ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
  }
  return id;
}

export async function generateRunway(input: {
  userId: number;
  prompt: string;
  imageBuffer: Buffer;
  imageName?: string;
  imageMime?: string;
  duration: number;
  ratio: string;
  onStatus?: (stage: 'upload' | 'submit' | 'poll') => void;
  onPoll?: (elapsedSec: number) => void;
}): Promise<{ url: string; credits?: number }> {
  // Runway: pool 5-100.
  return runWithAccount(input.userId, 'p100', async (credId) => {
    input.onStatus?.('upload');
    const imageUrl = await uploadFile(
      credId,
      input.imageBuffer,
      input.imageName || 'reference.jpg',
      input.imageMime || 'image/jpeg'
    );
    input.onStatus?.('submit');
    const id = await submitRunway(credId, {
      prompt: input.prompt,
      imageUrl,
      duration: input.duration,
      ratio: input.ratio,
    });
    input.onStatus?.('poll');
    return pollWorkflowUrl(credId, (jid) => `/workflows/runway-gen4-5-image-to-video/${jid}/result`, id, {
      onTick: (ms) => input.onPoll?.(Math.round(ms / 1000)),
    });
  });
}


// ─── Sora 2 (OpenAI video: text-to-video or image-to-video) ───────────────────
// POST /workflows/openai/v1/videos/submit          -> {response:{id}}
// poll GET /workflows/openai/v1/videos/{id}/result -> COMPLETED, result.videoUrl
export const SORA_MODEL = 'sora-2';

export async function submitSora(credId: number, input: {
  prompt: string;
  imageUrl?: string;
  seconds: number;
  size: string;
}): Promise<string> {
  const access = await getAccessToken(credId);
  const params: Record<string, unknown> = {
    model: SORA_MODEL,
    prompt: input.prompt ?? '',
    seconds: input.seconds,
    size: input.size,
  };
  if (input.imageUrl) {
    params.input_reference_url = input.imageUrl;
    params.adjust_input_image_ratio = true;
  }
  const r = await http.post(`${API_BASE}/workflows/openai/v1/videos/submit`, { params }, {
    headers: commonHeaders({ 'content-type': 'application/json', authorization: `Bearer ${access}` }),
    validateStatus: () => true,
  });
  const id = r.data?.response?.id;
  if (!ok2xx(r.status) || !id) {
    throw new Error(`PICSART_SUBMIT_FAILED status ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
  }
  return id;
}

export async function pollSoraResult(
  credId: number,
  id: string,
  opts?: { maxAttempts?: number; intervalMs?: number; onTick?: (elapsedMs: number) => void }
): Promise<{ url: string; credits?: number }> {
  const maxAttempts = opts?.maxAttempts ?? 180; // ~15 min at 5s
  const intervalMs = opts?.intervalMs ?? 5000;
  const start = Date.now();
  const diag = new PollDiag();
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((res) => setTimeout(res, intervalMs));
    opts?.onTick?.(Date.now() - start);
    const access = await getAccessToken(credId);
    const r = await http.get(`${API_BASE}/workflows/openai/v1/videos/${id}/result`, {
      headers: commonHeaders({ authorization: `Bearer ${access}` }),
      validateStatus: () => true,
    });
    if (!diag.note(r)) continue;
    const resp = r.data?.response;
    const status = String(resp?.status ?? '').toUpperCase();
    if (status === 'COMPLETED') {
      const url = resp?.result?.videoUrl;
      if (!url) throw new Error('PICSART_NO_RESULT_URL');
      return { url, credits: resp.usage?.credits };
    }
    if (status === 'FAILED' || status === 'ERROR' || status === 'CANCELLED') {
      throw new Error(`PICSART_GEN_FAILED: ${JSON.stringify(resp).slice(0, 200)}`);
    }
  }
  throw diag.timeoutError();
}

// High-level orchestrator: optional image upload -> submit -> poll -> result URL.
export async function generateSora(input: {
  userId: number;
  prompt: string;
  imageBuffer?: Buffer;
  imageName?: string;
  imageMime?: string;
  seconds: number;
  size: string;
  onStatus?: (stage: 'upload' | 'submit' | 'poll') => void;
  onPoll?: (elapsedSec: number) => void;
}): Promise<{ url: string; credits?: number }> {
  // Sora: pool 5-100.
  return runWithAccount(input.userId, 'p100', async (credId) => {
    let imageUrl: string | undefined;
    if (input.imageBuffer) {
      input.onStatus?.('upload');
      imageUrl = await uploadFile(
        credId,
        input.imageBuffer,
        input.imageName || 'reference.jpg',
        input.imageMime || 'image/jpeg'
      );
    }
    input.onStatus?.('submit');
    const id = await submitSora(credId, {
      prompt: input.prompt,
      imageUrl,
      seconds: input.seconds,
      size: input.size,
    });
    input.onStatus?.('poll');
    return pollSoraResult(credId, id, {
      onTick: (ms) => input.onPoll?.(Math.round(ms / 1000)),
    });
  });
}

// ─── Gemini Omni (Google video: text-to-video or image-to-video) ──────────────
// POST /workflows/gemini-omni/video/submit          -> {response:{id}}
// poll GET /workflows/gemini-omni/video/{id}/result -> COMPLETED, result[0].url
export const GEMINI_OMNI_MODEL = 'gemini-omni-flash-preview';

export async function submitGeminiOmni(credId: number, input: {
  prompt: string;
  imageUrl?: string;
  imageMime?: string;
  videoUrl?: string;
  durationSeconds: number;
  aspectRatio: string;
}): Promise<string> {
  const access = await getAccessToken(credId);
  const params: Record<string, unknown> = {
    prompt: input.prompt ?? '',
    model: GEMINI_OMNI_MODEL,
    aspectRatio: input.aspectRatio,
    durationSeconds: input.durationSeconds,
  };
  if (input.imageUrl) {
    params.image = { url: input.imageUrl, mimeType: input.imageMime || 'image/jpeg' };
  }
  if (input.videoUrl) {
    params.video = { url: input.videoUrl };
  }
  const r = await http.post(`${API_BASE}/workflows/gemini-omni/video/submit`, { params }, {
    headers: commonHeaders({ 'content-type': 'application/json', authorization: `Bearer ${access}` }),
    validateStatus: () => true,
  });
  const id = r.data?.response?.id;
  if (!ok2xx(r.status) || !id) {
    throw new Error(`PICSART_SUBMIT_FAILED status ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
  }
  return id;
}

export async function pollGeminiOmniResult(
  credId: number,
  id: string,
  opts?: { maxAttempts?: number; intervalMs?: number; onTick?: (elapsedMs: number) => void }
): Promise<{ url: string; credits?: number }> {
  const maxAttempts = opts?.maxAttempts ?? 180; // ~15 min at 5s
  const intervalMs = opts?.intervalMs ?? 5000;
  const start = Date.now();
  const diag = new PollDiag();
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((res) => setTimeout(res, intervalMs));
    opts?.onTick?.(Date.now() - start);
    const access = await getAccessToken(credId);
    const r = await http.get(`${API_BASE}/workflows/gemini-omni/video/${id}/result`, {
      headers: commonHeaders({ authorization: `Bearer ${access}` }),
      validateStatus: () => true,
    });
    if (!diag.note(r)) continue;
    const resp = r.data?.response;
    const status = String(resp?.status ?? '').toUpperCase();
    if (status === 'COMPLETED') {
      const url = Array.isArray(resp?.result) ? resp.result[0]?.url : resp?.result?.url;
      if (!url) throw new Error('PICSART_NO_RESULT_URL');
      return { url, credits: resp.usage?.credits };
    }
    if (status === 'FAILED' || status === 'ERROR' || status === 'CANCELLED') {
      throw new Error(`PICSART_GEN_FAILED: ${JSON.stringify(resp).slice(0, 200)}`);
    }
  }
  throw diag.timeoutError();
}

// High-level orchestrator: optional image upload -> submit -> poll -> result URL.
export async function generateGeminiOmni(input: {
  userId: number;
  prompt: string;
  imageBuffer?: Buffer;
  imageName?: string;
  imageMime?: string;
  videoBuffer?: Buffer;
  videoName?: string;
  videoMime?: string;
  durationSeconds: number;
  aspectRatio: string;
  onStatus?: (stage: 'upload' | 'submit' | 'poll') => void;
  onPoll?: (elapsedSec: number) => void;
}): Promise<{ url: string; credits?: number }> {
  // Gemini Omni: pool 5-100.
  return runWithAccount(input.userId, 'p100', async (credId) => {
    let imageUrl: string | undefined;
    let imageMime: string | undefined;
    if (input.imageBuffer) {
      input.onStatus?.('upload');
      imageUrl = await uploadFile(
        credId,
        input.imageBuffer,
        input.imageName || 'reference.jpg',
        input.imageMime || 'image/jpeg'
      );
      imageMime = input.imageMime || 'image/jpeg';
    }
    let videoUrl: string | undefined;
    if (input.videoBuffer) {
      input.onStatus?.('upload');
      videoUrl = await uploadFile(
        credId,
        input.videoBuffer,
        input.videoName || 'reference.mp4',
        input.videoMime || 'video/mp4'
      );
    }
    input.onStatus?.('submit');
    const id = await submitGeminiOmni(credId, {
      prompt: input.prompt,
      imageUrl,
      imageMime,
      videoUrl,
      durationSeconds: input.durationSeconds,
      aspectRatio: input.aspectRatio,
    });
    input.onStatus?.('poll');
    return pollGeminiOmniResult(credId, id, {
      onTick: (ms) => input.onPoll?.(Math.round(ms / 1000)),
    });
  });
}


// ─── Seedance 2.5 (ByteDance video: text + up to 5 reference images) ───────────
// POST /workflows/seedance/submit          -> {response:{id}}
// poll GET /workflows/seedance/{id}/result -> COMPLETED, result.video_url
// params: {model:"seedance_2_5", content:[{type:"image_url",image_url:{url},role:"reference_image"}..., {type:"text",text}],
//          ratio:"9:16"|"16:9"|..., duration:15|30, resolution:"480p", generate_audio, output_format:"mp4"}
export const SEEDANCE_MODEL = 'seedance_2_5';
export const SEEDANCE_MAX_REF_IMAGES = 5;
// Minimum credits an account must have before we even attempt a Seedance submit.
// Based on observed consumption: ~120 credits for 30s, ~60 for 15s. We add a
// small buffer so the account still has credits left for other models afterward.
export const SEEDANCE_MIN_CREDITS: Record<number, number> = { 15: 70, 30: 130 };
// Sentinel error thrown when a pre-submit credit check shows insufficient credits.
// runWithAccount catches this and skips to the next account WITHOUT discarding.
export const ERR_INSUFFICIENT_CREDITS = 'PICSART_INSUFFICIENT_CREDITS';

export async function submitSeedance(credId: number, input: {
  prompt: string;
  imageUrls: string[];
  duration: number; // 15 | 30
  ratio: string; // label mis. "9:16", "16:9"
  resolution?: string; // default "480p"
  generateAudio?: boolean;
  outputName?: string;
}): Promise<string> {
  const access = await getAccessToken(credId);
  const resolution = input.resolution || '480p';
  const generateAudio = input.generateAudio ?? true;
  const content: Array<Record<string, unknown>> = [
    ...input.imageUrls.map((url) => ({
      type: 'image_url',
      image_url: { url },
      role: 'reference_image',
    })),
    { type: 'text', text: input.prompt ?? '' },
  ];
  const params = {
    model: SEEDANCE_MODEL,
    content,
    ratio: input.ratio,
    duration: input.duration,
    resolution,
    generate_audio: generateAudio,
    output_format: 'mp4',
    options: {
      drive: {
        name: input.outputName || 'seedance.mp4',
        attributes: {
          model: 'seedance-2.5',
          aiSDKPayload: JSON.stringify({
            prompt: input.prompt ?? '',
            aspectRatio: input.ratio,
            resolution,
            duration: input.duration,
            generateAudio,
            returnLastFrame: false,
            outputFormat: 'mp4',
            imageUrls: input.imageUrls,
          }),
          appId: 'com.picsart.ai-playground',
          appType: 'miniapp',
        },
        folder: { path: 'AI Playground' },
      },
    },
  };
  const r = await http.post(`${API_BASE}/workflows/seedance/submit`, { params }, {
    headers: commonHeaders({ 'content-type': 'application/json', authorization: `Bearer ${access}` }),
    validateStatus: () => true,
  });
  const id = r.data?.response?.id;
  if (!ok2xx(r.status) || !id) {
    throw new Error(`PICSART_SUBMIT_FAILED status ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
  }
  return id;
}

export async function pollSeedanceResult(
  credId: number,
  id: string,
  opts?: { maxAttempts?: number; intervalMs?: number; onTick?: (elapsedMs: number) => void }
): Promise<{ url: string; credits?: number }> {
  const maxAttempts = opts?.maxAttempts ?? 300; // ~25 min at 5s (seedance can run long)
  const intervalMs = opts?.intervalMs ?? 5000;
  const start = Date.now();
  const diag = new PollDiag();
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((res) => setTimeout(res, intervalMs));
    opts?.onTick?.(Date.now() - start);
    const access = await getAccessToken(credId);
    const r = await http.get(`${API_BASE}/workflows/seedance/${id}/result`, {
      headers: commonHeaders({ authorization: `Bearer ${access}` }),
      validateStatus: () => true,
    });
    const ok = diag.note(r);
    // 4xx dengan body error (misal 422 policy violation) — fail-fast, jangan tunggu timeout.
    if (!ok) {
      const topStatus = String((r.data as any)?.status ?? '').toLowerCase();
      const reason    = String((r.data as any)?.reason ?? '');
      const msg       = String((r.data as any)?.message ?? '');
      if (r.status >= 400 && (topStatus === 'error' || reason || msg)) {
        throw new Error(`PICSART_GEN_FAILED: ${r.status} ${reason || topStatus} — ${msg}`.slice(0, 300));
      }
      continue;
    }
    const resp = r.data?.response;
    const status = String(resp?.status ?? '').toUpperCase();
    if (status === 'COMPLETED') {
      const url = resp?.result?.video_url;
      if (!url) throw new Error('PICSART_NO_RESULT_URL');
      return { url, credits: resp.usage?.credits };
    }
    if (status === 'FAILED' || status === 'ERROR' || status === 'CANCELLED') {
      throw new Error(`PICSART_GEN_FAILED: ${JSON.stringify(resp).slice(0, 200)}`);
    }
  }
  throw diag.timeoutError();
}

// High-level orchestrator: upload up to 5 reference images -> submit -> poll -> result URL.
export async function generateSeedance(input: {
  userId: number;
  prompt: string;
  images: Array<{ buffer: Buffer; name?: string; mime?: string }>;
  duration: number; // 15 | 30
  ratio: string; // "9:16" | "16:9" | ...
  resolution?: string; // default "480p"
  generateAudio?: boolean;
  onStatus?: (stage: 'upload' | 'submit' | 'poll') => void;
  onPoll?: (elapsedSec: number) => void;
}): Promise<{ url: string; credits?: number }> {
  // Seedance: pool 500 kredit.
  return runWithAccount(input.userId, 'p500', async (credId) => {
    // Pre-submit credit check: verify the account has enough credits BEFORE
    // uploading images or submitting. This is more reliable than parsing the
    // error message from a failed submit (which may vary by Picsart version).
    const minRequired = SEEDANCE_MIN_CREDITS[input.duration] ?? SEEDANCE_MIN_CREDITS[30];
    try {
      const { credits } = await getCredits(credId);
      if (credits < minRequired) {
        console.log(`[picsart] Seedance pre-check: account #${credId} has ${credits} credits, need ${minRequired} — skipping`);
        throw new Error(ERR_INSUFFICIENT_CREDITS);
      }
      console.log(`[picsart] Seedance pre-check: account #${credId} has ${credits} credits ✓`);
    } catch (e: any) {
      // Re-throw the sentinel as-is; for any other check error (network, auth),
      // also skip so we don't burn upload time on a potentially dead account.
      if (e.message === ERR_INSUFFICIENT_CREDITS) throw e;
      console.warn(`[picsart] Seedance pre-check failed for #${credId}: ${e.message} — skipping`);
      throw new Error(ERR_INSUFFICIENT_CREDITS);
    }

    const imgs = (input.images || []).slice(0, SEEDANCE_MAX_REF_IMAGES);
    const imageUrls: string[] = [];
    for (const img of imgs) {
      input.onStatus?.('upload');
      const url = await uploadFile(
        credId,
        img.buffer,
        img.name || 'reference.jpg',
        img.mime || 'image/jpeg'
      );
      imageUrls.push(url);
    }
    input.onStatus?.('submit');
    const id = await submitSeedance(credId, {
      prompt: input.prompt,
      imageUrls,
      duration: input.duration,
      ratio: input.ratio,
      resolution: input.resolution,
      generateAudio: input.generateAudio,
    });
    input.onStatus?.('poll');
    return pollSeedanceResult(credId, id, {
      onTick: (ms) => input.onPoll?.(Math.round(ms / 1000)),
    });
  });
}

// ─── Seedream 2.7 4K & GPT Image 2 (image generation via Picsart workflows) ──

export const SEEDREAM_MODEL = 'seedream_4_7';
export const GPT_IMAGE_MODEL = 'gpt-image-2';

/** Generic poll for workflows that return result.urls[] (Seedream, GPT Image). */
async function pollPicsartImageResult(
  credId: number,
  workflowPath: string, // e.g. 'seedream' or 'openai-image-editing'
  id: string,
  opts?: { maxAttempts?: number; intervalMs?: number; onTick?: (elapsedMs: number) => void }
): Promise<{ url: string; credits?: number }> {
  const maxAttempts = opts?.maxAttempts ?? 120; // ~10 min at 5s
  const intervalMs = opts?.intervalMs ?? 5000;
  const start = Date.now();
  const diag = new PollDiag();
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((res) => setTimeout(res, intervalMs));
    opts?.onTick?.(Date.now() - start);
    const access = await getAccessToken(credId);
    const r = await http.get(`${API_BASE}/workflows/${workflowPath}/${id}/result`, {
      headers: commonHeaders({ authorization: `Bearer ${access}` }),
      validateStatus: () => true,
    });
    const ok = diag.note(r);
    if (!ok) {
      const topStatus = String((r.data as any)?.status ?? '').toLowerCase();
      const reason    = String((r.data as any)?.reason ?? '');
      const msg       = String((r.data as any)?.message ?? '');
      if (r.status >= 400 && (topStatus === 'error' || reason || msg)) {
        throw new Error(`PICSART_GEN_FAILED: ${r.status} ${reason || topStatus} — ${msg}`.slice(0, 300));
      }
      continue;
    }
    const resp = r.data?.response;
    const status = String(resp?.status ?? '').toUpperCase();
    if (status === 'COMPLETED') {
      const url = resp?.result?.urls?.[0];
      if (!url) throw new Error('PICSART_NO_RESULT_URL');
      return { url, credits: resp.usage?.credits };
    }
    if (status === 'FAILED' || status === 'ERROR' || status === 'CANCELLED') {
      throw new Error(`PICSART_GEN_FAILED: ${JSON.stringify(resp).slice(0, 200)}`);
    }
  }
  throw diag.timeoutError();
}

async function submitSeedream(
  credId: number,
  opts: { prompt: string; imageUrls: string[]; ratio: string; resolution?: string }
): Promise<string> {
  const access = await getAccessToken(credId);
  const r = await http.post(
    `${API_BASE}/workflows/seedream/submit`,
    {
      params: {
        prompt: opts.prompt,
        model: SEEDREAM_MODEL,
        count: 1,
        resolution: opts.resolution ?? '4K',
        aspect_ratio: opts.ratio,
        image: opts.imageUrls,
        options: {
          drive: {
            name: `seedream-4k-${Date.now()}.jpeg`,
            attributes: { model: 'seedream-4.7', appId: 'com.picsart.ai-playground', appType: 'miniapp' },
            folder: { path: 'AI Playground' },
          },
        },
      },
    },
    { headers: commonHeaders({ authorization: `Bearer ${access}` }), validateStatus: () => true }
  );
  if (r.status < 200 || r.status >= 300)
    throw new Error(`PICSART_SUBMIT_FAILED: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  const id = r.data?.response?.id;
  if (!id) throw new Error('PICSART_NO_JOB_ID');
  return id;
}

export async function generateSeedream(input: {
  userId: number;
  prompt: string;
  images: Array<{ buffer: Buffer; name?: string; mime?: string }>;
  ratio: string;
  onStatus?: (stage: 'upload' | 'submit' | 'poll') => void;
  onPoll?: (elapsedSec: number) => void;
}): Promise<{ url: string; credits?: number }> {
  return runWithAccount(input.userId, 'p100', async (credId) => {
    const imageUrls: string[] = [];
    for (const img of (input.images ?? []).slice(0, 2)) {
      input.onStatus?.('upload');
      const url = await uploadFile(credId, img.buffer, img.name || 'reference.jpg', img.mime || 'image/jpeg');
      imageUrls.push(url);
    }
    input.onStatus?.('submit');
    const id = await submitSeedream(credId, {
      prompt: input.prompt,
      imageUrls,
      ratio: input.ratio,
    });
    input.onStatus?.('poll');
    return pollPicsartImageResult(credId, 'seedream', id, {
      onTick: (ms) => input.onPoll?.(Math.round(ms / 1000)),
    });
  });
}

async function submitGptImage(
  credId: number,
  opts: { prompt: string; imageUrls: string[]; size?: string; quality?: string }
): Promise<string> {
  const access = await getAccessToken(credId);
  const r = await http.post(
    `${API_BASE}/workflows/openai-image-editing/submit`,
    {
      params: {
        prompt: opts.prompt,
        model: GPT_IMAGE_MODEL,
        images: opts.imageUrls,
        n: 1,
        size: opts.size ?? 'auto',
        quality: opts.quality ?? 'high',
        output_format: 'png',
        options: {
          drive: {
            name: `gpt-image-2-${Date.now()}.png`,
            attributes: { model: 'gpt-image-2', appId: 'com.picsart.ai-playground', appType: 'miniapp' },
            folder: { path: 'AI Playground' },
          },
        },
      },
    },
    { headers: commonHeaders({ authorization: `Bearer ${access}` }), validateStatus: () => true }
  );
  if (r.status < 200 || r.status >= 300)
    throw new Error(`PICSART_SUBMIT_FAILED: ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
  const id = r.data?.response?.id;
  if (!id) throw new Error('PICSART_NO_JOB_ID');
  return id;
}

export async function generateGptImage(input: {
  userId: number;
  prompt: string;
  images: Array<{ buffer: Buffer; name?: string; mime?: string }>;
  ratio: string; // used for display only; GPT Image uses size='auto'
  onStatus?: (stage: 'upload' | 'submit' | 'poll') => void;
  onPoll?: (elapsedSec: number) => void;
}): Promise<{ url: string; credits?: number }> {
  return runWithAccount(input.userId, 'p100', async (credId) => {
    const imageUrls: string[] = [];
    for (const img of (input.images ?? []).slice(0, 2)) {
      input.onStatus?.('upload');
      const url = await uploadFile(credId, img.buffer, img.name || 'reference.jpg', img.mime || 'image/jpeg');
      imageUrls.push(url);
    }
    input.onStatus?.('submit');
    const id = await submitGptImage(credId, {
      prompt: input.prompt,
      imageUrls,
    });
    input.onStatus?.('poll');
    return pollPicsartImageResult(credId, 'openai-image-editing', id, {
      onTick: (ms) => input.onPoll?.(Math.round(ms / 1000)),
    });
  });
}

