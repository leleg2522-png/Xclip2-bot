import { DeapiDramaRenderer } from './microdrama-deapi';
import { PooledDeapiRenderer } from './deapi-pooled-renderer';
import { DeapiRateLimitError } from './deapi-rate-limit';
import { DeapiAccountSuspendedError } from './deapi-rejections';
import type { DeapiKeySource } from './deapi-key-pool';

export const BUDGET_VIDEO_MODELS = {
  vela: { label: 'Vela AI', duration: 5, quality: '720p', price: 500, imageRequired: true, endFrame: true },
  muse: { label: 'MUSE AI', duration: 10, quality: 'resolusi otomatis', price: 500, imageRequired: false, endFrame: false },
  deapi_ltx: { label: 'LTX 2.5 · Paket Hemat', duration: 10, quality: 'native', price: 500, imageRequired: false, endFrame: false },
  deapi_h3: { label: 'MiniMax H3 Turbo · Paket Hemat', duration: 10, quality: 'native', price: 500, imageRequired: false, endFrame: false },
} as const;
export type BudgetVideoModel = keyof typeof BUDGET_VIDEO_MODELS;
export type VideoRatio = '9:16' | '16:9' | '1:1';
export interface VideoImage { bytes: Buffer; mime: string }
export interface BudgetVideoInput { model: BudgetVideoModel; ratio: VideoRatio; prompt: string; images: VideoImage[] }
export function isBudgetVideoModel(value: string): value is BudgetVideoModel {
  return Object.hasOwn(BUDGET_VIDEO_MODELS, value);
}

function snapgenVideoFailure(history: any): Error {
  const raw = history?.error_code || history?.generated_video?.[0]?.error_code;
  if (raw === 'HIGH_TRAFFIC_ERROR') return Error('SNAPGEN_HIGH_TRAFFIC');
  if (raw === 'CONTENT_MODERATION_ERROR') return Error('SNAPGEN_CONTENT_MODERATION');
  const suffix = typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,47}$/.test(raw) ? `_${raw}` : '';
  return Error(`SNAPGEN_JOB_FAILED${suffix}`);
}

export function validateBudgetVideo(input: BudgetVideoInput) {
  if (!isBudgetVideoModel(input.model) || !['9:16', '16:9', '1:1'].includes(input.ratio)
    || !input.prompt.trim() || input.prompt.length > 20_000) throw Error('VIDEO_INPUT_INVALID');
  const config = BUDGET_VIDEO_MODELS[input.model];
  if ((config.imageRequired && !input.images.length) || input.images.length > (config.endFrame ? 2 : 1)
    || input.images.some(i => !i.bytes.length || i.bytes.length > 10 * 1024 * 1024 || !['image/jpeg','image/png','image/webp'].includes(i.mime))) {
    throw Error('VIDEO_IMAGE_INVALID');
  }
}

export class BudgetVideoApi {
  constructor(private pool: DeapiKeySource, private snapgenKey: string | undefined,
    private request: typeof fetch = fetch, private sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))) {}

  async generate(input: BudgetVideoInput, accepted: (id: string, keyId?: number) => void = () => {}): Promise<string> {
    validateBudgetVideo(input);
    if (input.model === 'vela' || input.model === 'muse') return this.snapgen(input, accepted);
    const model = input.model === 'deapi_ltx' ? 'Ltx2_5_22B_Dist_INT8' : 'MiniMaxH3_33B_Turbo_INT8';
    const [width, height] = input.ratio === '16:9' ? [1344, 768] : input.ratio === '1:1' ? [768, 768] : [768, 1344];
    const settings = { model, width, height, frames: input.model === 'deapi_ltx' ? 241 : 240, fps: 24 };
    const renderer = new PooledDeapiRenderer(this.pool,
      key => new DeapiDramaRenderer(key, this.request, this.sleep, settings), Date.now, model);
    const skipped: number[] = [], frame = input.images[0]?.bytes;
    while (skipped.length < 100) {
      const { keyId } = await renderer.prepare(input.prompt, frame, skipped);
      let id: string;
      try { id = await renderer.submit(input.prompt, 71, frame, keyId); }
      catch (error) {
        if (!(error instanceof DeapiRateLimitError || error instanceof DeapiAccountSuspendedError)
          || error.phase !== 'SUBMIT') throw error;
        skipped.push(keyId);
        continue;
      }
      accepted(id, keyId);
      return renderer.poll(id, keyId); // Never replay a paid submit after acceptance.
    }
    throw Error('DEAPI_POOL_NO_USABLE_KEY');
  }

  private async snapgen(input: BudgetVideoInput, accepted: (id: string) => void): Promise<string> {
    if (!this.snapgenKey) throw Error('SNAPGEN_KEY_MISSING');
    const model = input.model === 'vela' ? 'vela-ai-video' : 'muse-ai-video';
    const headers = { 'x-api-key': this.snapgenKey, Accept: 'application/json' };
    const body = new FormData();
    body.set('prompt', input.prompt.trim()); body.set('model', model);
    body.set('duration', String(BUDGET_VIDEO_MODELS[input.model].duration));
    body.set('orientation', input.ratio === '9:16' ? 'portrait' : input.ratio === '16:9' ? 'landscape' : 'square');
    if (input.model === 'vela') body.set('resolution', '720p');
    input.images.forEach((image, i) => {
      const extension = ({ 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' } as Record<string, string>)[image.mime];
      // SnapGen validates the filename extension as well as the Content-Type.
      body.append('files', new Blob([new Uint8Array(image.bytes)], { type: image.mime }), `frame-${i + 1}.${extension}`);
    });
    const r = await this.request(`https://api.snapgen.ai/uapi/v1/video-gen/${input.model}`, {
      method: 'POST', headers, body, signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) {
      const rejection: any = await r.json().catch(() => null);
      const rawCode = rejection?.detail?.error_code ?? rejection?.error_code;
      // Retain only a bounded machine code, never raw upstream text, URLs or inputs.
      const code = typeof rawCode === 'string' && /^[A-Z][A-Z0-9_]{0,47}$/.test(rawCode) ? `_${rawCode}` : '';
      throw Error(`SNAPGEN_SUBMIT_HTTP_${r.status}${code}`);
    }
    const result: any = await r.json();
    if (typeof result.uuid !== 'string' || !result.uuid) throw Error('SNAPGEN_SUBMIT_UNCERTAIN');
    accepted(result.uuid);
    if (result.model_name !== model) throw Error('SNAPGEN_MODEL_MISMATCH');
    if (Number(result.status) === 3) throw snapgenVideoFailure(result);
    for (let attempt = 0; attempt < 90; attempt++) {
      await this.sleep(10_000);
      const poll = await this.request(`https://api.snapgen.ai/uapi/v1/history/${encodeURIComponent(result.uuid)}`, {
        headers, signal: AbortSignal.timeout(60_000),
      });
      if (poll.status === 429) {
        await this.sleep(Math.min(120, Math.max(10, Number(poll.headers.get('retry-after')) || 30)) * 1000);
        continue;
      }
      if (!poll.ok) throw Error(`SNAPGEN_POLL_HTTP_${poll.status}`);
      const history: any = await poll.json();
      if (history.model_name !== model) throw Error('SNAPGEN_MODEL_MISMATCH');
      const video = history.generated_video?.[0];
      if (Number(history.status) === 3 || Number(video?.status) === 3) {
        throw snapgenVideoFailure(history);
      }
      if (Number(history.status) === 2 || Number(video?.status) === 2) {
        if (typeof video?.video_url !== 'string' || !video.video_url.startsWith('https://')) throw Error('SNAPGEN_RESULT_INVALID');
        return video.video_url;
      }
    }
    throw Error('SNAPGEN_POLL_TIMEOUT');
  }
}
