/** Native 480p generation contracts; delivery applies the automatic 1K pass. */
export type Flora480VideoModelKey = 'minimax_h3_480' | 'wan_v3_480';
export type Flora480AspectRatio = '9:16' | '16:9';

export const FLORA_480_VIDEO_MODELS = {
  minimax_h3_480: {
    label: 'MiniMax H3 Uncensored',
    durationSeconds: 15,
    resolution: '480P',
  },
  wan_v3_480: {
    label: 'Wan 3.0 Uncensored',
    durationSeconds: 30,
    resolution: '480p',
  },
} as const;

type CatalogParam = {
  name?: string;
  type?: string;
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

/**
 * Resolve the account's live endpoint rather than deriving an ID from its name.
 * Reject unsupported duration/resolution before uploading or charging upstream.
 */
export function resolveFlora480VideoModel(
  key: Flora480VideoModelKey,
  rawModels: unknown,
): string {
  const config = FLORA_480_VIDEO_MODELS[key];
  const candidates = catalogRows(rawModels).filter((row) => {
    const name = String(row?.name ?? row?.display_name ?? '')
      .toLowerCase().replace(/[^a-z0-9]+/g, '');
    return modelNames[key].includes(name)
      && row.type === 'video'
      && row.capabilities?.some((capability) =>
        capability === 'audio-image-to-video' || capability === 'image-to-video');
  });
  for (const row of candidates) {
    if (typeof row.model_id !== 'string' || !row.model_id.trim() || !Array.isArray(row.params)) continue;
    const params = new Map(row.params.map((param) => [param.name, param]));
    const expectedParams = buildFlora480VideoParams(key, 'https://example.test/image.jpg', '9:16');
    const unknownRequired = row.params.some((param) =>
      param.required && param.default == null && !(param.name! in expectedParams));
    if (
      !unknownRequired
      && params.get('image_urls')?.type === 'string[]'
      && supportsOption(params.get('duration'), String(config.durationSeconds))
      && supportsOption(params.get('resolution'), config.resolution)
      && supportsOption(params.get('aspect_ratio'), '9:16')
      && supportsOption(params.get('aspect_ratio'), '16:9')
    ) return row.model_id;
  }
  throw new Error(candidates.length ? 'FLORA_MODEL_UNSUPPORTED_PARAMETERS' : 'FLORA_MODEL_UNAVAILABLE');
}

export function buildFlora480VideoParams(
  key: Flora480VideoModelKey,
  imageUrl: string,
  ratio: Flora480AspectRatio,
): Record<string, unknown> {
  if (!imageUrl.trim()) throw new Error('FLORA_REFERENCE_IMAGE_REQUIRED');
  if (ratio !== '9:16' && ratio !== '16:9') throw new Error('FLORA_INVALID_ASPECT_RATIO');
  const config = FLORA_480_VIDEO_MODELS[key];
  return {
    image_urls: [imageUrl],
    duration: String(config.durationSeconds),
    resolution: config.resolution,
    aspect_ratio: ratio,
    ...(key === 'minimax_h3_480'
      ? { prompt_expansion_mode: 'balanced' }
      : { audio: true, prompt_expansion: true, thinking: false }),
  };
}