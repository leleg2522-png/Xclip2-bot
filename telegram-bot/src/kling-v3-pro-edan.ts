export const KLING_V3_PRO = {
  label: 'Kling v3 Pro 1080',
  model: 'kling-3',
  settingsLabel: '9:16 · 15 detik · 1080p · audio',
  maxImages: 2,
} as const;

export type EdanImageAsset = { type: string; url: string; name: string; size: number };
type Cookie = { id: number; cookie: string };
type Image = { buffer: Buffer; name: string; mime: string };
type Dependencies = {
  cookies(): Promise<Cookie[]>;
  markDead(id: number): Promise<void>;
  upload(cookie: string, image: Image): Promise<EdanImageAsset>;
  submit(cookie: string, body: ReturnType<typeof klingV3ProRequest>): Promise<string>;
  poll(cookie: string, jobId: string): Promise<string>;
  onStatus?(stage: 'upload' | 'submit' | 'poll'): void;
};

export function klingV3ProRequest(prompt: string, assets: EdanImageAsset[]) {
  if (!prompt.trim() || assets.length < 1 || assets.length > KLING_V3_PRO.maxImages
    || assets.some(asset => asset.type !== 'image' || !asset.url)) {
    throw new Error('KLING_V3_PRO_INVALID_INPUT');
  }
  return {
    model: KLING_V3_PRO.model,
    fields: {
      prompt,
      aspect_ratio: '9:16',
      duration: 15,
      resolution: '1080p',
      start_image: assets[0],
      ...(assets[1] ? { end_image: assets[1] } : {}),
      generate_audio: true,
    },
  };
}

function authFailure(error: unknown): boolean {
  const status = (error as { response?: { status?: number } })?.response?.status;
  return status === 401 || status === 403;
}

export async function generateKlingV3Pro(prompt: string, images: Image[], deps: Dependencies) {
  if (!prompt.trim() || images.length < 1 || images.length > KLING_V3_PRO.maxImages) {
    throw new Error('KLING_V3_PRO_INVALID_INPUT');
  }
  const cookies = await deps.cookies();
  if (!cookies.length) throw new Error('EDANBOT_NO_COOKIE');
  for (const entry of cookies) {
    let jobId: string | undefined;
    try {
      deps.onStatus?.('upload');
      const assets: EdanImageAsset[] = [];
      for (const image of images) assets.push(await deps.upload(entry.cookie, image));
      deps.onStatus?.('submit');
      // Only an explicit authentication rejection permits trying another cookie.
      // Timeouts, missing IDs, and all post-acceptance failures must never resubmit.
      jobId = await deps.submit(entry.cookie, klingV3ProRequest(prompt, assets));
      if (!jobId) throw new Error('EDANBOT_NO_JOB_ID');
      deps.onStatus?.('poll');
      const url = await deps.poll(entry.cookie, jobId);
      if (!url) throw new Error('EDANBOT_NO_RESULT');
      return { url, jobId };
    } catch (error) {
      if (authFailure(error)) {
        await deps.markDead(entry.id).catch(() => {});
        if (!jobId) continue;
      }
      if (jobId) {
        throw new Error(`EDANBOT_ACCEPTED_JOB_FAILED: ${jobId}`, { cause: error });
      }
      throw error;
    }
  }
  throw new Error('EDANBOT_NO_VALID_COOKIE');
}
