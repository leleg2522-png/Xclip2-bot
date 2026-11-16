import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareGenjutsuVideo } from '../src/genjutsu-video';
import { restoreGenjutsuAudio } from '../src/genjutsu-audio';

const exec = promisify(execFile);
async function main() {
  const dir = await mkdtemp(join(tmpdir(), 'genjutsu-short-test-'));
  try {
    const source = join(dir, 'source.mp4');
    await exec('ffmpeg', [
      '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x120:r=25:d=3',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=3',
      '-c:v', 'libx264', '-threads', '2', '-c:a', 'aac', '-shortest', source,
    ]);
    const buffer = await readFile(source);
    const input = { buffer, duration: 3, name: 'source.mp4', mime: 'video/mp4' };
    const prepared = await prepareGenjutsuVideo(input);
    assert(prepared.duration >= 4 && prepared.duration <= 4.3);
    assert(input.buffer.equals(buffer), 'Never overwrite the original source/audio');
    const restored = await restoreGenjutsuAudio(buffer, prepared.buffer);
    assert(restored.hasAudio);
    const output = join(dir, 'result.mp4');
    await writeFile(output, restored.buffer);
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output]);
    const facts = JSON.parse(stdout);
    assert(Math.abs(Number(facts.format.duration) - 3) < 0.15, 'Final output retains the actual 3-second source duration');
    const audio = async (file: string) => (await exec('ffmpeg', [
      '-v', 'error', '-i', file, '-vn', '-f', 's16le', '-acodec', 'pcm_s16le', '-',
    ], { encoding: 'buffer', maxBuffer: 1024 * 1024 })).stdout;
    assert((await audio(source)).equals(await audio(output)), 'Original AAC samples remain unchanged');
    const long = { ...input, duration: 15 };
    assert.equal(await prepareGenjutsuVideo(long), long, 'Do not re-encode supported reference lengths');
    for (const duration of [2.99, 30.01, NaN]) {
      await assert.rejects(() => prepareGenjutsuVideo({ ...input, duration }), /GENJUTSU_INVALID/);
    }
    console.log('Genjutsu short video passed: 3-second input prepared safely and output restored to 3 seconds with original audio.');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
