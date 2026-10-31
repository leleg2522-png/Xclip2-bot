import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SEEDANCE25_MAX_MEDIA_BYTES, SEEDANCE25_MAX_REFERENCE_SECONDS } from './seedance25-picsart';

const exec = promisify(execFile);

// Probe actual bytes, not Telegram's reported duration/MIME. Always remove user media.
export async function inspectSeedance25Media(buffer: Buffer, kind: 'video' | 'audio'): Promise<number> {
  if (!buffer.length || buffer.length > SEEDANCE25_MAX_MEDIA_BYTES) {
    throw Error('Referensi harus berisi data dan maksimal 19MB per file.');
  }
  const dir = await mkdtemp(join(tmpdir(), 'seedance25-'));
  try {
    const path = join(dir, 'reference');
    await writeFile(path, buffer);
    const { stdout } = await exec('ffprobe', [
      '-v', 'error', '-show_streams', '-show_format', '-of', 'json', path,
    ], { timeout: 15000, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout);
    const duration = Number(result.format?.duration);
    if (!result.streams?.some((s: any) => s.codec_type === kind)
      || !Number.isFinite(duration) || duration <= 0 || duration > SEEDANCE25_MAX_REFERENCE_SECONDS) {
      throw Error('INVALID_MEDIA');
    }
    return duration;
  } catch {
    throw Error(`Referensi ${kind} tidak valid. Durasi maksimal 30 detik; gunakan MP4 untuk video atau MP3/M4A/WAV/OGG untuk audio.`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
