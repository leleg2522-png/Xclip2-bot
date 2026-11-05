import { DeapiDramaRenderer } from './microdrama-deapi';
import { MICRODRAMA_SETTINGS } from './microdrama-plan';
import type { DeapiKeySource } from './deapi-key-pool';
import { DeapiRateLimitError, deapiRetryAt, explicitDeapiRateRejection } from './deapi-rate-limit';

export interface EpisodeRequest {
  kind: 'image' | 'video' | 'transcript'; prompt: string; images?: Buffer[]; source?: Buffer; seed: number;
}
export interface EpisodeApi {
  quote(r: EpisodeRequest, skipIds?: number[]): Promise<{ price: number; keyId: number }>;
  submit(r: EpisodeRequest, keyId: number): Promise<string>;
  result(id: string, keyId: number): Promise<Buffer>;
}

/** Immutable credential binding for every paid image, video and transcription job. */
export class DeapiEpisodeApi implements EpisodeApi {
  private cooldowns = new Map<string, number>();
  constructor(private pool: DeapiKeySource, private request: typeof fetch = fetch) {}
  private bucket(r: EpisodeRequest, keyId: number): string {
    return `${keyId}:${r.kind}:${r.kind === 'image' && r.images?.length ? 'edit' : 'generate'}`;
  }
  private body(r: EpisodeRequest, price: boolean) {
    const image = r.kind === 'image', transcript = r.kind === 'transcript';
    const edit = image && !!r.images?.length;
    const endpoint = image ? `images/${edit ? 'edits' : 'generations'}` : transcript ? 'audio/transcriptions' : 'videos/animations';
    const fields: Record<string, string | number> = image
      ? { model: 'Flux_2_Klein_4B_BF16', prompt: r.prompt, width: 768, height: 1344, steps: 4, seed: r.seed }
      : transcript ? { model: 'WhisperLargeV3Ct2', include_ts: '1', ts_level: 'segment', lang: 'id' }
        : { ...MICRODRAMA_SETTINGS, prompt: r.prompt, seed: r.seed };
    if (image && !edit) return { endpoint, body: JSON.stringify(fields), json: true };
    const form = new FormData();
    Object.entries(fields).forEach(([k, v]) => form.append(k, String(v)));
    if (edit) {
      if (r.images!.length > 3) throw new Error('EPISODE_REFERENCE_LIMIT');
      r.images!.forEach((b, i) => form.append('images[]', new Blob([new Uint8Array(b)], { type: 'image/jpeg' }), `ref-${i}.jpg`));
    } else if (transcript) {
      if (price && !r.source) form.append('duration_seconds', '10');
      else {
        if (!r.source) throw new Error('EPISODE_AUDIO_MISSING');
        form.append('source_file', new Blob([new Uint8Array(r.source)], { type: 'audio/wav' }), 'dialogue.wav');
      }
    } else {
      if (!r.images?.[0]) throw new Error('EPISODE_FRAME_MISSING');
      form.append('first_frame_image', new Blob([new Uint8Array(r.images[0])], { type: 'image/jpeg' }), 'frame.jpg');
    }
    return { endpoint, body: form, json: false };
  }
  private async send(r: EpisodeRequest, key: string, price: boolean) {
    const data = this.body(r, price);
    const res = await this.request(`https://api.deapi.ai/api/v2/${data.endpoint}${price ? '/price' : ''}`, {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, Accept: 'application/json',
        ...(data.json ? { 'Content-Type': 'application/json' } : {}) }, body: data.body,
      signal: AbortSignal.timeout(price ? 60_000 : 120_000),
    });
    if (res.status === 429) {
      const body = await res.json().catch(() => null);
      if (price || explicitDeapiRateRejection(body)) {
        throw new DeapiRateLimitError(price ? 'QUOTE' : 'SUBMIT', deapiRetryAt(res.headers));
      }
    }
    if (!res.ok) throw new Error(`EPISODE_${price ? 'QUOTE' : 'SUBMIT'}_${res.status}`);
    return await res.json() as any;
  }
  async quote(r: EpisodeRequest, skipIds: number[] = []) {
    const skip: number[] = [...new Set(skipIds)];
    while (skip.length < 100) {
      const key = await this.pool.next(skip);
      if (!key || skip.includes(key.id)) break;
      skip.push(key.id);
      const bucket = this.bucket(r, key.id);
      if ((this.cooldowns.get(bucket) ?? 0) > Date.now()) continue;
      this.cooldowns.delete(bucket);
      try {
        const q = await this.send(r, key.apiKey, true), price = Number(q.data?.price);
        const max = r.kind === 'image' ? 0.10 : r.kind === 'video' ? 0.30 : 0.03;
        // The transcription price contract returns {price} without is_estimated.
        // Its explicit ten-second duration is re-priced using the actual WAV before submit.
        const exact = q.data?.is_estimated === false || (r.kind === 'transcript' && q.data?.is_estimated === undefined);
        if (!exact || !Number.isFinite(price) || price <= 0 || price > max) throw new Error('EPISODE_PRICE_INVALID');
        return { price, keyId: key.id };
      } catch (e) {
        const code = e instanceof Error ? e.message : '';
        if (code === 'EPISODE_QUOTE_401') { await this.pool.disable(key.id); continue; }
        if (code === 'EPISODE_QUOTE_402' || code === 'EPISODE_QUOTE_403') continue;
        if (e instanceof DeapiRateLimitError && e.phase === 'QUOTE') {
          this.cooldowns.set(bucket, e.retryAt);
          continue;
        }
        throw e;
      }
    }
    throw new Error('DEAPI_POOL_NO_USABLE_KEY');
  }
  async submit(r: EpisodeRequest, keyId: number): Promise<string> {
    const key = await this.pool.get(keyId);
    if (!key) throw new Error('DEAPI_JOB_KEY_MISSING');
    let p: any;
    try { p = await this.send(r, key.apiKey, false); }
    catch (error) {
      if (error instanceof DeapiRateLimitError && error.phase === 'SUBMIT') {
        this.cooldowns.set(this.bucket(r, keyId), error.retryAt);
      }
      throw error;
    }
    if (typeof p.data?.request_id !== 'string' || !p.data.request_id) throw new Error('EPISODE_SUBMIT_NO_ID');
    return p.data.request_id;
  }
  async result(id: string, keyId: number): Promise<Buffer> {
    const key = await this.pool.get(keyId);
    if (!key) throw new Error('DEAPI_JOB_KEY_MISSING');
    const client = new DeapiDramaRenderer(key.apiKey, this.request);
    const url = await client.poll(id); // Refresh signed URL on resume; never repeat submit.
    return client.download(url);
  }
}
