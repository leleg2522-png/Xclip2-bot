/** This credential is exclusive to Botelexkey. Never fall back to another key/provider. */
export const MICRODRAMA_LLM_BASE_URL = 'https://botelexkey.store/v1';
export const MICRODRAMA_LLM_DEFAULT = 'claude-fable-5.1';
export const microdramaLlmKey = () => process.env.BOTELEX_API_KEY || '';

export class MicrodramaLlm {
  constructor(private key: string, private request: typeof fetch = fetch) {}

  async models(): Promise<string[]> {
    if (!this.key) throw new Error('LLM_KEY_MISSING');
    const r = await this.request(`${MICRODRAMA_LLM_BASE_URL}/models`, {
      headers: { Authorization: `Bearer ${this.key}` }, signal: AbortSignal.timeout(30_000),
    });
    if (!r.ok) throw new Error(`LLM_MODELS_HTTP_${r.status}`);
    const body = await r.json() as any;
    if (!Array.isArray(body.data)) throw new Error('LLM_MODELS_INVALID');
    // OpenAI catalog entries need not include enabled/available flags.
    return body.data.filter((m: any) => typeof m?.id === 'string'
      && m.enabled !== false && m.available !== false).map((m: any) => m.id);
  }

  async complete(model: string, messages: any[], tokens: number, temperature: number): Promise<string> {
    if (!(await this.models()).includes(model)) throw new Error('LLM_MODEL_UNAVAILABLE');
    // Long director requests stream so gateway idle limits do not cut off the
    // response. No automatic retry: an interrupted request may already be billed.
    const r = await this.request(`${MICRODRAMA_LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.key}`, 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(240_000),
      body: JSON.stringify({ model, messages, stream: true, max_tokens: tokens, temperature }),
    });
    if (!r.ok) throw new Error(`LLM_HTTP_${r.status}`);
    if (!(r.headers.get('content-type') || '').includes('text/event-stream')) {
      let body: any;
      try { body = await r.json(); }
      catch { throw new Error('LLM_RESPONSE_INVALID_JSON'); }
      const choice = body.choices?.[0];
      if (choice?.finish_reason === 'length') throw new Error('LLM_TRUNCATED');
      if (typeof choice?.message?.content !== 'string' || choice.message.content.length > 65_000) {
        throw new Error('LLM_RESPONSE_INVALID');
      }
      return choice.message.content;
    }
    if (!r.body) throw new Error('LLM_STREAM_MISSING');
    const decoder = new TextDecoder();
    let buffer = '', content = '', ended = false, finished = false, bytes = 0;
    const event = (block: string) => {
      const data = block.split('\n').filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart()).join('\n').trim();
      if (!data) return;
      if (data === '[DONE]') { ended = true; return; }
      let value: any;
      try { value = JSON.parse(data); }
      catch { throw new Error('LLM_STREAM_INVALID_JSON'); }
      if (value.error) throw new Error('LLM_STREAM_ERROR');
      const choice = value.choices?.[0];
      if (choice?.finish_reason === 'length') throw new Error('LLM_TRUNCATED');
      if (choice?.finish_reason) finished = true;
      // Reasoning deltas are not the requested JSON and must never be mixed in.
      if (typeof choice?.delta?.content === 'string') content += choice.delta.content;
      if (content.length > 65_000) throw new Error('LLM_RESPONSE_TOO_LARGE');
    };
    for await (const chunk of r.body as any) {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) throw new Error('LLM_STREAM_TOO_LARGE');
      buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
      let boundary: number;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        event(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) event(buffer);
    if ((!ended && !finished) || !content.trim()) throw new Error('LLM_STREAM_INCOMPLETE');
    return content;
  }
}
