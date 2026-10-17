import axios from 'axios';
import type { AlrizKeySource } from './alriz-key-pool';

export const ALRIZ_KLING_P5 = {
  label: 'Kling MC V3 Pro P5',
  model: 'mc-kling-2.6-pro',
} as const;
const API_BASE = 'https://alrizmotion.my.id/api';
const directHttp = axios.create({ proxy: false, timeout: 120_000 });
type Response = { status: number; data: any };
export interface AlrizMotionApi {
  apiKey?: string;
  publish: (bytes: Buffer, video: boolean) => Promise<string>;
  status: (text: string) => Promise<void>;
  http?: {
    post: (url: string, body: any, config: any) => Promise<Response>;
    get: (url: string, config: any) => Promise<Response>;
  };
  wait?: (ms: number) => Promise<void>;
  maxPolls?: number;
}

/** Pool only: environment credentials are deliberately not a runtime fallback. */
export async function generateKlingAlrizFromPool(
  input: Parameters<typeof generateKlingAlriz>[0],
  api: Omit<AlrizMotionApi, 'apiKey'> & { pool: AlrizKeySource },
): Promise<string> {
  const skipped: number[] = [];
  while (skipped.length < 20) {
    const key = await api.pool.next(skipped);
    if (!key) throw new Error('ALRIZ_POOL_NO_AVAILABLE_KEY');
    skipped.push(key.id);
    try {
      return await generateKlingAlriz(input, { ...api, apiKey: key.apiKey });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      // These are explicit HTTP rejections, not timeouts, missing IDs or accepted jobs.
      if (/^ALRIZ_SUBMIT_HTTP_(401|402|403)$/.test(message)) {
        await api.pool.disable(key.id);
        continue;
      }
      // A post-acceptance auth failure retires the key but NEVER resubmits.
      if (/^ALRIZ_(POLL|RESULT)_HTTP_(401|403)\b/.test(message)) await api.pool.disable(key.id);
      throw error;
    }
  }
  throw new Error('ALRIZ_POOL_NO_AVAILABLE_KEY');
}

function validMediaUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && !/(^|\.)telegram\.org$/i.test(url.hostname)
      && !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/i.test(url.hostname)
      && !/^172\.(1[6-9]|2\d|3[01])\./.test(url.hostname);
  } catch { return false; }
}

/** One paid submit only. Never replay an accepted or ambiguous job. */
export async function generateKlingAlriz(
  input: { image: Buffer; video: Buffer; seconds?: number; prompt: string; publicLabel?: string },
  api: AlrizMotionApi,
): Promise<string> {
  const key = api.apiKey?.trim();
  if (!key) throw new Error('ALRIZ_API_KEY_REQUIRED');
  if (!input.image.length || input.image.length > 10 * 1024 * 1024) throw new Error('ALRIZ_INVALID_IMAGE_SIZE');
  // Retain the bot's existing stricter 15MB reference-video limit.
  if (!input.video.length || input.video.length > 15 * 1024 * 1024) throw new Error('ALRIZ_INVALID_VIDEO_SIZE');
  if (input.seconds !== undefined && (!Number.isFinite(input.seconds) || input.seconds < 3 || input.seconds > 30)) {
    throw new Error('ALRIZ_INVALID_VIDEO_DURATION');
  }
  const http = api.http ?? directHttp;
  const config = {
    headers: { 'X-API-Key': key, Accept: 'application/json' },
    validateStatus: () => true,
    timeout: 120_000,
    proxy: false as const,
  };
  const wait = api.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  await api.status(`⏳ ${input.publicLabel ?? ALRIZ_KLING_P5.label}: menyiapkan foto dan video referensi...`);
  // Publish our own bytes, never Telegram's bot-token-bearing file URLs.
  const imageUrl = await api.publish(input.image, false);
  const videoUrl = await api.publish(input.video, true);
  if (!validMediaUrl(imageUrl) || !validMediaUrl(videoUrl)) throw new Error('ALRIZ_PUBLIC_MEDIA_URL_REQUIRED');
  await api.status(`⏳ ${input.publicLabel ?? ALRIZ_KLING_P5.label}: mengirim perintah...`);
  let submitted: Response;
  try {
    submitted = await http.post(`${API_BASE}/jobs`, {
      model: ALRIZ_KLING_P5.model,
      image_url: imageUrl, video_url: videoUrl,
      prompt: input.prompt.trim() || 'Follow the motion in the reference video.',
    }, { ...config, headers: { ...config.headers, 'Content-Type': 'application/json' } });
  } catch {
    // Hide request configs, API keys, prompts and reference URLs from error logs.
    throw new Error('ALRIZ_SUBMIT_AMBIGUOUS');
  }
  if (submitted.status < 200 || submitted.status >= 300) throw new Error(`ALRIZ_SUBMIT_HTTP_${submitted.status}`);
  const jobId = submitted.data?.job_id;
  if (typeof jobId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(jobId)) throw new Error('ALRIZ_SUBMIT_NO_JOB_ID');
  await api.status(`⏳ ${input.publicLabel ?? ALRIZ_KLING_P5.label}: video sedang dibuat.\nHasil dikirim otomatis.`);
  for (let attempt = 0; attempt < (api.maxPolls ?? 240); attempt++) {
    await wait(5000);
    let response: Response;
    try {
      response = await http.get(`${API_BASE}/jobs/${jobId}`, config);
    } catch {
      // Retrying a read is safe; retrying the paid POST is not.
      continue;
    }
    if (response.status === 429 || response.status >= 500) continue;
    if (response.status !== 200) throw new Error(`ALRIZ_POLL_HTTP_${response.status} job=${jobId}`);
    const job = response.data;
    const state = String(job?.status ?? '').toUpperCase();
    if (state === 'DONE') {
      if (job.result_expired) throw new Error(`ALRIZ_RESULT_EXPIRED job=${jobId}`);
      let result = job.result_url;
      if (!result) {
        let output: Response;
        try { output = await http.get(`${API_BASE}/jobs/${jobId}/result`, config); }
        catch { throw new Error(`ALRIZ_RESULT_REQUEST_FAILED job=${jobId}`); }
        if (output.status !== 200) throw new Error(`ALRIZ_RESULT_HTTP_${output.status} job=${jobId}`);
        result = output.data?.result_url;
      }
      if (!validMediaUrl(result)) throw new Error(`ALRIZ_INVALID_RESULT_URL job=${jobId}`);
      return result;
    }
    if (state === 'FAILED' || state === 'NO_STOCK') {
      const code = typeof job.error_code === 'string' && /^[A-Z0-9_]{1,48}$/.test(job.error_code)
        ? ` code=${job.error_code}` : '';
      const detail = typeof job.error === 'string' ? job.error : job.error?.message;
      // Log only an allowlisted reason, never raw upstream text or private URLs.
      const reason = typeof detail === 'string' && /file type not supported/i.test(detail)
        ? ' reason=UNSUPPORTED_FILE_TYPE' : '';
      throw new Error(`ALRIZ_JOB_${state} job=${jobId}${code}${reason}`);
    }
    if (!['QUEUED', 'CLAIMING', 'UPLOADING', 'PROCESSING', 'SAVING'].includes(state)) {
      throw new Error(`ALRIZ_INVALID_JOB_STATUS job=${jobId}`);
    }
  }
  throw new Error(`ALRIZ_JOB_TIMEOUT job=${jobId}`);
}
