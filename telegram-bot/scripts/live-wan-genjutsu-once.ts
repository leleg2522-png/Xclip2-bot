// One explicitly authorized Wan 3.0 comparison; never replay an ambiguous submit.
import fs from 'node:fs/promises';
import path from 'node:path';
import axios from 'axios';
import { Pool } from 'pg';
import { VivareelWanClient, wanOutputDuration, wanRequest } from '../src/vivareel-wan';
import { inspectWanReferenceVideo, cropWanBuffer } from '../src/vivareel-wan-media';
import { restoreGenjutsuAudio } from '../src/genjutsu-audio';
import { inspectFloraUpscaleVideo, normalizeFlora1080 } from '../src/flora-upscale-media';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const args = process.argv.slice(2);
if (!args.includes('--paid-once')) throw Error('PAID_AUTHORIZATION_REQUIRED');
const root = path.resolve(__dirname, '../../generated-artifacts/wan-genjutsu-india-once');
const statePath = path.join(root, 'state.json');
const sourcePath = path.resolve(root, '../genjutsu-indian-film-live-once/source-solo.mp4');
const imagePath = path.resolve(__dirname, '../../attached_assets/generated_images/young-ceo-woman-reference.jpg');
const state = { current: {} as Record<string, any> };
const db = new Pool({ connectionString: process.env.RAILWAY_DATABASE_URL,
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
const http = axios.create({ proxy: false, timeout: 180000, maxContentLength: 250 * 1024 * 1024 });
const renderfulBase = 'https://api.renderful.ai/api/v1';
const vivareelBase = 'https://vivareel.ai/api/developer/v1';

async function save(patch: Record<string, unknown>) {
  state.current = { ...state.current, ...patch };
  await fs.writeFile(statePath + '.tmp', JSON.stringify(state.current, null, 2));
  await fs.rename(statePath + '.tmp', statePath);
}
function publicError(error: any) {
  return String(error?.message ?? 'UNKNOWN_ERROR')
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/Bearer\s+\S+/gi, '[redacted]').slice(0, 350);
}
async function getWanTask(key: string, id: string) {
  let failures = 0;
  for (let i = 0; i < 540; i++) {
    await new Promise(resolve => setTimeout(resolve, 5000));
    let response: Response;
    try {
      response = await fetch(`${vivareelBase}/tasks/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(90000),
      });
    } catch {
      if (++failures >= 6) throw Error('WAN_POLL_NETWORK_FAILED');
      await new Promise(resolve => setTimeout(resolve, 10000));
      continue;
    }
    if (!response.ok) {
      if (response.status >= 500 && ++failures < 6) {
        await new Promise(resolve => setTimeout(resolve, 10000));
        continue;
      }
      throw Error(`WAN_POLL_HTTP_${response.status}`);
    }
    failures = 0;
    const json: any = await response.json().catch(() => undefined);
    const task = json?.data;
    if (!task) throw Error('WAN_INVALID_POLL_RESPONSE');
    if (state.current.wanStatus !== task.status) {
      await save({ wanStatus: task.status });
      console.log('WAN_STATUS', task.status);
    }
    if (task.status === 'completed') {
      if (!String(task.result_url ?? '').startsWith('https://')) throw Error('WAN_MISSING_RESULT');
      return { url: task.result_url, points: task.extra?.billing_points ?? task.points_cost ?? null };
    }
    if (['failed', 'cancelled', 'canceled'].includes(task.status)) throw Error('WAN_GENERATION_FAILED');
    if (!['pending', 'queued', 'processing', 'running', 'in_progress', 'submitted'].includes(task.status)) {
      throw Error('WAN_UNKNOWN_TASK_STATUS');
    }
  }
  throw Error('WAN_POLL_TIMEOUT');
}
async function trimToReference(input: Buffer, duration: number) {
  const temp = await fs.mkdtemp(path.join('/tmp', 'wan-genjutsu-trim-'));
  try {
    const inputPath = path.join(temp, 'input.mp4'), outputPath = path.join(temp, 'trimmed.mp4');
    await fs.writeFile(inputPath, input);
    await exec('ffmpeg', ['-y', '-v', 'error', '-i', inputPath, '-t', duration.toFixed(3),
      '-map', '0:v:0', '-map', '0:a?', '-c:v', 'libx264', '-threads', '2',
      '-preset', 'fast', '-crf', '18', '-c:a', 'aac', '-movflags', '+faststart', outputPath],
    { timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
    return await fs.readFile(outputPath);
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

async function main() {
  if (!process.env.RAILWAY_DATABASE_URL) throw Error('DATABASE_NOT_CONFIGURED');
  await fs.mkdir(root, { recursive: true });
  try { state.current = JSON.parse(await fs.readFile(statePath, 'utf8')); }
  catch (error: any) { if (error.code !== 'ENOENT') throw error; }
  if (state.current.completedAt) throw Error('TEST_ALREADY_COMPLETE');
  const lock = await fs.open(path.join(root, 'run.lock'), 'wx');
  await lock.close();

  const [source, image] = await Promise.all([fs.readFile(sourcePath), fs.readFile(imagePath)]);
  const referenceSeconds = await inspectWanReferenceVideo(source);
  const outputSeconds = wanOutputDuration(referenceSeconds);
  const prompt =
    'Use the single portrait image as the only identity and appearance reference for the featured woman. ' +
    'Make her face and identity resemble the image, not the woman in the reference video. ' +
    'Use the reference video only for the Indian classical dance performance, gestures, timing, camera and black-and-white film look. ' +
    'Keep one consistent woman and the same face throughout. Do not blend identities or preserve the source performer facial identity. ' +
    'Preserve the Indian film setting and monochrome cinematography. No subtitles or added text.';

  const wanRows = await db.query("SELECT id, api_key FROM vivareel_key_pool WHERE status = 'available' ORDER BY id");
  if (!wanRows.rows.length) throw Error('NO_AVAILABLE_WAN_KEY');
  let wanKey: any;
  for (const candidate of wanRows.rows) {
    try {
      const response = await fetch(`${vivareelBase}/models`, {
        headers: { Authorization: `Bearer ${candidate.api_key}` }, signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) continue;
      const catalog: any = await response.json();
      const model = catalog.data?.video_models?.find((item: any) => item.name === 'dashscope-wan3.0-video');
      if (model?.is_available && model.capabilities?.includes('image_reference')
        && model.allowed_resolutions?.includes('480P')
        && (model.max_reference_videos ?? 0) >= 1
        && (model.max_reference_images ?? 0) >= 1
        && (model.max_duration_seconds?.image_reference ?? 0) >= outputSeconds) {
        wanKey = candidate;
        break;
      }
    } catch { /* Keep credential and transport details out of test output. */ }
  }
  if (!wanKey) throw Error('WAN_REFERENCE_CAPABILITY_UNAVAILABLE');

  const renderfulRows = await db.query("SELECT id, api_key FROM renderful_key_pool WHERE status <> 'dead' ORDER BY id");
  let renderfulKey: any;
  for (const candidate of renderfulRows.rows) {
    try {
      const response = await http.get(`${renderfulBase}/account/balance`, {
        headers: { Authorization: `Bearer ${candidate.api_key}` },
      });
      if (Number(response.data.balance_available) > 0) { renderfulKey = candidate; break; }
    } catch { /* Read-only preflight; no account or key rotation. */ }
  }
  if (!renderfulKey) throw Error('NO_READY_FINISHING_KEY');

  const client = new VivareelWanClient(wanKey.api_key);
  await save({
    started: true, sourcePath, imagePath, model: 'Wan 3.0 · Vivareel',
    status: state.current.status ?? 'preflight', sourceSeconds: referenceSeconds,
    expectedWanSeconds: outputSeconds, ratio: '16:9', resolution: '480P',
    botSaldoCharged: false, wanKeyRecord: wanKey.id, finishingKeyRecord: renderfulKey.id,
    prompt,
  });

  if (!state.current.wanTaskId) {
    if (state.current.wanSubmitAttempted) throw Error('WAN_AMBIGUOUS_SUBMIT_DO_NOT_RETRY');
    let imageUrl = state.current.imageUrl, videoUrl = state.current.videoUrl;
    if (!imageUrl) {
      imageUrl = await client.upload({ buffer: image, name: 'identity-reference.jpg', mime: 'image/jpeg' });
      await save({ imageUrl });
    }
    if (!videoUrl) {
      videoUrl = await client.upload({ buffer: source, name: 'indian-film-reference.mp4', mime: 'video/mp4' }, true);
      await save({ videoUrl });
    }
    const body = wanRequest(prompt, '16:9', [imageUrl], { url: videoUrl, duration: referenceSeconds });
    await save({ wanSubmitAttempted: true, status: 'submitting_wan', requestDuration: body.duration_seconds });
    console.log('WAN_SUBMIT_ONCE', JSON.stringify({ sourceSeconds: referenceSeconds,
      outputSeconds: body.duration_seconds, ratio: body.aspect_ratio, capability: (body as any).capability }));
    const taskId = await client.submit(body);
    await save({ wanTaskId: taskId, status: 'polling_wan' });
  }

  if (!state.current.wanResultUrl || state.current.wanStatus !== 'completed') {
    const result = await getWanTask(wanKey.api_key, state.current.wanTaskId);
    await save({ wanResultUrl: result.url, wanPointsCost: result.points, wanStatus: 'completed', status: 'wan_completed' });
  }
  const generated = Buffer.from((await http.get(state.current.wanResultUrl, { responseType: 'arraybuffer' })).data);
  const cropped = await cropWanBuffer(generated, '16:9', outputSeconds);
  await save({ status: 'cropping_complete', generatedBytes: generated.length, croppedBytes: cropped.length });

  const trimmedPath = path.join(root, 'wan-cropped-source-duration.mp4');
  let trimmed: Buffer;
  if (state.current.trimmedReady && await fs.stat(trimmedPath).then(() => true).catch(() => false)) {
    trimmed = await fs.readFile(trimmedPath);
  } else {
    trimmed = await trimToReference(cropped, referenceSeconds);
    await fs.writeFile(trimmedPath, trimmed);
    await save({ trimmedReady: true, trimmedBytes: trimmed.length });
  }

  const renderfulSourceUrl = state.current.renderfulSourceUrl
    ?? await client.upload({ buffer: trimmed, name: 'cropped-wan-reference-duration.mp4', mime: 'video/mp4' }, true);
  await save({ renderfulSourceUrl });
  const visualPath = path.join(root, 'wan-1080p-visual.mp4');
  if (!state.current.visualReady) {
    let outputUrl = state.current.finishingResultUrl;
    if (!outputUrl) {
      const id = state.current.finishingTaskId;
      if (!id) {
        if (state.current.finishingAttempted) throw Error('RENDERFUL_AMBIGUOUS_SUBMIT_DO_NOT_RETRY');
        await save({ finishingAttempted: true, status: 'submitting_finishing' });
        const response = await http.post(`${renderfulBase}/generations`, {
          type: 'video-to-video', model: 'bytedance-video-upscaler',
          video_url: renderfulSourceUrl, resolution: '1080p',
        }, { headers: { Authorization: `Bearer ${renderfulKey.api_key}` } });
        const taskId = response.data?.id;
        if (!taskId) throw Error('RENDERFUL_AMBIGUOUS_SUBMIT');
        await save({ finishingTaskId: taskId, status: 'polling_finishing' });
      }
      const taskId = state.current.finishingTaskId;
      for (let i = 0; !outputUrl && i < 120; i++) {
        await new Promise(resolve => setTimeout(resolve, 10000));
        const { data } = await http.get(`${renderfulBase}/generations/${taskId}`, {
          headers: { Authorization: `Bearer ${renderfulKey.api_key}` },
        });
        if (state.current.finishingStatus !== data.status) {
          await save({ finishingStatus: data.status });
          console.log('FINISHING_STATUS', data.status);
        }
        if (data.status === 'failed') throw Error('RENDERFUL_FINISHING_FAILED');
        if (data.status === 'completed') {
          const result = data.output ?? data.outputs?.[0];
          outputUrl = typeof result === 'string' ? result : result?.url ?? result?.video_url;
          if (!outputUrl) throw Error('RENDERFUL_NO_OUTPUT');
        }
      }
      if (!outputUrl) throw Error('RENDERFUL_POLL_TIMEOUT');
      await save({ finishingResultUrl: outputUrl });
    }
    const rendered = Buffer.from((await http.get(outputUrl, { responseType: 'arraybuffer' })).data);
    const normalized = await normalizeFlora1080(trimmed, rendered);
    const facts = await inspectFloraUpscaleVideo(normalized);
    if (Math.min(facts.width, facts.height) < 1080) throw Error('OUTPUT_NOT_1080P');
    await fs.writeFile(visualPath, normalized);
    await save({ visualReady: true, visualFacts: facts });
  }

  if (!state.current.completedAt) {
    const visual = await fs.readFile(visualPath);
    const final = await restoreGenjutsuAudio(source, visual);
    const outputPath = path.join(root, 'wan-genjutsu-1080p.mp4');
    await fs.writeFile(outputPath, final.buffer);
    const facts = await inspectFloraUpscaleVideo(final.buffer);
    await save({ status: 'completed', completedAt: new Date().toISOString(),
      output: facts, audioMode: 'source', hasOriginalAudio: final.hasAudio,
      outputFile: outputPath, wanPointsCost: state.current.wanPointsCost ?? null });
    console.log('WAN_GENJUTSU_COMPLETED', JSON.stringify({
      width: facts.width, height: facts.height, duration: facts.duration,
      wanPoints: state.current.wanPointsCost ?? 'NOT_RETURNED',
      hasOriginalAudio: final.hasAudio,
    }));
  }
}

main().catch(async error => {
  const detail = publicError(error);
  console.error('WAN_GENJUTSU_STOPPED', detail);
  if (state.current.started) await save({ failure: detail, lastKnownStatus: state.current.status }).catch(() => {});
  process.exitCode = 1;
}).finally(() => db.end());
