// One explicitly authorized paid test; never charges a customer's bot saldo.
// Keep state so interruption can resume polling, never repeat a paid submit.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { pipeline } from 'node:stream/promises';

if (!process.argv.includes('--paid')) throw Error('PAID_TEST_AUTHORIZATION_REQUIRED');
if (!process.env.DECODO_TEST_USERNAME || !process.env.DECODO_TEST_PASSWORD) throw Error('TEST_PROXY_SECRETS_MISSING');
const root = path.resolve(import.meta.dirname, '../..');
const dir = path.join(root, 'generated-artifacts/picsart-datacenter-test');
fs.mkdirSync(dir, { recursive: true });
const stateFile = path.join(dir, 'state.json');
let state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
const lock = fs.openSync(path.join(dir, 'running.lock'), 'wx');
function save(patch) {
  state = { ...state, ...patch };
  fs.writeFileSync(`${stateFile}.tmp`, JSON.stringify(state, null, 2));
  fs.renameSync(`${stateFile}.tmp`, stateFile);
}
const require = createRequire(path.join(root, 'telegram-bot/dist/picsart.js'));
const { Pool } = require('pg');
const axios = require('axios');
const db = new Pool({
  connectionString: process.env.RAILWAY_DATABASE_URL,
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000,
});
// Override only this diagnostic process. Production settings are untouched.
const env = {
  ...process.env, DECODO_PROXY_HOST: 'dc.decodo.com',
  DECODO_PROXY_PORT: '10001', DECODO_PROXY_PORTS: '10001',
  DECODO_PROXY_USERNAME: process.env.DECODO_TEST_USERNAME,
  DECODO_PROXY_PASSWORD: process.env.DECODO_TEST_PASSWORD,
  PICSART_PROXY_MODE: 'isp',
};
const context = vm.createContext({
  exports: {}, require, process: { env }, Buffer, URL,
  console: { log() {}, warn() {}, error() {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
});
const code = fs.readFileSync(path.join(root, 'telegram-bot/dist/picsart.js'), 'utf8');
vm.runInContext(`${code}\nexports.qa = { http, commonHeaders, preflightKling4OmniCredits, submitPicsartI2v, pollPicsartI2vResult };`, context);
const picsart = context.exports;
const { http, preflightKling4OmniCredits, submitPicsartI2v, pollPicsartI2vResult } = picsart.qa;
// No customer assignments, saldo changes, schema changes or dead-account writes.
// Only normal successful token-refresh updates are allowed during this test.
picsart.initPicsart({
  query: (sql, values) => {
    if (!/^\s*SELECT\b/i.test(sql) && !/^\s*UPDATE picsart_credentials\s+SET access_token\b/i.test(sql)) {
      throw Error('QA_DATABASE_WRITE_BLOCKED');
    }
    return db.query(sql, values);
  },
});
http.interceptors.request.use(config => {
  if (/\/submit$/.test(config.url ?? '')) {
    if (state.submitAttempted) throw Error('QA_SUBMIT_ALREADY_ATTEMPTED_NO_REPLAY');
    save({ submitAttempted: true, submittedAt: new Date().toISOString() });
  }
  return config;
});
http.interceptors.response.use(response => {
  if (/\/options$/.test(response.config.url ?? '')) {
    const credits = response.data?.response?.credits;
    if (typeof credits === 'number') {
      if (credits > 90) throw Error('QA_QUOTE_EXCEEDS_TEST_BUDGET');
      save({ quotedCredits: credits });
      console.log('QUOTE_CREDITS', credits);
    }
  }
  if (/\/submit$/.test(response.config.url ?? '')) {
    const id = response.data?.response?.id;
    if (response.status >= 200 && response.status < 300 && typeof id === 'string' && /^[a-zA-Z0-9_-]{1,160}$/.test(id)) {
      save({ jobId: id, status: 'accepted' });
      console.log('PAID_JOB_ACCEPTED', id);
    } else {
      console.log('SUBMIT_HTTP_STATUS', response.status);
    }
  }
  return response;
});
try {
  if (state.status === 'completed' && fs.existsSync(path.join(dir, 'native.mp4'))) {
    console.log('TEST_ALREADY_COMPLETE');
  } else {
    const prompt = 'A cinematic wide shot of a small red sailboat moving gently across a calm turquoise lake, green mountains in the background, warm sunrise light, smooth slow camera movement, realistic natural details, no people, no text, no logos.';
    let credentialId = state.credentialId;
    if (!state.jobId) {
      if (state.submitAttempted) throw Error('QA_AMBIGUOUS_SUBMIT_DO_NOT_RETRY');
      const candidates = await db.query(`SELECT id FROM picsart_credentials
        WHERE status = 'available'
        ORDER BY (access_expires_at > NOW() + INTERVAL '5 minutes') DESC NULLS LAST, updated_at DESC LIMIT 5`);
      credentialId = undefined;
      for (const row of candidates.rows) {
        try {
          await preflightKling4OmniCredits(row.id, prompt, '', '16:9', {
            mode: 't2v', duration: 10, imageUrls: [],
          });
          credentialId = row.id;
          break;
        } catch (error) {
          console.log('PRE_SUBMIT_ACCOUNT_CHECK_FAILED', error?.response?.status ?? 'PREFLIGHT_OR_AUTH');
        }
      }
      if (!credentialId) throw Error('QA_NO_READY_ACCOUNT_NO_PAID_SUBMIT');
      save({
        credentialId, model: 'kling_v4_t2v', duration: 10, ratio: '16:9',
        proxyHost: 'dc.decodo.com', proxyPort: '10001', botSaldoCharged: false,
      });
      console.log('PREFLIGHT_PASSED');
      const id = await submitPicsartI2v(credentialId, 'kling_v4_t2v', prompt, '', { duration: 10, ratio: '16:9' });
      if (state.jobId !== id) throw Error('QA_JOB_STATE_MISMATCH');
    } else {
      console.log('RESUMING_EXISTING_JOB_NO_RESUBMIT');
    }
    let lastTick = 0;
    const result = await pollPicsartI2vResult(credentialId, 'kling_v4_t2v', state.jobId, {
      onTick: ms => {
        if (ms - lastTick >= 30000) {
          lastTick = ms;
          console.log('POLLING_SECONDS', Math.round(ms / 1000));
        }
      },
    });
    save({ status: 'generated', usedCredits: result.credits ?? null });
    console.log('GENERATION_COMPLETE', result.credits ?? 'USAGE_NOT_REPORTED');
    // Download through the same new proxy. Result URLs and tokens are not logged.
    const media = await http.get(result.url, { responseType: 'stream', timeout: 120000 });
    await pipeline(media.data, fs.createWriteStream(path.join(dir, 'native.mp4')));
    save({ status: 'completed', completedAt: new Date().toISOString(), nativeFile: 'native.mp4' });
    console.log('TEST_COMPLETE', 'generated-artifacts/picsart-datacenter-test/native.mp4');
  }
} catch (error) {
  const known = String(error?.message ?? '').match(/^(?:QA_[A-Z_]+|PICSART_[A-Z_]+)(?: status \d{3})?/);
  const diagnostic = known?.[0] ?? (error?.response?.status ? `HTTP_${error.response.status}` : 'NETWORK_OR_PROVIDER_FAILURE');
  save({ lastError: diagnostic, failedAt: new Date().toISOString() });
  console.log('TEST_FAILED', diagnostic);
  process.exitCode = 1;
} finally {
  await db.end();
  fs.closeSync(lock);
  fs.unlinkSync(path.join(dir, 'running.lock'));
}
