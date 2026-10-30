import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import type { EpisodeProject, ShotWork, TranscriptSegment } from './episode-types';
const exec = promisify(execFile);

export function parseTranscript(bytes: Buffer): TranscriptSegment[] {
  const p = JSON.parse(bytes.toString('utf8'));
  const rows = p.segments || p.data?.segments || p.result?.segments;
  if (!Array.isArray(rows) || rows.length > 80) throw new Error('EPISODE_TRANSCRIPT_FORMAT');
  return rows.map((r: any) => {
    const start = Number(r.start), end = Number(r.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > 12
      || typeof r.text !== 'string' || r.text.length > 500) throw new Error('EPISODE_TRANSCRIPT_FORMAT');
    return { start, end, text: r.text.trim() };
  }).filter(r => r.text);
}
const words = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
export function dialogueIssues(work: ShotWork, segments: TranscriptSegment[]): string[] {
  const expected = work.shot.dialogue.flatMap(d => words(d.text)), actual = words(segments.map(s => s.text).join(' '));
  const counts = new Map<string, number>();
  actual.forEach(w => counts.set(w, (counts.get(w) || 0) + 1));
  let found = 0;
  expected.forEach(w => { if (counts.get(w)) { found++; counts.set(w, counts.get(w)! - 1); } });
  const issues: string[] = [];
  if (expected.length && found / expected.length < 0.75) issues.push('Dialog hasil transkripsi tidak cukup cocok dengan naskah.');
  if (!expected.length && actual.length > 3) issues.push('Ada dialog tambahan pada shot yang direncanakan tanpa dialog.');
  if (segments.some(s => s.end > 9.7)) issues.push('Dialog mendekati batas potong 10 detik; berisiko terpotong.');
  return issues;
}
const time = (s: number) => {
  const ms = Math.max(0, Math.round(s * 1000));
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
};
export function episodeSrt(p: EpisodeProject): string {
  let n = 0;
  return p.episode.shots.flatMap((w, i) => {
    const t = w.takes[w.accepted!];
    return (t.transcript || []).filter(s => s.start < 10).map(s =>
      `${++n}\n${time(i * 10 + s.start)} --> ${time(i * 10 + Math.min(10, s.end))}\n${s.text.replace(/[<>{}]/g, '')}\n`);
  }).join('\n');
}

export class EpisodeMedia {
  private root = path.join(os.tmpdir(), 'xclip-episodes');
  async directory(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('EPISODE_ID');
    const d = path.join(this.root, id); await fs.mkdir(d, { recursive: true }); return d;
  }
  async check() {
    const { stdout } = await exec('ffmpeg', ['-hide_banner', '-filters'], { timeout: 10_000 });
    if (!stdout.includes('loudnorm')) throw new Error('EPISODE_FFMPEG_FILTERS');
    await exec('ffprobe', ['-version'], { timeout: 10_000 });
  }
  async jpeg(bytes: Buffer, small = false) {
    return sharp(bytes).resize(small ? 512 : 768, small ? 896 : 1344, { fit: small ? 'inside' : 'cover' }).jpeg({ quality: small ? 80 : 94 }).toBuffer();
  }
  async placeholder() {
    return sharp({ create: { width: 768, height: 1344, channels: 3, background: '#888888' } }).jpeg().toBuffer();
  }
  async cache(project: string, shot: number, take: number, bytes?: Buffer): Promise<string | undefined> {
    const d = await this.directory(project), file = path.join(d, `shot-${shot}-${take}.mp4`);
    if (bytes) {
      await fs.writeFile(file + '.partial', bytes); await fs.rename(file + '.partial', file);
    }
    try { await fs.access(file); return file; } catch { return undefined; }
  }
  async probe(file: string) {
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], { timeout: 30_000 });
    const p = JSON.parse(stdout), v = p.streams?.find((s: any) => s.codec_type === 'video');
    if (v?.width !== 768 || v?.height !== 1344 || Number(p.format?.duration) < 10 || Number(p.format?.duration) > 12
      || !p.streams.some((s: any) => s.codec_type === 'audio')) throw new Error('EPISODE_VIDEO_FORMAT');
  }
  async frame(file: string, seconds: number) {
    const { stdout } = await exec('ffmpeg', ['-v', 'error', '-threads', '2', '-ss', String(seconds), '-i', file,
      '-frames:v', '1', '-threads', '2', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'],
    { encoding: 'buffer', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  }
  async audio(file: string) {
    const { stdout } = await exec('ffmpeg', ['-v', 'error', '-threads', '2', '-i', file, '-t', '10',
      '-vn', '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1'], { encoding: 'buffer', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
    return stdout;
  }
  async assemble(p: EpisodeProject, files: string[]) {
    if (files.length !== p.episode.minutes * 6 || p.episode.shots.some(w => w.accepted === undefined)) throw new Error('EPISODE_INCOMPLETE');
    const d = await this.directory(p.id);
    const srt = episodeSrt(p);
    await fs.writeFile(path.join(d, 'subtitles.srt'), srt);
    for (let i = 0; i < files.length; i++) {
      await this.probe(files[i]);
      // Bounded memory: process one clip at a time, fixed thread counts.
      await exec('ffmpeg', ['-y', '-v', 'error', '-threads', '2', '-filter_threads', '2', '-i', files[i], '-t', '10',
        '-vf', 'crop=756:1344:6:0,setsar=1,fps=24', '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000',
        '-ac', '2', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-threads', '2', '-c:a', 'aac', '-b:a', '128k',
        path.join(d, `edit-${i}.mp4`)], { timeout: 300_000 });
    }
    await fs.writeFile(path.join(d, 'concat.txt'), files.map((_, i) => `file 'edit-${i}.mp4'`).join('\n'));
    const final = path.join(d, 'episode.mp4');
    // Soft subtitle track and separate SRT: no inaccurate script-derived timestamps.
    await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(d, 'concat.txt'),
      ...(srt ? ['-i', path.join(d, 'subtitles.srt')] : []), '-map', '0:v', '-map', '0:a',
      ...(srt ? ['-map', '1:0', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=ind'] : []),
      '-c:v', 'copy', '-c:a', 'copy',
      '-movflags', '+faststart', final], { timeout: 300_000 });
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_format', '-of', 'json', final]);
    if (Math.abs(Number(JSON.parse(stdout).format.duration) - p.episode.minutes * 60) > 1) throw new Error('EPISODE_FINAL_DURATION');
    return { video: final, subtitles: path.join(d, 'subtitles.srt') };
  }
  async cleanup(id: string) { await fs.rm(await this.directory(id), { recursive: true, force: true }); }
}
