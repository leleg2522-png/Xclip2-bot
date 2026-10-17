import { KLING4_DURATION_SECONDS, KLING4_RESOLUTION } from './picsart-kling4';

export const KLING4_OMNI_MODEL = 'kling-v4-omni';

export function buildKling4OmniParams(input: {
  prompt: string;
  ratio: '9:16' | '16:9';
  imageUrl: string;
  outputName?: string;
}): Record<string, unknown> {
  if (!input.prompt.trim() || !['9:16', '16:9'].includes(input.ratio)) {
    throw new Error('PICSART_KLING4_OMNI_INVALID_INPUT');
  }
  try {
    const url = new URL(input.imageUrl);
    if (url.protocol !== 'https:' || url.username || url.password) throw Error();
  } catch {
    throw new Error('PICSART_KLING4_OMNI_IMAGE_REQUIRED');
  }
  return {
    prompt: input.prompt.trim(),
    model_name: KLING4_OMNI_MODEL,
    aspect_ratio: input.ratio,
    duration: String(KLING4_DURATION_SECONDS),
    resolution: KLING4_RESOLUTION,
    image_list: [{ image_url: input.imageUrl }],
    options: {
      inputs_transformation: { downscale_oversized_images: true },
      drive: {
        name: input.outputName || 'kling-4-omni-ai-playground.mp4',
        attributes: {
          model: KLING4_OMNI_MODEL,
          aiSDKPayload: JSON.stringify({
            prompt: input.prompt.trim(),
            aspectRatio: input.ratio,
            duration: KLING4_DURATION_SECONDS,
            resolution: KLING4_RESOLUTION,
            referType: 'feature',
            imageUrls: [input.imageUrl],
          }),
          appId: 'com.picsart.ai-playground',
          appType: 'miniapp',
        },
        folder: { path: 'AI Playground' },
      },
    },
  };
}
