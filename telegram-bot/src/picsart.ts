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

// Seedance 2.0 — image/text-to-video. Submit payload mirrors the AI Playground
// `/workflows/seedance/options` pricing pre-check captured from the web app.
export const SEEDANCE_MODEL = 'seedance_2_0';

let db: Pool;
let notifyOwner: (msg: string) => void = () => {};

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
}

async function getActiveCredential(): Promise<CredRow | null> {
  const r = await db.query(
    `SELECT id, refresh_token, access_token, access_expires_at, status
       FROM picsart_credentials WHERE status = 'available'
       ORDER BY updated_at DESC LIMIT 1`
  );
  return r.rows[0] ?? null;
}

// Admin: register a refresh token (rt:...). Supersedes any previous active one.
export async function addRefreshToken(rt: string, label?: string): Promise<boolean> {
  let token = rt.trim();
  // Cookie values copied from the browser are URL-encoded, so the leading
  // colon arrives as `rt%3A...`. Decode so `rt:` validation passes.
  if (/%[0-9a-f]{2}/i.test(token)) {
    try { token = decodeURIComponent(token); } catch { /* keep raw */ }
  }
  if (!token.startsWith('rt:')) return false;
  await db.query(`UPDATE picsart_credentials SET status = 'replaced', updated_at = NOW() WHERE status = 'available'`);
  await db.query(
    `INSERT INTO picsart_credentials (refresh_token, label, status) VALUES ($1, $2, 'available')`,
    [token, label ?? null]
  );
  return true;
}

export async function getStatus(): Promise<{
  counts: Record<string, number>;
  hasActive: boolean;
  accessValidUntil: string | null;
}> {
  const r = await db.query(`SELECT status, COUNT(*)::int AS cnt FROM picsart_credentials GROUP BY status`);
  const counts: Record<string, number> = {};
  for (const row of r.rows) counts[row.status] = row.cnt;
  const active = await getActiveCredential();
  return { counts, hasActive: !!active, accessValidUntil: active?.access_expires_at ?? null };
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

let refreshInFlight: Promise<string> | null = null;

async function doRefresh(force = false): Promise<string> {
  const cred = await getActiveCredential();
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
      notifyOwner(
        `⚠️ Picsart refresh token DITOLAK (${detail}). Tambahkan token baru:\n/addpicsartkey rt:...`
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

export async function getAccessToken(): Promise<string> {
  if (refreshInFlight) return refreshInFlight;
  refreshInFlight = doRefresh(false).finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

// Keepalive: periodically force a refresh so the refresh-token's ~30-day window
// keeps rolling forward even when nobody generates. On a dedicated account this
// makes the token effectively permanent — the user only seeds it ONCE.
export function startPicsartKeepalive(intervalMs = 3 * 24 * 60 * 60 * 1000): NodeJS.Timeout {
  const tick = async () => {
    try {
      if (refreshInFlight) { await refreshInFlight; return; }
      refreshInFlight = doRefresh(true).finally(() => { refreshInFlight = null; });
      await refreshInFlight;
      console.log('[picsart] keepalive refresh ok');
    } catch (e: any) {
      // PICSART_NO_CREDENTIAL (nothing seeded yet) or PICSART_REFRESH_DEAD (owner already notified) — just skip.
      console.warn('[picsart] keepalive skip:', e?.message ?? e);
    }
  };
  const timer = setInterval(tick, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return timer;
}

export async function getCredits(): Promise<{ credits: number; renewDate?: string }> {
  const access = await getAccessToken();
  const r = await http.get(`${API_BASE}/guard/credits`, {
    headers: commonHeaders({ authorization: `Bearer ${access}` }),
    validateStatus: () => true,
  });
  if (!ok2xx(r.status)) throw new Error(`PICSART_CREDITS_FAILED status ${r.status}`);
  return { credits: r.data?.response?.credits ?? r.data?.credits, renewDate: r.data?.response?.renewDate };
}

export async function uploadFile(buf: Buffer, filename: string, contentType: string): Promise<string> {
  const access = await getAccessToken();
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

export async function submitKlingMotionControl(input: {
  prompt: string;
  imageUrl: string;
  videoUrl: string;
  model: KlingModelKey;
  outputName?: string;
}): Promise<string> {
  const access = await getAccessToken();
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
  id: string,
  opts?: { maxAttempts?: number; intervalMs?: number }
): Promise<{ url: string; duration?: string; credits?: number }> {
  const maxAttempts = opts?.maxAttempts ?? 180; // ~15 min at 5s
  const intervalMs = opts?.intervalMs ?? 5000;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((res) => setTimeout(res, intervalMs));
    const access = await getAccessToken();
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
export async function generateKlingMotionControl(input: {
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
  input.onStatus?.('upload');
  const imageUrl = await uploadFile(input.imageBuffer, input.imageName, input.imageMime);
  const videoUrl = await uploadFile(input.videoBuffer, input.videoName, input.videoMime);
  input.onStatus?.('submit');

  let usedModel: KlingModelKey = input.model;
  let id: string;
  try {
    id = await submitKlingMotionControl({
      prompt: input.prompt, imageUrl, videoUrl, model: input.model, outputName: input.videoName,
    });
  } catch (e: any) {
    // The v2.6 model_name is a best-guess (not yet HAR-verified). If Picsart rejects the
    // submit, transparently fall back to the verified v3 so the user still gets a result.
    if (input.model !== 'v3' && String(e?.message ?? '').includes('PICSART_SUBMIT_FAILED')) {
      usedModel = 'v3';
      id = await submitKlingMotionControl({
        prompt: input.prompt, imageUrl, videoUrl, model: 'v3', outputName: input.videoName,
      });
    } else {
      throw e;
    }
  }

  input.onStatus?.('poll');
  const res = await pollKlingResult(id);
  return { ...res, usedModel };
}

// ─── Seedance 2.0 ─────────────────────────────────────────────────────────────

export async function submitSeedance(input: {
  prompt: string;
  imageUrl?: string;
  duration: number;
  ratio: string;
  resolution: string;
  generateAudio: boolean;
}): Promise<string> {
  const access = await getAccessToken();
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
  id: string,
  opts?: { maxAttempts?: number; intervalMs?: number }
): Promise<{ url: string; credits?: number }> {
  const maxAttempts = opts?.maxAttempts ?? 180; // ~15 min at 5s
  const intervalMs = opts?.intervalMs ?? 5000;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((res) => setTimeout(res, intervalMs));
    const access = await getAccessToken();
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
  prompt: string;
  imageBuffer?: Buffer;
  imageName?: string;
  imageMime?: string;
  duration: number;
  ratio: string;
  resolution: string;
  generateAudio: boolean;
  onStatus?: (stage: 'upload' | 'submit' | 'poll') => void;
}): Promise<{ url: string; credits?: number }> {
  let imageUrl: string | undefined;
  if (input.imageBuffer) {
    input.onStatus?.('upload');
    imageUrl = await uploadFile(
      input.imageBuffer,
      input.imageName || 'reference.jpg',
      input.imageMime || 'image/jpeg'
    );
  }
  input.onStatus?.('submit');
  const id = await submitSeedance({
    prompt: input.prompt,
    imageUrl,
    duration: input.duration,
    ratio: input.ratio,
    resolution: input.resolution,
    generateAudio: input.generateAudio,
  });
  input.onStatus?.('poll');
  return pollSeedanceResult(id);
}
