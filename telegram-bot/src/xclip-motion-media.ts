import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const exec = promisify(execFile);
export const XCLIP_MOTION = {
  label: 'Xclip Motion', minSeconds: 3, maxSeconds: 15,
  maxVideoBytes: 15 * 1024 * 1024, maxImageBytes: 10 * 1024 * 1024,
} as const;

export function xclipMotionVideoError(size?: number, seconds?: number): string | undefined {
  if (size && size > XCLIP_MOTION.maxVideoBytes) return 'Video referensi maksimal 15MB. Potong atau kompres dulu.';
  if (seconds !== undefined && (!Number.isFinite(seconds) || seconds < 3 || seconds > 15)) {
    return 'Durasi video referensi harus 3–15 detik.';
  }
}

export interface XclipMotionReference {
  video: { buf: Buffer; name: string; mime: string };
  audio?: { buf: Buffer; name: string; mime: string };
  referenceSeconds: number;
  outputSeconds: number;
  ratio: '9:16' | '16:9';
}

/** Validate the actual file, including documents without Telegram duration metadata. */
export async function prepareXclipMotionReference(buf: Buffer): Promise<XclipMotionReference> {
  if (xclipMotionVideoError(buf.length)) throw Error('XCLIP_VIDEO_TOO_LARGE');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xclip-motion-'));
  const opts = { timeout: 120000, maxBuffer: 1024 * 1024 };
  try {
    const input = path.join(dir, 'input');
    await fs.writeFile(input, buf);
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', input], opts);
    const probe = JSON.parse(stdout);
    const stream = probe.streams?.find((s: any) => s.codec_type === 'video');
    const seconds = Number(probe.format?.duration);
    if (xclipMotionVideoError(undefined, seconds)) throw Error('XCLIP_REFERENCE_DURATION');
    if (!stream || stream.width < 240 || stream.height < 240
      || Math.max(stream.width / stream.height, stream.height / stream.width) > 8) {
      throw Error('XCLIP_INVALID_REFERENCE_VIDEO');
    }
    // Produce a bounded MP4, regardless of the uploaded container. Audio is
    // slightly shorter to avoid AAC padding making a 15s video exceed the limit.
    const frames = Math.floor(seconds * 30);
    const referenceSeconds = frames / 30;
    const scale = Math.min(1, 1920 / Math.max(stream.width, stream.height));
    const width = Math.floor(stream.width * scale / 2) * 2;
    const height = Math.floor(stream.height * scale / 2) * 2;
    const hasAudio = probe.streams.some((s: any) => s.codec_type === 'audio');
    const output = path.join(dir, 'reference.mp4');
    await exec('ffmpeg', [
      '-v', 'error', '-i', input, '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', `fps=30,scale=${width}:${height}`, '-frames:v', String(frames),
      '-t', String(referenceSeconds), '-c:v', 'libx264', '-preset', 'fast', '-crf', '25',
      '-pix_fmt', 'yuv420p',
      ...(hasAudio ? ['-af', `atrim=duration=${Math.max(0, referenceSeconds - 0.05)}`, '-c:a', 'aac', '-b:a', '128k'] : ['-an']),
      '-movflags', '+faststart', output,
    ], opts);
    let audio: XclipMotionReference['audio'];
    if (hasAudio) {
      const audioFile = path.join(dir, 'reference.mp3');
      // MP3 encoder padding counts toward the upstream 15s audio limit.
      await exec('ffmpeg', ['-v', 'error', '-i', input, '-vn', '-t', String(Math.min(referenceSeconds, 14.8)),
        '-c:a', 'libmp3lame', '-q:a', '3', audioFile], opts);
      audio = { buf: await fs.readFile(audioFile), name: 'reference.mp3', mime: 'audio/mpeg' };
    }
    return {
      video: { buf: await fs.readFile(output), name: 'reference.mp4', mime: 'video/mp4' },
      audio, referenceSeconds, outputSeconds: Math.min(15, Math.max(3, Math.round(referenceSeconds))),
      ratio: height > width ? '9:16' : '16:9',
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('XCLIP_')) throw error;
    throw Error('XCLIP_REFERENCE_PREPARATION_FAILED');
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
