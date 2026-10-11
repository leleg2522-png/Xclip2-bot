// Authorized, one-paid-submit experiment; never charges a bot user's saldo.
// Resume the accepted run after interruption, never replay ambiguous submissions.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';
const require = createRequire(import.meta.url);
const { Pool } = require('pg');
const axios = require('axios');
const FormData = require('form-data');
const ts = require('typescript');
if (!process.argv.includes('--paid')) throw Error('QA_REQUIRES_PAID_AUTHORIZATION');
const root = path.resolve(import.meta.dirname, '../..');
const dir = path.join(root, 'generated-artifacts/wan-three-character-test');
fs.mkdirSync(dir, { recursive: true });
const stateFile = path.join(dir, 'state.json');
let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
function save(patch) {
  state = { ...state, ...patch };
  fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(state, null, 2));
  fs.renameSync(`${stateFile}.tmp`, stateFile);
}
const http = axios.create({ proxy: false, timeout: 180000 });
const db = new Pool({ connectionString: process.env.RAILWAY_DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
const base = 'https://app.flora.ai/api/v1';
http.interceptors.response.use(response => {
  if (/\/runs\//.test(response.config.url || '')) {
    const data = response.data;
    if (state.status !== data.status) {
      save({ status: data.status, chargedCost: data.charged_cost ?? state.chargedCost });
      console.log('POLL_STATUS', data.status);
    }
  }
  return response;
});
try {
  if (state.status === 'completed' && fs.existsSync(path.join(dir, 'output.mp4'))) {
    console.log('TEST_ALREADY_COMPLETE');
  } else {
    const source = fs.readFileSync(path.join(root, 'telegram-bot/src/index.ts'), 'utf8');
    const from = source.indexOf('interface FloraWorkspace'), to = source.indexOf('// Katalog image generation Flora', from);
    if (from < 0 || to < from) throw Error('QA_ADAPTER_NOT_FOUND');
    const adapters = vm.createContext({
      floraHttp: http, FLORA_BASE: base, FormData, Buffer, setTimeout,
      axios: { post: (...args) => http.post(...args) },
      console: { log() {}, error() {} },
    });
    vm.runInContext(ts.transpileModule(source.slice(from, to), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText, adapters);
    const rows = state.keyRecord
      ? (await db.query('SELECT id, api_key FROM flora_key_pool WHERE id = $1', [state.keyRecord])).rows
      : (await db.query("SELECT id, api_key FROM flora_key_pool WHERE status = 'available' ORDER BY id")).rows;
    let record, ws;
    for (const candidate of rows) {
      try {
        ws = await adapters.floraGetWorkspace(candidate.api_key);
        record = candidate;
        break;
      } catch (error) {
        console.log('PREPARATION_UNAVAILABLE', error.response?.status ?? 'ACCOUNT_SETUP');
      }
    }
    if (!record) throw Error('QA_NO_READY_KEY');
    const key = record.api_key; // Never log or persist credential values.
    let url;
    if (state.runId) {
      console.log('RESUME_ACCEPTED_RUN');
      url = await adapters.floraPollRun(key, state.runId, 20 * 60 * 1000);
    } else {
      if (state.submitAttempted) throw Error('QA_AMBIGUOUS_SUBMIT_DO_NOT_RETRY');
      const catalog = await http.get(`${base}/models`, { headers: { Authorization: `Bearer ${key}` } });
      const models = Array.isArray(catalog.data) ? catalog.data : catalog.data.models;
      const model = models.find(x => x.model_id === 'm2v-wan-3-0-gateway' && x.capabilities?.includes('mixed-to-video'));
      const params = new Map((model?.params ?? []).map(p => [p.name, p]));
      if (!params.has('image_urls') || !params.has('video_urls')
        || !params.get('duration')?.options?.some(x => x.value === '30')
        || !params.get('resolution')?.options?.some(x => x.value === '480p')) throw Error('QA_UNSUPPORTED_CONTRACT');
      console.log('CONTRACT_CONFIRMED_3_IMAGES_VIDEO_AUDIO_30S_480P');
      save({ keyRecord: record.id, model: model.model_id, botSaldoCharged: false, referenceVideoSeconds: 11.237 });
      const inputs = [
        ['character1.jpg', path.join(root, 'attached_assets/image_search/banana-character-fullbody.jpg'), 'image/jpeg'],
        ['character2.jpg', path.join(dir, 'character2.jpg'), 'image/jpeg'],
        ['character3.jpg', path.join(dir, 'character3.jpg'), 'image/jpeg'],
        ['dance-reference.mp4', path.join(dir, 'reference-source.mp4'), 'video/mp4'],
        ['reference-sound.mp3', path.join(dir, 'reference-audio.mp3'), 'audio/mpeg'],
      ];
      const urls = [];
      for (const [name, file, mime] of inputs) {
        console.log('UPLOAD', name);
        urls.push(await adapters.floraUploadAsset(key, ws.workspaceId, fs.readFileSync(file), name, mime));
      }
      const prompt = 'Use the first three image references as THREE DIFFERENT characters, all appearing together in one wide shot: character 1 on the left, character 2 in the middle, character 3 on the right. Preserve each individual face, hairstyle and original clothing. Show all three full bodies head to feet, with enough space between them. All three characters perform the SAME choreography as the dancer in the reference video, copying the sequence, timing, arm gestures, body turns and footwork in synchronized unison. Do not copy the reference dancer face or outfit. Use the supplied reference audio as the soundtrack, preserving the original music, vocals and beat rather than inventing new sound. Synchronize the dancing to that soundtrack. The reference is about 11 seconds; repeat its choreography and music to fill a 30-second video. Fixed wide camera, photorealistic, no cuts, no extra people, no unrelated text.';
      save({ submitAttempted: true, submittedAt: new Date().toISOString(), prompt, referenceImages: 3, separateAudioExtractedFromVideo: true });
      const id = await adapters.floraGenerate(key, ws, model.model_id, {
        image_urls: urls.slice(0, 3), video_urls: [urls[3]], audio_urls: [urls[4]],
        duration: '30', resolution: '480p', aspect_ratio: '16:9', audio: true,
        prompt_expansion: false, thinking: false,
      }, prompt, 'video');
      save({ runId: id, status: 'accepted' });
      console.log('ACCEPTED_RUN', id);
      url = await adapters.floraPollRun(key, id, 20 * 60 * 1000);
    }
    console.log('DOWNLOAD_RESULT');
    const output = await http.get(url, { responseType: 'stream' });
    await pipeline(output.data, fs.createWriteStream(path.join(dir, 'output.mp4')));
    save({ status: 'completed', bytes: fs.statSync(path.join(dir, 'output.mp4')).size });
    console.log('TEST_COMPLETE');
  }
} catch (error) {
  const failure = {
    accepted: !!state.runId, httpStatus: error.response?.status,
    code: error.response?.data?.error?.code ?? error.code,
    errorType: String(error.message).startsWith('QA_') ? error.message
      : String(error.message).startsWith('FLORA_RUN_FAILED')
        ? String(error.message).replace(/https?:\/\/\S+/g, '[URL]').slice(0, 250)
        : 'UPSTREAM_ERROR',
  };
  save({ failure });
  console.log('TEST_FAILED', JSON.stringify(failure));
  process.exitCode = 1;
} finally { await db.end(); }
