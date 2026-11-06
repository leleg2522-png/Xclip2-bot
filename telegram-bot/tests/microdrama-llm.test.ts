import assert from 'node:assert/strict';
import { MicrodramaLlm, MICRODRAMA_LLM_DEFAULT, microdramaLlmKey } from '../src/microdrama-llm';

const models = () => new Response(JSON.stringify({ data: [
  { id: 'claude-fable-5.1' }, { id: 'off', available: false }, { id: 'disabled', enabled: false },
] }));
const payload = '{"title":"Rahasia"}';
const streamText = [
  { choices: [{ delta: { reasoning_content: 'Private reasoning is not output JSON.' } }] },
  { choices: [{ delta: { content: payload.slice(0, 12) } }] },
  { choices: [{ delta: { content: payload.slice(12) }, finish_reason: 'stop' }] },
].map(v => `data: ${JSON.stringify(v)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n';
function sse(source: string) {
  // One byte at a time exercises split CRLF and fragmented events.
  const bytes = new TextEncoder().encode(source);
  return new Response(new ReadableStream({
    start(c) { for (const b of bytes) c.enqueue(new Uint8Array([b])); c.close(); },
  }), { headers: { 'content-type': 'text/event-stream' } });
}
async function main() {
  assert.equal(MICRODRAMA_LLM_DEFAULT, 'claude-fable-5.1');
  const calls: Array<{ url: string; body: any }> = [];
  const client = new MicrodramaLlm('fixture-botelex-key', (async (url: any, init: any) => {
    assert.equal(new URL(String(url)).origin, 'https://botelexkey.store');
    assert.equal(init.headers.Authorization, 'Bearer fixture-botelex-key');
    calls.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    return String(url).endsWith('/models') ? models() : sse(streamText);
  }) as any);
  assert.deepEqual(await client.models(), ['claude-fable-5.1']);
  assert.equal(await client.complete(MICRODRAMA_LLM_DEFAULT, [{ role: 'user', content: 'Test' }], 100, 0.1), payload);
  assert.equal(calls.at(-1)!.body.stream, true);
  assert.equal(calls.at(-1)!.body.model, 'claude-fable-5.1');
  await assert.rejects(client.complete('missing-model', [], 10, 0.1), /LLM_MODEL_UNAVAILABLE/);
  assert.equal(calls.filter(v => v.body).length, 1, 'Unknown models never submit and never fall back');
  for (const [source, error] of [
    ['data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', /LLM_STREAM_INCOMPLETE/],
    ['data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n', /LLM_TRUNCATED/],
    ['data: {"error":{"message":"fixture"}}\n\n', /LLM_STREAM_ERROR/],
  ] as const) {
    let submits = 0;
    const broken = new MicrodramaLlm('fixture', (async (url: any) => {
      if (String(url).endsWith('/models')) return models();
      submits++; return sse(source);
    }) as any);
    await assert.rejects(broken.complete(MICRODRAMA_LLM_DEFAULT, [], 10, 0.1), error);
    assert.equal(submits, 1, 'Never replay a potentially billed completion');
  }
  const old = process.env.BOTELEX_API_KEY, legacy = process.env.BUATSIMPEL_API_KEY;
  try {
    delete process.env.BOTELEX_API_KEY; process.env.BUATSIMPEL_API_KEY = 'legacy-not-for-botelex';
    assert.equal(microdramaLlmKey(), '', 'Never send the previous provider credential to a new host');
  } finally {
    if (old === undefined) delete process.env.BOTELEX_API_KEY; else process.env.BOTELEX_API_KEY = old;
    if (legacy === undefined) delete process.env.BUATSIMPEL_API_KEY; else process.env.BUATSIMPEL_API_KEY = legacy;
  }
  console.log('PASS Botelex model catalog, streaming, reasoning separation, credential isolation, no paid replay');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
