// One-shot text-only generation. Requires an explicit --approved flag.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

if (!process.argv.includes('--approved')) throw Error('APPROVAL_REQUIRED');
const require = createRequire(import.meta.url);
const { EpisodeDirector } = require('../dist/episode-director.js');
const { newEpisode, STORY_BEAT_BATCH_SIZE, STORY_BEATS_PER_MINUTE } = require('../dist/episode-types.js');
const { MICRODRAMA_LLM_DEFAULT, microdramaLlmKey } = require('../dist/microdrama-llm.js');

const root = path.resolve(import.meta.dirname, '../..');
const dir = path.join(root, 'generated-artifacts/botelex-cio-drama-15m');
await fs.mkdir(dir, { recursive: true });
const statePath = path.join(dir, 'state.json');
const lock = await fs.open(path.join(dir, 'running.lock'), 'wx');
const model = MICRODRAMA_LLM_DEFAULT;
let state;
try {
  state = JSON.parse(await fs.readFile(statePath, 'utf8'));
  throw Error('PREVIOUS_ATTEMPT_EXISTS_NO_AUTOMATIC_REPLAY');
} catch (error) {
  if (error.code !== 'ENOENT') {
    await lock.close();
    await fs.unlink(path.join(dir, 'running.lock'));
    throw error;
  }
  state = { model, durationMinutes: 15, attempts: {}, results: {}, mediaSubmissions: 0 };
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

async function once(stage, run) {
  if (state.results[stage]) return state.results[stage];
  if (state.attempts[stage]) throw Error('PREVIOUS_ATTEMPT_EXISTS_NO_AUTOMATIC_REPLAY');
  state.attempts[stage] = true;
  await save();
  console.log(`DRAMA_STAGE_STARTED ${stage}`);
  try {
    const result = await run();
    state.results[stage] = result;
    await save();
    console.log(`DRAMA_STAGE_COMPLETED ${stage}`);
    return result;
  } catch (error) {
    state.failedStage = stage;
    state.errorCode = safeError(error);
    await save();
    throw error;
  }
}

function timestamp(seconds) {
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

function renderText(episode) {
  const b = episode.bible;
  const lines = [
    `# ${b.title}`,
    '',
    `**Durasi:** 15 menit · **Model:** ${model} · **Status:** naskah teks, tanpa render media`,
    '',
    `## Sinopsis`,
    b.synopsis,
    '',
    `## Gaya`,
    b.style,
    '',
    `## Tokoh`,
    ...b.cast.flatMap(c => [
      `### ${c.name} (${c.age})`,
      `- Ciri dan pakaian: ${c.look}`,
      `- Suara: ${c.voice}`,
      `- Kepribadian: ${c.personality}`,
      '',
    ]),
    `## Lokasi`,
    ...b.locations.flatMap(l => [`- **${l.id}:** ${l.description}`]),
    '',
    `## Alur lengkap`,
    `**Prolog:** ${b.arc.prologue}`,
    `**Konflik utama:** ${b.arc.centralConflict}`,
    ...b.arc.acts.map(a => `**Babak ${a.number} (beat ${a.startBeat}–${a.endBeat}):** ${a.purpose} Titik balik: ${a.turningPoint}`),
    `**Klimaks:** ${b.arc.climax}`,
    `**Epilog:** ${b.arc.epilogue}`,
    `**Jenis akhir:** ${b.arc.endingType}`,
    '',
    `## Peta 30 beat`,
  ];
  b.beats.forEach((beat, i) => {
    lines.push(`**${String(i + 1).padStart(2, '0')} · ${timestamp(i * 30)}–${timestamp((i + 1) * 30)} · ${beat.location}:** ${beat.objective}`);
  });
  lines.push('', '## Naskah adegan dan dialog');
  b.beats.forEach((beat, i) => {
    lines.push('', `### Adegan ${String(i + 1).padStart(2, '0')} · ${timestamp(i * 30)}–${timestamp((i + 1) * 30)} · ${beat.location}`);
    for (const shot of episode.shots.filter(item => item.shot.scene === i).map(item => item.shot)) {
      lines.push('', `#### Shot ${shot.number} · 10 detik`, `**Kamera:** ${shot.camera}`,
        `**Aksi:** ${shot.action}`, `**Kontinuitas awal:** ${shot.startState}`, `**Kontinuitas akhir:** ${shot.endState}`);
      for (const line of shot.dialogue) lines.push(`**${line.speaker}:** ${line.text}`);
    }
  });
  return lines.join('\n');
}

function htmlEscape(value) {
  return value.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

try {
  const key = microdramaLlmKey();
  if (!key) throw Error('LLM_KEY_MISSING');
  const episode = newEpisode(15);
  const director = new EpisodeDirector(key);
  episode.bible = await once('bible', () => director.bible(
    'Buat dracin pendek berbahasa Indonesia yang utuh, emosional, dan punya beberapa kejutan sebab-akibat yang masuk akal. Tokoh utama harus bernama Cio, seorang kurir makanan dewasa. Jadikan pekerjaan mengantar makanan bagian penting dari konflik, bukan sekadar latar. Ciptakan sendiri cerita, tokoh pendamping, rahasia, pilihan sulit, klimaks, dan akhir yang tuntas berdasarkan premis ini; jangan menyalin cerita populer. Dialog nantinya harus alami dalam bahasa Indonesia. Jaga jumlah tokoh utama maksimal dua orang dan lokasi maksimal tiga. Hindari kebetulan yang menyelesaikan konflik, pengulangan, dan akhir menggantung.',
    15, model));
  for (let start = 0; start < 15 * STORY_BEATS_PER_MINUTE; start += STORY_BEAT_BATCH_SIZE) {
    const count = Math.min(STORY_BEAT_BATCH_SIZE, 15 * STORY_BEATS_PER_MINUTE - start);
    const stage = `beats_${start + 1}_${start + count}`;
    const beats = await once(stage, () => director.beats(episode, start, count, model));
    episode.bible.beats.push(...beats);
    state.episode = episode;
    await save();
  }
  for (let scene = 0; scene < episode.bible.beats.length; scene++) {
    const shots = await once(`scene_${scene + 1}`, () => director.scene(episode, scene, model));
    episode.shots.push(...shots.map(shot => ({ shot, takes: [] })));
    state.episode = episode;
    await save();
  }

  const text = renderText(episode);
  await fs.writeFile(path.join(dir, 'cio-dracin-15-menit.md'), text);
  await fs.writeFile(path.join(dir, 'cio-dracin-15-menit.html'),
    `<!doctype html><html lang="id"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlEscape(episode.bible.title)}</title><style>body{margin:0;background:#f5f1e9;color:#20221f;font:16px/1.75 Georgia,serif}.page{max-width:900px;margin:40px auto;padding:32px;background:#fffdf8;box-shadow:0 12px 40px #0001}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}h1{font-size:2rem} @media(max-width:640px){.page{margin:0;padding:22px}}</style><main class="page"><pre>${htmlEscape(text)}</pre></main></html>`);
  state.completed = true;
  state.story = 'cio-dracin-15-menit.md';
  state.shots = episode.shots.length;
  state.mediaSubmissions = 0;
  await save();
  console.log(`DRAMA_SCRIPT_COMPLETE ${JSON.stringify({
    title: episode.bible.title, durationMinutes: episode.minutes, beats: episode.bible.beats.length,
    shots: episode.shots.length, mediaSubmissions: 0, file: 'generated-artifacts/botelex-cio-drama-15m/cio-dracin-15-menit.html',
  })}`);
} catch (error) {
  state.errorCode ||= safeError(error);
  await save();
  console.error(`DRAMA_SCRIPT_STOPPED ${state.errorCode}`);
  process.exitCode = 1;
} finally {
  await lock.close();
  await fs.unlink(path.join(dir, 'running.lock')).catch(() => {});
}
