/**
 * Owner-authorized completion of this single test, not a production bot policy.
 * Existing persisted paid jobs are reused; no automatic retry or regeneration.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EpisodeMedia, parseTranscript } from '../src/episode-media';

const exec = promisify(execFile);
const root = path.resolve(__dirname, '../../generated-artifacts/microdrama-china-mandarin-test');
const stateFile = path.join(root, 'media-state.json');
async function atomic(file: string, value: unknown) {
  await fs.writeFile(file + '.partial', JSON.stringify(value, null, 2));
  await fs.rename(file + '.partial', file);
}
async function stage(mode: string, shot: number) {
  await new Promise<void>((resolve, reject) => {
    const child = spawn('pnpm', ['exec', 'tsx', 'scripts/live-mandarin-media.ts', mode, String(shot), '--approved'], {
      cwd: path.resolve(__dirname, '..'), stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`STAGE_STOPPED_${mode}_${shot}`)));
  });
}
function stamp(seconds: number) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}
async function probe(file: string) {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  return JSON.parse(stdout);
}
async function assemble() {
  const media = new EpisodeMedia();
  await media.check();
  const work = path.join(root, 'assembly');
  await fs.mkdir(work, { recursive: true });
  const subtitles: string[] = [], checks: unknown[] = [];
  for (let shot = 1; shot <= 6; shot++) {
    const file = path.join(root, `shot-${shot}.mp4`);
    await media.probe(file);
    const original = await probe(file);
    const duration = Number(original.format.duration);
    // Keep the complete native audio, including the short tail beyond 10s.
    // Apply the same slight speed adjustment to picture and sound, then pad
    // picture if necessary. Do not blindly cut off the final spoken syllable.
    const speed = Math.max(1, duration / 10);
    const transcript = parseTranscript(await fs.readFile(path.join(root, `transcript-${shot}.json`)));
    for (const segment of transcript) {
      const start = Math.min(9.999, segment.start / speed);
      const end = Math.min(10, segment.end / speed);
      if (end <= start) continue;
      subtitles.push(`${subtitles.length + 1}\n${stamp((shot - 1) * 10 + start)} --> ${stamp((shot - 1) * 10 + end)}\n${segment.text.replace(/[<>{}]/g, '')}\n`);
    }
    checks.push({ shot, nativeDuration: duration, speed,
      dialogue: JSON.parse(await fs.readFile(path.join(root, `dialogue-check-${shot}.json`), 'utf8')) });
    await exec('ffmpeg', ['-y', '-v', 'error', '-threads', '2', '-filter_threads', '2', '-i', file,
      '-vf', `setpts=(PTS-STARTPTS)/${speed},crop=756:1344:6:0,setsar=1,fps=24,tpad=stop_mode=clone:stop_duration=1,trim=duration=10`,
      '-af', `asetpts=PTS-STARTPTS,atempo=${speed},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000,apad,atrim=duration=10`,
      '-t', '10', '-ac', '2', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-threads', '2',
      '-c:a', 'aac', '-b:a', '128k', path.join(work, `edit-${shot}.mp4`)],
    { timeout: 300_000 });
    console.log(`EDIT_READY shot=${shot} speed=${speed.toFixed(6)}`);
  }
  const srt = path.join(root, 'episode-mandarin.srt');
  await fs.writeFile(srt, subtitles.join('\n'));
  const concat = path.join(work, 'concat.txt');
  await fs.writeFile(concat, Array.from({ length: 6 }, (_, i) => `file 'edit-${i + 1}.mp4'`).join('\n'));
  const partial = path.join(root, 'episode-mandarin.partial.mp4');
  await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', concat, '-i', srt,
    '-map', '0:v:0', '-map', '0:a:0', '-map', '1:0', '-c:v', 'copy', '-c:a', 'copy', '-c:s', 'mov_text',
    '-metadata:s:s:0', 'language=zho', '-metadata', 'title=谁是这个家的女儿',
    '-movflags', '+faststart', partial], { timeout: 300_000 });
  const output = await probe(partial);
  const video = output.streams.find((s: any) => s.codec_type === 'video');
  if (Math.abs(Number(output.format.duration) - 60) > 0.15 || video?.width !== 756 || video?.height !== 1344
    || !output.streams.some((s: any) => s.codec_type === 'audio')
    || !output.streams.some((s: any) => s.codec_type === 'subtitle' && s.tags?.language === 'zho')) {
    throw new Error('FINAL_VERIFICATION_FAILED');
  }
  // Decode the whole output once to detect corruption before publishing the file.
  await exec('ffmpeg', ['-v', 'error', '-threads', '2', '-i', partial, '-map', '0:v', '-map', '0:a',
    '-f', 'null', '-'], { timeout: 300_000 });
  await fs.rename(partial, path.join(root, 'episode-mandarin.mp4'));
  const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  await atomic(path.join(root, 'episode-report.json'), { status: 'assembled', duration: Number(output.format.duration),
    width: video.width, height: video.height, reservedUsd: state.reservedUsd, capUsd: state.capUsd,
    llmExcluded: true, checks, note: 'Character matching is not proof of speaker identity or lip synchronization.' });
  console.log(`EPISODE_READY duration=${output.format.duration} quoted_usd=${state.reservedUsd}`);
}
async function main() {
  if (!process.argv.includes('--approved-finish')) throw new Error('EXPLICIT_FINISH_APPROVAL_REQUIRED');
  const lock = await fs.open(path.join(root, 'finish-operation.lock'), 'wx');
  try {
    const mediaLock = await fs.open(path.join(root, 'media-operation.lock'), 'wx');
    try {
      const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
      if (state.capUsd !== 1.85 || state.reservedUsd > state.capUsd) throw new Error('UNAPPROVED_BUDGET');
      state.finishAuthorized = true;
      await atomic(stateFile, state);
    } finally {
      await mediaLock.close();
      await fs.unlink(path.join(root, 'media-operation.lock'));
    }
    if (!process.argv.includes('--assemble-only')) {
      for (let shot = 3; shot <= 6; shot++) {
        await stage('shot', shot);
        await stage('transcript', shot);
      }
    }
    await assemble();
  } finally {
    await lock.close();
    await fs.unlink(path.join(root, 'finish-operation.lock'));
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'FINISH_FAILED'); process.exitCode = 1; });
