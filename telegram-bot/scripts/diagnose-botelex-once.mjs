import fs from 'node:fs/promises';
import path from 'node:path';
if (!process.argv.includes('--approved')) throw Error('APPROVAL_REQUIRED');
const dir = path.resolve(import.meta.dirname, '../../generated-artifacts/botelex-diagnostic');
await fs.mkdir(dir, { recursive: true });
const statePath = path.join(dir, 'state.json');
// Exclusive creation also prevents accidental replays after process interruption.
const marker = await fs.open(statePath, 'wx');
await marker.writeFile(JSON.stringify({ attempted: true })); await marker.close();
const state = { attempted: true, model: 'claude-fable-5.1', postRequests: 1 };
async function save() { await fs.writeFile(statePath, JSON.stringify(state, null, 2)); }
try {
  if (!process.env.BOTELEX_API_KEY) throw Error('LLM_KEY_MISSING');
  const r = await fetch('https://botelexkey.store/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.BOTELEX_API_KEY}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(180000),
    body: JSON.stringify({
      model: state.model, stream: true, max_tokens: 512,
      messages: [{ role: 'user', content: 'Return ONLY this JSON, without explanation or markdown: {"ok":true,"language":"id"}' }],
    }),
  });
  state.httpStatus = r.status;
  state.contentType = r.headers.get('content-type');
  await save();
  const raw = await r.text();
  state.bytes = Buffer.byteLength(raw);
  state.html = /^\s*(?:<!doctype|<html)/i.test(raw);
  state.sse = /(?:^|\n)data:/.test(raw);
  let content = '', reasoning = '', finishes = [], events = 0, malformed = 0;
  const inspect = value => {
    const c = value?.choices?.[0];
    if (c?.finish_reason) finishes.push(c.finish_reason);
    if (typeof c?.delta?.content === 'string') content += c.delta.content;
    if (typeof c?.message?.content === 'string') content += c.message.content;
    if (typeof c?.delta?.reasoning_content === 'string') reasoning += c.delta.reasoning_content;
    // Only inspect top-level shape, never dump upstream messages or headers.
    if (value?.error) state.upstreamError = true;
  };
  if (state.sse) {
    for (const line of raw.split(/\r?\n/).filter(v => v.startsWith('data:'))) {
      const data = line.slice(5).trim();
      if (data === '[DONE]') { state.done = true; continue; }
      if (!data) continue;
      try { inspect(JSON.parse(data)); events++; } catch { malformed++; }
    }
  } else {
    try { const value = JSON.parse(raw); state.jsonKeys = Object.keys(value); inspect(value); }
    catch { state.bodyNotJson = true; }
  }
  Object.assign(state, { events, malformed, finishes, contentChars: content.length, reasoningChars: reasoning.length });
  try {
    const value = JSON.parse(content);
    state.expectedJson = value?.ok === true && value?.language === 'id';
    if (state.expectedJson) state.result = { ok: true, language: 'id' };
  } catch { state.assistantNotJson = true; }
  state.completed = true;
  await save();
  console.log(JSON.stringify(state));
} catch (e) {
  state.errorName = /^[A-Za-z_]+$/.test(e.name) ? e.name : 'UnknownError';
  state.errorCode = /^[A-Z0-9_]+$/.test(e.code || '') ? e.code : 'REQUEST_OR_BODY_READ_FAILED';
  await save(); console.log(JSON.stringify(state)); process.exitCode = 1;
}
