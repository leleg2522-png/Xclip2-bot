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
const simple = process.argv.includes('--simple');
const threeShort = process.argv.includes('--three-short');
const reference30 = process.argv.includes('--reference30');
const newAccount = process.argv.includes('--new-account');
if (newAccount && !reference30) throw Error('QA_NEW_ACCOUNT_REQUIRES_REFERENCE30_TEST');
if ([simple, threeShort, reference30].filter(Boolean).length > 1) throw Error('QA_CHOOSE_ONE_TEST_VARIANT');
const oneCharacter = simple || reference30;
const inputDir = path.join(root, 'generated-artifacts/wan-three-character-test');
const reference30Dir = path.join(root, 'generated-artifacts/wan-reference-30s-test');
const dir = simple ? path.join(root, 'generated-artifacts/wan-simple-reference-test')
  : reference30 ? (newAccount ? path.join(root, 'generated-artifacts/wan-reference-30s-new-account-test') : reference30Dir)
  : threeShort ? path.join(root, 'generated-artifacts/wan-three-character-short-test') : inputDir;
const seconds = simple ? '10' : threeShort ? '11' : '30';
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
  if (response.config.url === `${base}/generate`) {
    save({ chargedCost: response.data?.charged_cost ?? null });
    console.log('SUBMIT_CHARGED_COST', response.data?.charged_cost ?? 'NOT_RETURNED');
  }
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
    const prior30State = newAccount ? JSON.parse(fs.readFileSync(path.join(reference30Dir, 'state.json'), 'utf8')) : null;
    if (newAccount && !prior30State?.keyRecord) throw Error('QA_ORIGINAL_ACCOUNT_UNKNOWN');
    const rows = state.keyRecord
      ? (await db.query('SELECT id, api_key FROM flora_key_pool WHERE id = $1', [state.keyRecord])).rows
      : newAccount
        ? (await db.query("SELECT id, api_key FROM flora_key_pool WHERE status = 'available' AND id <> $1 ORDER BY id", [prior30State.keyRecord])).rows
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
    if (newAccount && record.id === prior30State.keyRecord) throw Error('QA_OLD_ACCOUNT_BLOCKED');
    if (newAccount) console.log('DIFFERENT_ACCOUNT_CONFIRMED');
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
        || !params.get('duration')?.options?.some(x => x.value === seconds)
        || !params.get('resolution')?.options?.some(x => x.value === '480p')) throw Error('QA_UNSUPPORTED_CONTRACT');
      console.log(oneCharacter ? `CONTRACT_CONFIRMED_1_IMAGE_VIDEO_${seconds}S_480P`
        : `CONTRACT_CONFIRMED_3_IMAGES_VIDEO_AUDIO_${seconds}S_480P`);
      save({ keyRecord: record.id, model: model.model_id, botSaldoCharged: false, referenceVideoSeconds: reference30 ? 30 : 11.237, nativeLimitBoundaryTest: reference30 });
      const inputs = oneCharacter ? [
        ['character1.jpg', path.join(root, 'attached_assets/image_search/banana-character-fullbody.jpg'), 'image/jpeg'],
        ['dance-reference.mp4', reference30 ? path.join(reference30Dir, 'reference-30s.mp4') : path.join(inputDir, 'reference-source.mp4'), 'video/mp4'],
      ] : [
        ['character1.jpg', path.join(root, 'attached_assets/image_search/banana-character-fullbody.jpg'), 'image/jpeg'],
        ['character2.jpg', path.join(inputDir, 'character2.jpg'), 'image/jpeg'],
        ['character3.jpg', path.join(inputDir, 'character3.jpg'), 'image/jpeg'],
        ['dance-reference.mp4', path.join(inputDir, 'reference-source.mp4'), 'video/mp4'],
        ['reference-sound.mp3', path.join(inputDir, 'reference-audio.mp3'), 'audio/mpeg'],
      ];
      const urls = [];
      for (const [name, file, mime] of inputs) {
        console.log('UPLOAD', name);
        urls.push(await adapters.floraUploadAsset(key, ws.workspaceId, fs.readFileSync(file), name, mime));
      }
      const prompt = oneCharacter
        ? 'Use the woman in the image as the only character. Preserve her face, hair and clothing. Make her follow the dance choreography, body movements and timing in the reference video. Do not copy the reference dancer appearance. Show the full body with a fixed camera. Use the reference video music if supported. Photorealistic, no extra people, no unrelated text.'
        : `Use the first three image references as THREE DIFFERENT characters, all appearing together in one wide shot: character 1 on the left, character 2 in the middle, character 3 on the right. Preserve each individual face, hairstyle and original clothing. Show all three full bodies head to feet, with enough space between them. All three characters perform the SAME choreography as the dancer in the reference video, copying the sequence, timing, arm gestures, body turns and footwork in synchronized unison. Do not copy the reference dancer face or outfit. Use the supplied reference audio as the soundtrack, preserving the original music, vocals and beat rather than inventing new sound. Synchronize the dancing to that soundtrack. The reference is about 11 seconds; generate a ${seconds}-second video. Fixed wide camera, photorealistic, no cuts, no extra people, no unrelated text.`;
      // --reference30 explicitly tests whether Flora enforces the documented
      // native bounds. It is not a production bypass or an automatic retry.
      if (!reference30 && Number(seconds) + 11.237 > 30) throw Error('QA_REFERENCE_PLUS_OUTPUT_EXCEEDS_NATIVE_30S_LIMIT');
      const requestParams = oneCharacter ? {
        image_urls: [urls[0]], video_urls: [urls[1]],
        duration: seconds, resolution: '480p', aspect_ratio: '16:9',
      } : {
        image_urls: urls.slice(0, 3), video_urls: [urls[3]], audio_urls: [urls[4]],
        duration: seconds, resolution: '480p', aspect_ratio: '16:9', audio: true,
        prompt_expansion: false, thinking: false,
      };
      save({ submitAttempted: true, submittedAt: new Date().toISOString(), prompt, referenceImages: oneCharacter ? 1 : 3, durationRequested: seconds, separateAudioExtractedFromVideo: !oneCharacter });
      const id = await adapters.floraGenerate(key, ws, model.model_id, requestParams, prompt, 'video');
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
