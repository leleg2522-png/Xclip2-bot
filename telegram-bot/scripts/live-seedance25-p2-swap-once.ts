// One authorized P2 generation and one finishing job. Never replay a submit.
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import axios from 'axios';
import { Pool } from 'pg';
import { inspectFloraUpscaleVideo, normalizeFlora1080 } from '../src/flora-upscale-media';

if (!process.argv.includes('--paid-once')) throw Error('PAID_AUTHORIZATION_REQUIRED');
const workspace = path.resolve(__dirname, '../..');
const root = path.join(workspace, 'generated-artifacts/seedance25-p2-character-swap-once');
const stateFile = path.join(root, 'state.json');
const db = new Pool({ connectionString: process.env.RAILWAY_DATABASE_URL,
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
const download = axios.create({ proxy: false, timeout: 180000, maxContentLength: 250 * 1024 * 1024 });
const finishingBase = 'https://api.renderful.ai/api/v1';
let state: any = {};
let locked = false;
async function save(patch: Record<string, unknown>) {
  state = { ...state, ...patch };
  await fs.writeFile(stateFile + '.tmp', JSON.stringify(state, null, 2));
  await fs.rename(stateFile + '.tmp', stateFile);
}
function safeError(error: any) {
  return String(error?.message ?? 'UNKNOWN_ERROR').replace(/https?:\/\/\S+/g, '[url]')
    .replace(/Bearer\s+\S+|rt:\S+/gi, '[redacted]').slice(0, 400);
}
async function main() {
  const preflight = JSON.parse(await fs.readFile(path.join(root, 'preflight.json'), 'utf8'));
  if (preflight.duration !== 30 || preflight.generateAudio !== false || preflight.quoteCredits !== 200
    || preflight.imageUrls?.length !== 1 || preflight.videoUrls?.length !== 1) {
    throw Error('P2_PREFLIGHT_DOES_NOT_MATCH_APPROVAL');
  }
  try { state = JSON.parse(await fs.readFile(stateFile, 'utf8')); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  if (state.completedAt) { console.log('P2_TEST_ALREADY_COMPLETED'); return; }
  await (await fs.open(path.join(root, 'run.lock'), 'wx')).close();
  locked = true;
  const accountId = state.accountId ?? preflight.accountId;
  await save({ accountId, startedAt: state.startedAt ?? new Date().toISOString(),
    model: 'Seedance 2.5 P2 · standard', botSaldoCharged: false,
    status: state.status ?? 'preflight', sourcePath: preflight.sourcePath,
    imagePath: preflight.imagePath, outputSeconds: 30, generatedAudio: false });

  const moduleSource = await fs.readFile(path.join(workspace, 'telegram-bot/src/picsart.ts'), 'utf8');
  const context = vm.createContext({
    exports: {}, require: createRequire(path.join(workspace, 'telegram-bot/src/picsart.ts')),
    process, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval,
    console: { log() {}, warn() {}, error() {} },
  });
  vm.runInContext(ts.transpileModule(moduleSource, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText + '\nexports.qa = { http, commonHeaders, API_BASE, X_APP_AUTHORIZATION };', context);
  const provider = (context as any).exports;
  provider.initPicsart({ query: (sql: string, values?: any[]) => {
    if (!/^\s*SELECT\b/i.test(sql) && !/^\s*UPDATE picsart_credentials\s+SET access_token\b/i.test(sql)) {
      throw Error('P2_QA_DATABASE_WRITE_BLOCKED');
    }
    return db.query(sql, values);
  } });
  // Resume accepted jobs with their original key, never another pool account.
  const keys = await db.query(state.finishingKeyId
    ? 'SELECT id, api_key FROM renderful_key_pool WHERE id = $1'
    : "SELECT id, api_key FROM renderful_key_pool WHERE status <> 'dead' ORDER BY id",
  state.finishingKeyId ? [state.finishingKeyId] : []);
  let finishingKey: any;
  for (const row of keys.rows) {
    if (state.finishingKeyId && state.finishingTaskId) { finishingKey = row; break; }
    try {
      const balance = await download.get(`${finishingBase}/account/balance`, {
        headers: { Authorization: `Bearer ${row.api_key}` },
      });
      if (Number(balance.data.balance_available) > 0) { finishingKey = row; break; }
    } catch { /* Do not log credential-bearing transport errors. */ }
  }
  if (!finishingKey) throw Error('NO_READY_FINISHING_KEY');
  await save({ finishingKeyId: finishingKey.id });

  if (!state.nativeTaskId) {
    if (state.nativeSubmitAttempted) throw Error('P2_AMBIGUOUS_SUBMIT_DO_NOT_REPLAY');
    const { http, commonHeaders, API_BASE, X_APP_AUTHORIZATION } = provider.qa;
    const quote = await http.post(`${API_BASE}/gw-v2/workflows/seedance/options`, { params: {
      model: provider.SEEDANCE_MODEL,
      content: [
        { type: 'video_url', video_url: { url: preflight.videoUrls[0] }, role: 'reference_video' },
        { type: 'image_url', image_url: { url: preflight.imageUrls[0] }, role: 'reference_image' },
        { type: 'text', text: preflight.prompt },
      ],
      ratio: '16:9', duration: 30, resolution: '480p', generate_audio: false,
      omni_reference_task_type: 'reference', output_format: 'mp4',
    } }, { headers: commonHeaders({
      'content-type': 'application/json',
      authorization: `Bearer ${await provider.getAccessToken(accountId)}`,
      'x-app-authorization': X_APP_AUTHORIZATION,
      'x-sub-package-id': 'subscription_pro_monthly',
    }), validateStatus: () => true });
    const credits = quote.data?.response?.credits;
    if (quote.status < 200 || quote.status >= 300 || !Number.isFinite(credits) || credits <= 0
      || credits > 200 || quote.data?.response?.chargeCredits === true) {
      throw Error('P2_QUOTE_CHANGED_OR_INVALID_DO_NOT_SUBMIT');
    }
    const balance = await provider.getCredits(accountId);
    if (!(balance.credits >= credits)) throw Error('P2_ACCOUNT_CREDITS_BELOW_QUOTE');
    await save({ confirmedQuoteCredits: credits, nativeSubmitAttempted: true, status: 'submitting_native' });
    console.log('P2_SUBMIT_ONCE', JSON.stringify({ quoteCredits: credits, outputSeconds: 30, generatedAudio: false }));
    const id = await provider.submitSeedance(accountId, {
      prompt: preflight.prompt, imageUrls: preflight.imageUrls, videoUrls: preflight.videoUrls,
      audioUrls: [], duration: 30, ratio: '16:9', resolution: '480p', generateAudio: false,
      outputName: 'seedance25-p2-character-swap-test.mp4',
    });
    await save({ nativeTaskId: id, status: 'polling_native' });
    console.log('P2_NATIVE_JOB_SAVED');
  }
  if (!state.nativeResultUrl) {
    let minute = -1;
    const native = await provider.pollSeedanceResult(accountId, state.nativeTaskId, {
      maxAttempts: 360, intervalMs: 5000,
      onTick: (elapsed: number) => {
        const current = Math.floor(elapsed / 60000);
        if (current !== minute) { minute = current; console.log('P2_ELAPSED_MINUTES', minute); }
      },
    });
    await save({ nativeResultUrl: native.url, nativeCredits: native.credits ?? null, status: 'native_completed' });
  }
  const source = Buffer.from((await download.get(state.nativeResultUrl, { responseType: 'arraybuffer' })).data);
  await fs.writeFile(path.join(root, 'native.mp4'), source);
  const nativeFacts = await inspectFloraUpscaleVideo(source);
  if (Math.abs(nativeFacts.duration - 30) > 0.5) throw Error('P2_UNEXPECTED_OUTPUT_DURATION');
  await save({ nativeFacts });
  console.log('P2_NATIVE_COMPLETED', JSON.stringify({ ...nativeFacts, credits: state.nativeCredits }));
  if (!state.finishingTaskId) {
    if (state.finishingSubmitAttempted) throw Error('P2_FINISHING_AMBIGUOUS_DO_NOT_REPLAY');
    await save({ finishingSubmitAttempted: true, status: 'submitting_finishing' });
    const response = await download.post(`${finishingBase}/generations`, {
      type: 'video-to-video', model: 'bytedance-video-upscaler',
      video_url: state.nativeResultUrl, resolution: '1080p',
    }, { headers: { Authorization: `Bearer ${finishingKey.api_key}` } });
    const id = response.data?.id;
    if (!id) throw Error('P2_FINISHING_AMBIGUOUS_RESPONSE');
    await save({ finishingTaskId: id, status: 'polling_finishing' });
    console.log('P2_FINISHING_JOB_SAVED');
  }
  let outputUrl = state.finishingResultUrl;
  for (let i = 0; !outputUrl && i < 120; i++) {
    await new Promise(resolve => setTimeout(resolve, 10000));
    const { data } = await download.get(`${finishingBase}/generations/${state.finishingTaskId}`, {
      headers: { Authorization: `Bearer ${finishingKey.api_key}` },
    });
    if (state.finishingStatus !== data.status) {
      await save({ finishingStatus: data.status });
      console.log('P2_FINISHING_STATUS', data.status);
    }
    if (data.status === 'failed') throw Error('P2_FINISHING_FAILED');
    if (data.status === 'completed') {
      const output = data.output ?? data.outputs?.[0];
      outputUrl = typeof output === 'string' ? output : output?.url ?? output?.video_url;
      if (!outputUrl) throw Error('P2_FINISHING_MISSING_OUTPUT');
      await save({ finishingResultUrl: outputUrl });
    }
  }
  if (!outputUrl) throw Error('P2_FINISHING_POLL_TIMEOUT');
  const rendered = Buffer.from((await download.get(outputUrl, { responseType: 'arraybuffer' })).data);
  const final = await normalizeFlora1080(source, rendered);
  const facts = await inspectFloraUpscaleVideo(final);
  if (Math.min(facts.width, facts.height) !== 1080 || Math.abs(facts.duration - 30) > 0.5) {
    throw Error('P2_FINAL_SETTINGS_MISMATCH');
  }
  await fs.writeFile(path.join(root, 'p2-character-swap-1080p.mp4'), final);
  await save({ status: 'completed', output: facts, completedAt: new Date().toISOString(), failure: null });
  console.log('P2_TEST_COMPLETED', JSON.stringify({ ...facts, credits: state.nativeCredits }));
}
main().catch(async error => {
  const message = safeError(error);
  console.error('P2_TEST_STOPPED', message);
  if (locked) await save({ failure: message, stoppedAt: new Date().toISOString() }).catch(() => {});
  process.exitCode = 1;
}).finally(async () => {
  if (locked) await fs.unlink(path.join(root, 'run.lock')).catch(() => {});
  await db.end();
});
