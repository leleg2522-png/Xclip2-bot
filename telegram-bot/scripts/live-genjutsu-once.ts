// Owner-authorized single live test. Persist accepted jobs; never submit twice.
import fs from 'node:fs/promises';
import path from 'node:path';
import axios from 'axios';
import { Pool } from 'pg';
import { GENJUTSU_PROMPT } from '../src/genjutsu';
import { restoreGenjutsuAudio } from '../src/genjutsu-audio';
import * as picsart from '../src/picsart';
import { inspectSeedance25Media } from '../src/seedance25-media';
import { generateRenderful1080 } from '../src/renderful-auto-upscale';
import { inspectFloraUpscaleVideo, normalizeFlora1080 } from '../src/flora-upscale-media';

const runName = process.argv.find(arg => arg.startsWith('--run-name='))?.slice('--run-name='.length)
  ?? 'genjutsu-live-once';
if (!/^genjutsu-[a-z0-9-]+$/.test(runName)) throw Error('INVALID_RUN_NAME');
const root = path.resolve(__dirname, '../../generated-artifacts', runName);
const statePath = path.join(root, 'state.json');
const sourceFile = process.argv.find(arg => arg.startsWith('--source-file='))?.slice('--source-file='.length)
  ?? 'generated-artifacts/kling4-woman-dance-live/native.mp4';
const sourcePath = path.resolve(__dirname, '../..', sourceFile);
const imagePath = path.resolve(__dirname, '../../attached_assets/generated_images/young-ceo-woman-reference.jpg');
const promptFile = process.argv.find(arg => arg.startsWith('--prompt-file='))?.slice('--prompt-file='.length);
const creditLimitArg = process.argv.find(arg => arg.startsWith('--max-credits='))?.slice('--max-credits='.length);
const creditLimit = creditLimitArg === undefined ? undefined : Number(creditLimitArg);
if (creditLimit !== undefined && (!Number.isFinite(creditLimit) || creditLimit <= 0)) {
  throw Error('INVALID_TEST_CREDIT_LIMIT');
}
const lockPath = path.join(root, 'run.lock');
const approveUpscale = process.argv.includes('--approve-upscale');
const db = new Pool({ connectionString: process.env.RAILWAY_DATABASE_URL,
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
const http = axios.create({ proxy: false, timeout: 180000, maxContentLength: 250 * 1024 * 1024 });
const base = 'https://api.renderful.ai/api/v1';
let state: any = {};
let ownsLock = false;
async function save(patch: Record<string, unknown>) {
  state = { ...state, ...patch };
  await fs.writeFile(statePath + '.tmp', JSON.stringify(state, null, 2));
  await fs.rename(statePath + '.tmp', statePath);
}
function safeError(error: any) {
  return String(error?.message ?? 'UNKNOWN_ERROR')
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/rt:\S+|Bearer\s+\S+/gi, '[redacted]').slice(0, 350);
}

async function main() {
  if (!process.argv.includes('--paid-once')) throw Error('PAID_AUTHORIZATION_REQUIRED');
  if (!process.env.RAILWAY_DATABASE_URL) throw Error('DATABASE_NOT_CONFIGURED');
  await fs.mkdir(root, { recursive: true });
  try { state = JSON.parse(await fs.readFile(statePath, 'utf8')); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  if (state.completedAt) { console.log('GENJUTSU_ALREADY_COMPLETED'); return; }
  // Resume the saved provider job, or a run that stopped strictly before submit.
  if (state.nativeAttempted && !state.nativeTaskId && !state.nativeResultUrl) {
    throw Error('GENJUTSU_AMBIGUOUS_SUBMIT_DO_NOT_REPLAY');
  }
  if (state.started) {
    // A stale lock is recoverable only for a persisted pre-submit state.
    try {
      const pidText = (await fs.readFile(lockPath, 'utf8')).trim();
      const pid = Number(pidText);
      if (Number.isInteger(pid) && pid > 0 && pid !== process.pid) {
        try {
          const args = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
          if (['node', 'nodejs', 'tsx'].includes(path.basename(args[0] ?? ''))
            && args.some(arg => arg.endsWith('/live-genjutsu-once.ts'))
            && args.includes(`--run-name=${runName}`)) {
            throw Error('TEST_ALREADY_RUNNING');
          }
        } catch (error: any) {
          if (error.code !== 'ENOENT' && error.code !== 'ESRCH') throw error;
        }
      }
      if ((await fs.readFile(lockPath, 'utf8')).trim() !== pidText) throw Error('TEST_LOCK_CHANGED_RETRY_LATER');
      await fs.unlink(lockPath);
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  // Exclusive lock also covers simultaneous invocations.
  const lock = await fs.open(lockPath, 'wx');
  ownsLock = true;
  await lock.writeFile(String(process.pid));
  await lock.close();
  await save({ started: true, status: 'preflight', startedAt: state.startedAt ?? new Date().toISOString(),
    resumedPreSubmit: Boolean(state.started),
    sourcePath, imagePath, botSaldoCharged: false, generateAudio: false });
  const originalQuery = db.query.bind(db);
  db.query = ((sql: string, values?: any[]) => {
    if (!/^\s*SELECT\b/i.test(sql)
      && !/^\s*UPDATE picsart_credentials\s+SET access_token\b/i.test(sql)) {
      throw Error('QA_DATABASE_WRITE_BLOCKED');
    }
    return originalQuery(sql, values);
  }) as typeof db.query;
  picsart.initPicsart(db);
  const [video, image] = await Promise.all([fs.readFile(sourcePath), fs.readFile(imagePath)]);
  const duration = await inspectSeedance25Media(video, 'video');
  if (duration < 4 || duration > 30) throw Error('INVALID_SOURCE_DURATION');
  const requestedPrompt = promptFile
    ? (await fs.readFile(path.resolve(__dirname, '../..', promptFile), 'utf8')).trim()
    : GENJUTSU_PROMPT;
  if (state.nativeAttempted && state.prompt && state.prompt !== requestedPrompt) {
    throw Error('CANNOT_CHANGE_PROMPT_AFTER_SUBMIT');
  }
  const prompt = state.nativeAttempted ? (state.prompt ?? requestedPrompt) : requestedPrompt;
  await save({ prompt });
  console.log('GENJUTSU_PREFLIGHT', JSON.stringify({ sourceSeconds: duration, duration: 'auto', taskType: 'edit' }));

  let selected: any;
  // Finishing is an explicit second step after the owner reviews the raw video.
  if (approveUpscale) {
    console.log('GENJUTSU_FINISHING_POOL_CHECK');
    const rows = state.finishingKeyId
      ? await db.query('SELECT id, api_key FROM renderful_key_pool WHERE id = $1', [state.finishingKeyId])
      : await db.query("SELECT id, api_key FROM renderful_key_pool WHERE status <> 'dead' ORDER BY id");
    for (const row of rows.rows) {
      if (state.finishingTaskId) { selected = row; break; }
      try {
        const response = await http.get(`${base}/account/balance`, {
          headers: { Authorization: `Bearer ${row.api_key}` },
          timeout: 15000,
        });
        if (Number(response.data.balance_available) > 0) { selected = row; break; }
      } catch { /* No secret-bearing transport errors in output. */ }
    }
    if (!selected) throw Error('NO_READY_FINISHING_KEY');
  }
  const input = {
    userId: 0, persistAccount: false, prompt,
    generateAudio: false,
    taskType: 'edit' as const,
    images: [{ buffer: image, name: 'genjutsu-character.jpg', mime: 'image/jpeg' }],
    videos: [{ buffer: video, name: 'genjutsu-source.mp4', mime: 'video/mp4', duration }],
    audios: [],
  };
  let nativeUrl = state.nativeResultUrl as string | undefined;
  let nativeCredits = state.nativeCredits as number | undefined;
  if (!nativeUrl && state.nativeTaskId) {
    let lastTick = 0;
    const result = await picsart.pollSeedance25FlashResult(state.credentialId, state.nativeTaskId, {
      onTick: elapsedMs => {
        const seconds = Math.round(elapsedMs / 1000);
        if (seconds - lastTick >= 60) { lastTick = seconds; console.log('NATIVE_ELAPSED_SECONDS', seconds); }
      },
    });
    nativeUrl = result.url;
    nativeCredits = result.credits;
    await save({ nativeResultUrl: nativeUrl, nativeCredits, status: 'finishing', nativeCompleted: true });
  }
  if (!nativeUrl) {
    if (state.nativeAttempted) throw Error('GENJUTSU_AMBIGUOUS_SUBMIT_DO_NOT_REPLAY');
    const quote = await picsart.generateSeedance25Flash({ ...input, quoteOnly: true });
    await save({ quoteCredits: quote.credits, inputDuration: duration, status: 'quoted',
      taskType: quote.taskType, durationSetting: quote.duration, ratioSetting: quote.aspectRatio });
    console.log('QUOTE', JSON.stringify({ credits: quote.credits, sourceSeconds: duration,
      taskType: quote.taskType, duration: quote.duration, ratio: quote.aspectRatio }));
    if (quote.taskType !== 'edit' || quote.duration !== -1 || quote.aspectRatio !== 'adaptive') {
      throw Error('TEST_REQUIRES_AUTOMATIC_REFERENCE_VIDEO_DURATION_AND_RATIO');
    }
    if (creditLimit !== undefined && quote.credits > creditLimit) {
      throw Error('TEST_QUOTE_EXCEEDS_CREDIT_LIMIT_DO_NOT_SUBMIT');
    }
    if (!quote.hasEnoughProviderCredits) throw Error('INSUFFICIENT_PROVIDER_CREDITS');
    await save({ nativeAttempted: true, status: 'generating' });
    let lastTick = 0;
    const result = await picsart.generateSeedance25Flash({
      ...input, maxProviderCredits: quote.credits,
      onStatus: stage => console.log('NATIVE_STAGE', stage),
      onSubmitted: async ({ credentialId, taskId }) => {
        await save({ credentialId, nativeTaskId: taskId, status: 'polling_native' });
        console.log('NATIVE_JOB_SAVED');
      },
      onPoll: seconds => {
        if (seconds - lastTick >= 60) { lastTick = seconds; console.log('NATIVE_ELAPSED_SECONDS', seconds); }
      },
    });
    nativeUrl = result.url;
    nativeCredits = result.credits;
    await save({ status: 'finishing', nativeCompleted: true, nativeCredits, nativeResultUrl: nativeUrl });
  }
  const nativePath = path.join(root, 'native.mp4');
  try { await fs.access(nativePath); }
  catch {
    await fs.writeFile(nativePath, (await http.get(nativeUrl, { responseType: 'arraybuffer' })).data);
  }
  console.log('NATIVE_COMPLETED', JSON.stringify({ credits: nativeCredits }));
  if (!approveUpscale) {
    const facts = await inspectFloraUpscaleVideo(await fs.readFile(nativePath));
    await save({ status: 'awaiting_visual_review', previewReadyAt: new Date().toISOString(),
      nativeFacts: facts, finishingApproved: false, failure: null });
    console.log('GENJUTSU_RAW_REVIEW_READY', JSON.stringify({ ...facts, credits: nativeCredits }));
    return;
  }
  let published = 0;
  const final = await generateRenderful1080(nativeUrl!, {
    key: async () => selected.api_key, disable: async () => {},
    download: async url => Buffer.from((await http.get(url, { responseType: 'arraybuffer' })).data),
    inspect: inspectFloraUpscaleVideo,
    publish: async bytes => {
      // Native URL is a public Picsart asset, never a Telegram-token URL.
      if (published++ === 0) return nativeUrl!;
      const file = path.join(root, 'genjutsu-1080p.mp4');
      await fs.writeFile(file, bytes);
      return file;
    },
    submit: async (key, url) => {
      if (state.finishingTaskId) return { id: state.finishingTaskId };
      if (state.finishingAttempted) throw Error('NO_FINISHING_REPLAY');
      await save({ finishingAttempted: true, finishingKeyId: selected.id });
      const response = await http.post(`${base}/generations`, {
        type: 'video-to-video', model: 'bytedance-video-upscaler', video_url: url, resolution: '1080p',
      }, { headers: { Authorization: `Bearer ${key}` } });
      const id = response.data?.id;
      await save({ finishingTaskId: id ?? null });
      if (!id) throw Error('AMBIGUOUS_FINISHING_SUBMIT');
      console.log('FINISHING_JOB_SAVED');
      return { id };
    },
    poll: async (key, id) => {
      if (state.finishingResultUrl) return state.finishingResultUrl;
      for (let i = 0; i < 120; i++) {
        await new Promise(resolve => setTimeout(resolve, 10000));
        const { data } = await http.get(`${base}/generations/${id}`, {
          headers: { Authorization: `Bearer ${key}` },
        });
        if (state.finishingStatus !== data.status) {
          await save({ finishingStatus: data.status });
          console.log('FINISHING_STATUS', data.status);
        }
        if (data.status === 'failed') throw Error('FINISHING_JOB_FAILED');
        if (data.status === 'completed') {
          const output = data.output ?? data.outputs?.[0];
          const url = typeof output === 'string' ? output : output?.url ?? output?.video_url;
          if (!url) throw Error('FINISHING_NO_OUTPUT');
          await save({ finishingResultUrl: url });
          return url;
        }
      }
      throw Error('FINISHING_POLL_TIMEOUT');
    },
    normalize: normalizeFlora1080,
    log: event => console.log('FINISHING_EVENT', event),
  });
  if (!final.upscaled) throw Error('MANDATORY_1080P_FAILED');
  // This fixture is 480p natively; a local final must have been produced.
  const outputPath = path.join(root, 'genjutsu-1080p.mp4');
  const visual = await fs.readFile(outputPath);
  const restored = await restoreGenjutsuAudio(video, visual);
  await fs.writeFile(outputPath, restored.buffer);
  const facts = await inspectFloraUpscaleVideo(restored.buffer);
  if (Math.min(facts.width, facts.height) !== 1080) throw Error('OUTPUT_NOT_1080P');
  await save({ status: 'completed', completedAt: new Date().toISOString(), output: facts,
    audioMode: 'source', hasOriginalAudio: restored.hasAudio });
  console.log('GENJUTSU_COMPLETED', JSON.stringify(facts));
}
main().catch(async error => {
  const detail = safeError(error);
  console.error('GENJUTSU_STOPPED', detail);
  if (ownsLock && state.started && !['completed', 'failed'].includes(state.status)) {
    await save({ status: 'failed', failure: detail, failedAt: new Date().toISOString() }).catch(() => {});
  }
  process.exitCode = 1;
}).finally(async () => {
  if (ownsLock) await fs.unlink(lockPath).catch(() => {});
  await db.end();
});
