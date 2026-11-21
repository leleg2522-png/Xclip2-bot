import { randomUUID } from 'node:crypto';

export const KLING_MOTION_EDAN = {
  model: 'kling-motion-26-pro',
  minReferenceSeconds: 3,
  maxReferenceSeconds: 30,
} as const;

export type KlingMotionEdanAsset = {
  type: 'image' | 'video';
  url: string;
  name: string;
  size: number;
};

export type KlingMotionEdanMedia = {
  buffer: Buffer;
  name: string;
  mime: string;
};

type Cookie = { id: number; cookie: string };
type Dependencies = {
  cookies(): Promise<Cookie[]>;
  markDead(id: number): Promise<void>;
  upload(cookie: string, media: KlingMotionEdanMedia): Promise<KlingMotionEdanAsset>;
  submit(cookie: string, body: ReturnType<typeof klingMotionEdanRequest>): Promise<string>;
  poll(cookie: string, jobId: string): Promise<string>;
  onStatus?(stage: 'upload' | 'submit' | 'poll'): void;
};

function isEdanbotAsset(asset: KlingMotionEdanAsset, type: 'image' | 'video'): boolean {
  if (asset.type !== type || !asset.name || !Number.isSafeInteger(asset.size) || asset.size <= 0) return false;
  try {
    const url = new URL(asset.url);
    return url.protocol === 'https:' && url.hostname === 'edanbot.digital'
      && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function klingMotionEdanRequest(
  prompt: string,
  image: KlingMotionEdanAsset,
  video: KlingMotionEdanAsset,
  duration: number,
) {
  if (typeof prompt !== 'string'
    || !isEdanbotAsset(image, 'image')
    || !isEdanbotAsset(video, 'video')
    || !Number.isFinite(duration)
    || duration < KLING_MOTION_EDAN.minReferenceSeconds
    || duration > KLING_MOTION_EDAN.maxReferenceSeconds) {
    throw new Error('KLING_MOTION_EDAN_INVALID_INPUT');
  }
  return {
    model: KLING_MOTION_EDAN.model,
    request_id: randomUUID(),
    fields: {
      prompt,
      image_url: image,
      video_url: video,
      reference_video_duration: duration,
      character_orientation: 'video',
      keep_original_sound: true,
    },
  };
}

function isAuthFailure(error: unknown): boolean {
  const status = (error as { response?: { status?: number } })?.response?.status;
  return status === 401 || status === 403;
}

export async function generateKlingMotionEdan(
  prompt: string,
  image: KlingMotionEdanMedia,
  video: KlingMotionEdanMedia,
  duration: number,
  deps: Dependencies,
) {
  if (!image.buffer.length || !video.buffer.length) throw new Error('KLING_MOTION_EDAN_INVALID_MEDIA');
  const cookies = await deps.cookies();
  if (!cookies.length) throw new Error('EDANBOT_NO_COOKIE');

  for (const entry of cookies) {
    let jobId: string | undefined;
    try {
      deps.onStatus?.('upload');
      const imageAsset = await deps.upload(entry.cookie, image);
      const videoAsset = await deps.upload(entry.cookie, video);
      const body = klingMotionEdanRequest(prompt, imageAsset, videoAsset, duration);

      deps.onStatus?.('submit');
      jobId = await deps.submit(entry.cookie, body);
      if (typeof jobId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(jobId)) {
        jobId = undefined;
        throw new Error('EDANBOT_KLING_MOTION_NO_JOB_ID');
      }

      deps.onStatus?.('poll');
      const url = await deps.poll(entry.cookie, jobId);
      if (!url || new URL(url).protocol !== 'https:') throw new Error('EDANBOT_KLING_MOTION_NO_RESULT');
      return { url, jobId };
    } catch (error) {
      if (isAuthFailure(error)) {
        await deps.markDead(entry.id).catch(() => {});
        if (!jobId) continue;
      }
      if (jobId) {
        throw new Error(`EDANBOT_KLING_MOTION_ACCEPTED_JOB_FAILED: ${jobId}`, { cause: error });
      }
      throw error;
    }
  }
  throw new Error('EDANBOT_NO_VALID_COOKIE');
}
