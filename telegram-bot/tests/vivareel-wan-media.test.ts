import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cropWanBuffer } from '../src/vivareel-wan-media';

async function main() {
  const dir = mkdtempSync(join(tmpdir(), 'wan-media-test-'));
  try {
    for (const ratio of ['9:16', '16:9'] as const) {
      const [width, height] = ratio === '9:16' ? [720, 1280] : [1280, 720];
      const input = join(dir, `input-${width}.mp4`), output = join(dir, `output-${width}.mp4`);
      execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', `color=c=blue:s=${width}x${height}:r=2:d=30`,
        '-f', 'lavfi', '-i', 'sine=frequency=440:duration=30', '-threads', '2',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', input]);
      const result = await cropWanBuffer(readFileSync(input), ratio);
      writeFileSync(output, result);
      const facts = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format',
        '-of', 'json', output], { encoding: 'utf8' }));
      assert.equal(facts.streams[0].width, width);
      assert.equal(facts.streams[0].height, height);
      assert.equal(facts.streams[0].r_frame_rate, '2/1');
      assert.ok(Math.abs(Number(facts.format.duration) - 30) < 0.1);
      assert.ok(facts.streams.some((s: any) => s.codec_type === 'audio'));
      const hash = (path: string) => execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-map', '0:a:0',
        '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-'], { encoding: 'utf8' }).trim();
      assert.equal(hash(input), hash(output));
      await assert.rejects(cropWanBuffer(readFileSync(input), ratio === '9:16' ? '16:9' : '9:16'), /RATIO_MISMATCH/);
    }
    await assert.rejects(cropWanBuffer(Buffer.from('not-video'), '9:16'));
    await assert.rejects(cropWanBuffer(Buffer.alloc(0), '9:16'), /OUTPUT_TOO_LARGE/);
    console.log('Vivareel media tests passed: both 720p ratios, crop, duration, frame rate, unchanged audio and invalid media.');
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
