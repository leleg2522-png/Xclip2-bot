export const KLING4_MODEL = 'kling-v4-omni';
export const KLING4_DURATION_SECONDS = 30;
export const KLING4_RESOLUTION = '720p';
export const KLING4_CREDITS = 90;
// Picsart's Kling v4 Omni playground schema: imageUrls.array.max = 8;
// videoUrl is singular. Do not apply these to regular start/end-frame routes.
export const KLING4_MAX_REFERENCE_IMAGES = 8;
export const KLING4_DURATIONS = [10, 15, 30] as const;
export type Kling4Duration = typeof KLING4_DURATIONS[number];

export function buildKling4Params(input: {
  mode: 'i2v' | 't2v';
  prompt: string;
  ratio: '9:16' | '16:9';
  imageUrl?: string;
  imageUrls?: string[];
  videoUrl?: string;
  referType?: 'feature' | 'base';
  duration?: Kling4Duration;
  outputName?: string;
}): Record<string, unknown> {
  const duration = input.duration ?? KLING4_DURATION_SECONDS;
  if (!(KLING4_DURATIONS as readonly number[]).includes(duration)) throw new Error('PICSART_KLING4_INVALID_DURATION');
  if (!input.prompt.trim() || !['9:16', '16:9'].includes(input.ratio)) {
    throw new Error('PICSART_KLING4_INVALID_INPUT');
  }
  const imageUrls = input.imageUrls?.length ? input.imageUrls : input.imageUrl ? [input.imageUrl] : [];
  if (input.mode === 'i2v') {
    if (imageUrls.length === 0 && !input.videoUrl) throw new Error('PICSART_KLING4_IMAGE_REQUIRED');
    if (imageUrls.length > KLING4_MAX_REFERENCE_IMAGES) throw new Error('PICSART_KLING4_TOO_MANY_IMAGES');
    if (input.referType && !['feature', 'base'].includes(input.referType)) throw Error('PICSART_KLING4_INVALID_VIDEO_MODE');
    for (const imageUrl of [...imageUrls, ...(input.videoUrl ? [input.videoUrl] : [])]) {
      try {
        const url = new URL(imageUrl);
        if (url.protocol !== 'https:' || url.username || url.password) throw Error();
      } catch { throw new Error('PICSART_KLING4_IMAGE_REQUIRED'); }
    }
  } else if (input.mode !== 't2v' || imageUrls.length || input.videoUrl) {
    throw new Error('PICSART_KLING4_UNEXPECTED_IMAGE');
  }
  return {
    prompt: input.prompt.trim(),
    aspect_ratio: input.ratio,
    duration: String(duration),
    model_name: KLING4_MODEL,
    resolution: KLING4_RESOLUTION,
    ...(input.mode === 'i2v' && imageUrls.length ? { image_list: imageUrls.map(image_url => ({ image_url })) } : {}),
    ...(input.videoUrl ? { video_list: [{ video_url: input.videoUrl, refer_type: input.referType ?? 'feature' }] } : {}),
    options: {
      inputs_transformation: { downscale_oversized_images: true },
      drive: {
        name: input.outputName || `kling-4-${input.mode}-ai-playground.mp4`,
        attributes: {
          model: KLING4_MODEL,
          aiSDKPayload: JSON.stringify({
            prompt: input.prompt.trim(),
            aspectRatio: input.ratio,
            duration,
            resolution: KLING4_RESOLUTION,
            referType: input.referType ?? 'feature',
            ...(input.videoUrl ? { videoUrl: input.videoUrl } : {}),
            ...(input.mode === 'i2v' ? { imageUrls } : {}),
          }),
          appId: 'com.picsart.ai-playground',
          appType: 'miniapp',
        },
        folder: { path: 'AI Playground' },
      },
    },
  };
}
