import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WanRatio } from './vivareel-wan';

const exec = promisify(execFile);
const MAX_BYTES = 200 * 1024 * 1024;
export function wanCropPlan(width: number, height: number, ratio: WanRatio) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 100 || height < 100
    || Math.abs(width / height - (ratio === '9:16' ? 9 / 16 : 16 / 9)) > 0.01) {
    throw Error('WAN_OUTPUT_RATIO_MISMATCH');
  }
  if (ratio === '9:16') {
    const units = Math.floor(width * 0.9 / 18);
    const w = units * 18, h = units * 32;
    return { width: w, height: h, x: Math.floor((width - w) / 4) * 2, y: 0 };
  }
  // Landscape logo extends farther up relative to the short edge.
  const w = Math.floor(width * (736 / 854) / 32) * 32;
  return { width: w, height: w * 9 / 16, x: 0, y: 0 };
}

async function probe(path: string) {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', path],
    { timeout: 30000, maxBuffer: 1024 * 1024 });
  return JSON.parse(stdout);
}
/** Probe actual bytes, never Telegram's rounded duration or a filename alone. */
export async function inspectWanReferenceVideo(buffer: Buffer): Promise<number> {
  if (!buffer.length || buffer.length > 19 * 1024 * 1024) throw Error('WAN_REFERENCE_SIZE_INVALID');
  const dir = await mkdtemp(join(tmpdir(), 'wan-reference-'));
  try {
    const input = join(dir, 'reference.mp4');
    await writeFile(input, buffer);
    const facts = await probe(input);
    const video = facts.streams?.find((s: any) => s.codec_type === 'video');
    const duration = Number(facts.format?.duration);
    if (!video || !(video.width > 0 && video.height > 0)
      || !facts.format?.format_name?.split(',').some((name: string) => ['mov', 'mp4'].includes(name))
      || !Number.isFinite(duration) || duration < 1 || duration > 15) throw Error('WAN_REFERENCE_DURATION_INVALID');
    return duration;
  } catch {
    throw Error('WAN_REFERENCE_INVALID');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
async function audioHash(path: string) {
  const { stdout } = await exec('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:a:0', '-c', 'copy',
    '-f', 'hash', '-hash', 'sha256', '-'], { timeout: 60000 });
  return stdout.trim();
}
export async function cropWanBuffer(buffer: Buffer, ratio: WanRatio, expectedDuration = 30): Promise<Buffer> {
  if (!buffer.length || buffer.length > MAX_BYTES) throw Error('WAN_OUTPUT_TOO_LARGE');
  if (!Number.isInteger(expectedDuration) || expectedDuration < 2 || expectedDuration > 30) {
    throw Error('WAN_OUTPUT_DURATION_INVALID');
  }
  const dir = await mkdtemp(join(tmpdir(), 'wan-crop-'));
  try {
    const input = join(dir, 'original.mp4'), output = join(dir, 'cropped.mp4');
    await writeFile(input, buffer);
    const before = await probe(input);
    const video = before.streams?.find((s: any) => s.codec_type === 'video');
    const duration = Number(before.format?.duration);
    if (!video || !Number.isFinite(duration) || Math.abs(duration - expectedDuration) > 0.5
      || Math.min(video.width, video.height) !== 480) {
      throw Error('WAN_OUTPUT_SETTINGS_MISMATCH');
    }
    const crop = wanCropPlan(video.width, video.height, ratio);
    await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-n', '-i', input,
      '-map', '0:v:0', '-map', '0:a?',
      '-vf', `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},scale=${video.width}:${video.height}:flags=lanczos,setsar=1`,
      '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-threads', '2', '-filter_threads', '2',
      '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', output],
    { timeout: 240000, maxBuffer: 2 * 1024 * 1024 });
    const after = await probe(output);
    const final = after.streams?.find((s: any) => s.codec_type === 'video');
    const audioCount = (p: any) => p.streams.filter((s: any) => s.codec_type === 'audio').length;
    if (final?.width !== video.width || final?.height !== video.height
      || final?.r_frame_rate !== video.r_frame_rate
      || Math.abs(Number(after.format?.duration) - duration) > 0.05 || audioCount(after) !== audioCount(before)
      || (audioCount(before) && await audioHash(input) !== await audioHash(output))) {
      throw Error('WAN_CROP_VALIDATION_FAILED');
    }
    return await readFile(output);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
export async function prepareWanDelivery(url: string, ratio: WanRatio, expectedDuration = 30): Promise<Buffer> {
  // Never forward provider authentication to the result CDN.
  const response = await fetch(url, { signal: AbortSignal.timeout(180000) });
  if (!response.ok || !response.body) throw Error('WAN_DOWNLOAD_FAILED');
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BYTES) throw Error('WAN_OUTPUT_TOO_LARGE');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  // Mandatory finishing. No return of the unprocessed source on any failure.
  return cropWanBuffer(Buffer.concat(chunks), ratio, expectedDuration);
}
