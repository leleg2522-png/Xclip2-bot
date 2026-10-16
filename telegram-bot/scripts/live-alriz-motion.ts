import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import axios from 'axios';
import { Client } from 'pg';
import { AlrizKeyPool } from '../src/alriz-key-pool';
import { generateKlingAlrizFromPool } from '../src/alriz-motion';

// One explicitly authorized paid job. Keep generated outputs and state out of Git.
const directory = path.resolve(__dirname, '../../generated-artifacts/alriz-p5-live-test');
const stateFile = path.join(directory, 'state.json');
const outputFile = path.join(directory, 'result.mp4');
type State = { keyId?: number; submitAttempted?: boolean; jobId?: string; status?: string; submittedAt?: string; downloaded?: boolean };
let state: State = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
fs.mkdirSync(directory, { recursive: true });
function save(patch: Partial<State>) {
  state = { ...state, ...patch };
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
}
const client = new Client({
  connectionString: process.env.RAILWAY_DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000,
});
const http = axios.create({ timeout: 120000, proxy: false, validateStatus: () => true });
const base = 'https://alrizmotion.my.id/api';
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
function note(status: unknown) {
  if (typeof status === 'string' && ['QUEUED', 'CLAIMING', 'UPLOADING', 'PROCESSING', 'SAVING', 'DONE', 'FAILED', 'NO_STOCK'].includes(status)
    && state.status !== status) {
    save({ status });
    console.log(JSON.stringify({ stage: 'poll', status }));
  }
}
async function resume(): Promise<string> {
  const rows = await client.query('SELECT api_key FROM alriz_key_pool WHERE id = $1', [state.keyId]);
  if (!rows.rows.length) throw Error('QA_KEY_NOT_FOUND');
  const config = { headers: { 'X-API-Key': rows.rows[0].api_key } };
  console.log(JSON.stringify({ stage: 'resume', accepted: true, jobId: state.jobId }));
  for (let i = 0; i < 240; i++) {
    const response = await http.get(`${base}/jobs/${state.jobId}`, config);
    if (response.status === 429 || response.status >= 500) { await wait(5000); continue; }
    if (response.status !== 200) throw Error('QA_RESUME_REQUEST_FAILED');
    const job = response.data;
    note(job.status);
    if (job.status === 'DONE') {
      if (job.result_expired) throw Error('QA_RESULT_EXPIRED');
      if (job.result_url) return job.result_url;
      const result = await http.get(`${base}/jobs/${state.jobId}/result`, config);
      if (result.status === 200 && result.data.result_url) return result.data.result_url;
      throw Error('QA_RESULT_MISSING');
    }
    if (['FAILED', 'NO_STOCK'].includes(job.status)) throw Error('QA_JOB_FAILED');
    await wait(5000);
  }
  throw Error('QA_POLL_TIMEOUT');
}

async function main() {
  if (state.downloaded && fs.existsSync(outputFile)) {
    console.log(JSON.stringify({ completed: true, reusedExistingResult: true, output: path.relative(process.cwd(), outputFile) }));
    return;
  }
  await client.connect();
  let url: string;
  if (state.jobId) {
    url = await resume();
  } else {
    if (!process.argv.includes('--submit')) throw Error('QA_EXPLICIT_SUBMIT_REQUIRED');
    if (state.submitAttempted) throw Error('QA_AMBIGUOUS_SUBMIT_DO_NOT_RETRY');
    const source = JSON.parse(fs.readFileSync('/tmp/alriz-live-inputs.json', 'utf8'));
    const pool = new AlrizKeyPool(client);
    url = await generateKlingAlrizFromPool({
      image: fs.readFileSync('/tmp/alriz-live-image'),
      video: fs.readFileSync('/tmp/alriz-live-video'),
      seconds: source.seconds,
      prompt: 'Make the person in the image follow the body movements in the reference video. Preserve their appearance and clothing.',
    }, {
      pool: {
        next: async skip => {
          // This live test is limited to one credential and one submit attempt.
          if (skip.length || state.submitAttempted) return null;
          const key = await pool.next(skip);
          if (key) save({ keyId: key.id });
          return key;
        },
        disable: id => pool.disable(id),
      },
      // Reuse the public reference assets from the user's previously supplied HAR.
      // Production instead publishes Telegram bytes on the bot's own domain.
      publish: async (_bytes, video) => video ? source.videoUrl : source.imageUrl,
      status: async () => {},
      http: {
        post: async (requestUrl, body, config) => {
          if (state.submitAttempted) throw Error('QA_SECOND_SUBMIT_BLOCKED');
          save({ submitAttempted: true, submittedAt: new Date().toISOString() });
          const response = await http.post(requestUrl, body, config);
          const id = response.data?.job_id;
          if (response.status >= 200 && response.status < 300 && typeof id === 'string' && /^[A-Za-z0-9_-]{1,160}$/.test(id)) {
            save({ jobId: id });
            console.log(JSON.stringify({ stage: 'accepted', jobId: id, keyId: state.keyId }));
          }
          return response;
        },
        get: async (requestUrl, config) => {
          const response = await http.get(requestUrl, config);
          if (response.status === 200) note(response.data?.status);
          return response;
        },
      },
    });
  }
  if (typeof url !== 'string' || !url.startsWith('https://')) throw Error('QA_INVALID_RESULT_URL');
  const response = await http.get(url, { responseType: 'stream', timeout: 180000 });
  if (response.status !== 200) throw Error('QA_DOWNLOAD_FAILED');
  await pipeline(response.data, fs.createWriteStream(outputFile));
  save({ status: 'DONE', downloaded: true });
  console.log(JSON.stringify({ completed: true, output: path.relative(process.cwd(), outputFile), bytes: fs.statSync(outputFile).size }));
}
main().catch(error => {
  console.error(JSON.stringify({
    failed: true, accepted: Boolean(state.jobId), jobId: state.jobId,
    code: typeof error?.message === 'string' && /^(QA|ALRIZ)_[A-Z0-9_]+(?: job=[A-Za-z0-9_-]+)?$/.test(error.message)
      ? error.message : 'QA_UPSTREAM_FAILED',
  }));
  process.exitCode = 1;
}).finally(() => client.end().catch(() => {}));
