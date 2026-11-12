import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const [input, output] = process.argv.slice(2);
if (!input || !output || !existsSync(input) || input === output || existsSync(output)) {
  throw new Error('Usage: node crop-vivareel-battle.mjs INPUT.mp4 NEW_OUTPUT.mp4');
}

function probe(path) {
  return JSON.parse(execFileSync('ffprobe', [
    '-v', 'error', '-show_streams', '-show_format', '-of', 'json', path,
  ], { encoding: 'utf8' }));
}

const before = probe(input);
const original = before.streams.find(stream => stream.codec_type === 'video');
if (original?.width !== 854 || original?.height !== 480) {
  throw new Error('This crop was inspected for the 854×480 Vivareel battle sample only.');
}

// Keep the top-left edge and retain a 16:9 crop.
// Discard 118 pixels on the right and 66 at the bottom, safely outside
// the inspected VR overlay's bounds rather than leaving a partial letter.
// Resize to the original delivery dimensions without replacing the source file.
execFileSync('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-n', '-i', input,
  '-map', '0:v:0', '-map', '0:a?',
  '-vf', 'crop=736:414:0:0,scale=854:480:flags=lanczos,setsar=1',
  '-c:v', 'libx264', '-crf', '18', '-preset', 'fast', '-threads', '2',
  '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-movflags', '+faststart', output,
], { stdio: 'inherit' });

const after = probe(output);
const video = after.streams.find(stream => stream.codec_type === 'video');
if (video?.width !== 854 || video?.height !== 480
  || Math.abs(Number(after.format.duration) - Number(before.format.duration)) > 0.05
  || before.streams.filter(s => s.codec_type === 'audio').length
    !== after.streams.filter(s => s.codec_type === 'audio').length) {
  throw new Error('Output dimensions, duration, or audio validation failed.');
}

function audioHash(path) {
  return execFileSync('ffmpeg', [
    '-v', 'error', '-i', path, '-map', '0:a:0', '-c', 'copy',
    '-f', 'hash', '-hash', 'sha256', '-',
  ], { encoding: 'utf8' }).trim();
}
if (before.streams.some(s => s.codec_type === 'audio') && audioHash(input) !== audioHash(output)) {
  throw new Error('Audio must remain unchanged.');
}

console.log(JSON.stringify({
  output, crop: { width: 736, height: 414, x: 0, y: 0 },
  outputWidth: video.width, outputHeight: video.height,
  frameRate: video.r_frame_rate, duration: after.format.duration,
  bytes: after.format.size, originalPreserved: true, audioUnchanged: true,
}));
