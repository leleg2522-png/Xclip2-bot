/** One explicit, non-replayable audio-transcription probe using the Claude provider key. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, '../../generated-artifacts/microdrama-china-muse');
const stateFile = path.join(root, 'botelex-audio-probe.json');
const lockFile = path.join(root, 'botelex-audio-probe.lock');
const base = 'https://botelexkey.store/v1';

async function save(state) {
  await fs.writeFile(stateFile + '.partial', JSON.stringify(state, null, 2));
  await fs.rename(stateFile + '.partial', stateFile);
}

async function main() {
  if (!process.argv.includes('--approved')) throw new Error('APPROVAL_REQUIRED');
  const key = process.env.BOTELEX_API_KEY;
  if (!key) throw new Error('BOTELEX_KEY_MISSING');
  const lock = await fs.open(lockFile, 'wx');
  let state;
  try {
    try {
      state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      if (state.attempted) throw new Error('BOTELEX_AUDIO_PROBE_NOT_REPLAYED');
    } catch (error) {
      if (error instanceof Error && error.message === 'BOTELEX_AUDIO_PROBE_NOT_REPLAYED') throw error;
      if (error?.code !== 'ENOENT') throw error;
    }

    const episode = JSON.parse(await fs.readFile(path.join(root, 'state.json'), 'utf8'));
    if (!episode.completed || !episode.scenes?.[0]?.media?.audio) {
      throw new Error('COMPLETE_MUSE_AUDIO_REQUIRED');
    }
    const { stdout: audio } = await exec('ffmpeg', [
      '-v', 'error', '-threads', '2', '-i', path.join(root, 'scene-1.mp4'),
      '-t', '10', '-vn', '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1',
    ], { encoding: 'buffer', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });

    state = {
      attempted: true, status: 'submitting', provider: 'botelexkey',
      endpoint: '/audio/transcriptions', model: 'whisper-1',
      scene: 1, durationSeconds: 10, startedAt: new Date().toISOString(),
    };
    await save(state);

    const form = new FormData();
    form.set('file', new Blob([audio], { type: 'audio/wav' }), 'scene-1.wav');
    form.set('model', 'whisper-1');
    form.set('language', 'zh');
    form.set('response_format', 'verbose_json');
    let response;
    try {
      response = await fetch(`${base}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
        body: form,
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      state.status = 'ambiguous_no_replay';
      state.error = 'NETWORK_OR_TIMEOUT';
      await save(state);
      throw new Error('BOTELEX_AUDIO_PROBE_AMBIGUOUS_NO_REPLAY');
    }

    state.httpStatus = response.status;
    if (!response.ok) {
      state.status = 'rejected';
      state.error = `HTTP_${response.status}`;
      await save(state);
      throw new Error(`BOTELEX_AUDIO_PROBE_HTTP_${response.status}`);
    }

    let result;
    try { result = await response.json(); }
    catch {
      state.status = 'invalid_response';
      await save(state);
      throw new Error('BOTELEX_AUDIO_PROBE_INVALID_RESPONSE');
    }
    const rows = result.segments || result.data?.segments;
    const text = typeof result.text === 'string' ? result.text.trim() : '';
    if (!text || !Array.isArray(rows) || rows.length > 80) {
      state.status = 'unsupported_timestamp_response';
      state.text = text;
      await save(state);
      throw new Error('BOTELEX_AUDIO_PROBE_NO_TIMED_SEGMENTS');
    }
    const segments = rows.map(row => ({
      start: Number(row.start), end: Number(row.end), text: String(row.text || '').trim(),
    }));
    if (segments.some(row => !Number.isFinite(row.start) || !Number.isFinite(row.end)
      || row.start < 0 || row.end <= row.start || row.end > 10.5 || !row.text)) {
      state.status = 'invalid_segments';
      state.text = text;
      await save(state);
      throw new Error('BOTELEX_AUDIO_PROBE_INVALID_SEGMENTS');
    }
    state.status = 'transcribed';
    state.text = text;
    state.segments = segments;
    await save(state);
    console.log(JSON.stringify({ status: state.status, segmentCount: segments.length, transcript: text }));
  } finally {
    await lock.close();
    await fs.unlink(lockFile);
  }
}

main().catch(error => {
  console.error(error instanceof Error && /^[A-Z0-9_:-]{1,120}$/.test(error.message)
    ? error.message : 'BOTELEX_AUDIO_PROBE_FAILED');
  process.exitCode = 1;
});
