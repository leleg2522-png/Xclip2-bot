// One-shot serial text generation in 60-second chapters. Requires --approved.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

if (!process.argv.includes('--approved')) throw Error('APPROVAL_REQUIRED');
const require = createRequire(import.meta.url);
const { MicrodramaLlm, MICRODRAMA_LLM_DEFAULT, microdramaLlmKey } = require('../dist/microdrama-llm.js');

const root = path.resolve(import.meta.dirname, '../..');
const dir = path.join(root, 'generated-artifacts/botelex-cio-drama-15m-segments');
await fs.mkdir(dir, { recursive: true });
const statePath = path.join(dir, 'state.json');
const lockPath = path.join(dir, 'running.lock');
const lock = await fs.open(lockPath, 'wx');
const model = MICRODRAMA_LLM_DEFAULT;
const resumeSaved = process.argv.includes('--resume-saved');
let state;
try {
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  if (!resumeSaved) throw Error('PREVIOUS_ATTEMPT_EXISTS_NO_AUTOMATIC_REPLAY');
  if (state.model !== model || state.durationMinutes !== 15) throw Error('STATE_MODEL_MISMATCH');
} catch (error) {
  if (error.code !== 'ENOENT') {
    await lock.close();
    await fs.unlink(lockPath);
    throw error;
  }
  state = { model, durationMinutes: 15, attempts: {}, raw: {}, segments: {}, mediaSubmissions: 0 };
}
async function save() {
  await fs.writeFile(`${statePath}.tmp`, JSON.stringify(state, null, 2));
  await fs.rename(`${statePath}.tmp`, statePath);
}
function safeError(error) {
  const message = error instanceof Error ? error.message : '';
  return /^[A-Z0-9_]+$/.test(message) || /^LLM_HTTP_[0-9]{3}$/.test(message)
    ? message : 'LLM_REQUEST_OR_FORMAT_FAILURE';
}
function parseJson(raw) {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let value;
  try { value = JSON.parse(text); }
  catch {
    // Permit only the unambiguous case where the provider output is otherwise
    // balanced JSON and omitted the single final brace for the root object.
    const stack = [];
    let inString = false, escaped = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
        continue;
      }
      if (c === '"') inString = true;
      else if (c === '{' || c === '[') stack.push({ c, i });
      else if (c === '}' || c === ']') {
        const open = stack.pop();
        if (!open || (open.c === '{' && c !== '}') || (open.c === '[' && c !== ']')) {
          throw Error('LLM_DIRECTOR_INVALID_JSON');
        }
      }
    }
    if (inString || stack.length !== 1 || stack[0].c !== '{' || stack[0].i !== 0) {
      throw Error('LLM_DIRECTOR_INVALID_JSON');
    }
    try { value = JSON.parse(`${text}}`); }
    catch { throw Error('LLM_DIRECTOR_INVALID_JSON'); }
    console.log('DRAMA_JSON_ROOT_BRACE_RECOVERED');
  }
  // Normalize only the common schema-placement mistake; do not change story text.
  if (!value.segment && value.series?.segment) {
    value.segment = value.series.segment;
    delete value.series.segment;
    console.log('DRAMA_SEGMENT_FIELD_NORMALIZED');
  }
  return value;
}
function string(value, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw Error('DIRECTOR_FORMAT');
  return value.trim();
}
function validateSegment(value, minute, series) {
  if (!value || !value.segment || value.segment.minute !== minute
      || !Array.isArray(value.segment.shots) || value.segment.shots.length !== 6) throw Error('DIRECTOR_FORMAT');
  const allowedSpeakers = new Set(series.cast.map(c => c.id));
  const shots = value.segment.shots.map(shot => {
    if (!shot || !Array.isArray(shot.dialogue) || shot.dialogue.length > 3) throw Error('DIRECTOR_FORMAT');
    const dialogue = shot.dialogue.map(line => {
        if (!line || !allowedSpeakers.has(line.speaker)) throw Error('DIRECTOR_FORMAT');
        return { speaker: line.speaker, text: string(line.text, 120) };
      });
    if (dialogue.reduce((sum, line) => sum + line.text.length, 0) > 140) throw Error('DIRECTOR_FORMAT');
    return { action: string(shot.action, 400), dialogue };
  });
  return {
    minute,
    summary: string(value.segment.summary, 500),
    continuityOut: string(value.segment.continuityOut, 700),
    shots,
  };
}
function validateSeries(value) {
  const source = value?.series;
  if (!source || !Array.isArray(source.cast) || source.cast.length < 1 || source.cast.length > 2
      || !Array.isArray(source.locations) || source.locations.length < 1 || source.locations.length > 3
      || !Array.isArray(source.globalArc?.actTurns) || source.globalArc.actTurns.length !== 5) throw Error('DIRECTOR_FORMAT');
  const cast = source.cast.map(member => {
    if (!member || !/^[A-Z][A-Z0-9_]*$/.test(member.id) || !Number.isInteger(member.age) || member.age < 18) {
      throw Error('DIRECTOR_FORMAT');
    }
    return {
      id: member.id, name: string(member.name, 40), age: member.age,
      look: string(member.look, 300), personality: string(member.personality, 180),
    };
  });
  if (!cast.some(member => member.name.toLowerCase() === 'cio')) throw Error('DIRECTOR_FORMAT');
  const locations = source.locations.map(location => ({
    id: location.id, description: string(location.description, 350),
  }));
  if (locations.some(location => !/^[A-Z][A-Z0-9_]*$/.test(location.id))) throw Error('DIRECTOR_FORMAT');
  const globalArc = {
    prologue: string(source.globalArc.prologue, 300),
    centralConflict: string(source.globalArc.centralConflict, 350),
    actTurns: source.globalArc.actTurns.map(turn => string(turn, 250)),
    climax: string(source.globalArc.climax, 300),
    epilogue: string(source.globalArc.epilogue, 300),
  };
  return {
    title: string(source.title, 90),
    synopsis: string(source.synopsis, 600),
    cast, locations, globalArc,
  };
}
function escapeHtml(value) {
  return value.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}
function renderMarkdown(series, segments) {
  const lines = [
    `# ${series.title}`, '',
    `**Durasi:** 15 menit · **Model:** ${model} · **Format:** 15 bagian teks 1 menit`,
    '', '## Sinopsis', series.synopsis, '', '## Tokoh',
  ];
  for (const member of series.cast) {
    lines.push(`### ${member.name} (${member.age})`, `- Ciri dan pakaian: ${member.look}`,
      `- Kepribadian: ${member.personality}`, '');
  }
  lines.push('## Lokasi', ...series.locations.map(location => `- **${location.id}:** ${location.description}`),
    '', '## Arah cerita 15 menit', `**Prolog:** ${series.globalArc.prologue}`,
    `**Konflik utama:** ${series.globalArc.centralConflict}`,
    ...series.globalArc.actTurns.map((turn, i) => `**Babak ${i + 1}:** ${turn}`),
    `**Klimaks:** ${series.globalArc.climax}`, `**Epilog:** ${series.globalArc.epilogue}`);
  for (const segment of segments) {
    lines.push('', `## Menit ${String(segment.minute).padStart(2, '0')}`, segment.summary);
    segment.shots.forEach((shot, i) => {
      const start = (segment.minute - 1) * 60 + i * 10;
      lines.push('', `### ${String(i + 1).padStart(2, '0')} · ${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}–${String(Math.floor((start + 10) / 60)).padStart(2, '0')}:${String((start + 10) % 60).padStart(2, '0')}`,
        shot.action, ...shot.dialogue.map(line => `**${line.speaker}:** ${line.text}`));
    });
  }
  return lines.join('\n');
}

try {
  const key = microdramaLlmKey();
  if (!key) throw Error('LLM_KEY_MISSING');
  const llm = new MicrodramaLlm(key);
  let series = state.series;
  const segments = Object.values(state.segments).sort((a, b) => a.minute - b.minute);
  let continuity = segments.at(-1)?.continuityOut || '';
  for (let minute = 1; minute <= 15; minute++) {
    const stage = `minute_${minute}`;
    if (state.segments[stage]) continue;
    if (state.attempts[stage]) {
      if (!resumeSaved || typeof state.raw[stage] !== 'string') {
        throw Error('PREVIOUS_ATTEMPT_EXISTS_NO_AUTOMATIC_REPLAY');
      }
      const parsed = parseJson(state.raw[stage]);
      if (minute === 1) series = validateSeries(parsed);
      if (!series) throw Error('DIRECTOR_FORMAT');
      const segment = validateSegment(parsed, minute, series);
      segments.push(segment);
      continuity = segment.continuityOut;
      state.series = series;
      state.segments[stage] = segment;
      delete state.errorCode;
      await save();
      console.log(`DRAMA_SEGMENT_REVALIDATED minute=${minute}`);
      continue;
    }
    const previous = segments.slice(-3).map(segment => `Menit ${segment.minute}: ${segment.summary}`).join('\n');
    const firstMinute = minute === 1;
    const finalMinute = minute === 15;
    const system = `You are a professional Indonesian short-drama writer and continuity editor.
Create only the requested one-minute part of a single connected 15-minute drama. Each minute contains exactly six numbered 10-second shots, grouped into two causal 30-second beats. Return compact valid JSON only, no markdown or commentary. This is text screenplay content only: do not call tools or create any image, audio, or video. Use only the named adult cast and listed locations. Dialogue must be natural Indonesian and brief enough to speak within the shot; use at most three quick turns and 140 total spoken characters per shot. Keep actions filmable, continuity exact, and causality clear.`;
    const schema = firstMinute
      ? `Return {"series":{"title":"","synopsis":"","cast":[{"id":"CIO","name":"Cio","age":30,"look":"","personality":""}],"locations":[{"id":"PLACE","description":""}],"globalArc":{"prologue":"","centralConflict":"","actTurns":["","","","",""],"climax":"","epilogue":""}},"segment":{"minute":1,"summary":"","shots":[{"action":"","dialogue":[{"speaker":"CIO","text":""}]}],"continuityOut":""}}. Exactly six shots. Cio must be an adult food courier; include at most one other main character.`
      : `Return {"segment":{"minute":${minute},"summary":"","shots":[{"action":"","dialogue":[{"speaker":"CIO","text":""}]}],"continuityOut":""}}. Exactly six shots.`;
    const user = [
      `Write minute ${minute} of 15. The finished drama must resolve the main conflict and prologue in minute 15.`,
      firstMinute
        ? 'Premise: an Indonesian dracin about Cio, an adult food courier. Invent an original emotional conflict in which food delivery drives the plot. Make it dramatic and surprising but coherent; let the first minute establish the hook and starting situation.'
        : `Series anchors created by you: ${JSON.stringify(series)}`,
      firstMinute ? '' : `Previous continuity note created by you: ${continuity}`,
      previous ? `Recent completed minute summaries:\n${previous}` : '',
      finalMinute
        ? `This is the finale. Follow the planned climax and epilogue, resolve the central conflict, and end conclusively. Do not add a sequel hook.`
        : `End this minute with a natural forward beat that connects directly to the next minute; do not resolve the whole conflict early.`,
      `Continuity note after this minute: record only stable facts, character knowledge/emotions, unresolved conflict, prop/location state, and the immediate next step. Keep it under 700 characters.`,
      schema,
      `Keep each action under 240 characters, each spoken line under 100 characters, and the whole JSON under 8,000 characters.`,
    ].filter(Boolean).join('\n\n');
    state.attempts[stage] = true;
    await save();
    console.log(`DRAMA_SEGMENT_STARTED minute=${minute}`);
    const raw = await llm.complete(model, [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ], 12_288, 0.65, stage);
    state.raw[stage] = raw;
    await save();
    const parsed = parseJson(raw);
    if (firstMinute) series = validateSeries(parsed);
    const segment = validateSegment(parsed, minute, series);
    segments.push(segment);
    continuity = segment.continuityOut;
    state.series = series;
    state.segments[stage] = segment;
    await save();
    console.log(`DRAMA_SEGMENT_COMPLETED minute=${minute}`);
  }
  const markdown = renderMarkdown(series, segments);
  await fs.writeFile(path.join(dir, 'cio-dracin-15-menit.md'), markdown);
  await fs.writeFile(path.join(dir, 'cio-dracin-15-menit.html'),
    `<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(series.title)}</title><style>body{margin:0;background:#f5f1e9;color:#20221f;font:16px/1.75 Georgia,serif}.page{max-width:900px;margin:40px auto;padding:32px;background:#fffdf8;box-shadow:0 12px 40px #0001}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}h1{font-size:2rem}@media(max-width:640px){.page{margin:0;padding:22px}}</style><main class="page"><pre>${escapeHtml(markdown)}</pre></main></html>`);
  state.completed = true;
  state.segmentCount = segments.length;
  state.shots = segments.reduce((sum, segment) => sum + segment.shots.length, 0);
  state.mediaSubmissions = 0;
  await save();
  console.log(`DRAMA_SCRIPT_COMPLETE ${JSON.stringify({
    title: series.title, durationMinutes: 15, segments: segments.length, shots: state.shots,
    mediaSubmissions: 0, file: 'generated-artifacts/botelex-cio-drama-15m-segments/cio-dracin-15-menit.html',
  })}`);
} catch (error) {
  state.errorCode = safeError(error);
  await save();
  console.error(`DRAMA_SCRIPT_STOPPED ${state.errorCode}`);
  process.exitCode = 1;
} finally {
  await lock.close();
  await fs.unlink(lockPath).catch(() => {});
}
