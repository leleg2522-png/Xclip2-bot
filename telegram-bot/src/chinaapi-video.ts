import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

export const CHINA_VIDEO_MODELS = {
  kling_omni: { label: 'Kling Omni', model: 'kling-v3-omni', duration: 15, resolution: '720p', price: 2000 },
  kling_v3: { label: 'Kling V3', model: 'kling-v3', duration: 15, resolution: '720p', price: 2000 },
  wan3: { label: 'Wan 3.0', model: 'wan3.0-video', duration: 30, resolution: '480p', price: 2000 },
  seedance2: { label: 'Seedance 2.0', model: 'doubao-seedance-2-0-260128', duration: 15, resolution: '480p', price: 2000 },
} as const;
export type ChinaVideoModelKey = keyof typeof CHINA_VIDEO_MODELS;
export type ChinaVideoRatio = '9:16' | '16:9';

export function isChinaVideoModel(value: string): value is ChinaVideoModelKey {
  return Object.hasOwn(CHINA_VIDEO_MODELS, value);
}

export function chinaVideoRequest(key: ChinaVideoModelKey, image: string, prompt: string, ratio: ChinaVideoRatio) {
  if (!image.startsWith('https://') || !prompt.trim() || !['9:16', '16:9'].includes(ratio)) {
    throw new Error('CHINA_VIDEO_INVALID_INPUT');
  }
  const config = CHINA_VIDEO_MODELS[key];
  const common = { model: config.model, prompt: prompt.trim() };
  if (key === 'kling_omni') {
    return {
      ...common,
      metadata: {
        image_list: [{ image_url: image, type: 'first_frame' }],
        mode: 'std', duration: String(config.duration), aspect_ratio: ratio, sound: 'off',
      },
    };
  }
  if (key === 'kling_v3') {
    return {
      ...common, image, duration: config.duration, mode: 'std',
      metadata: { aspect_ratio: ratio, sound: 'off' },
    };
  }
  if (key === 'seedance2') {
    // First-frame mode follows the cropped image's ratio. Explicit ratio is
    // invalid in this mode; the 30-second reference contract belongs to 2.5.
    return { ...common, input_reference: image, duration: config.duration, metadata: { resolution: '480p' } };
  }
  return { ...common, input_reference: image, duration: config.duration, size: ratio === '9:16' ? '480*832' : '832*480' };
}

export class ChinaVideoClient {
  private readonly base = 'https://api.chinaapi.ai';
  constructor(
    private readonly apiKey: string,
    private readonly transport: typeof fetch = fetch,
    private readonly pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
  ) {
    if (!apiKey) throw new Error('CHINA_VIDEO_UNCONFIGURED');
  }
  private async request(endpoint: string, body?: unknown): Promise<any> {
    const response = await this.transport(this.base + endpoint, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${this.apiKey}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(90000),
    });
    if (!response.ok) throw new Error(`CHINA_VIDEO_HTTP_${response.status}`);
    const payload = await response.json();
    const data = payload?.data ?? payload;
    if (!data || payload?.success === false || (data.error && data.status !== 'failed')) {
      throw new Error('CHINA_VIDEO_INVALID_RESPONSE');
    }
    return data;
  }
  async ensureModel(key: ChinaVideoModelKey): Promise<void> {
    const models = await this.request('/v1/models');
    if (!Array.isArray(models) || !models.some(model => model.id === CHINA_VIDEO_MODELS[key].model)) {
      throw new Error('CHINA_VIDEO_MODEL_UNAVAILABLE');
    }
  }
  async submit(body: ReturnType<typeof chinaVideoRequest>): Promise<string> {
    // No retry: even a network timeout may hide an accepted, billable job.
    const accepted = await this.request('/v1/videos', body);
    const id = accepted.task_id ?? accepted.id;
    if (typeof id !== 'string' || !id) throw new Error('CHINA_VIDEO_MISSING_TASK_ID');
    return id;
  }
  async poll(id: string, progress: (value: number) => Promise<void>, maxAttempts = 160): Promise<void> {
    let failures = 0;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      let run;
      try {
        run = await this.request(`/v1/videos/${encodeURIComponent(id)}`);
        failures = 0;
      } catch (error) {
        if (/HTTP_40[134]/.test(String(error)) || ++failures >= 6) throw error;
        await this.pause(15000);
        continue;
      }
      if (run.status === 'failed' || run.status === 'cancelled' || run.status === 'canceled') {
        throw new Error('CHINA_VIDEO_GENERATION_FAILED');
      }
      if (run.status === 'completed') return;
      if (!['queued', 'in_progress', 'processing', 'pending', 'running'].includes(run.status)) {
        throw new Error('CHINA_VIDEO_UNKNOWN_STATUS');
      }
      if (Number.isFinite(run.progress)) await progress(Math.max(0, Math.min(100, run.progress)));
      await this.pause(15000);
    }
    throw new Error('CHINA_VIDEO_POLL_TIMEOUT');
  }
  async download(id: string): Promise<Buffer> {
    const response = await this.transport(`${this.base}/v1/videos/${encodeURIComponent(id)}/content`, {
      headers: { Authorization: `Bearer ${this.apiKey}` }, signal: AbortSignal.timeout(180000),
    });
    if (!response.ok || !response.body) throw new Error('CHINA_VIDEO_DOWNLOAD_FAILED');
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 250 * 1024 * 1024) {
          await reader.cancel();
          throw new Error('CHINA_VIDEO_OUTPUT_TOO_LARGE');
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    if (!size) throw new Error('CHINA_VIDEO_EMPTY_OUTPUT');
    return Buffer.concat(chunks);
  }
}

export function validateChinaVideoFacts(key: ChinaVideoModelKey, ratio: ChinaVideoRatio, probe: any) {
  const config = CHINA_VIDEO_MODELS[key];
  const video = probe.streams?.find((stream: any) => stream.codec_type === 'video');
  const streamDuration = Number(video?.duration);
  const duration = Number.isFinite(streamDuration) ? streamDuration : Number(probe.format?.duration);
  const shortest = Math.min(video?.width, video?.height);
  const expectedAspect = ratio === '9:16' ? 9 / 16 : 16 / 9;
  if (!video || !Number.isFinite(duration) || Math.abs(duration - config.duration) > 0.25
    || shortest !== Number.parseInt(config.resolution)
    || Math.abs(video.width / video.height - expectedAspect) > 0.025) {
    throw new Error('CHINA_VIDEO_OUTPUT_MISMATCH');
  }
  return { width: video.width as number, height: video.height as number, duration };
}

export async function inspectChinaVideo(key: ChinaVideoModelKey, ratio: ChinaVideoRatio, buffer: Buffer) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'china-video-'));
  try {
    const file = path.join(directory, 'result.mp4');
    await fs.writeFile(file, buffer);
    const { stdout } = await promisify(execFile)('ffprobe', [
      '-v', 'error', '-show_streams', '-show_format', '-of', 'json', file,
    ], { timeout: 30000, maxBuffer: 1024 * 1024 });
    return validateChinaVideoFacts(key, ratio, JSON.parse(stdout));
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
