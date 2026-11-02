// Finish the existing accepted TXT experiment. Never create another Picsart job.
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';
import { Pool } from 'pg';
import { initPicsart, pollSeedanceResult } from '../src/picsart';
import { generateRenderful1080 } from '../src/renderful-auto-upscale';
import { inspectFloraUpscaleVideo, normalizeFlora1080 } from '../src/flora-upscale-media';

if (!process.argv.includes('--paid')) throw Error('PAID_AUTHORIZATION_REQUIRED');
const dir = path.resolve(__dirname, process.argv.includes('--compact-metadata')
  ? '../../generated-artifacts/seedance25-txt-compact-metadata'
  : '../../generated-artifacts/seedance25-txt-live');
const stateFile = path.join(dir, 'finishing.json');
let native = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
let state: any = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
function save(patch: Record<string, unknown>) {
  state = { ...state, ...patch };
  fs.writeFileSync(stateFile + '.tmp', JSON.stringify(state, null, 2));
  fs.renameSync(stateFile + '.tmp', stateFile);
}
const db = new Pool({ connectionString: process.env.RAILWAY_DATABASE_URL,
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
const http = axios.create({ proxy: false, timeout: 180000 });
const base = 'https://api.renderful.ai/api/v1';
initPicsart(db);
async function main() {
  const deadline = Date.now() + 30 * 60 * 1000;
  while (native.status !== 'completed') {
    if (native.status === 'stopped' || Date.now() >= deadline) throw Error('NATIVE_NOT_COMPLETED');
    await new Promise(resolve => setTimeout(resolve, 10000));
    native = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8'));
  }
  if (!native.jobId) throw Error('NATIVE_JOB_MISSING');
  if (state.completed) { console.log('ALREADY_FINISHED'); return; }
  if (state.submitAttempted && !state.jobId) throw Error('AMBIGUOUS_UPSCALE_DO_NOT_REPLAY');
  // Poll an already completed job to recover its download URL; no new generation.
  const source = await pollSeedanceResult(native.accountId, native.jobId, { maxAttempts: 1, intervalMs: 1 });
  const rows = await db.query(state.keyId
    ? 'SELECT id, api_key FROM renderful_key_pool WHERE id = $1'
    : "SELECT id, api_key FROM renderful_key_pool WHERE status <> 'dead' ORDER BY id",
    state.keyId ? [state.keyId] : []);
  let selected: any;
  for (const row of rows.rows) {
    if (state.jobId) { selected = row; break; }
    try {
      const balance = await http.get(`${base}/account/balance`, {
        headers: { Authorization: `Bearer ${row.api_key}` },
      });
      if (Number(balance.data.balance_available) > 0) { selected = row; break; }
    } catch { console.log('UPSCALER_PREFLIGHT_UNAVAILABLE'); }
  }
  if (!selected) throw Error('NO_READY_UPSCALER_KEY');
  save({ keyId: selected.id });
  let published = 0;
  const result = await generateRenderful1080(source.url, {
    key: async () => selected.api_key,
    disable: async () => {}, // QA never changes key availability for public users.
    download: async url => Buffer.from((await http.get(url, {
      responseType: 'arraybuffer', maxContentLength: 250 * 1024 * 1024,
    })).data),
    inspect: inspectFloraUpscaleVideo,
    publish: async bytes => {
      if (published++ === 0) return source.url; // Public Picsart asset, never a Telegram-token URL.
      const file = path.join(dir, 'output-1080p.mp4');
      fs.writeFileSync(file, bytes);
      return file;
    },
    submit: async (key, url) => {
      if (state.jobId) return { id: state.jobId };
      if (state.submitAttempted) throw Error('AMBIGUOUS_UPSCALE_DO_NOT_REPLAY');
      save({ submitAttempted: true });
      const response = await http.post(`${base}/generations`, {
        type: 'video-to-video', model: 'bytedance-video-upscaler',
        video_url: url, resolution: '1080p',
      }, { headers: { Authorization: `Bearer ${key}` } });
      const id = response.data?.id;
      save({ jobId: id ?? null });
      if (!id) throw Error('AMBIGUOUS_UPSCALE_RESPONSE');
      console.log('ONE_UPSCALE_JOB_ACCEPTED', id);
      return { id };
    },
    poll: async (key, id) => {
      for (let i = 0; i < 120; i++) {
        await new Promise(resolve => setTimeout(resolve, 10000));
        const response = await http.get(`${base}/generations/${id}`, {
          headers: { Authorization: `Bearer ${key}` },
        });
        const data = response.data;
        if (state.providerStatus !== data.status) {
          save({ providerStatus: data.status });
          console.log('UPSCALER_STATUS', data.status);
        }
        if (data.status === 'failed') throw Error('UPSCALER_FAILED');
        if (data.status === 'completed') {
          const output = data.output ?? data.outputs?.[0];
          const url = typeof output === 'string' ? output : output?.url ?? output?.video_url;
          if (!url) throw Error('UPSCALER_NO_OUTPUT');
          return url;
        }
      }
      throw Error('UPSCALER_POLL_TIMEOUT');
    },
    normalize: normalizeFlora1080,
    log: event => console.log(event),
  });
  if (!result.upscaled || !fs.existsSync(path.join(dir, 'output-1080p.mp4'))) {
    throw Error('MANDATORY_UPSCALE_NOT_DELIVERABLE');
  }
  const facts = await inspectFloraUpscaleVideo(fs.readFileSync(result.url));
  save({ completed: true, ...facts, botSaldoCharged: false });
  console.log('FINISHED_1080P', JSON.stringify(facts));
}
main().catch((error: any) => {
  // Never print Axios configs or upstream bodies, which can contain credentials.
  console.error('FINISH_STOPPED', error.response?.status ?? error.code ?? (
    /^[A-Z_]+$/.test(error.message) ? error.message : 'FINISH_ERROR'));
  process.exitCode = 1;
}).finally(() => db.end());
