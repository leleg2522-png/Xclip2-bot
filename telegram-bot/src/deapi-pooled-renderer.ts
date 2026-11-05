import { DeapiDramaRenderer, type DramaRenderer } from './microdrama-deapi';
import type { DeapiKeySource } from './deapi-key-pool';
import { DeapiRateLimitError } from './deapi-rate-limit';
import { MICRODRAMA_SETTINGS } from './microdrama-plan';

/** Rotation requires pre-submit preparation or an explicit unaccepted rate rejection. */
export class PooledDeapiRenderer implements DramaRenderer {
  private cooldowns = new Map<string, number>();
  constructor(private pool: DeapiKeySource,
    private client: (key: string) => DramaRenderer = key => new DeapiDramaRenderer(key),
    private now: () => number = Date.now,
    private model: string = MICRODRAMA_SETTINGS.model) {}

  private scope(frame?: Buffer): string {
    return `videos/${frame ? 'animations' : 'generations'}:${this.model}`;
  }

  private bucket(keyId: number, frame?: Buffer): string {
    return `${keyId}:${this.scope(frame)}`;
  }

  async prepare(prompt: string, frame?: Buffer, skipIds: number[] = []): Promise<{ price: number; keyId: number }> {
    const skip: number[] = [...new Set(skipIds)];
    while (skip.length < 100) {
      const key = await this.pool.next(skip, ['quotes', this.scope(frame)]);
      if (!key || skip.includes(key.id)) break;
      skip.push(key.id);
      const bucket = this.bucket(key.id, frame);
      if ((this.cooldowns.get(bucket) ?? 0) > this.now()) continue;
      this.cooldowns.delete(bucket);
      try {
        return { price: await this.client(key.apiKey).quote(prompt, frame), keyId: key.id };
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        // 403 can mean plan/permission limits, not a dead token. Do NOT probe /account/balance.
        if (code === 'DEAPI_QUOTE_HTTP_401') { await this.pool.disable(key.id); continue; }
        if (code === 'DEAPI_QUOTE_HTTP_402' || code === 'DEAPI_QUOTE_HTTP_403') continue;
        if (code === 'DEAPI_QUOTE_HTTP_429') {
          const retryAt = error instanceof DeapiRateLimitError ? error.retryAt : this.now() + 60_000;
          await this.pool.markLimited(key.id, 'quotes', retryAt);
          this.cooldowns.set(bucket, retryAt);
          continue;
        }
        throw error;
      }
    }
    throw new Error('DEAPI_POOL_NO_USABLE_KEY');
  }

  async quote(prompt: string, frame?: Buffer): Promise<number> {
    return (await this.prepare(prompt, frame)).price;
  }

  private async bound(keyId?: number): Promise<DramaRenderer> {
    if (!keyId) throw new Error('DEAPI_JOB_KEY_UNKNOWN');
    const key = await this.pool.get(keyId);
    if (!key) throw new Error('DEAPI_JOB_KEY_MISSING');
    return this.client(key.apiKey);
  }

  async submit(prompt: string, seed: number, frame?: Buffer, keyId?: number): Promise<string> {
    try {
      return await (await this.bound(keyId)).submit(prompt, seed, frame);
    } catch (error) {
      if (keyId && error instanceof DeapiRateLimitError && error.phase === 'SUBMIT') {
        await this.pool.markLimited(keyId, this.scope(frame), error.retryAt);
        this.cooldowns.set(this.bucket(keyId, frame), error.retryAt);
      }
      throw error;
    }
  }

  async poll(id: string, keyId?: number): Promise<string> {
    return (await this.bound(keyId)).poll(id);
  }

  async download(url: string): Promise<Buffer> {
    // Result downloads do not carry API credentials, including to the provider CDN.
    return this.client('').download(url);
  }
}
