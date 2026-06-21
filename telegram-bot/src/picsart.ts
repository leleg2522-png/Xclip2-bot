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
import type { Pool } from 'pg';

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

// Kling model_name mapping. v3 is live-verified; v26 string is a best-guess pending capture.
export const KLING_MODELS = {
  v3: { modelName: 'kling-v3', modelLabel: 'kling-motion-control-v3' },
  v26: { modelName: 'kling-v2.6', modelLabel: 'kling-motion-control-v2.6' },
} as const;
export type KlingModelKey = keyof typeof KLING_MODELS;

// Seedance 2.0 Fast — image/text-to-video. Submit payload mirrors the AI Playground
// `/workflows/seedance/options` pricing pre-check captured from the web app.
export const SEEDANCE_MODEL = 'seedance_2_0_fast';

// Grok Imagine — image-to-video only (requires a reference image). Endpoint
// `/workflows/x-ai/v1/videos/generations/*`. Pricing ~5 credits/sec.
export const GROK_MODEL = 'grok-imagine-video-1.5-preview';

// Kling V3 image-to-video — endpoint `/workflows/kling-image-to-video/*`.
// Same endpoint serves both single-image (image only) and start/end-frame
// (image + image_tail). Uses `mode: "pro"`. Pricing ~3 credits/sec.
export const KLING_I2V_MODEL = 'kling-v3';

let db: Pool;
let notifyOwner: (msg: string) => void = () => {};

// Absolute safety ceiling on failover attempts, so a logic error can never spin
// forever. The real bound is the pool size (see runWithAccount): failover keeps
// moving to the next available account until every account has been tried.
const MAX_ACCOUNT_ATTEMPTS = 50;

export function initPicsart(pool: Pool, notify?: (msg: string) => void) {
  db = pool;
  if (notify) notifyOwner = notify;
}

export async function ensurePicsartSchema(): Promise<void> {
  await db.query(`
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
  // Sticky mapping: each user gets ONE dedicated account so concurrent users
  // never share an account (no collisions, no results leaking across users).
  await db.query(`
    CREATE TABLE IF NOT EXISTS picsart_user_accounts (
      user_id BIGINT PRIMARY KEY,
      credential_id INTEGER NOT NULL REFERENCES picsart_credentials(id) ON DELETE CASCADE,
      assigned_at TIMESTAMPTZ DEFAULT NOW()
    )
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
  const r = await db.query(
    `SELECT id, refresh_token, access_token, access_expires_at, status, label
       FROM picsart_credentials WHERE id = $1`,
    [credId]
  );
  return r.rows[0] ?? null;
}

// Pick the account for a user (sticky 1-user-1-account).
//  • If the user already has an assignment to an available account → reuse it.
//  • Otherwise assign the available account with the FEWEST users (so users
//    spread out 1:1 across accounts whenever there are enough accounts).
//  • `exclude` lets the failover loop skip accounts that just failed.
// Returns the credential id, or null when no usable account exists.
async function acquireAccount(userId: number, exclude: number[] = []): Promise<number | null> {
  const existing = await db.query(
    `SELECT a.credential_id AS id
       FROM picsart_user_accounts a
       JOIN picsart_credentials c ON c.id = a.credential_id
      WHERE a.user_id = $1 AND c.status = 'available'
        AND NOT (a.credential_id = ANY($2::int[]))`,
    [userId, exclude]
  );
  if (existing.rows[0]) return existing.rows[0].id as number;

  const pick = await db.query(
    `SELECT c.id
       FROM picsart_credentials c
       LEFT JOIN picsart_user_accounts a ON a.credential_id = c.id
      WHERE c.status = 'available' AND NOT (c.id = ANY($1::int[]))
      GROUP BY c.id
      ORDER BY COUNT(a.user_id) ASC, c.updated_at ASC
      LIMIT 1`,
    [exclude]
  );
  const credId = pick.rows[0]?.id as number | undefined;
  if (credId == null) return null;

  await db.query(
    `INSERT INTO picsart_user_accounts (user_id, credential_id, assigned_at)
       VALUES ($1, $2, NOW())
     ON CONFLICT (user_id)
       DO UPDATE SET credential_id = EXCLUDED.credential_id, assigned_at = NOW()`,
    [userId, credId]
  );
  return credId;
}

// Account is out of credits — discard it entirely (per owner's request: a
// credit-exhausted account is thrown away, not kept around). The ON DELETE
// CASCADE on picsart_user_accounts unpins any users, so they get reassigned to
// another account on their next request.
async function discardAccount(credId: number): Promise<void> {
  const cred = await loadCredential(credId);
  await db.query(`DELETE FROM picsart_credentials WHERE id = $1`, [credId]);
  const who = cred?.label ? `"${cred.label}" (#${credId})` : `#${credId}`;
  notifyOwner(
    `🗑️ Akun Picsart ${who} kehabisan kredit dan sudah dibuang dari pool.\n` +
    `Tambahkan akun baru bila perlu:\n/addpicsartkey rt:...`
  );
}

function isCreditError(msg: string): boolean {
  return /\b402\b|insufficient|not[_\s-]?enough|credit|quota|payment|balance|limit.?exceeded/i.test(msg);
}

// Run a generation for `userId` on its assigned account. If that account is
// dead (token rejected) or out of credits, transparently move the user to
// another available account and retry — so a single exhausted account never
// fails the user while others still have credits.
async function runWithAccount<T>(userId: number, fn: (credId: number) => Promise<T>): Promise<T> {
  const tried: number[] = [];
  let lastErr: unknown = null;
  // Try every account in the pool before giving up (acquireAccount returns null
  // once all available accounts are excluded). MAX_ACCOUNT_ATTEMPTS is only a
  // hard safety ceiling against an unexpected infinite loop.
  const poolCount = await db.query(`SELECT COUNT(*)::int AS n FROM picsart_credentials`);
  const ceiling = Math.min(MAX_ACCOUNT_ATTEMPTS, Math.max(1, poolCount.rows[0]?.n ?? 1));
  for (let attempt = 0; attempt < ceiling; attempt++) {
    const credId = await acquireAccount(userId, tried);
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
      if (msg.includes('PICSART_SUBMIT_FAILED') && isCreditError(msg)) {
        await discardAccount(credId);
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
  const r = await db.query(
    `INSERT INTO picsart_credentials (refresh_token, label, status) VALUES ($1, $2, 'available') RETURNING id`,
    [token, label ?? null]
  );
  return r.rows[0].id as number;
}

export async function getStatus(): Promise<{
  counts: Record<string, number>;
  available: number;
  totalUsers: number;
}> {
  const r = await db.query(`SELECT status, COUNT(*)::int AS cnt FROM picsart_credentials GROUP BY status`);
  const counts: Record<string, number> = {};
  for (const row of r.rows) counts[row.status] = row.cnt;
  const u = await db.query(`SELECT COUNT(*)::int AS cnt FROM picsart_user_accounts`);
  return { counts, available: counts['available'] ?? 0, totalUsers: u.rows[0]?.cnt ?? 0 };
}

// Admin: full view of the account pool, with how many users are pinned to each.
export async function getPool(): Promise<Array<{
  id: number;
  label: string | null;
  status: string;
  users: number;
  accessValidUntil: string | null;
  createdAt: string;
}>> {
  const r = await db.query(
    `SELECT c.id, c.label, c.status, c.access_expires_at, c.created_at,
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
      await db.query(
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

  await db.query(
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
      const r = await db.query(
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

export async function getCredits(credId: number): Promise<{ credits: number; renewDate?: string }> {
  const access = await getAccessToken(credId);
  const r = await http.get(`${API_BASE}/guard/credits`, {
    headers: commonHeaders({ authorization: `Bearer ${access}` }),
    validateStatus: () => true,
  });
  if (!ok2xx(r.status)) throw new Error(`PICSART_CREDITS_FAILED status ${r.status}`);
  return { credits: r.data?.response?.credits ?? r.data?.credits, renewDate: r.data?.response?.renewDate };
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
          tool: 'ai-playground',
          model: modelLabel,
          prompt: input.prompt ?? '',
          subType: 'i2v',
          service: 'kling',
          textScript: JSON.stringify({
            resolution: '1080p',
            referenceImageUrls: [input.imageUrl],
            referenceVideoUrl: input.videoUrl,
          }),
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
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((res) => setTimeout(res, intervalMs));
    const access = await getAccessToken(credId);
    const r = await http.get(`${API_BASE}/workflows/kling-motion-control/${id}/result`, {
      headers: commonHeaders({ authorization: `Bearer ${access}` }),
      validateStatus: () => true,
    });
    if (!ok2xx(r.status)) continue;
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
  throw new Error('PICSART_TIMEOUT');
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
  onStatus?: (stage: 'upload' | 'submit' | 'poll') => void;
}): Promise<{ url: string; credits?: number; duration?: string; usedModel: KlingModelKey }> {
  return runWithAccount(input.userId, async (credId) => {
    input.onStatus?.('upload');
    const imageUrl = await uploadFile(credId, input.imageBuffer, input.imageName, input.imageMime);
    const videoUrl = await uploadFile(credId, input.videoBuffer, input.videoName, input.videoMime);
    input.onStatus?.('submit');

    let usedModel: KlingModelKey = input.model;
    let id: string;
    try {
      id = await submitKlingMotionControl(credId, {
        prompt: input.prompt, imageUrl, videoUrl, model: input.model, outputName: input.videoName,
      });
    } catch (e: any) {
      // The v2.6 model_name is a best-guess (not yet HAR-verified). If Picsart rejects the
      // submit, transparently fall back to the verified v3 so the user still gets a result.
      // A credit error is re-thrown so runWithAccount can move to another account.
      const msg = String(e?.message ?? '');
      if (input.model !== 'v3' && msg.includes('PICSART_SUBMIT_FAILED') && !isCreditError(msg)) {
        usedModel = 'v3';
        id = await submitKlingMotionControl(credId, {
          prompt: input.prompt, imageUrl, videoUrl, model: 'v3', outputName: input.videoName,
        });
      } else {
        throw e;
      }
    }

    input.onStatus?.('poll');
    const res = await pollKlingResult(credId, id);
    return { ...res, usedModel };
  });
}

// ─── Seedance 2.0 ─────────────────────────────────────────────────────────────

export async function submitSeedance(credId: number, input: {
  prompt: string;
  imageUrl?: string;
  duration: number;
  ratio: string;
  resolution: string;
  generateAudio: boolean;
}): Promise<string> {
  const access = await getAccessToken(credId);
  const content: Array<Record<string, unknown>> = [];
  if (input.imageUrl) {
    content.push({ type: 'image_url', image_url: { url: input.imageUrl }, role: 'reference_image' });
  }
  content.push({ type: 'text', text: input.prompt ?? '' });
  const params = {
    model: SEEDANCE_MODEL,
    content,
    ratio: input.ratio,
    duration: input.duration,
    resolution: input.resolution,
    generate_audio: input.generateAudio,
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
  const maxAttempts = opts?.maxAttempts ?? 180; // ~15 min at 5s
  const intervalMs = opts?.intervalMs ?? 5000;
  const start = Date.now();
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((res) => setTimeout(res, intervalMs));
    opts?.onTick?.(Date.now() - start);
    const access = await getAccessToken(credId);
    const r = await http.get(`${API_BASE}/workflows/seedance/${id}/result`, {
      headers: commonHeaders({ authorization: `Bearer ${access}` }),
      validateStatus: () => true,
    });
    if (!ok2xx(r.status)) continue;
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
  throw new Error('PICSART_TIMEOUT');
}

// High-level orchestrator: optional image upload -> submit -> poll -> result URL.
export async function generateSeedance(input: {
  userId: number;
  prompt: string;
  imageBuffer?: Buffer;
  imageName?: string;
  imageMime?: string;
  duration: number;
  ratio: string;
  resolution: string;
  generateAudio: boolean;
  onStatus?: (stage: 'upload' | 'submit' | 'poll') => void;
  onPoll?: (elapsedSec: number) => void;
}): Promise<{ url: string; credits?: number }> {
  return runWithAccount(input.userId, async (credId) => {
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
    const id = await submitSeedance(credId, {
      prompt: input.prompt,
      imageUrl,
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

// ─── Grok Imagine (image-to-video) ────────────────────────────────────────────

export async function submitGrok(credId: number, input: {
  prompt: string;
  imageUrl: string;
  duration: number;
  ratio: string;
}): Promise<string> {
  const access = await getAccessToken(credId);
  const params = {
    model: GROK_MODEL,
    prompt: input.prompt ?? '',
    image: { url: input.imageUrl },
    duration: input.duration,
    aspect_ratio: input.ratio,
  };
  const r = await http.post(`${API_BASE}/workflows/x-ai/v1/videos/generations/submit`, { params }, {
    headers: commonHeaders({ 'content-type': 'application/json', authorization: `Bearer ${access}` }),
    validateStatus: () => true,
  });
  const id = r.data?.response?.id;
  if (!ok2xx(r.status) || !id) {
    throw new Error(`PICSART_SUBMIT_FAILED status ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
  }
  return id;
}

export async function pollGrokResult(
  credId: number,
  id: string,
  opts?: { maxAttempts?: number; intervalMs?: number; onTick?: (elapsedMs: number) => void }
): Promise<{ url: string; credits?: number }> {
  const maxAttempts = opts?.maxAttempts ?? 180; // ~15 min at 5s
  const intervalMs = opts?.intervalMs ?? 5000;
  const start = Date.now();
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((res) => setTimeout(res, intervalMs));
    opts?.onTick?.(Date.now() - start);
    const access = await getAccessToken(credId);
    const r = await http.get(`${API_BASE}/workflows/x-ai/v1/videos/generations/${id}/result`, {
      headers: commonHeaders({ authorization: `Bearer ${access}` }),
      validateStatus: () => true,
    });
    if (!ok2xx(r.status)) continue;
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
  throw new Error('PICSART_TIMEOUT');
}

// High-level orchestrator: image upload -> submit -> poll -> result URL.
// Grok is image-to-video only, so a reference image is required.
export async function generateGrok(input: {
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
  return runWithAccount(input.userId, async (credId) => {
    input.onStatus?.('upload');
    const imageUrl = await uploadFile(
      credId,
      input.imageBuffer,
      input.imageName || 'reference.jpg',
      input.imageMime || 'image/jpeg'
    );
    input.onStatus?.('submit');
    const id = await submitGrok(credId, {
      prompt: input.prompt,
      imageUrl,
      duration: input.duration,
      ratio: input.ratio,
    });
    input.onStatus?.('poll');
    return pollGrokResult(credId, id, {
      onTick: (ms) => input.onPoll?.(Math.round(ms / 1000)),
    });
  });
}

// ─── Kling V3 image-to-video ──────────────────────────────────────────────────
// Single image (image-to-video) or two images (start frame + end frame).

export async function submitKlingI2V(credId: number, input: {
  prompt: string;
  imageUrl: string;
  imageTailUrl?: string;
  duration: number;
  ratio: string;
}): Promise<string> {
  const access = await getAccessToken(credId);
  const params: Record<string, unknown> = {
    prompt: input.prompt ?? '',
    aspect_ratio: input.ratio,
    duration: String(input.duration),
    model_name: KLING_I2V_MODEL,
    image: input.imageUrl,
    mode: 'pro',
    multi_shot: false,
    shot_type: 'customize',
  };
  if (input.imageTailUrl) params.image_tail = input.imageTailUrl;
  const r = await http.post(`${API_BASE}/workflows/kling-image-to-video/submit`, { params }, {
    headers: commonHeaders({ 'content-type': 'application/json', authorization: `Bearer ${access}` }),
    validateStatus: () => true,
  });
  const id = r.data?.response?.id;
  if (!ok2xx(r.status) || !id) {
    throw new Error(`PICSART_SUBMIT_FAILED status ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
  }
  return id;
}

export async function pollKlingI2VResult(
  credId: number,
  id: string,
  opts?: { maxAttempts?: number; intervalMs?: number; onTick?: (elapsedMs: number) => void }
): Promise<{ url: string; credits?: number }> {
  const maxAttempts = opts?.maxAttempts ?? 180; // ~15 min at 5s
  const intervalMs = opts?.intervalMs ?? 5000;
  const start = Date.now();
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((res) => setTimeout(res, intervalMs));
    opts?.onTick?.(Date.now() - start);
    const access = await getAccessToken(credId);
    const r = await http.get(`${API_BASE}/workflows/kling-image-to-video/${id}/result`, {
      headers: commonHeaders({ authorization: `Bearer ${access}` }),
      validateStatus: () => true,
    });
    if (!ok2xx(r.status)) continue;
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
  throw new Error('PICSART_TIMEOUT');
}

// High-level orchestrator: upload start image (and optional end image) ->
// submit -> poll -> result URL. A start image is always required.
export async function generateKlingI2V(input: {
  userId: number;
  prompt: string;
  imageBuffer: Buffer;
  imageName?: string;
  imageMime?: string;
  imageTailBuffer?: Buffer;
  imageTailName?: string;
  imageTailMime?: string;
  duration: number;
  ratio: string;
  onStatus?: (stage: 'upload' | 'submit' | 'poll') => void;
  onPoll?: (elapsedSec: number) => void;
}): Promise<{ url: string; credits?: number }> {
  return runWithAccount(input.userId, async (credId) => {
    input.onStatus?.('upload');
    const imageUrl = await uploadFile(
      credId,
      input.imageBuffer,
      input.imageName || 'start.jpg',
      input.imageMime || 'image/jpeg'
    );
    let imageTailUrl: string | undefined;
    if (input.imageTailBuffer) {
      imageTailUrl = await uploadFile(
        credId,
        input.imageTailBuffer,
        input.imageTailName || 'end.jpg',
        input.imageTailMime || 'image/jpeg'
      );
    }
    input.onStatus?.('submit');
    const id = await submitKlingI2V(credId, {
      prompt: input.prompt,
      imageUrl,
      imageTailUrl,
      duration: input.duration,
      ratio: input.ratio,
    });
    input.onStatus?.('poll');
    return pollKlingI2VResult(credId, id, {
      onTick: (ms) => input.onPoll?.(Math.round(ms / 1000)),
    });
  });
}
