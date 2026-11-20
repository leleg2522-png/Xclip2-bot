import axios from 'axios';
import type { AlrizKeySource } from './alriz-key-pool';

export const ALRIZ_KLING_25_P2 = {
  model: 'kling-2.5-turbo',
  duration: 10,
  resolution: 1080,
  credits: 1000,
} as const;

const API_BASE = 'https://alrizmotion.my.id/api';
const directHttp = axios.create({ proxy: false, timeout: 120_000 });
type Response = { status: number; data: any };
type Api = {
  apiKey?: string;
  publish: (bytes: Buffer) => Promise<string>;
  status: (text: string) => Promise<void>;
  http?: {
    post: (url: string, body: any, config: any) => Promise<Response>;
    get: (url: string, config: any) => Promise<Response>;
  };
  wait?: (ms: number) => Promise<void>;
  maxPolls?: number;
};

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

/** Only explicit submit rejections may rotate keys; accepted or ambiguous jobs are never replayed. */
export async function generateAlrizKling25P2FromPool(
  input: { image: Buffer; prompt: string; publicLabel?: string },
  api: Omit<Api, 'apiKey'> & { pool: AlrizKeySource },
): Promise<string> {
  const skipped: number[] = [];
  while (skipped.length < 20) {
    const key = await api.pool.next(skipped);
    if (!key) throw new Error('ALRIZ_POOL_NO_AVAILABLE_KEY');
    skipped.push(key.id);
    try {
      return await generateAlrizKling25P2(input, { ...api, apiKey: key.apiKey });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/^ALRIZ_SUBMIT_HTTP_(401|402|403)$/.test(message)) {
        await api.pool.disable(key.id);
        continue;
      }
      if (/^ALRIZ_(POLL|RESULT)_HTTP_(401|403)\b/.test(message)) {
        await api.pool.disable(key.id);
      }
      throw error;
    }
  }
  throw new Error('ALRIZ_POOL_NO_AVAILABLE_KEY');
}

export async function generateAlrizKling25P2(
  input: { image: Buffer; prompt: string; publicLabel?: string },
  api: Api,
): Promise<string> {
  const key = api.apiKey?.trim();
  if (!key) throw new Error('ALRIZ_API_KEY_REQUIRED');
  if (!input.image.length || input.image.length > 10 * 1024 * 1024) {
    throw new Error('ALRIZ_INVALID_IMAGE_SIZE');
  }

  const prompt = input.prompt.trim();
  if (prompt.length > 3072) throw new Error('ALRIZ_INVALID_PROMPT_LENGTH');

  const label = input.publicLabel ?? 'Kling 2.1 P2';
  const http = api.http ?? directHttp;
  const config = {
    headers: { 'X-API-Key': key, Accept: 'application/json' },
    validateStatus: () => true,
    timeout: 120_000,
    proxy: false as const,
  };
  const wait = api.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));

  let imageUrl: string;
  try {
    imageUrl = await api.publish(input.image);
  } catch {
    throw new Error('ALRIZ_I2V_MEDIA_PUBLISH_FAILED');
  }
  if (!validMediaUrl(imageUrl)) throw new Error('ALRIZ_PUBLIC_MEDIA_URL_REQUIRED');

  await api.status(`⏳ ${label}: mengirim perintah...`);
  let submitted: Response;
  try {
    submitted = await http.post(`${API_BASE}/jobs`, {
      model: ALRIZ_KLING_25_P2.model,
      image_url: imageUrl,
      prompt,
      op: 'i2v',
      duration: ALRIZ_KLING_25_P2.duration,
      resolution: ALRIZ_KLING_25_P2.resolution,
    }, { ...config, headers: { ...config.headers, 'Content-Type': 'application/json' } });
  } catch {
    throw new Error('ALRIZ_SUBMIT_AMBIGUOUS');
  }
  if (submitted.status < 200 || submitted.status >= 300) {
    throw new Error(`ALRIZ_SUBMIT_HTTP_${submitted.status}`);
  }
  const jobId = submitted.data?.job_id;
  if (typeof jobId !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(jobId)) {
    throw new Error('ALRIZ_SUBMIT_NO_JOB_ID');
  }

  await api.status(`⏳ ${label}: video 10 detik 1080p sedang dibuat.\nHasil dikirim otomatis.`);
  for (let attempt = 0; attempt < (api.maxPolls ?? 240); attempt++) {
    await wait(5000);
    let response: Response;
    try {
      response = await http.get(`${API_BASE}/jobs/${jobId}`, config);
    } catch {
      continue;
    }
    if (response.status === 429 || response.status >= 500) continue;
    if (response.status !== 200) throw new Error(`ALRIZ_POLL_HTTP_${response.status} job=${jobId}`);

    const job = response.data;
    const state = String(job?.status ?? '').toUpperCase();
    if (state === 'DONE') {
      if (job.result_expired) throw new Error(`ALRIZ_RESULT_EXPIRED job=${jobId}`);
      let resultUrl = job.result_url;
      if (!resultUrl) {
        let result: Response;
        try {
          result = await http.get(`${API_BASE}/jobs/${jobId}/result`, config);
        } catch {
          throw new Error(`ALRIZ_RESULT_REQUEST_FAILED job=${jobId}`);
        }
        if (result.status !== 200) throw new Error(`ALRIZ_RESULT_HTTP_${result.status} job=${jobId}`);
        resultUrl = result.data?.result_url;
      }
      if (!validMediaUrl(resultUrl)) throw new Error(`ALRIZ_INVALID_RESULT_URL job=${jobId}`);
      return resultUrl;
    }
    if (state === 'FAILED' || state === 'NO_STOCK') {
      const code = typeof job.error_code === 'string' && /^[A-Z0-9_]{1,48}$/.test(job.error_code)
        ? ` code=${job.error_code}` : '';
      throw new Error(`ALRIZ_JOB_${state} job=${jobId}${code}`);
    }
    if (!['QUEUED', 'CLAIMING', 'UPLOADING', 'PROCESSING', 'SAVING'].includes(state)) {
      throw new Error(`ALRIZ_INVALID_JOB_STATUS job=${jobId}`);
    }
  }
  throw new Error(`ALRIZ_JOB_TIMEOUT job=${jobId}`);
}
