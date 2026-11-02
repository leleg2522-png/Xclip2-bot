import { KLING4_DURATIONS, type Kling4Duration } from './picsart-kling4';
import { validateKling4ProPrompt } from './kling4-pro-prompt';

// Picsart API docs: /models/kling-v4/api; SDK 7.5.0 vendor
// KlingImageToVideoCommand maps startFrame/endFrame to image/image_tail.
export function buildKling4RegularParams(input: {
  mode: 'i2v' | 'frames';
  prompt: string;
  imageUrls: string[];
  ratio: '9:16' | '16:9';
  duration?: Kling4Duration;
  outputName?: string;
}) {
  const duration = input.duration ?? 30;
  if (!KLING4_DURATIONS.includes(duration)) throw Error('PICSART_KLING4_INVALID_DURATION');
  const prompt = validateKling4ProPrompt(input.prompt);
  if (!['9:16', '16:9'].includes(input.ratio)) throw Error('PICSART_KLING4_INVALID_INPUT');
  const count = input.mode === 'i2v' ? 1 : input.mode === 'frames' ? 2 : 0;
  if (!count || input.imageUrls.length !== count) throw Error('PICSART_KLING4_INVALID_FRAME_COUNT');
  for (const value of input.imageUrls) {
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password) throw Error();
    } catch { throw Error('PICSART_KLING4_INVALID_FRAME_URL'); }
  }
  return {
    model_name: 'kling-v4',
    prompt,
    image: input.imageUrls[0],
    ...(input.mode === 'frames' ? { image_tail: input.imageUrls[1] } : {}),
    duration: String(duration),
    aspect_ratio: input.ratio,
    resolution: '720p',
    options: {
      inputs_transformation: { downscale_oversized_images: true },
      drive: {
        name: input.outputName ?? 'kling-4-regular.mp4',
        attributes: {
          model: 'kling-v4',
          // Do not duplicate long generation prompts into limited Drive metadata.
          aiSDKPayload: JSON.stringify({
            aspectRatio: input.ratio, duration, resolution: '720p',
            startFrame: input.imageUrls[0],
            ...(input.mode === 'frames' ? { endFrame: input.imageUrls[1] } : {}),
          }),
          appId: 'com.picsart.ai-playground', appType: 'miniapp',
        },
        folder: { path: 'AI Playground' },
      },
    },
  };
}
