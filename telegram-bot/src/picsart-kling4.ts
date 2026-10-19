export const KLING4_MODEL = 'kling-v4-omni';
export const KLING4_DURATION_SECONDS = 30;
export const KLING4_RESOLUTION = '720p';
export const KLING4_CREDITS = 90;

export function buildKling4Params(input: {
  mode: 'i2v' | 't2v';
  prompt: string;
  ratio: '9:16' | '16:9';
  imageUrl?: string;
  imageUrls?: string[];
  outputName?: string;
}): Record<string, unknown> {
  if (!input.prompt.trim() || !['9:16', '16:9'].includes(input.ratio)) {
    throw new Error('PICSART_KLING4_INVALID_INPUT');
  }
  const imageUrls = input.imageUrls?.length ? input.imageUrls : input.imageUrl ? [input.imageUrl] : [];
  if (input.mode === 'i2v') {
    if (imageUrls.length === 0) throw new Error('PICSART_KLING4_IMAGE_REQUIRED');
    if (imageUrls.length > 5) throw new Error('PICSART_KLING4_TOO_MANY_IMAGES');
    for (const imageUrl of imageUrls) {
      try {
        const url = new URL(imageUrl);
        if (url.protocol !== 'https:' || url.username || url.password) throw Error();
      } catch { throw new Error('PICSART_KLING4_IMAGE_REQUIRED'); }
    }
  } else if (input.mode !== 't2v' || imageUrls.length) {
    throw new Error('PICSART_KLING4_UNEXPECTED_IMAGE');
  }
  return {
    prompt: input.prompt.trim(),
    aspect_ratio: input.ratio,
    duration: String(KLING4_DURATION_SECONDS),
    model_name: KLING4_MODEL,
    resolution: KLING4_RESOLUTION,
    ...(input.mode === 'i2v' ? { image_list: imageUrls.map(image_url => ({ image_url })) } : {}),
    options: {
      inputs_transformation: { downscale_oversized_images: true },
      drive: {
        name: input.outputName || `kling-4-${input.mode}-ai-playground.mp4`,
        attributes: {
          model: KLING4_MODEL,
          aiSDKPayload: JSON.stringify({
            prompt: input.prompt.trim(),
            aspectRatio: input.ratio,
            duration: KLING4_DURATION_SECONDS,
            resolution: KLING4_RESOLUTION,
            referType: 'feature',
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
