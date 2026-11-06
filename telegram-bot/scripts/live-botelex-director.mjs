// Explicit migration verification only. No media submits or customer saldo.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
if (!process.argv.includes('--approved')) throw Error('APPROVAL_REQUIRED');
const require = createRequire(import.meta.url);
const { EpisodeDirector, validateBible, validateScene } = require('../dist/episode-director.js');
const { newEpisode } = require('../dist/episode-types.js');
const { MICRODRAMA_LLM_DEFAULT, microdramaLlmKey } = require('../dist/microdrama-llm.js');
const root = path.resolve(import.meta.dirname, '../..');
const scriptTest = process.argv.includes('--script-test');
const museNegative = process.argv.includes('--muse-negative');
const dir = path.join(root, museNegative
  ? 'generated-artifacts/botelex-muse-negative-plan'
  : scriptTest
  ? 'generated-artifacts/botelex-director-script-test'
  : 'generated-artifacts/botelex-director-verification');
await fs.mkdir(dir, { recursive: true });
const lockPath = path.join(dir, 'running.lock');
const lock = await fs.open(lockPath, 'wx');
const statePath = path.join(dir, 'state.json');
let state;
let stage = 'initial';
try { state = JSON.parse(await fs.readFile(statePath, 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; state = { attempts: {}, results: {}, model: MICRODRAMA_LLM_DEFAULT }; }
async function save() {
  await fs.writeFile(statePath + '.tmp', JSON.stringify(state, null, 2));
  await fs.rename(statePath + '.tmp', statePath);
}
async function once(name, run, restore) {
  if (Object.hasOwn(state.results, name)) return state.results[name];
  if (state.attempts[name] && process.argv.includes('--revalidate-saved') && restore) {
    const raw = await fs.readFile(path.join(dir, `${name}-assistant.txt`), 'utf8');
    const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    const result = restore(value);
    state.results[name] = result;
    state.revalidatedFromSaved ??= [];
    state.revalidatedFromSaved.push(name);
    delete state.error;
    await save();
    console.log('LLM_SAVED_RESPONSE_VALIDATED_NO_NEW_REQUEST', name);
    return result;
  }
  if (state.attempts[name]) throw Error('LLM_PREVIOUS_ATTEMPT_NO_AUTOMATIC_REPLAY');
  state.attempts[name] = true; await save();
  stage = name;
  console.log('LLM_TEST_STARTED', name);
  const result = await run();
  state.results[name] = result; await save();
  console.log('LLM_TEST_PASSED', name);
  return result;
}
try {
  const key = microdramaLlmKey();
  if (!key) throw Error('LLM_KEY_MISSING');
  const request = async (url, init) => {
    const response = await fetch(url, init);
    if (!String(url).endsWith('/chat/completions')) return response;
    const diagnostic = {
      httpStatus: response.status, contentType: response.headers.get('content-type'),
    };
    state.transport ??= {};
    state.transport[stage] = diagnostic; await save();
    // Only retain the assistant's fictional story output and machine metadata.
    // Never store request headers, credentials, reasoning or upstream messages.
    const copy = response.clone();
    let raw = '';
    const decoder = new TextDecoder();
    try {
      for await (const bytes of copy.body) {
        raw += decoder.decode(bytes, { stream: true });
        if (raw.length > 4 * 1024 * 1024) throw Error('LLM_DIAGNOSTIC_BODY_TOO_LARGE');
      }
      raw += decoder.decode();
      diagnostic.bytes = Buffer.byteLength(raw);
      let content = '';
      diagnostic.finishReasons = [];
      const inspect = value => {
        const c = value?.choices?.[0];
        if (typeof c?.delta?.content === 'string') content += c.delta.content;
        if (typeof c?.message?.content === 'string') content += c.message.content;
        if (c?.finish_reason) diagnostic.finishReasons.push(c.finish_reason);
      };
      if (/(?:^|\n)data:/.test(raw)) {
        for (const line of raw.split(/\r?\n/).filter(v => v.startsWith('data:'))) {
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try { inspect(JSON.parse(data)); }
          catch { diagnostic.malformedEvents = (diagnostic.malformedEvents || 0) + 1; }
        }
      } else {
        try { inspect(JSON.parse(raw)); } catch { diagnostic.bodyNotJson = true; }
      }
      diagnostic.assistantChars = content.length;
      if (content) await fs.writeFile(path.join(dir, `${stage}-assistant.txt`), content);
    } catch (e) {
      diagnostic.readErrorName = /^[A-Za-z_]+$/.test(e.name) ? e.name : 'UnknownError';
    }
    await save();
    return response;
  };
  const d = new EpisodeDirector(key, request, museNegative);
  const episode = newEpisode(1);
  episode.bible = await once('bible', () => d.bible(
    museNegative
      ? 'Buat microdrama romantis Indonesia tepat satu menit: Arga CEO tampan dewasa dan Nara wanita dewasa sederhana yang mengantar makanan, ternyata pernah saling menolong dan baru saling mengenali. HANYA dua tokoh dewasa itu dari awal sampai akhir; lobi kantor kecil yang kosong, tanpa orang lewat, pegawai, manajer atau satpam. Semua tokoh berdiri tenang. Satu kalimat singkat dari satu pembicara per shot. Aksi sederhana: tatapan, senyum, anggukan. Satu kantong makanan tetap di tangan Nara sepanjang episode; tidak dijatuhkan atau dipindahkan. Tanpa peragaan kenangan, flashback, menyentuh wajah/tangan, gelang tambahan, merogoh kantong atau pergantian baju. Jadikan dialog pendek sebagai pengungkapan masa lalu. Semua shot akan disambung memakai frame terakhir shot sebelumnya. Akhiri dengan pengungkapan romantis, bukan aksi fisik.'
      : 'Microdrama romantis Indonesia satu menit: Arga, CEO tampan dewasa, bertemu Nara, wanita dewasa yang hidup sederhana dan mengantar makanan. Mereka menyadari pernah saling menolong. Hanya dua pemeran, satu lobi kantor, gerakan sederhana, dialog singkat, tanpa kekerasan. Akhiri dengan pengungkapan emosional.',
    1, state.model), value => validateBible(value, 1));
  for (let i=0; i<2; i++) {
    const shots = await once(`scene${i+1}`, () => d.scene(episode, i, state.model),
      value => validateScene(value, episode, i, museNegative));
    episode.shots.push(...shots.map(shot => ({ shot })));
  }
  let quality;
  if (!scriptTest && !museNegative) {
    const imageDir = path.join(root,'generated-artifacts/muse-ceo-microdrama-strict');
    const images = await Promise.all(['scene-1-check.jpg','sample-6.jpg'].map(n=>fs.readFile(path.join(imageDir,n))));
    quality = await once('vision', () => d.review(state.model,
      'First image is the approved reference, second is a later candidate frame. Check whether the same two leads, wardrobe and supporting cast persist. Flag any new/unapproved adult. Evaluate only visible evidence, not dialogue or audio.', images));
  }
  state.completed = true; await save();
  console.log('DIRECTOR_VERIFIED',JSON.stringify({
    model:state.model,beats:episode.bible.beats.length,shots:episode.shots.length,
    visionResponded:!!quality,visionPass:quality?.pass,visionIssues:quality?.issues.length,
    mediaSubmissions:0,botSaldoCharged:false,
  }));
} catch(e) {
  const code = /^(LLM_[A-Z0-9_]+|DIRECTOR_FORMAT)$/.test(e.message)
    ? e.message : 'LLM_NETWORK_OR_FORMAT_FAILURE';
  state.error = code;
  state.errorName = /^[A-Za-z_]+$/.test(e.name) ? e.name : 'UnknownError';
  await save(); console.error('DIRECTOR_VERIFICATION_STOPPED',code); process.exitCode=1;
} finally {
  await lock.close(); await fs.unlink(lockPath);
}
