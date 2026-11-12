import { inspectWanReferenceVideo } from './vivareel-wan-media';
import { generationFailure } from './generation-errors';

export type WanRatio = '9:16' | '16:9';
export interface WanImage { buffer: Buffer; name?: string; mime?: string }
export interface WanInput {
  prompt: string;
  ratio?: WanRatio;
  images?: WanImage[];
  video?: WanImage;
  onStatus?: (stage: 'upload' | 'submit' | 'poll' | 'export') => void;
  onPoll?: (elapsedSec: number) => void;
}
const BASE = 'https://vivareel.ai/api/developer/v1';
export const VIVAREEL_WAN_MODEL = 'dashscope-wan3.0-video';
export const WAN_REFERENCE_MAX_BYTES = 19 * 1024 * 1024;

export function wanOutputDuration(referenceSeconds?: number): number {
  if (referenceSeconds === undefined) return 30;
  if (!Number.isFinite(referenceSeconds) || referenceSeconds < 1 || referenceSeconds > 15) {
    throw Error('WAN_REFERENCE_DURATION_INVALID');
  }
  return Math.floor(30 - referenceSeconds);
}

export function wanRequest(prompt: string, ratio: WanRatio, urls: string[] = [],
  referenceVideo?: { url: string; duration: number }) {
  if (!prompt.trim() || !['9:16', '16:9'].includes(ratio) || urls.length > 5) {
    throw Error('WAN_INVALID_INPUT');
  }
  if (urls.some(url => !url.startsWith('https://'))) throw Error('WAN_INVALID_IMAGE_URL');
  if (referenceVideo && !referenceVideo.url.startsWith('https://')) throw Error('WAN_INVALID_VIDEO_URL');
  return {
    model: VIVAREEL_WAN_MODEL, motion_instruction: prompt, aspect_ratio: ratio,
    duration_seconds: wanOutputDuration(referenceVideo?.duration), resolution: '480P', audio: true,
    prompt_extend: false, smart_duration: false, watermark: false,
    ...(referenceVideo ? { capability: 'image_reference', reference_video_urls: [referenceVideo.url],
      ...(urls.length ? { reference_urls: urls } : {}) }
      : urls.length === 1 ? { capability: 'first_frame', image_url: urls[0] }
      : urls.length > 1 ? { capability: 'image_reference', reference_urls: urls } : {}),
  };
}

export class VivareelWanClient {
  constructor(
    private readonly key: string,
    private readonly transport: typeof fetch = fetch,
    private readonly pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
  ) {
    if (!key) throw Error('VIVAREEL_UNCONFIGURED');
  }
  private async request(path: string, body?: Record<string, unknown> | FormData): Promise<any> {
    const multipart = body instanceof FormData;
    let response: Response;
    try {
      response = await this.transport(BASE + path, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${this.key}`,
          ...(!multipart && body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: multipart ? body : JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(90000),
      });
    } catch {
      // Never include transport errors that may contain credentials or signed URLs.
      throw Error(path === '/videos/generations' ? 'VIVAREEL_SUBMIT_AMBIGUOUS' : 'VIVAREEL_NETWORK_ERROR');
    }
    if (!response.ok) {
      const detail = await response.json().catch(() => undefined);
      throw generationFailure(`VIVAREEL_HTTP_${response.status}`, detail);
    }
    const json = await response.json().catch(() => { throw Error('VIVAREEL_INVALID_RESPONSE'); });
    if (json.code !== 200 || !json.data) throw generationFailure('VIVAREEL_REJECTED_RESPONSE', json);
    return json.data;
  }
  async upload(image: WanImage, video = false): Promise<string> {
    if (!image.buffer.length || image.buffer.length > (video ? WAN_REFERENCE_MAX_BYTES : 20 * 1024 * 1024)) {
      throw Error(video ? 'WAN_INVALID_VIDEO' : 'WAN_INVALID_IMAGE');
    }
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(image.buffer)], { type: image.mime ?? (video ? 'video/mp4' : 'image/jpeg') }),
      image.name ?? (video ? 'reference.mp4' : 'reference.jpg'));
    const data = await this.request('/files', form);
    if (typeof data.url !== 'string' || !data.url.startsWith('https://')) throw Error('VIVAREEL_UPLOAD_FAILED');
    return data.url;
  }
  async submit(body: ReturnType<typeof wanRequest>): Promise<string> {
    // Exactly one paid POST. No credential rotation, provider fallback or submit retry.
    const data = await this.request('/videos/generations', body);
    if (typeof data.task_id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(data.task_id)) {
      throw Error('VIVAREEL_MISSING_TASK_ID');
    }
    console.log(`[wan] accepted task=${data.task_id}`);
    return data.task_id;
  }
  async poll(taskId: string, onPoll?: WanInput['onPoll'], maxAttempts = 540) {
    const start = Date.now();
    let failures = 0;
    for (let attempt = 0; attempt < maxAttempts && Date.now() - start < 45 * 60 * 1000; attempt++) {
      await this.pause(5000);
      let data;
      try {
        data = await this.request(`/tasks/${encodeURIComponent(taskId)}`);
        failures = 0;
      } catch (error) {
        if (/HTTP_40[134]/.test(String(error)) || ++failures >= 6) throw error;
        await this.pause(10000);
        continue;
      }
      onPoll?.(Math.floor((Date.now() - start) / 1000));
      if (['failed', 'cancelled', 'canceled'].includes(data.status)) {
        throw generationFailure('VIVAREEL_GENERATION_FAILED', {
          message: data.error_message, error: data.error, code: data.error_code, reason: data.failure_reason,
        });
      }
      if (data.status === 'completed') {
        if (typeof data.result_url !== 'string' || !data.result_url.startsWith('https://')) {
          throw Error('VIVAREEL_MISSING_RESULT');
        }
        return { url: data.result_url, credits: data.extra?.billing_points ?? data.points_cost };
      }
      if (!['pending', 'queued', 'processing', 'running', 'in_progress', 'submitted'].includes(data.status)) {
        throw Error('VIVAREEL_UNKNOWN_STATUS');
      }
    }
    throw Error('VIVAREEL_TIMEOUT');
  }
  async generate(input: WanInput) {
    const images = input.images ?? [];
    const ratio = input.ratio ?? '9:16';
    wanRequest(input.prompt, ratio); // Validate before any upload or billable action.
    if (images.length > 5) throw Error('WAN_TOO_MANY_IMAGES');
    const referenceSeconds = input.video ? await inspectWanReferenceVideo(input.video.buffer) : undefined;
    const durationSeconds = wanOutputDuration(referenceSeconds);
    const catalog = await this.request('/models');
    const model = catalog.video_models?.find((m: any) => m.name === VIVAREEL_WAN_MODEL);
    const capability = input.video ? 'image_reference'
      : images.length === 1 ? 'first_frame' : images.length > 1 ? 'image_reference' : 'text_to_video';
    const maxDuration = model?.max_duration_seconds?.[capability];
    if (!model?.is_available || !model.allowed_resolutions?.includes('480P')
      || !model.capabilities?.includes(capability) || !Number.isFinite(maxDuration) || maxDuration < durationSeconds
      || ((images.length > 1 || input.video) && !(model.max_reference_images >= images.length))
      || (input.video && !(model.max_reference_videos >= 1))) {
      throw Error('VIVAREEL_MODEL_UNAVAILABLE');
    }
    const urls: string[] = [];
    if (images.length || input.video) input.onStatus?.('upload');
    for (const image of images) urls.push(await this.upload(image));
    const videoUrl = input.video ? await this.upload(input.video, true) : undefined;
    input.onStatus?.('submit');
    const id = await this.submit(wanRequest(input.prompt, ratio, urls,
      videoUrl ? { url: videoUrl, duration: referenceSeconds! } : undefined));
    input.onStatus?.('poll');
    return { ...await this.poll(id, input.onPoll), durationSeconds };
  }
}

export function generateVivareelWan(input: WanInput) {
  return new VivareelWanClient(process.env.VIVAREEL_API_KEY ?? '').generate(input);
}
