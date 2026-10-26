import axios from 'axios';
import type { AlrizKeySource } from './alriz-key-pool';

export const SEEDANCE25_RATIOS = ['16:9', '9:16', '1:1', '3:4', '4:3', '21:9'] as const;
export type Seedance25Settings = {
  mode: 't2v' | 'start' | 'start_end' | 'reference';
  resolution: 720 | 1080;
  audio: boolean;
  ratio: string;
};
type Http = {
  post: (url: string, body: any, config: any) => Promise<{ status: number; data: any }>;
  get: (url: string, config: any) => Promise<{ status: number; data: any }>;
};
const http = axios.create({ proxy: false, timeout: 120_000 });
const BASE = 'https://alrizmotion.my.id/api';

function safeUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !u.username && !u.password
      && !/(^|\.)telegram\.org$/i.test(u.hostname)
      && !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|\[)/i.test(u.hostname)
      && !/^172\.(1[6-9]|2\d|3[01])\./.test(u.hostname);
  } catch { return false; }
}

export function buildAlrizSeedance25(
  settings: Seedance25Settings, prompt: string, images: string[],
) {
  if (!['t2v', 'start', 'start_end', 'reference'].includes(settings.mode)
    || ![720, 1080].includes(settings.resolution) || typeof settings.audio !== 'boolean'
    || ![...SEEDANCE25_RATIOS, ...(settings.mode === 't2v' ? [] : ['auto'])].includes(settings.ratio as any)
    || !prompt.trim() || prompt.length > 20000) throw Error('SEEDANCE25_INVALID_SETTINGS');
  const count = images.length;
  if ((settings.mode === 't2v' && count !== 0)
    || (settings.mode === 'start' && count !== 1)
    || (settings.mode === 'start_end' && count !== 2)
    || (settings.mode === 'reference' && (count < 1 || count > 3))
    || images.some(url => !safeUrl(url))) throw Error('SEEDANCE25_INVALID_IMAGES');
  return {
    model: settings.mode === 't2v' ? 'seedance-2.5-t2v' : 'seedance-2.5-i2v',
    op: settings.mode === 't2v' ? 't2v' : 'i2v',
    prompt: prompt.trim(), duration: 30, resolution: settings.resolution,
    audio: settings.audio, aspect_ratio: settings.ratio,
    ...(settings.mode === 'start' ? { start_url: images[0] } : {}),
    ...(settings.mode === 'start_end' ? { start_url: images[0], end_url: images[1] } : {}),
    ...(settings.mode === 'reference' ? { ref_urls: images } : {}),
  };
}

export async function generateAlrizSeedance25(
  input: { settings: Seedance25Settings; prompt: string; images: Buffer[] },
  api: {
    pool: AlrizKeySource;
    publish: (bytes: Buffer) => Promise<string>;
    status: (text: string) => Promise<void>;
    onAccepted?: (jobId: string, keyId: number) => void;
    http?: Http; wait?: (ms: number) => Promise<void>; maxPolls?: number;
  },
): Promise<string> {
  // Validate before uploads or a paid submit. Dummy URLs are validation-only.
  buildAlrizSeedance25(input.settings, input.prompt, input.images.map(() => 'https://media.example.test/image.jpg'));
  if (input.images.some(b => !b.length || b.length > 10 * 1024 * 1024)) throw Error('SEEDANCE25_INVALID_IMAGE_SIZE');
  const images = await Promise.all(input.images.map(api.publish));
  const body = buildAlrizSeedance25(input.settings, input.prompt, images);
  const transport = api.http ?? http;
  const wait = api.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const skipped: number[] = [];
  while (skipped.length < 20) {
    const key = await api.pool.next(skipped);
    if (!key) throw Error('ALRIZ_POOL_NO_AVAILABLE_KEY');
    skipped.push(key.id);
    const config = { headers: { 'X-API-Key': key.apiKey, Accept: 'application/json' },
      proxy: false, timeout: 120_000, validateStatus: () => true };
    await api.status('⏳ Seedance 2.5: mengirim perintah...');
    let submitted;
    try { submitted = await transport.post(`${BASE}/jobs`, body, config); }
    catch { throw Error('ALRIZ_SUBMIT_AMBIGUOUS_NO_REPLAY'); }
    if ([401, 402, 403].includes(submitted.status)) {
      await api.pool.disable(key.id);
      continue;
    }
    if (submitted.status < 200 || submitted.status >= 300) throw Error(`ALRIZ_SUBMIT_HTTP_${submitted.status}`);
    const jobId = submitted.data?.job_id;
    if (typeof jobId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(jobId)) throw Error('ALRIZ_SUBMIT_MISSING_JOB_NO_REPLAY');
    api.onAccepted?.(jobId, key.id);
    // There is deliberately no account retry around this accepted job.
    await api.status('⏳ Seedance 2.5: video sedang dibuat. Hasil dikirim otomatis.');
    for (let n = 0; n < (api.maxPolls ?? 240); n++) {
      await wait(5000);
      let response;
      try { response = await transport.get(`${BASE}/jobs/${jobId}`, config); }
      catch { continue; }
      if (response.status === 429 || response.status >= 500) continue;
      if ([401, 403].includes(response.status)) await api.pool.disable(key.id);
      if (response.status !== 200) throw Error(`ALRIZ_POLL_HTTP_${response.status} job=${jobId}`);
      const job = response.data?.job ?? response.data;
      if (job.status === 'DONE') {
        if (job.result_expired) throw Error(`ALRIZ_RESULT_EXPIRED job=${jobId}`);
        let url = job.result_url;
        if (!url) {
          let result;
          try { result = await transport.get(`${BASE}/jobs/${jobId}/result`, config); }
          catch { continue; }
          if (result.status === 409 || result.status === 429 || result.status >= 500) continue;
          if ([401, 403].includes(result.status)) await api.pool.disable(key.id);
          if (result.status !== 200) throw Error(`ALRIZ_RESULT_HTTP_${result.status} job=${jobId}`);
          url = result.data?.result_url;
        }
        if (!safeUrl(url)) throw Error(`ALRIZ_INVALID_RESULT_URL job=${jobId}`);
        return url;
      }
      if (!['QUEUED', 'CLAIMING', 'UPLOADING', 'PROCESSING', 'SAVING'].includes(job.status)) {
        throw Error(`ALRIZ_JOB_FAILED job=${jobId}`);
      }
    }
    throw Error(`ALRIZ_JOB_TIMEOUT job=${jobId}`);
  }
  throw Error('ALRIZ_POOL_NO_AVAILABLE_KEY');
}
