import { DeapiDramaRenderer, type DramaRenderer } from './microdrama-deapi';
import type { DeapiKeySource } from './deapi-key-pool';

/** Pool rotation exists only during non-billable preparation. Paid calls never rotate or retry. */
export class PooledDeapiRenderer implements DramaRenderer {
  constructor(private pool: DeapiKeySource,
    private client: (key: string) => DramaRenderer = key => new DeapiDramaRenderer(key)) {}

  async prepare(prompt: string, frame?: Buffer): Promise<{ price: number; keyId: number }> {
    const skip: number[] = [];
    while (skip.length < 100) {
      const key = await this.pool.next(skip);
      if (!key || skip.includes(key.id)) break;
      skip.push(key.id);
      try {
        return { price: await this.client(key.apiKey).quote(prompt, frame), keyId: key.id };
      } catch (error) {
        const code = error instanceof Error ? error.message : '';
        // 403 can mean plan/permission limits, not a dead token. Do NOT probe /account/balance.
        if (code === 'DEAPI_QUOTE_HTTP_401') { await this.pool.disable(key.id); continue; }
        if (code === 'DEAPI_QUOTE_HTTP_402' || code === 'DEAPI_QUOTE_HTTP_403') continue;
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
    return (await this.bound(keyId)).submit(prompt, seed, frame);
  }

  async poll(id: string, keyId?: number): Promise<string> {
    return (await this.bound(keyId)).poll(id);
  }

  async download(url: string): Promise<Buffer> {
    // Result downloads do not carry API credentials, including to the provider CDN.
    return this.client('').download(url);
  }
}
