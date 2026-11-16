import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);
const maxBytes = 250 * 1024 * 1024;
async function facts(file: string) {
  const { stdout } = await exec('ffprobe', [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', file,
  ], { timeout: 15000, maxBuffer: 1024 * 1024 });
  const info = JSON.parse(stdout);
  const video = info.streams?.find((stream: any) => stream.codec_type === 'video');
  const audio = info.streams?.find((stream: any) => stream.codec_type === 'audio');
  const duration = Number(video?.duration ?? info.format?.duration);
  if (!video || !Number.isFinite(duration) || duration <= 0) throw Error('GENJUTSU_AUDIO_INVALID_VIDEO');
  return { width: Number(video.width), height: Number(video.height), duration, audio };
}

/** Replace ALL generated audio with the source track, or silence if the source has none. */
export async function restoreGenjutsuAudio(
  source: Buffer, generated: Buffer,
): Promise<{ buffer: Buffer; hasAudio: boolean }> {
  if ([source, generated].some(bytes => !bytes.length || bytes.length > maxBytes)) {
    throw Error('GENJUTSU_AUDIO_INVALID_SIZE');
  }
  const dir = await mkdtemp(join(tmpdir(), 'genjutsu-audio-'));
  try {
    const originalFile = join(dir, 'source.mp4');
    const generatedFile = join(dir, 'visual.mp4');
    const outputFile = join(dir, 'result.mp4');
    await Promise.all([writeFile(originalFile, source), writeFile(generatedFile, generated)]);
    const [original, visual] = await Promise.all([facts(originalFile), facts(generatedFile)]);
    if (Math.abs(original.duration - visual.duration) > 1) {
      throw Error('GENJUTSU_AUDIO_DURATION_MISMATCH');
    }
    // Short edit outputs may differ by a few frames. Pad the final frame rather
    // than speeding/slowing the original audio or truncating its last syllable.
    await exec('ffmpeg', [
      '-y', '-v', 'error', '-i', generatedFile, '-i', originalFile,
      '-map', '0:v:0',
      ...(original.audio ? ['-map', '1:a:0', '-c:a', original.audio.codec_name === 'aac' ? 'copy' : 'aac'] : ['-an']),
      '-vf', 'tpad=stop_mode=clone:stop_duration=1',
      '-t', String(original.duration),
      '-c:v', 'libx264', '-threads', '2', '-preset', 'fast', '-crf', '18',
      '-map_metadata', '-1', '-movflags', '+faststart', outputFile,
    ], { timeout: 180000, maxBuffer: 1024 * 1024 });
    const result = await facts(outputFile);
    if (result.width !== visual.width || result.height !== visual.height
      || Math.abs(result.duration - original.duration) > 0.15
      || Boolean(result.audio) !== Boolean(original.audio)) {
      throw Error('GENJUTSU_AUDIO_OUTPUT_MISMATCH');
    }
    const buffer = await readFile(outputFile);
    if (!buffer.length || buffer.length > maxBytes) throw Error('GENJUTSU_AUDIO_INVALID_SIZE');
    return { buffer, hasAudio: Boolean(original.audio) };
  } catch (error: any) {
    // Do not expose command arguments or local user-media paths via public errors.
    if (/^GENJUTSU_AUDIO_/.test(error?.message ?? '')) throw error;
    throw Error('GENJUTSU_AUDIO_FINISH_FAILED');
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
