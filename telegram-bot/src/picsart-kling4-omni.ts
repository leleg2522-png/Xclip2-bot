import { buildKling4Params } from './picsart-kling4';

export const KLING4_OMNI_MODEL = 'kling-v4-omni';

export function buildKling4OmniParams(input: {
  prompt: string;
  ratio: '9:16' | '16:9';
  imageUrl?: string;
  imageUrls?: string[];
  videoUrl?: string;
  referType?: 'feature' | 'base';
  outputName?: string;
}): Record<string, unknown> {
  return buildKling4Params({
    ...input, mode: 'i2v',
    outputName: input.outputName || 'kling-4-omni-ai-playground.mp4',
  });
}
