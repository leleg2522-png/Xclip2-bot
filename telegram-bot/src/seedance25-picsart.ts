// Public output settings. Picsart generates native 480p; delivery requires
// a separate successful 1080p finishing pass.
export const SEEDANCE25_RATIOS = ['16:9', '9:16'] as const;
export const SEEDANCE25_MAX_IMAGES = 10;
export type Seedance25Settings = {
  provider: 'picsart';
  mode: 't2v' | 'reference';
  resolution: 1080;
  audio: boolean;
  ratio: typeof SEEDANCE25_RATIOS[number];
};

export function validateSeedance25Request(
  settings: Seedance25Settings, prompt: string, imageCount: number,
): void {
  if (!settings || settings.provider !== 'picsart'
    || !['t2v', 'reference'].includes(settings.mode)
    || settings.resolution !== 1080 || typeof settings.audio !== 'boolean'
    || !SEEDANCE25_RATIOS.includes(settings.ratio)
    || !prompt.trim() || prompt.length > 20000
    || !Number.isInteger(imageCount)
    || (settings.mode === 't2v' ? imageCount !== 0
      : imageCount < 1 || imageCount > SEEDANCE25_MAX_IMAGES)) {
    throw Error('SEEDANCE25_INVALID_SETTINGS');
  }
}
