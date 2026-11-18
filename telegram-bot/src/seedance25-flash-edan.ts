import { randomUUID } from 'node:crypto';
import { validateSeedance25Prompt } from './seedance25-prompt';

export const SEEDANCE25_FLASH_EDAN = {
  label: 'Seedance 2.5 Flash 480p',
  model: 'seedance-2.5-flash-480p',
  aspectRatio: '16:9',
  duration: 30,
  resolution: '480p',
  maxImages: 9,
  maxImageBytes: 19 * 1024 * 1024,
  maxTotalBytes: 100 * 1024 * 1024,
} as const;

export type EdanFlashImage = { buffer: Buffer; name: string; mime: string };
export type EdanFlashAsset = { type: string; url: string; name?: string; size?: number };
type Cookie = { id: number; cookie: string };

type Dependencies = {
  cookies(): Promise<Cookie[]>;
  markDead(id: number): Promise<void>;
  upload(cookie: string, image: EdanFlashImage): Promise<EdanFlashAsset>;
  submit(cookie: string, body: ReturnType<typeof seedance25FlashEdanRequest>): Promise<string>;
  poll(cookie: string, jobId: string): Promise<string>;
  onStatus?(stage: 'upload' | 'submit' | 'poll'): void;
};

export function seedance25FlashEdanRequest(prompt: string, assets: EdanFlashAsset[]) {
  const text = validateSeedance25Prompt(prompt);
  if (assets.length < 1 || assets.length > SEEDANCE25_FLASH_EDAN.maxImages
    || assets.some(asset => asset.type !== 'image' || !isEdanbotAssetUrl(asset.url))) {
    throw new Error('EDANBOT_SEEDANCE25_FLASH_INVALID_REFERENCES');
  }
  return {
    model: SEEDANCE25_FLASH_EDAN.model,
    request_id: randomUUID(),
    fields: {
      prompt: text,
      aspect_ratio: SEEDANCE25_FLASH_EDAN.aspectRatio,
      duration: SEEDANCE25_FLASH_EDAN.duration,
      resolution: SEEDANCE25_FLASH_EDAN.resolution,
      reference_images: assets.map(asset => asset.url),
    },
  };
}

function isEdanbotAssetUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'edanbot.digital'
      && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isAuthFailure(error: unknown): boolean {
  const status = (error as { response?: { status?: number } })?.response?.status;
  return status === 401 || status === 403;
}

export async function generateSeedance25FlashEdan(
  prompt: string,
  images: EdanFlashImage[],
  deps: Dependencies,
) {
  const text = validateSeedance25Prompt(prompt);
  const totalBytes = images.reduce((sum, image) => sum + image.buffer.length, 0);
  if (images.length < 1 || images.length > SEEDANCE25_FLASH_EDAN.maxImages
    || images.some(image => !image.buffer.length || image.buffer.length > SEEDANCE25_FLASH_EDAN.maxImageBytes)
    || totalBytes > SEEDANCE25_FLASH_EDAN.maxTotalBytes) {
    throw new Error('EDANBOT_SEEDANCE25_FLASH_INVALID_REFERENCES');
  }

  const cookies = await deps.cookies();
  if (!cookies.length) throw new Error('EDANBOT_NO_COOKIE');
  for (const entry of cookies) {
    let jobId: string | undefined;
    try {
      deps.onStatus?.('upload');
      const assets: EdanFlashAsset[] = [];
      for (const image of images) {
        assets.push(await deps.upload(entry.cookie, image));
      }
      const body = seedance25FlashEdanRequest(text, assets);
      deps.onStatus?.('submit');
      jobId = await deps.submit(entry.cookie, body);
      if (typeof jobId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(jobId)) {
        jobId = undefined;
        throw new Error('EDANBOT_SEEDANCE25_FLASH_NO_JOB_ID');
      }
      deps.onStatus?.('poll');
      const url = await deps.poll(entry.cookie, jobId);
      if (!url || new URL(url).protocol !== 'https:') {
        throw new Error('EDANBOT_SEEDANCE25_FLASH_NO_RESULT');
      }
      return { url, jobId };
    } catch (error) {
      if (isAuthFailure(error)) {
        await deps.markDead(entry.id).catch(() => {});
        if (!jobId) continue;
      }
      if (jobId) {
        throw new Error(`EDANBOT_SEEDANCE25_FLASH_ACCEPTED_JOB_FAILED ${jobId}`, { cause: error });
      }
      throw error;
    }
  }
  throw new Error('EDANBOT_NO_VALID_COOKIE');
}
