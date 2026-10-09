export type BananaModel = 'nano-banana-pro' | 'nano-banana-2' | 'nano-banana-2-lite';
export interface BananaImage { buffer: Buffer; name: string; mime: string }
export interface BananaRequest {
  type: 'text-to-image' | 'image-to-image';
  model: string;
  prompt: string;
  aspect_ratio: string;
  resolution: '4k';
  num_outputs: 1;
  image_url?: string;
  images?: string[];
}
export interface BananaApi {
  getKey(skip: Set<string>): Promise<string | null>;
  markDead(key: string): Promise<void>;
  rejectedKey(error: unknown): boolean;
  host(image: BananaImage): Promise<string>;
  submit(key: string, body: BananaRequest): Promise<string>;
  poll(key: string, id: string): Promise<string>;
  status(stage: 'upload' | 'submit' | 'poll'): Promise<void>;
}

// Lite is a retained public package, not a nonexistent Renderful model ID.
export function bananaRenderfulModel(model: BananaModel, mode: 't2i' | 'i2i'): string {
  if (!['nano-banana-pro', 'nano-banana-2', 'nano-banana-2-lite'].includes(model)) {
    throw new Error('BANANA_INVALID_MODEL');
  }
  const base = model === 'nano-banana-pro' ? model : 'nano-banana-2';
  return mode === 'i2i' ? `${base}-i2i` : base;
}

export async function generateBananaRenderful(
  input: { model: BananaModel; mode: 't2i' | 'i2i'; prompt: string; ratio: string; images: BananaImage[] },
  api: BananaApi
): Promise<string> {
  const model = bananaRenderfulModel(input.model, input.mode);
  if (!input.prompt.trim() || !['1:1', '16:9', '9:16', '4:3', '3:4'].includes(input.ratio)) {
    throw new Error('BANANA_INVALID_INPUT');
  }
  if (!['t2i', 'i2i'].includes(input.mode)
    || (input.mode === 'i2i' ? input.images.length < 1 || input.images.length > 2 : input.images.length !== 0)) {
    throw new Error('BANANA_INVALID_REFERENCES');
  }
  if (input.images.some(image => image.buffer.length > 10 * 1024 * 1024 || !['image/jpeg', 'image/png'].includes(image.mime))) {
    throw new Error('BANANA_INVALID_IMAGE');
  }
  const skipped = new Set<string>();
  let references: string[] | undefined;
  for (let attempt = 0; attempt < 5; attempt++) {
    const key = await api.getKey(skipped);
    if (!key) throw new Error('BANANA_UNAVAILABLE');
    let accepted = false;
    let submitting = false;
    try {
      if (input.images.length && !references) {
        await api.status('upload');
        references = await Promise.all(input.images.map(image => api.host(image)));
      }
      await api.status('submit');
      submitting = true;
      const id = await api.submit(key, {
        type: input.mode === 'i2i' ? 'image-to-image' : 'text-to-image',
        model, prompt: input.prompt.trim(), aspect_ratio: input.ratio,
        resolution: '4k', num_outputs: 1,
        ...(references ? { image_url: references[0], images: references } : {}),
      });
      if (!id) throw new Error('BANANA_SUBMIT_NO_ID');
      accepted = true;
      await api.status('poll');
      return await api.poll(key, id);
    } catch (error) {
      // Only an explicit rejected submit is safe to rotate. An accepted job,
      // missing ID or uncertain timeout must never cause another paid request.
      const rejected = submitting && api.rejectedKey(error);
      if (rejected) {
        await api.markDead(key).catch(() => {});
      }
      if (!accepted && rejected) {
        skipped.add(key);
        continue;
      }
      throw error;
    }
  }
  throw new Error('BANANA_UNAVAILABLE');
}
