export type HarModelKey = 'heygen' | 'xclip_motion' | 'banana21_t2i' | 'banana21_i2i';
export type HarAspectRatio = '9:16' | '16:9' | '1:1';

export const HAR_MODELS = {
  heygen: { label: 'Heygen Video', priceKey: 'heygen', video: true, needsImage: true, needsVideo: false },
  xclip_motion: { label: 'Xclip Motion', priceKey: 'xclip_motion', video: true, needsImage: true, needsVideo: true },
  banana21_t2i: { label: 'Nano Banana 2.1 Text to Image', priceKey: 'banana21', video: false, needsImage: false, needsVideo: false },
  banana21_i2i: { label: 'Nano Banana 2.1 Image to Image', priceKey: 'banana21', video: false, needsImage: true, needsVideo: false },
} as const;

export function harWorkflow(model: HarModelKey): string {
  if (model === 'xclip_motion') throw new Error('XCLIP_MOTION_BACKEND_CHANGED');
  return HAR_MODELS[model].video
    ? '/gw-v2/workflows/heygen/v1/models/video/generate'
    : '/gw-v2/workflows/gemini/v2/images';
}

export function buildHarModelParams(input: {
  model: HarModelKey;
  prompt: string;
  ratio: HarAspectRatio;
  imageUrl?: string;
  videoUrl?: string;
}): Record<string, any> {
  if (input.model === 'xclip_motion') throw new Error('XCLIP_MOTION_BACKEND_CHANGED');
  const cfg = HAR_MODELS[input.model];
  if (!cfg || !input.prompt.trim()) throw new Error('PICSART_INVALID_HAR_INPUT');
  if (cfg.needsImage !== Boolean(input.imageUrl) || cfg.needsVideo !== Boolean(input.videoUrl)) {
    throw new Error('PICSART_INVALID_HAR_MEDIA');
  }
  if (!['9:16', '16:9', '1:1'].includes(input.ratio) || (cfg.video && input.ratio === '1:1')) {
    throw new Error('PICSART_INVALID_HAR_RATIO');
  }
  const model = cfg.video ? 'heygen-video-1' : 'gemini-nano-banana-2.1';
  const params: Record<string, any> = cfg.video ? {
    model, prompt: input.prompt, duration: 15, resolution: '768p',
    prompt_enhancement: 'turbo', aspect_ratio: input.ratio,
    reference_images: [{ type: 'url', url: input.imageUrl }],
    ...(cfg.needsVideo ? { reference_videos: [{ type: 'url', url: input.videoUrl }] } : {}),
  } : {
    prompt: input.prompt, model, count: 1,
    imageUrls: input.imageUrl ? [input.imageUrl] : [],
    aspectRatio: input.ratio, imageSize: '4K',
    thinkingConfig: { thinkingLevel: 'MINIMAL' },
  };
  const payload = cfg.video ? {
    prompt: input.prompt, resolution: '768p', duration: 15,
    aspectRatio: input.ratio, promptEnhancement: 'turbo',
    imageUrls: [input.imageUrl], ...(input.videoUrl ? { videoUrls: [input.videoUrl] } : {}),
  } : {
    prompt: input.prompt, aspectRatio: input.ratio, resolution: '4K',
    count: 1, thinkingLevel: 'minimal', imageUrls: params.imageUrls,
  };
  return {
    ...params,
    options: {
      inputs_transformation: { downscale_oversized_images: true },
      drive: {
        name: `${input.model}-${Date.now()}.${cfg.video ? 'mp4' : 'png'}`,
        attributes: { model, aiSDKPayload: JSON.stringify(payload), appId: 'com.picsart.ai-playground', appType: 'miniapp' },
        folder: { path: 'AI Playground' },
      },
    },
  };
}

export function harResultUrl(result: any, video: boolean): string | undefined {
  const candidate = video ? result?.url : result?.imageUrls?.[0];
  const url = typeof candidate === 'string' ? candidate : candidate?.url;
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : undefined;
}
