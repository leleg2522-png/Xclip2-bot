// Public output settings. Picsart generates native 480p; delivery requires
// a separate successful 1080p finishing pass.
export const SEEDANCE25_RATIOS = ['16:9', '9:16'] as const;
export const SEEDANCE25_MAX_IMAGES = 30;
export const SEEDANCE25_MAX_VIDEOS = 10;
export const SEEDANCE25_MAX_AUDIOS = 10;
export const SEEDANCE25_MAX_MEDIA_BYTES = 19 * 1024 * 1024;
export const SEEDANCE25_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
// Conservative aggregate limits while Picsart's docs leave per-file vs total ambiguous.
export const SEEDANCE25_MAX_REFERENCE_SECONDS = 30;
export type Seedance25Media = { fileId: string; mime: string; duration: number };
export type Seedance25ResolvedMedia = { url: string; mime: string; duration: number };
export function seedance25ReferenceName(kind: 'video' | 'audio', mime: string): string {
  const extensions: Record<string, string> = {
    'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a',
    'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/ogg': 'ogg', 'audio/webm': 'webm',
    'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/aac': 'aac',
  };
  return `reference.${extensions[mime] ?? (kind === 'video' ? 'mp4' : 'mp3')}`;
}
export type Seedance25Settings = {
  provider: 'picsart';
  mode: 't2v' | 'reference';
  resolution: 1080;
  audio: boolean;
  ratio: typeof SEEDANCE25_RATIOS[number];
};

export function validateSeedance25Request(
  settings: Seedance25Settings, prompt: string, imageCount: number,
  videoCount = 0, audioCount = 0,
): void {
  if (!settings || settings.provider !== 'picsart'
    || !['t2v', 'reference'].includes(settings.mode)
    || settings.resolution !== 1080 || typeof settings.audio !== 'boolean'
    || !SEEDANCE25_RATIOS.includes(settings.ratio)
    || !prompt.trim() || prompt.length > 20000
    || !Number.isInteger(imageCount) || imageCount < 0 || imageCount > SEEDANCE25_MAX_IMAGES
    || !Number.isInteger(videoCount) || videoCount < 0 || videoCount > SEEDANCE25_MAX_VIDEOS
    || !Number.isInteger(audioCount) || audioCount < 0 || audioCount > SEEDANCE25_MAX_AUDIOS
    || (settings.mode === 't2v' ? imageCount + videoCount + audioCount !== 0
      : imageCount + videoCount + audioCount < 1)) {
    throw Error('SEEDANCE25_INVALID_SETTINGS');
  }
}
