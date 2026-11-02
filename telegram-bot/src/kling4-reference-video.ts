import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Operational Telegram download cap, NOT a documented Kling duration/size limit.
export const KLING4_REFERENCE_VIDEO_MAX_BYTES = 19 * 1024 * 1024;
const exec = promisify(execFile);

export async function validateKling4ReferenceVideo(bytes: Buffer): Promise<void> {
  if (!bytes.length || bytes.length > KLING4_REFERENCE_VIDEO_MAX_BYTES) {
    throw Error('PICSART_KLING4_REFERENCE_VIDEO_SIZE');
  }
  const dir = await mkdtemp(join(tmpdir(), 'kling4-reference-'));
  try {
    const path = join(dir, 'reference.mp4');
    await writeFile(path, bytes);
    const { stdout } = await exec('ffprobe', [
      '-v', 'error', '-show_streams', '-show_format', '-of', 'json', path,
    ], { timeout: 15000, maxBuffer: 1024 * 1024 });
    const info = JSON.parse(stdout);
    if (!String(info.format?.format_name).split(',').includes('mp4')
      || !info.streams?.some((stream: any) => stream.codec_type === 'video')
      || !Number.isFinite(Number(info.format?.duration)) || Number(info.format.duration) <= 0) {
      throw Error('INVALID_VIDEO');
    }
  } catch {
    throw Error('PICSART_KLING4_INVALID_REFERENCE_VIDEO');
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}
