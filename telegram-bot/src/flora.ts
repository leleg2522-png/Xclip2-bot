// ─── Flora AI client — Kling 2.6 Pro Motion Control ─────────────────────────
// Docs: developer.flora.ai — Bearer sk_live key per akun (workspace sendiri-sendiri).
// Alur: discover workspace/project → upload asset (signed-url ImageKit) → generate → poll.

const FLORA_BASE = 'https://app.flora.ai/api/v1';
const MODEL_ID = 'iv2v-kling-2.6-motion';

// Cache workspace/project per API key biar tidak discovery ulang tiap generate.
const wsCache = new Map<string, { workspaceId: string; projectId: string }>();

interface FloraApiResult {
  status: number;
  body: any;
}

async function floraApi(apiKey: string, path: string, init?: RequestInit): Promise<FloraApiResult> {
  const res = await fetch(FLORA_BASE + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: any;
  try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 300) }; }
  return { status: res.status, body };
}

function floraError(prefix: string, r: FloraApiResult): Error {
  const detail = typeof r.body === 'object' ? JSON.stringify(r.body).slice(0, 300) : String(r.body).slice(0, 300);
  return new Error(`${prefix} (HTTP ${r.status}): ${detail}`);
}

async function resolveWorkspaceProject(apiKey: string): Promise<{ workspaceId: string; projectId: string }> {
  const cached = wsCache.get(apiKey);
  if (cached) return cached;

  const ws = await floraApi(apiKey, '/workspaces');
  if (ws.status >= 300) throw floraError('FLORA_AUTH_FAILED', ws);
  const workspaceId: string | undefined = ws.body?.workspaces?.[0]?.workspace_id;
  if (!workspaceId) throw new Error('FLORA_AUTH_FAILED: tidak ada workspace di akun ini');

  const prj = await floraApi(apiKey, `/projects?workspace_id=${workspaceId}`);
  let projectId: string | undefined = prj.body?.projects?.[0]?.project_id;
  if (!projectId) {
    const created = await floraApi(apiKey, '/projects', {
      method: 'POST',
      body: JSON.stringify({ name: 'bot', workspace_id: workspaceId }),
    });
    projectId = created.body?.project_id ?? created.body?.project?.project_id;
    if (!projectId) throw floraError('FLORA_PROJECT_FAILED', created);
  }

  const resolved = { workspaceId, projectId };
  wsCache.set(apiKey, resolved);
  return resolved;
}

async function uploadAsset(
  apiKey: string,
  workspaceId: string,
  buf: Buffer,
  fileName: string,
  contentType: string,
): Promise<string> {
  const create = await floraApi(apiKey, '/assets', {
    method: 'POST',
    body: JSON.stringify({
      source: 'signed-url',
      workspace_id: workspaceId,
      file_name: fileName,
      content_type: contentType,
      folder: 'tg-bot',
    }),
  });
  if (create.status >= 300) throw floraError('FLORA_UPLOAD_FAILED', create);
  const { asset_id, upload } = create.body;

  const fd = new FormData();
  const formFields = upload?.form_fields ?? {};
  for (const [k, v] of Object.entries(formFields)) fd.append(k, String(v));
  fd.append(
    upload?.file_field ?? 'file',
    new Blob([new Uint8Array(buf)], { type: contentType }),
    (formFields as any).fileName ?? fileName,
  );
  const up = await fetch(upload.url, { method: upload?.method ?? 'POST', body: fd });
  if (up.status >= 300) {
    const errTxt = (await up.text()).slice(0, 300);
    throw new Error(`FLORA_UPLOAD_FAILED (HTTP ${up.status}): ${errTxt}`);
  }

  const done = await floraApi(apiKey, `/assets/${asset_id}/complete`, { method: 'POST' });
  if (done.status >= 300 || !done.body?.url) throw floraError('FLORA_UPLOAD_FAILED', done);
  return done.body.url as string;
}

export interface FloraMotionControlOpts {
  apiKey: string;
  imageBuffer: Buffer;
  imageName: string;
  imageMime: string;
  videoBuffer: Buffer;
  videoName: string;
  videoMime: string;
  prompt?: string;
  /** 'video' (default) = ikuti orientasi video referensi; 'image' = ikuti orientasi foto */
  characterOrientation?: 'video' | 'image';
  onStatus?: (stage: 'upload' | 'submit' | 'processing') => void;
  /** Batas tunggu polling (default 25 menit — job biasanya ~11 menit) */
  timeoutMs?: number;
}

export interface FloraResult {
  url: string;
  runId: string;
}

export async function generateKling26MotionControl(opts: FloraMotionControlOpts): Promise<FloraResult> {
  const { apiKey } = opts;
  const { workspaceId, projectId } = await resolveWorkspaceProject(apiKey);

  opts.onStatus?.('upload');
  const [imageUrl, videoUrl] = await Promise.all([
    uploadAsset(apiKey, workspaceId, opts.imageBuffer, opts.imageName, opts.imageMime),
    uploadAsset(apiKey, workspaceId, opts.videoBuffer, opts.videoName, opts.videoMime),
  ]);

  opts.onStatus?.('submit');
  const gen = await floraApi(apiKey, '/generate', {
    method: 'POST',
    body: JSON.stringify({
      type: 'video',
      prompt: opts.prompt?.trim() || 'The character follows the motion of the reference video',
      workspace_id: workspaceId,
      project_id: projectId,
      model: MODEL_ID,
      params: {
        image_url: imageUrl,
        video_url: videoUrl,
        character_orientation: opts.characterOrientation ?? 'video',
      },
    }),
  });
  if (gen.status >= 300 || !gen.body?.run_id) throw floraError('FLORA_SUBMIT_FAILED', gen);
  const runId: string = gen.body.run_id;

  opts.onStatus?.('processing');
  const timeoutMs = opts.timeoutMs ?? 25 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;
  let pollErrors = 0;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 15_000));
    let run: FloraApiResult;
    try {
      run = await floraApi(apiKey, `/runs/${runId}`);
    } catch {
      if (++pollErrors > 8) throw new Error('FLORA_POLL_FAILED: koneksi ke Flora terputus terus');
      continue;
    }
    if (run.status >= 300) {
      if (++pollErrors > 8) throw floraError('FLORA_POLL_FAILED', run);
      continue;
    }
    pollErrors = 0;

    const status = run.body?.status;
    if (status === 'completed') {
      const url = run.body?.outputs?.find((o: any) => o?.url)?.url;
      if (!url) throw new Error('FLORA_NO_OUTPUT: run selesai tapi tidak ada output URL');
      return { url, runId };
    }
    if (status === 'failed' || status === 'canceled') {
      const code = run.body?.error_code ?? 'UNKNOWN';
      const msg = run.body?.error_message ?? '';
      throw new Error(`FLORA_RUN_FAILED [${code}]: ${String(msg).slice(0, 200)}`);
    }
  }
  throw new Error('FLORA_TIMEOUT: job belum selesai dalam batas waktu');
}

// ─── Flora image-to-video generik (foto + prompt → video) ────────────────────
// Dipakai untuk: Kling 2.1 Pro (f2v-kling-2.1-pro) dan Kling 2.5 Turbo Pro
// (i2v-kling-2.5). Field input terverifikasi Jul 2026:
// params.image_url + params.duration ('5'|'10').

export interface FloraI2VOpts {
  apiKey: string;
  /** Flora model_id, mis. 'f2v-kling-2.1-pro' atau 'i2v-kling-2.5' */
  model: string;
  imageBuffer: Buffer;
  imageName: string;
  imageMime: string;
  prompt: string;
  duration?: '5' | '10';
  onStatus?: (stage: 'upload' | 'submit' | 'processing') => void;
  /** Batas tunggu polling (default 20 menit) */
  timeoutMs?: number;
}

export async function generateFloraI2V(opts: FloraI2VOpts): Promise<FloraResult> {
  const { apiKey } = opts;
  const { workspaceId, projectId } = await resolveWorkspaceProject(apiKey);

  opts.onStatus?.('upload');
  const imageUrl = await uploadAsset(apiKey, workspaceId, opts.imageBuffer, opts.imageName, opts.imageMime);

  opts.onStatus?.('submit');
  const gen = await floraApi(apiKey, '/generate', {
    method: 'POST',
    body: JSON.stringify({
      type: 'video',
      prompt: opts.prompt.trim(),
      workspace_id: workspaceId,
      project_id: projectId,
      model: opts.model,
      params: {
        image_url: imageUrl,
        duration: opts.duration ?? '10',
      },
    }),
  });
  if (gen.status >= 300 || !gen.body?.run_id) throw floraError('FLORA_SUBMIT_FAILED', gen);
  const runId: string = gen.body.run_id;

  opts.onStatus?.('processing');
  const timeoutMs = opts.timeoutMs ?? 20 * 60 * 1000;
  const deadline = Date.now() + timeoutMs;
  let pollErrors = 0;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 15_000));
    let run: FloraApiResult;
    try {
      run = await floraApi(apiKey, `/runs/${runId}`);
    } catch {
      if (++pollErrors > 8) throw new Error('FLORA_POLL_FAILED: koneksi ke Flora terputus terus');
      continue;
    }
    if (run.status >= 300) {
      if (++pollErrors > 8) throw floraError('FLORA_POLL_FAILED', run);
      continue;
    }
    pollErrors = 0;

    const status = run.body?.status;
    if (status === 'completed') {
      const url = run.body?.outputs?.find((o: any) => o?.url)?.url;
      if (!url) throw new Error('FLORA_NO_OUTPUT: run selesai tapi tidak ada output URL');
      return { url, runId };
    }
    if (status === 'failed' || status === 'canceled') {
      const code = run.body?.error_code ?? 'UNKNOWN';
      const msg = run.body?.error_message ?? '';
      throw new Error(`FLORA_RUN_FAILED [${code}]: ${String(msg).slice(0, 200)}`);
    }
  }
  throw new Error('FLORA_TIMEOUT: job belum selesai dalam batas waktu');
}

/** Validasi cepat sebuah key: coba list workspaces. */
export async function validateFloraKey(apiKey: string): Promise<boolean> {
  try {
    const ws = await floraApi(apiKey, '/workspaces');
    return ws.status < 300 && Array.isArray(ws.body?.workspaces) && ws.body.workspaces.length > 0;
  } catch {
    return false;
  }
}

/**
 * Error yang menandakan key ini tidak bisa dipakai lagi (habis/invalid) — bukan error konten.
 * Sengaja ketat: hanya kegagalan auth (FLORA_AUTH_FAILED) atau kegagalan SUBMIT/UPLOAD
 * dengan sinyal auth/saldo eksplisit. FLORA_RUN_FAILED (job sudah jalan lalu gagal)
 * dianggap error konten dan TIDAK mematikan key.
 */
export function isFloraKeyExhaustedError(raw: string): boolean {
  const lower = raw.toLowerCase();
  if (lower.includes('flora_auth_failed')) return true;
  // Hanya evaluasi tahap sebelum job jalan — run failure bukan salah key.
  if (!lower.includes('flora_submit_failed') && !lower.includes('flora_upload_failed') && !lower.includes('flora_project_failed')) {
    return false;
  }
  return lower.includes('http 401') || lower.includes('unauthorized')
    || lower.includes('http 402') || lower.includes('payment required')
    || lower.includes('http 403') || lower.includes('forbidden')
    || lower.includes('insufficient credit') || lower.includes('insufficient_credit')
    || lower.includes('not enough credit') || lower.includes('quota');
}
