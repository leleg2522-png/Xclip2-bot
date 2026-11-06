// Explicit migration verification only. No media submits or customer saldo.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
if (!process.argv.includes('--approved')) throw Error('APPROVAL_REQUIRED');
const require = createRequire(import.meta.url);
const { EpisodeDirector } = require('../dist/episode-director.js');
const { newEpisode } = require('../dist/episode-types.js');
const { MICRODRAMA_LLM_DEFAULT, microdramaLlmKey } = require('../dist/microdrama-llm.js');
const root = path.resolve(import.meta.dirname, '../..');
const dir = path.join(root, 'generated-artifacts/botelex-director-verification');
await fs.mkdir(dir, { recursive: true });
const lockPath = path.join(dir, 'running.lock');
const lock = await fs.open(lockPath, 'wx');
const statePath = path.join(dir, 'state.json');
let state;
try { state = JSON.parse(await fs.readFile(statePath, 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; state = { attempts: {}, results: {}, model: MICRODRAMA_LLM_DEFAULT }; }
async function save() {
  await fs.writeFile(statePath + '.tmp', JSON.stringify(state, null, 2));
  await fs.rename(statePath + '.tmp', statePath);
}
async function once(name, run) {
  if (Object.hasOwn(state.results, name)) return state.results[name];
  if (state.attempts[name]) throw Error('LLM_PREVIOUS_ATTEMPT_NO_AUTOMATIC_REPLAY');
  state.attempts[name] = true; await save();
  console.log('LLM_TEST_STARTED', name);
  const result = await run();
  state.results[name] = result; await save();
  console.log('LLM_TEST_PASSED', name);
  return result;
}
try {
  const key = microdramaLlmKey();
  if (!key) throw Error('LLM_KEY_MISSING');
  const d = new EpisodeDirector(key);
  const episode = newEpisode(1);
  episode.bible = await once('bible', () => d.bible(
    'Microdrama romantis Indonesia satu menit: Arga, CEO tampan dewasa, bertemu Nara, wanita dewasa yang hidup sederhana dan mengantar makanan. Mereka menyadari pernah saling menolong. Hanya dua pemeran, satu lobi kantor, gerakan sederhana, dialog singkat, tanpa kekerasan. Akhiri dengan pengungkapan emosional.',
    1, state.model));
  for (let i=0; i<2; i++) {
    const shots = await once(`scene${i+1}`, () => d.scene(episode, i, state.model));
    episode.shots.push(...shots.map(shot => ({ shot })));
  }
  const imageDir = path.join(root,'generated-artifacts/muse-ceo-microdrama-strict');
  const images = await Promise.all(['scene-1-check.jpg','sample-6.jpg'].map(n=>fs.readFile(path.join(imageDir,n))));
  const quality = await once('vision', () => d.review(state.model,
    'First image is the approved reference, second is a later candidate frame. Check whether the same two leads, wardrobe and supporting cast persist. Flag any new/unapproved adult. Evaluate only visible evidence, not dialogue or audio.', images));
  state.completed = true; await save();
  console.log('DIRECTOR_VERIFIED',JSON.stringify({
    model:state.model,beats:episode.bible.beats.length,shots:episode.shots.length,
    visionResponded:true,visionPass:quality.pass,visionIssues:quality.issues.length,
    mediaSubmissions:0,botSaldoCharged:false,
  }));
} catch(e) {
  const code = /^(LLM_[A-Z0-9_]+|DIRECTOR_FORMAT)$/.test(e.message)
    ? e.message : 'LLM_NETWORK_OR_FORMAT_FAILURE';
  state.error = code; await save(); console.error('DIRECTOR_VERIFICATION_STOPPED',code); process.exitCode=1;
} finally {
  await lock.close(); await fs.unlink(lockPath);
}
