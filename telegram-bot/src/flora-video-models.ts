/** Native 480p contracts with per-route finishing policies. */
export type Flora480VideoModelKey = 'minimax_h3_480' | 'wan_v3_480' | 'seedance_2_480' | 'seedance_2_5_480';
export type Flora480AspectRatio = '9:16' | '16:9';

type Flora480VideoConfig = {
  label: string;
  durationSeconds?: number;
  durationOptionsSeconds?: readonly number[];
  resolution: '480P' | '480p';
  autoUpscale: boolean;
  mandatoryUpscale?: boolean;
  deliveryResolution: '1K' | '1080p' | '480p';
};

export const FLORA_480_VIDEO_MODELS: Record<Flora480VideoModelKey, Flora480VideoConfig> = {
  minimax_h3_480: {
    label: 'MiniMax H3 Uncensored',
    durationSeconds: 15,
    resolution: '480P',
    autoUpscale: true,
    deliveryResolution: '1K',
  },
  wan_v3_480: {
    label: 'Wan 3.0 Uncensored',
    durationSeconds: 30,
    resolution: '480p',
    autoUpscale: true,
    deliveryResolution: '1K',
  },
  seedance_2_480: {
    label: 'Seedance 2 Uncensored',
    durationSeconds: 15,
    resolution: '480p',
    autoUpscale: true,
    deliveryResolution: '1080p',
  },
  seedance_2_5_480: {
    label: 'Seedance 2.5 Uncensored',
    durationOptionsSeconds: [10, 15, 30],
    resolution: '480p',
    autoUpscale: true,
    mandatoryUpscale: true,
    deliveryResolution: '1K',
  },
};

type CatalogParam = {
  name?: string;
  type?: string;
  items?: { type?: string };
  options?: Array<{ value?: unknown }>;
  required?: boolean;
  default?: unknown;
};

type CatalogModel = {
  model_id?: string;
  name?: string;
  display_name?: string;
  type?: string;
  capabilities?: string[];
  params?: CatalogParam[];
};

const modelNames: Record<Flora480VideoModelKey, readonly string[]> = {
  minimax_h3_480: ['minimaxh3max', 'minimaxh3'],
  wan_v3_480: ['wan30'],
  seedance_2_480: ['seedance20'],
  seedance_2_5_480: [
    'seedance25',
    'seedance25draft',
    'seedance25bybytedance',
    'seedance25referencetovideo',
  ],
};

function catalogRows(raw: unknown): CatalogModel[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && 'models' in raw && Array.isArray(raw.models)) {
    return raw.models;
  }
  return [];
}

function supportsOption(param: CatalogParam | undefined, value: string): boolean {
  return !!param?.options?.some((option) => String(option.value) === value);
}

export type Flora480VideoReferenceParam = {
  name: string;
  type: 'string' | 'string[]';
};

const VIDEO_REFERENCE_PARAM_NAMES = [
  'video_urls',
  'reference_video_urls',
  'video_url',
  'reference_video_url',
] as const;

function mediaReferenceParam(
  params: CatalogParam[], names: readonly string[],
): Flora480VideoReferenceParam | undefined {
  for (const name of names) {
    const param = params.find((row) => row.name === name);
    if (param?.type === 'string') return { name, type: 'string' };
    if (param?.type === 'string[]' || (param?.type === 'array' && param.items?.type === 'string')) {
      return { name, type: 'string[]' };
    }
  }
  return undefined;
}

export type Flora480VideoReference = {
  url: string;
  parameter: Flora480VideoReferenceParam;
  imageParameter?: Flora480VideoReferenceParam;
};

/**
 * Resolve the account's live endpoint rather than deriving an ID from its name.
 * Reject unsupported duration/resolution before uploading or charging upstream.
 */
export function resolveFlora480VideoModelContract(
  key: Flora480VideoModelKey,
  rawModels: unknown,
  durationSeconds?: number,
  includeVideoReference = false,
  includeImageReference = key !== 'seedance_2_480' || !includeVideoReference,
): { modelId: string; videoReferenceParam?: Flora480VideoReferenceParam; imageReferenceParam?: Flora480VideoReferenceParam } {
  const config = FLORA_480_VIDEO_MODELS[key];
  const seedance2Video = key === 'seedance_2_480' && includeVideoReference;
  const combined = seedance2Video && includeImageReference;
  const selectedDuration = durationSeconds ?? config.durationSeconds;
  const allowedDurations = config.durationOptionsSeconds ?? (config.durationSeconds ? [config.durationSeconds] : []);
  if (selectedDuration == null || !allowedDurations.includes(selectedDuration)) {
    throw new Error('FLORA_INVALID_DURATION');
  }
  const candidates = catalogRows(rawModels).filter((row) => {
    const name = String(row?.name ?? row?.display_name ?? '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '');
    return (modelNames[key].includes(name) || (seedance2Video && name === 'seedance20reference'))
      && row.type === 'video'
      && row.capabilities?.some((capability) => seedance2Video
        ? combined ? capability === 'mixed-to-video'
          : ['video-to-video', 'reference-to-video', 'mixed-to-video'].includes(capability)
        : capability === 'audio-image-to-video'
        || capability === 'image-to-video'
        || (key === 'seedance_2_5_480' && capability === 'reference-to-video'));
  });
  for (const row of candidates) {
    if (typeof row.model_id !== 'string' || !row.model_id.trim() || !Array.isArray(row.params)) continue;
    const params = new Map(row.params.map((param) => [param.name, param]));
    const referenceParam = includeVideoReference ? mediaReferenceParam(row.params, VIDEO_REFERENCE_PARAM_NAMES) : undefined;
    if (includeVideoReference && !referenceParam) continue;
    const imageParam = combined ? mediaReferenceParam(row.params, ['image_urls', 'image_url']) : undefined;
    if (combined && !imageParam) continue;
    const expectedParams = buildFlora480VideoParams(
      key, includeImageReference ? 'https://example.test/image.jpg' : '', '9:16', selectedDuration,
      referenceParam ? {
        url: 'https://example.test/reference.mp4', parameter: referenceParam, imageParameter: imageParam,
      } : undefined,
    );
    if (referenceParam) {
      expectedParams[referenceParam.name] = referenceParam.type === 'string'
        ? 'https://example.test/reference.mp4'
        : ['https://example.test/reference.mp4'];
    }
    const unknownRequired = row.params.some((param) =>
      param.required && param.default == null && !(param.name! in expectedParams));
    const singleImageInput = key === 'seedance_2_480' || key === 'seedance_2_5_480';
    if (
      !unknownRequired
      && (seedance2Video ? Boolean(referenceParam) : singleImageInput
        ? params.get('image_url')?.type === 'string'
        : params.get('image_urls')?.type === 'string[]')
      && supportsOption(params.get('duration'), String(selectedDuration))
      && supportsOption(params.get('resolution'), config.resolution)
      && supportsOption(params.get('aspect_ratio'), '9:16')
      && supportsOption(params.get('aspect_ratio'), '16:9')
    ) return {
      modelId: row.model_id, videoReferenceParam: referenceParam,
      ...(imageParam ? { imageReferenceParam: imageParam } : {}),
    };
  }
  throw new Error(candidates.length ? 'FLORA_MODEL_UNSUPPORTED_PARAMETERS' : 'FLORA_MODEL_UNAVAILABLE');
}

export function resolveFlora480VideoModel(
  key: Flora480VideoModelKey,
  rawModels: unknown,
  durationSeconds?: number,
): string {
  return resolveFlora480VideoModelContract(key, rawModels, durationSeconds).modelId;
}

export function buildFlora480VideoParams(
  key: Flora480VideoModelKey,
  imageUrl: string,
  ratio: Flora480AspectRatio,
  durationSeconds?: number,
  videoReference?: Flora480VideoReference,
): Record<string, unknown> {
  const videoOnly = key === 'seedance_2_480' && Boolean(videoReference);
  if (!videoOnly && !imageUrl.trim()) throw new Error('FLORA_REFERENCE_IMAGE_REQUIRED');
  if (ratio !== '9:16' && ratio !== '16:9') throw new Error('FLORA_INVALID_ASPECT_RATIO');
  const config = FLORA_480_VIDEO_MODELS[key];
  const selectedDuration = durationSeconds ?? config.durationSeconds;
  const allowedDurations = config.durationOptionsSeconds ?? (config.durationSeconds ? [config.durationSeconds] : []);
  if (selectedDuration == null || !allowedDurations.includes(selectedDuration)) {
    throw new Error('FLORA_INVALID_DURATION');
  }
  if (key === 'seedance_2_480') {
    if (videoReference) {
      if (!videoReference.url.trim()) throw new Error('FLORA_REFERENCE_VIDEO_REQUIRED');
      if (imageUrl.trim() && !videoReference.imageParameter) throw new Error('FLORA_MODEL_UNSUPPORTED_PARAMETERS');
      const imageParam = videoReference.imageParameter;
      return {
        ...(imageUrl.trim() && imageParam ? {
          [imageParam.name]: imageParam.type === 'string' ? imageUrl : [imageUrl],
        } : {}),
        [videoReference.parameter.name]: videoReference.parameter.type === 'string'
          ? videoReference.url : [videoReference.url],
        duration: String(selectedDuration),
        resolution: config.resolution,
        aspect_ratio: ratio,
      };
    }
    return {
      image_url: imageUrl,
      duration: String(selectedDuration),
      resolution: config.resolution,
      aspect_ratio: ratio,
      bitrate_mode: 'standard',
    };
  }
  if (key === 'seedance_2_5_480') {
    const params: Record<string, unknown> = {
      image_url: imageUrl,
      duration: String(selectedDuration),
      resolution: config.resolution,
      aspect_ratio: ratio,
    };
    if (videoReference) {
      if (!videoReference.url.trim()) throw new Error('FLORA_REFERENCE_VIDEO_REQUIRED');
      params[videoReference.parameter.name] = videoReference.parameter.type === 'string'
        ? videoReference.url
        : [videoReference.url];
    }
    return params;
  }
  if (videoReference) throw new Error('FLORA_VIDEO_REFERENCE_UNSUPPORTED');
  return {
    image_urls: [imageUrl],
    duration: String(selectedDuration),
    resolution: config.resolution,
    aspect_ratio: ratio,
    ...(key === 'minimax_h3_480'
      ? { prompt_expansion_mode: 'balanced' }
      : { audio: true, prompt_expansion: true, thinking: false }),
  };
}