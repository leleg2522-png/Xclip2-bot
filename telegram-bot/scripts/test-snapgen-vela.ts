/** One explicitly approved Vela I2V test. Existing or ambiguous submits are never replayed. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = path.resolve(__dirname, '../../generated-artifacts/snapgen-vela-test');
const stateFile = path.join(root, 'state.json');
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
  const lockFile = path.join(root, 'test.lock');
  const lock = await fs.open(lockFile, 'wx');
  const headers = { 'x-api-key': key, Accept: 'application/json' };
  let state: any;
  async function accountCredit() {
    const r = await fetch(`${base}/account`, { headers, signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw Error(`ACCOUNT_HTTP_${r.status}`);
    const body: any = await r.json();
    if (!body.is_active) throw Error('SNAPGEN_ACCOUNT_INACTIVE');
    const credit = Number(body.user_credit?.available_credit);
    if (!Number.isFinite(credit)) throw Error('SNAPGEN_CREDIT_RESPONSE_INVALID');
    return credit;
  }
  try {
    try { state = JSON.parse(await fs.readFile(stateFile, 'utf8')); }
    catch (error: any) { if (error.code !== 'ENOENT') throw error; }
    if (state?.status === 'downloaded') { console.log('EXISTING_RESULT: no new submit'); return; }
    if (state?.attempted && !state.uuid) throw Error('PRIOR_SUBMIT_NOT_REPLAYED');
    if (!state?.uuid) {
      const reference = await fs.readFile(path.resolve(root, '../snapgen-muse-test/muse-video-frame.jpg'));
      if (reference.length > 10 * 1024 * 1024) throw Error('REFERENCE_TOO_LARGE');
      const creditBefore = await accountCredit();
      const prompt = 'Animate this exact red fox in the snowy pine forest. The fox slowly takes two natural steps forward, then gently turns its head toward the right. Preserve its fur, anatomy, snowy environment and warm sunrise light. Subtle cinematic camera movement, realistic motion. No text or logos.';
      const form = new FormData();
      for (const [k, v] of Object.entries({ prompt, model: 'vela-ai-video', duration: '5', resolution: '720p', orientation: 'portrait' })) {
        form.set(k, v);
      }
      form.append('files', new Blob([new Uint8Array(reference)], { type: 'image/jpeg' }), 'start.jpg');
      state = { attempted: true, status: 'submitting', endpoint: '/video-gen/vela', model: 'vela-ai-video',
        duration: 5, resolution: '720p', orientation: 'portrait', referenceCount: 1, creditBefore,
        startedAt: new Date().toISOString() };
      await save(state);
      console.log('SUBMIT_ONCE model=vela-ai-video duration=5 resolution=720p reference_count=1');
      const r = await fetch(`${base}/video-gen/vela`, {
        method: 'POST', headers, body: form, signal: AbortSignal.timeout(120_000),
      });
      const body: any = await r.json().catch(() => null);
      state.httpStatus = r.status;
      state.uuid = typeof body?.uuid === 'string' ? body.uuid : undefined;
      state.estimatedCredit = body?.estimated_credit;
      state.errorCode = typeof body?.error_code === 'string' && /^[\w.-]{1,80}$/.test(body.error_code) ? body.error_code : undefined;
      state.status = state.uuid ? 'accepted' : r.ok ? 'uncertain' : 'rejected';
      await save(state);
      if (!r.ok) throw Error(`VELA_SUBMIT_HTTP_${r.status}`);
      if (!state.uuid || body.model_name !== 'vela-ai-video') throw Error('VELA_SUBMIT_RESPONSE_INVALID');
      console.log(`ACCEPTED estimated_credit=${state.estimatedCredit}`);
    }
    for (let attempt = 0; attempt < 90; attempt++) {
      const r = await fetch(`${base}/history/${encodeURIComponent(state.uuid)}`, { headers, signal: AbortSignal.timeout(30_000) });
      if (r.status === 429) {
        await new Promise(resolve => setTimeout(resolve, Math.min(300, Math.max(10, Number(r.headers.get('retry-after')) || 30)) * 1000));
        continue;
      }
      if (!r.ok) throw Error(`VELA_POLL_HTTP_${r.status}`);
      const body: any = await r.json();
      if (body.model_name !== 'vela-ai-video') throw Error('VELA_HISTORY_MODEL_MISMATCH');
      if (Number(body.status) === 3) {
        state.status = 'failed'; state.usedCredit = body.used_credit;
        state.errorCode = typeof body.error_code === 'string' && /^[\w.-]{1,80}$/.test(body.error_code) ? body.error_code : undefined;
        state.creditAfter = await accountCredit();
        await save(state); throw Error(`VELA_JOB_FAILED_${state.errorCode || 'UNKNOWN'}`);
      }
      if (Number(body.status) === 2) {
        const url = body.generated_video?.find((v: any) => v.video_url)?.video_url;
        if (typeof url !== 'string' || !url.startsWith('https://')) throw Error('VELA_NO_RESULT_URL');
        const media = await fetch(url, { signal: AbortSignal.timeout(120_000) });
        if (!media.ok || !media.body || Number(media.headers.get('content-length')) > 128 * 1024 * 1024) throw Error('VELA_DOWNLOAD_FAILED');
        const parts: Uint8Array[] = []; let size = 0;
        for await (const bytes of media.body as any) {
          size += bytes.length;
          if (size > 128 * 1024 * 1024) { await media.body.cancel(); throw Error('VELA_RESULT_TOO_LARGE'); }
          parts.push(bytes);
        }
        const file = path.join(root, 'vela-i2v-test.mp4');
        await fs.writeFile(file + '.partial', Buffer.concat(parts));
        await fs.rename(file + '.partial', file);
        const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
        const probe = JSON.parse(stdout);
        state.media = { duration: Number(probe.format.duration), bytes: size,
          streams: probe.streams.map((s: any) => ({ type: s.codec_type, width: s.width, height: s.height })) };
        const video = state.media.streams.find((s: any) => s.type === 'video');
        if (!video || Math.abs(state.media.duration - 5) > 1 || Math.min(video.width, video.height) < 720) throw Error('VELA_RESULT_FORMAT_INVALID');
        await exec('ffmpeg', ['-v', 'error', '-threads', '2', '-i', file, '-vf', 'fps=1/2,scale=240:-2,tile=3x1',
          '-frames:v', '1', '-threads', '2', '-y', path.join(root, 'frames.jpg')], { timeout: 60_000 });
        state.usedCredit = body.used_credit;
        state.creditAfter = await accountCredit();
        state.creditDifference = state.creditBefore - state.creditAfter;
        state.status = 'downloaded'; state.completedAt = new Date().toISOString();
        await save(state);
        console.log(JSON.stringify({ status: state.status, estimatedCredit: state.estimatedCredit, usedCredit: state.usedCredit,
          creditBefore: state.creditBefore, creditAfter: state.creditAfter, creditDifference: state.creditDifference, media: state.media }));
        return;
      }
      if (attempt % 6 === 0) console.log(`POLL provider_status=${Number(body.status)} elapsed_seconds=${Math.round((Date.now() - Date.parse(state.startedAt)) / 1000)}`);
      await new Promise(resolve => setTimeout(resolve, 10_000));
    }
    throw Error('VELA_POLL_PAUSED: resume the same job only');
  } catch (error: any) {
    if (state) { state.error = error.message; await save(state); }
    throw error;
  } finally { await lock.close(); await fs.unlink(lockFile); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
