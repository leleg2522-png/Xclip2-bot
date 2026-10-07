// One paid QA job, using the same adapters and orchestration as the bot.
// Cached run state prevents a restart from submitting another paid job.
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
const { generateKlingP4Flora } = require('../dist/kling-p4-flora.js');
const root = path.resolve(import.meta.dirname, '../..');
const stateFile = '/tmp/kling-p4-live-state.json';
const output = path.join(root, 'outputs/kling-p4-flora-live.mp4');
let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
function save(data) {
  state = { ...state, ...data };
  fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(state));
  fs.renameSync(`${stateFile}.tmp`, stateFile);
}

const db = new Pool({
  connectionString: process.env.RAILWAY_DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 15000,
});
const http = axios.create({ timeout: 180000, proxy: false });
http.interceptors.response.use(response => {
  if (/\/runs\//.test(response.config.url || '')) {
    const data = response.data;
    if (state.status !== data.status) {
      save({ status: data.status });
      console.log(JSON.stringify({ stage: 'poll', status: data.status }));
    }
  }
  return response;
});

try {
  const rows = state.keyRecord
    ? (await db.query('SELECT id, api_key FROM flora_key_pool WHERE id = $1', [state.keyRecord])).rows
    : (await db.query("SELECT id, api_key FROM flora_key_pool WHERE status = 'available' ORDER BY id LIMIT 1")).rows;
  if (!rows.length) throw new Error('QA_NO_AVAILABLE_KEY');
  const record = rows[0];
  save({ keyRecord: record.id });
  const key = record.api_key; // Never log or persist this value.
  const source = fs.readFileSync(path.join(root, 'telegram-bot/src/index.ts'), 'utf8');
  const start = source.indexOf('interface FloraWorkspace');
  const end = source.indexOf('// Katalog image generation Flora', start);
  if (start < 0 || end <= start) throw new Error('QA_ADAPTER_BLOCK_NOT_FOUND');
  const adapters = vm.createContext({
    floraHttp: http, FLORA_BASE: 'https://app.flora.ai/api/v1',
    axios, FormData, setTimeout, Buffer,
    console: { log() {}, error() {} }, // Suppress raw bodies, URLs and workspace info.
  });
  vm.runInContext(ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, adapters);

  let url;
  if (state.runId) {
    console.log(JSON.stringify({ stage: 'resume', accepted: true }));
    url = await adapters.floraPollRun(key, state.runId, 20 * 60 * 1000);
  } else {
    if (state.submitAttempted) throw new Error('QA_AMBIGUOUS_SUBMIT_DO_NOT_RETRY');
    url = await generateKlingP4Flora({
      image: { buf: fs.readFileSync('/tmp/kling-p4-image.jpg'), name: 'character.jpg', mime: 'image/jpeg' },
      video: { buf: fs.readFileSync('/tmp/kling-p4-reference-5s.mp4'), name: 'motion-reference.mp4', mime: 'video/mp4' },
      seconds: 5,
      prompt: "Make the person in the image follow the body movements in the reference video. Preserve the person's appearance and clothing.",
    }, {
      getKey: async skip => skip.has(key) ? null : key,
      markDead: async () => { console.log(JSON.stringify({ credentialRejected: true, poolUnchanged: true })); },
      workspace: adapters.floraGetWorkspace,
      upload: adapters.floraUploadAsset,
      generate: async (...args) => {
        if (state.submitAttempted) throw new Error('QA_SECOND_SUBMIT_BLOCKED');
        save({ submitAttempted: true, submittedAt: new Date().toISOString() });
        const id = await adapters.floraGenerate(...args);
        save({ runId: id, status: 'accepted' });
        console.log(JSON.stringify({ accepted: true, runId: id, keyRecord: record.id }));
        return id;
      },
      poll: adapters.floraPollRun,
      exhausted: error => /\b401\b|\b402\b|\b403\b|billing|insufficient/i.test(String(error)),
      status: async text => console.log(JSON.stringify({ stage: text })),
    });
  }
  console.log(JSON.stringify({ stage: 'download' }));
  const result = await http.get(url, { responseType: 'stream' });
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await pipeline(result.data, fs.createWriteStream(output));
  save({ status: 'completed', output: path.relative(root, output) });
  console.log(JSON.stringify({ completed: true, output: path.relative(root, output), bytes: fs.statSync(output).size }));
} catch (error) {
  // Axios messages/configs can contain credentials and signed URLs: never dump them.
  const data = error.response?.data;
  console.error(JSON.stringify({
    failed: true, accepted: Boolean(state.runId),
    httpStatus: error.response?.status, code: error.code,
    errorType: typeof error.message === 'string' && error.message.startsWith('FLORA_RUN_FAILED')
      ? error.message.slice(0, 220).replace(/https?:\/\/\S+/g, '[URL]')
      : typeof error.message === 'string' && error.message.startsWith('QA_') ? error.message : 'UPSTREAM_ERROR',
    providerCode: data?.code || data?.error?.code,
  }));
  process.exitCode = 1;
} finally {
  await db.end();
}
