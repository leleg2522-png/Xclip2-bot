import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';

const exec = promisify(execFile);

export interface DramaMedia {
  placeholder(): Promise<Buffer>;
  lastFrame(video: Buffer): Promise<Buffer>;
  assemble(videos: Buffer[]): Promise<Buffer>;
  check(): Promise<void>;
}

/** Temporary media only; accepted job IDs/result URLs remain in PG so a restart never needs another paid job. */
export class FfmpegDramaMedia implements DramaMedia {
  async check() {
    await exec('ffmpeg', ['-version'], { timeout: 10_000 });
    await exec('ffprobe', ['-version'], { timeout: 10_000 });
  }

  async placeholder(): Promise<Buffer> {
    return sharp({ create: { width: 768, height: 1344, channels: 3, background: '#888888' } }).png().toBuffer();
  }

  private async inspect(file: string) {
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file],
      { timeout: 30_000 });
    const info = JSON.parse(stdout);
    const video = info.streams?.find((s: any) => s.codec_type === 'video');
    if (video?.width !== 768 || video?.height !== 1344 || !info.streams.some((s: any) => s.codec_type === 'audio')
      || !(Number(info.format?.duration) >= 8 && Number(info.format?.duration) <= 12)) {
      throw new Error('DRAMA_MEDIA_INVALID');
    }
  }

  async lastFrame(video: Buffer): Promise<Buffer> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xclip-drama-frame-'));
    try {
      const input = path.join(dir, 'input.mp4'), output = path.join(dir, 'frame.png');
      await fs.writeFile(input, video);
      await this.inspect(input);
      await exec('ffmpeg', ['-y', '-v', 'error', '-threads', '2', '-sseof', '-0.08', '-i', input, '-frames:v', '1', '-threads', '2', output],
        { timeout: 60_000 });
      return await fs.readFile(output);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }

  async assemble(videos: Buffer[]): Promise<Buffer> {
    if (videos.length !== 2) throw new Error('DRAMA_MEDIA_INVALID');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xclip-drama-final-'));
    try {
      for (let n = 0; n < videos.length; n++) {
        const file = path.join(dir, `scene-${n}.mp4`);
        await fs.writeFile(file, videos[n]);
        await this.inspect(file);
      }
      await fs.writeFile(path.join(dir, 'list.txt'), "file 'scene-0.mp4'\nfile 'scene-1.mp4'\n");
      const out = path.join(dir, 'microdrama.mp4');
      await exec('ffmpeg', ['-y', '-v', 'error', '-threads', '2', '-filter_threads', '2', '-f', 'concat', '-safe', '0', '-i', path.join(dir, 'list.txt'),
        '-vf', 'crop=756:1344:6:0,setsar=1', '-c:v', 'libx264', '-preset', 'fast', '-crf', '18',
        '-threads', '2', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out], { timeout: 300_000 });
      return await fs.readFile(out);
    } finally { await fs.rm(dir, { recursive: true, force: true }); }
  }
}
