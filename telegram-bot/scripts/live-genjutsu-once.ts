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

const root = path.resolve(__dirname, '../../generated-artifacts/genjutsu-live-once');
const statePath = path.join(root, 'state.json');
const sourcePath = path.resolve(__dirname, '../../generated-artifacts/kling4-woman-dance-live/native.mp4');
const imagePath = path.resolve(__dirname, '../../attached_assets/generated_images/young-ceo-woman-reference.jpg');
const db = new Pool({ connectionString: process.env.RAILWAY_DATABASE_URL,
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
const http = axios.create({ proxy: false, timeout: 180000, maxContentLength: 250 * 1024 * 1024 });
const base = 'https://api.renderful.ai/api/v1';
let state: any = {};
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
  if (state.started) throw Error('TEST_ALREADY_STARTED_DO_NOT_RESUBMIT');
  // Exclusive lock also covers simultaneous invocations.
  const lock = await fs.open(path.join(root, 'run.lock'), 'wx');
  await lock.close();
  await save({ started: true, status: 'preflight', startedAt: new Date().toISOString(),
    sourcePath, imagePath, botSaldoCharged: false });
  picsart.initPicsart(db);
  const [video, image] = await Promise.all([fs.readFile(sourcePath), fs.readFile(imagePath)]);
  const duration = await inspectSeedance25Media(video, 'video');
  if (duration < 4 || duration > 30) throw Error('INVALID_SOURCE_DURATION');

  // Read-only pool preflight. Do not disable or reassign live users' keys in QA.
  const rows = await db.query("SELECT id, api_key FROM renderful_key_pool WHERE status <> 'dead' ORDER BY id");
  let selected: any;
  for (const row of rows.rows) {
    try {
      const response = await http.get(`${base}/account/balance`, {
        headers: { Authorization: `Bearer ${row.api_key}` },
      });
      if (Number(response.data.balance_available) > 0) { selected = row; break; }
    } catch { /* No secret-bearing transport errors in output. */ }
  }
  if (!selected) throw Error('NO_READY_FINISHING_KEY');
  const input = {
    userId: 0, persistAccount: false, prompt: GENJUTSU_PROMPT,
    generateAudio: false,
    taskType: 'edit' as const,
    images: [{ buffer: image, name: 'genjutsu-character.jpg', mime: 'image/jpeg' }],
    videos: [{ buffer: video, name: 'genjutsu-source.mp4', mime: 'video/mp4', duration }],
    audios: [],
  };
  const quote = await picsart.generateSeedance25Flash({ ...input, quoteOnly: true });
  await save({ quoteCredits: quote.credits, inputDuration: duration, status: 'quoted',
    taskType: quote.taskType, durationSetting: quote.duration, ratioSetting: quote.aspectRatio });
  console.log('QUOTE', JSON.stringify({ credits: quote.credits, sourceSeconds: duration,
    taskType: quote.taskType, duration: quote.duration, ratio: quote.aspectRatio }));
  if (!quote.hasEnoughProviderCredits) throw Error('INSUFFICIENT_PROVIDER_CREDITS');
  await save({ nativeAttempted: true, status: 'generating' });
  let lastTick = 0;
  const native = await picsart.generateSeedance25Flash({
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
  await fs.writeFile(path.join(root, 'native.mp4'), (await http.get(native.url, { responseType: 'arraybuffer' })).data);
  await save({ status: 'finishing', nativeCompleted: true, nativeCredits: native.credits });
  console.log('NATIVE_COMPLETED');
  let published = 0;
  const final = await generateRenderful1080(native.url, {
    key: async () => selected.api_key, disable: async () => {},
    download: async url => Buffer.from((await http.get(url, { responseType: 'arraybuffer' })).data),
    inspect: inspectFloraUpscaleVideo,
    publish: async bytes => {
      // Native URL is a public Picsart asset, never a Telegram-token URL.
      if (published++ === 0) return native.url;
      const file = path.join(root, 'genjutsu-1080p.mp4');
      await fs.writeFile(file, bytes);
      return file;
    },
    submit: async (key, url) => {
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
  if (state.started && !['completed', 'failed'].includes(state.status)) {
    await save({ status: 'failed', failure: detail, failedAt: new Date().toISOString() }).catch(() => {});
  }
  process.exitCode = 1;
}).finally(() => db.end());
