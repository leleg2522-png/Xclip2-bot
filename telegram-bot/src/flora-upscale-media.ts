import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { UpscaleFacts } from './flora-auto-upscale';

const exec = promisify(execFile);
const MAX_BYTES = 250 * 1024 * 1024;
const options = { timeout: 180000, maxBuffer: 1024 * 1024 };

async function probe(file: string): Promise<UpscaleFacts> {
  const { stdout } = await exec('ffprobe', [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', file,
  ], options);
  const data = JSON.parse(stdout);
  const video = data.streams?.find((stream: any) => stream.codec_type === 'video');
  let width = Number(video?.width);
  let height = Number(video?.height);
  const rotation = Number(video?.side_data_list?.find((row: any) => row.rotation !== undefined)?.rotation
    ?? video?.tags?.rotate ?? 0);
  if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
  const duration = Number(video?.duration ?? data.format?.duration);
  if (![width, height, duration].every(Number.isFinite)
    || width <= 0 || height <= 0 || duration <= 0) throw Error('FLORA_UPSCALE_INVALID_VIDEO');
  return { width, height, duration };
}

function checkBytes(bytes: Buffer) {
  if (!bytes.length || bytes.length > MAX_BYTES) throw Error('FLORA_UPSCALE_INVALID_SIZE');
}

export async function inspectFloraUpscaleVideo(bytes: Buffer): Promise<UpscaleFacts> {
  checkBytes(bytes);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flora-upscale-probe-'));
  try {
    const file = path.join(dir, 'input.mp4');
    await fs.writeFile(file, bytes);
    return await probe(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Only downsample a proven AI-upscaled result; never stretch a native fallback. */
export async function normalizeFlora1080(source: Buffer, output: Buffer): Promise<Buffer> {
  checkBytes(source);
  checkBytes(output);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flora-upscale-finish-'));
  try {
    const sourceFile = path.join(dir, 'source.mp4');
    const outputFile = path.join(dir, 'output.mp4');
    const finishedFile = path.join(dir, '1080.mp4');
    await Promise.all([fs.writeFile(sourceFile, source), fs.writeFile(outputFile, output)]);
    const [input, result] = await Promise.all([probe(sourceFile), probe(outputFile)]);
    const aspect = input.width / input.height;
    if (Math.min(result.width, result.height) < 1080
      || Math.abs(result.duration - input.duration) > 0.35
      || Math.abs((result.width / result.height) / aspect - 1) > 0.026) {
      throw Error('FLORA_UPSCALE_OUTPUT_MISMATCH');
    }
    const width = input.width >= input.height ? Math.round(1080 * aspect / 2) * 2 : 1080;
    const height = input.width >= input.height ? 1080 : Math.round(1080 / aspect / 2) * 2;
    // Preserve the original audio, even when Topaz returns a silent video.
    // Do not request FPS interpolation or creative changes from the provider.
    await exec('ffmpeg', [
      '-y', '-i', outputFile, '-i', sourceFile,
      '-map', '0:v:0', '-map', '1:a:0?',
      '-vf', `scale=${width}:${height}:flags=lanczos,setsar=1`,
      '-c:v', 'libx264', '-threads', '2', '-preset', 'fast', '-crf', '18',
      '-c:a', 'aac', '-b:a', '192k', '-map_metadata', '-1',
      '-t', String(input.duration), '-movflags', '+faststart', finishedFile,
    ], options);
    const final = await probe(finishedFile);
    if (Math.min(final.width, final.height) !== 1080
      || Math.abs(final.duration - input.duration) > 0.35) throw Error('FLORA_UPSCALE_OUTPUT_MISMATCH');
    const bytes = await fs.readFile(finishedFile);
    checkBytes(bytes);
    return bytes;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
