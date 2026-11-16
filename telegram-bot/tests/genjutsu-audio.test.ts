import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restoreGenjutsuAudio } from '../src/genjutsu-audio';

const exec = promisify(execFile);
async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'genjutsu-audio-test-'));
  try {
    const source = join(dir, 'original.mp4'), silent = join(dir, 'silent.mp4');
    const visual = join(dir, 'generated.mp4'), output = join(dir, 'result.mp4');
    async function fixture(file: string, size: string, duration: string, hz?: number) {
      await exec('ffmpeg', [
        '-y', '-v', 'error', '-f', 'lavfi', '-i', `color=c=blue:s=${size}:r=25:d=${duration}`,
        ...(hz ? ['-f', 'lavfi', '-i', `sine=frequency=${hz}:sample_rate=48000:duration=${duration}`] : []),
        '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        ...(hz ? ['-c:a', 'aac'] : ['-an']), '-movflags', '+faststart', file,
      ], { timeout: 30000 });
    }
    async function probe(file: string) {
      const { stdout } = await exec('ffprobe', [
        '-v', 'error', '-show_streams', '-show_format', '-of', 'json', file,
      ]);
      return JSON.parse(stdout);
    }
    async function pcm(file: string) {
      const { stdout } = await exec('ffmpeg', [
        '-v', 'error', '-i', file, '-map', '0:a:0', '-ar', '16000', '-ac', '1', '-f', 's16le', '-',
      ], { encoding: 'buffer', maxBuffer: 2 * 1024 * 1024 });
      return stdout;
    }
    // Distinct tones prove that the final takes source audio, not the model's track.
    await fixture(source, '160x90', '1.2', 440);
    await fixture(silent, '160x90', '1.2');
    await fixture(visual, '320x180', '1.0', 880);
    const sourceBytes = await readFile(source), visualBytes = await readFile(visual);
    const restored = await restoreGenjutsuAudio(sourceBytes, visualBytes);
    assert.equal(restored.hasAudio, true);
    await writeFile(output, restored.buffer);
    const info = await probe(output);
    const video = info.streams.find((s: any) => s.codec_type === 'video');
    assert.equal(video.width, 320); assert.equal(video.height, 180);
    assert(Math.abs(Number(video.duration) - 1.2) < 0.05, 'Pad the last frame to keep the complete original audio');
    const [originalPcm, finalPcm] = await Promise.all([pcm(source), pcm(output)]);
    const shared = Math.min(originalPcm.length, finalPcm.length);
    assert(shared > 16000);
    assert(originalPcm.subarray(0, shared).equals(finalPcm.subarray(0, shared)),
      'Copied AAC decodes exactly to the original audio samples');
    const noAudio = await restoreGenjutsuAudio(await readFile(silent), visualBytes);
    await writeFile(output, noAudio.buffer);
    assert.equal(noAudio.hasAudio, false);
    assert(!(await probe(output)).streams.some((s: any) => s.codec_type === 'audio'),
      'Silent source stays silent even when generated video has a soundtrack');
    await assert.rejects(() => restoreGenjutsuAudio(Buffer.alloc(0), visualBytes), /GENJUTSU_AUDIO_INVALID_SIZE/);
    await assert.rejects(() => restoreGenjutsuAudio(Buffer.from('broken'), visualBytes), /GENJUTSU_AUDIO_FINISH_FAILED/);
    const short = join(dir, 'short.mp4');
    await fixture(short, '160x90', '0.12');
    const shortBytes = await readFile(short);
    await assert.rejects(() => restoreGenjutsuAudio(sourceBytes, shortBytes), /GENJUTSU_AUDIO_DURATION_MISMATCH/);
    console.log('Genjutsu local media passed: original AAC samples preserved, generated audio removed, silent input stays silent, duration/resolution preserved, corrupt media rejected.');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
