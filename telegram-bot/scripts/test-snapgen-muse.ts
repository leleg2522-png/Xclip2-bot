/** One owner-approved MUSE video test. Never replay a paid submission. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
const root = path.resolve(__dirname, '../../generated-artifacts/snapgen-muse-test');
const stateFile = path.join(root, 'video-test-state.json');
const base = 'https://api.snapgen.ai/uapi/v1';
async function save(state: any) {
  await fs.writeFile(stateFile + '.partial', JSON.stringify(state, null, 2));
  await fs.rename(stateFile + '.partial', stateFile);
}
async function main() {
  if (!process.argv.includes('--approved')) throw Error('APPROVAL_REQUIRED');
  const key = process.env.SNAPGEN_API_KEY;
  if (!key) throw Error('SNAPGEN_KEY_MISSING');
  await fs.mkdir(root, { recursive: true });
  const lock = await fs.open(path.join(root, 'video-test.lock'), 'wx');
  let state: any;
  const headers = { 'x-api-key': key, Accept: 'application/json' };
  try {
    try { state = JSON.parse(await fs.readFile(stateFile, 'utf8')); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    if (state?.status === 'downloaded') { console.log('EXISTING_RESULT: no new submit'); return; }
    if (state?.attempted && !state.uuid) throw Error('PRIOR_SUBMIT_NOT_REPLAYED');
    if (!state?.uuid) {
      const accountRes = await fetch(`${base}/account`, { headers, signal: AbortSignal.timeout(30000) });
      if (!accountRes.ok) throw Error(`ACCOUNT_HTTP_${accountRes.status}`);
      const account: any = await accountRes.json();
      if (!account.is_active || account.plan_id !== 'PP0001') throw Error('MUSE_PREMIUM_REQUIRED');
      state = { attempted: true, status: 'submitting', model: 'muse-ai-video',
        endpoint: '/video-gen/muse', duration: 10, orientation: 'portrait',
        prompt: 'Photorealistic cinematic shot of one red fox walking slowly through a snow-covered pine forest at sunrise. Gentle tracking camera, natural movement, warm morning light, realistic fur. No text, no logos.',
        creditBefore: account.user_credit, startedAt: new Date().toISOString() };
      await save(state);
      const body = new FormData();
      for (const field of ['prompt', 'model', 'duration', 'orientation']) body.set(field, String(state[field]));
      console.log('SUBMIT_ONCE model=muse-ai-video duration=10');
      const response = await fetch(`${base}/video-gen/muse`, {
        method: 'POST', headers, body, signal: AbortSignal.timeout(120000),
      });
      const result: any = await response.json().catch(() => null);
      state.httpStatus = response.status;
      if (!response.ok) {
        state.status = 'rejected';
        state.errorCode = result?.detail?.error_code;
        await save(state);
        throw Error(`MUSE_SUBMIT_HTTP_${response.status}_${state.errorCode || 'UNKNOWN'}`);
      }
      if (!result?.uuid || result.model_name !== 'muse-ai-video') {
        // Retain any accepted UUID even if its model metadata is unexpected.
        state.uuid = result?.uuid;
        state.status = 'accepted_response_needs_review';
        await save(state);
        throw Error('MUSE_SUBMIT_RESPONSE_INVALID');
      }
      state.uuid = result.uuid;
      state.estimatedCredit = result.estimated_credit;
      state.status = 'accepted';
      await save(state);
      console.log(`ACCEPTED uuid=${state.uuid} estimated_credit=${state.estimatedCredit}`);
    }
    for (let attempt = 0; attempt < 90; attempt++) {
      const response = await fetch(`${base}/history/${encodeURIComponent(state.uuid)}`, {
        headers, signal: AbortSignal.timeout(30000),
      });
      if (response.status === 429) {
        const seconds = Math.min(300, Math.max(10, Number(response.headers.get('retry-after')) || 30));
        await new Promise(r => setTimeout(r, seconds * 1000)); continue;
      }
      if (!response.ok) throw Error(`MUSE_POLL_HTTP_${response.status}`);
      const result: any = await response.json();
      if (result.model_name !== 'muse-ai-video') throw Error('MUSE_HISTORY_MODEL_MISMATCH');
      if (Number(result.status) === 3) {
        state.status = 'failed'; state.errorCode = result.error_code;
        await save(state); throw Error(`MUSE_JOB_FAILED_${state.errorCode || 'UNKNOWN'}`);
      }
      if (Number(result.status) === 2) {
        const url = result.generated_video?.find((v: any) => v.video_url)?.video_url;
        if (typeof url !== 'string' || !url.startsWith('https://')) throw Error('MUSE_NO_VIDEO_URL');
        const media = await fetch(url, { signal: AbortSignal.timeout(120000) });
        if (!media.ok || !media.body || Number(media.headers.get('content-length')) > 128 * 1024 * 1024) {
          throw Error('MUSE_DOWNLOAD_FAILED');
        }
        const parts: Uint8Array[] = []; let size = 0;
        for await (const bytes of media.body as any) {
          size += bytes.length;
          if (size > 128 * 1024 * 1024) { await media.body.cancel().catch(() => {}); throw Error('MUSE_RESULT_TOO_LARGE'); }
          parts.push(bytes);
        }
        const file = path.join(root, 'muse-video-test.mp4');
        await fs.writeFile(file + '.partial', Buffer.concat(parts));
        await fs.rename(file + '.partial', file);
        const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
        const probe = JSON.parse(stdout);
        state.media = { duration: Number(probe.format.duration),
          streams: probe.streams.map((s: any) => ({ type: s.codec_type, width: s.width, height: s.height })) };
        if (!probe.streams.some((s: any) => s.codec_type === 'video') || Math.abs(state.media.duration - 10) > 1) {
          throw Error('MUSE_RESULT_FORMAT_INVALID');
        }
        await exec('ffmpeg', ['-v', 'error', '-threads', '2', '-ss', '3', '-i', file, '-frames:v', '1',
          '-threads', '2', '-y', path.join(root, 'muse-video-frame.jpg')], { timeout: 60000 });
        state.usedCredit = result.used_credit;
        state.status = 'downloaded'; state.file = 'muse-video-test.mp4';
        await save(state);
        console.log(JSON.stringify({ status: state.status, estimatedCredit: state.estimatedCredit, usedCredit: state.usedCredit, media: state.media }));
        return;
      }
      if (attempt % 6 === 0) console.log(`POLL provider_status=${result.status}`);
      await new Promise(r => setTimeout(r, 10000));
    }
    throw Error('MUSE_POLL_PAUSED: resume existing job only');
  } catch (error: any) {
    if (state) { state.error = error.message; await save(state); }
    throw error;
  } finally {
    await lock.close(); await fs.unlink(path.join(root, 'video-test.lock'));
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
