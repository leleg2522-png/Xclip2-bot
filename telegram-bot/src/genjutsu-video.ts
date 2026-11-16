import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectSeedance25Media } from './seedance25-media';
import type { GenjutsuTimedReference } from './picsart-genjutsu';

const exec = promisify(execFile);

/** Pad only the final frame for 3–4s sources; delivery retains the original duration/audio. */
export async function prepareGenjutsuVideo(video: GenjutsuTimedReference): Promise<GenjutsuTimedReference> {
  if (!Number.isFinite(video.duration) || video.duration < 3 || video.duration > 30
    || !video.buffer.length || video.buffer.length > 19 * 1024 * 1024) {
    throw Error('GENJUTSU_INVALID_VIDEO_DURATION');
  }
  if (video.duration >= 4) return video;
  const dir = await mkdtemp(join(tmpdir(), 'genjutsu-short-'));
  try {
    const source = join(dir, 'source.mp4'), output = join(dir, 'prepared.mp4');
    await writeFile(source, video.buffer);
    await exec('ffmpeg', [
      '-y', '-v', 'error', '-i', source, '-an',
      '-vf', 'tpad=stop_mode=clone:stop_duration=1.1', '-t', '4.1',
      '-c:v', 'libx264', '-threads', '2', '-preset', 'fast', '-crf', '18',
      '-map_metadata', '-1', '-movflags', '+faststart', output,
    ], { timeout: 120000, maxBuffer: 1024 * 1024 });
    const buffer = await readFile(output);
    const duration = await inspectSeedance25Media(buffer, 'video');
    if (duration < 4 || duration > 4.3) throw Error('GENJUTSU_SHORT_VIDEO_PREPARATION_FAILED');
    return { buffer, duration, name: 'source.mp4', mime: 'video/mp4' };
  } catch {
    throw Error('GENJUTSU_SHORT_VIDEO_PREPARATION_FAILED');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
