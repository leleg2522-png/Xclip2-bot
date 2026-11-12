import { execFileSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';

const dir = 'generated-artifacts/vivareel-wan30-portrait-test-20261112';
const input = `${dir}/vivareel-wan30-battle-portrait-original.mp4`;
const output = `${dir}/vivareel-wan30-battle-portrait-cropped.mp4`;
if (!existsSync(input) || existsSync(output)) throw Error('Input missing or output already exists.');
const probe = path => JSON.parse(execFileSync('ffprobe', [
  '-v', 'error', '-show_streams', '-show_format', '-of', 'json', path,
], { encoding: 'utf8' }));
const before = probe(input);
const original = before.streams.find(s => s.codec_type === 'video');
if (original?.width !== 480 || original?.height !== 854) {
  throw Error('This crop is only for the visually inspected 480×854 portrait sample.');
}

// The inspected logo starts near y=786. Keep y<768 for a safe margin.
// Preserve 9:16 framing: remove 24px on each side and 86px at the bottom.
execFileSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-n', '-i', input,
  '-map', '0:v:0', '-map', '0:a?',
  '-vf', 'crop=432:768:24:0,scale=480:854:flags=lanczos,setsar=1',
  '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-threads', '2',
  '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', output,
], { stdio: 'inherit' });
const after = probe(output);
const video = after.streams.find(s => s.codec_type === 'video');
const audioCount = data => data.streams.filter(s => s.codec_type === 'audio').length;
if (video?.width !== 480 || video?.height !== 854
  || video.r_frame_rate !== original.r_frame_rate
  || Math.abs(Number(after.format.duration) - Number(before.format.duration)) > 0.05
  || audioCount(before) !== audioCount(after)) throw Error('Media validation failed.');
const audioHash = path => execFileSync('ffmpeg', [
  '-v', 'error', '-i', path, '-map', '0:a:0', '-c', 'copy',
  '-f', 'hash', '-hash', 'sha256', '-',
], { encoding: 'utf8' }).trim();
if (audioCount(before) && audioHash(input) !== audioHash(output)) {
  throw Error('Audio changed unexpectedly.');
}
const summary = {
  input, output, crop: { width: 432, height: 768, x: 24, y: 0 },
  removedPixels: { left: 24, right: 24, top: 0, bottom: 86 },
  removedPercent: { width: 10, height: 100 * 86 / 854 },
  outputWidth: video.width, outputHeight: video.height,
  frameRate: video.r_frame_rate, duration: after.format.duration,
  originalPreserved: true, audioUnchanged: true,
};
writeFileSync(`${dir}/crop-summary.json`, JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
