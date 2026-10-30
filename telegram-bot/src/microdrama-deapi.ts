import { MICRODRAMA_SETTINGS } from './microdrama-plan';

export interface DramaRenderer {
  quote(prompt: string, frame?: Buffer): Promise<number>;
  submit(prompt: string, seed: number, frame?: Buffer): Promise<string>;
  poll(id: string): Promise<string>;
  download(url: string): Promise<Buffer>;
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export class DeapiDramaRenderer implements DramaRenderer {
  constructor(private key: string, private request: typeof fetch = fetch, private sleep = wait) {}

  private headers() { return { Authorization: `Bearer ${this.key}`, Accept: 'application/json' }; }

  private payload(prompt: string, seed: number, frame?: Buffer): { body: string | FormData; headers: Record<string, string> } {
    const data = { ...MICRODRAMA_SETTINGS, prompt, seed };
    if (!frame) return { body: JSON.stringify(data), headers: { ...this.headers(), 'Content-Type': 'application/json' } };
    const body = new FormData();
    Object.entries(data).forEach(([key, value]) => body.append(key, String(value)));
    body.append('first_frame_image', new Blob([new Uint8Array(frame)], { type: 'image/png' }), 'continuity.png');
    return { body, headers: this.headers() };
  }

  private async send(prompt: string, seed: number, frame: Buffer | undefined, quote: boolean) {
    const endpoint = frame ? 'animations' : 'generations';
    const r = await this.request(`https://api.deapi.ai/api/v2/videos/${endpoint}${quote ? '/price' : ''}`, {
      method: 'POST', ...this.payload(prompt, seed, frame), signal: AbortSignal.timeout(quote ? 60_000 : 120_000),
    });
    if (!r.ok) throw new Error(`DEAPI_${quote ? 'QUOTE' : 'SUBMIT'}_HTTP_${r.status}`);
    return await r.json() as any;
  }

  async quote(prompt: string, frame?: Buffer): Promise<number> {
    const body = await this.send(prompt, 71, frame, true);
    const price = Number(body.data?.price);
    if (body.data?.is_estimated !== false || !Number.isFinite(price) || price <= 0 || price > 0.30) {
      throw new Error('DEAPI_QUOTE_OVER_LIMIT');
    }
    return price;
  }

  async submit(prompt: string, seed: number, frame?: Buffer): Promise<string> {
    const body = await this.send(prompt, seed, frame, false);
    const id = body.data?.request_id;
    if (typeof id !== 'string' || !id) throw new Error('DEAPI_SUBMIT_NO_ID');
    return id;
  }

  async poll(id: string): Promise<string> {
    for (let n = 0; n < 135; n++) {
      const r = await this.request(`https://api.deapi.ai/api/v2/jobs/${encodeURIComponent(id)}`, {
        headers: this.headers(), signal: AbortSignal.timeout(60_000),
      });
      if (r.status === 429) {
        await this.sleep(Math.min(120, Math.max(20, Number(r.headers.get('retry-after')) || 60)) * 1000);
        continue;
      }
      if (!r.ok) throw new Error(`DEAPI_POLL_HTTP_${r.status}`);
      const body = await r.json() as any;
      const status = body.data?.status;
      if (['failed', 'error'].includes(status)) throw new Error('DEAPI_JOB_FAILED');
      if (status === 'done') {
        const url = body.data?.result_url;
        if (typeof url !== 'string' || !url.startsWith('https://')) throw new Error('DEAPI_RESULT_INVALID');
        return url;
      }
      await this.sleep(20_000);
    }
    throw new Error('DEAPI_POLL_PAUSED');
  }

  async download(url: string): Promise<Buffer> {
    if (!url.startsWith('https://')) throw new Error('DEAPI_RESULT_INVALID');
    const r = await this.request(url, { signal: AbortSignal.timeout(180_000) });
    if (!r.ok) throw new Error('DEAPI_DOWNLOAD_FAILED');
    const limit = 64 * 1024 * 1024;
    if (Number(r.headers.get('content-length')) > limit || !r.body) throw new Error('DEAPI_DOWNLOAD_SIZE');
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for await (const chunk of r.body as any) {
      bytes += chunk.length;
      if (bytes > limit) { await r.body.cancel().catch(() => {}); throw new Error('DEAPI_DOWNLOAD_SIZE'); }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
}
