export type SnapgenBananaModel = 'nano-banana-pro' | 'nano-banana-2' | 'nano-banana-2-lite';
export interface SnapgenBananaImage { buffer: Buffer; name: string; mime: string }
export interface SnapgenBananaApi {
  available: boolean;
  submit(input: {
    prompt: string;
    model: 'nano-banana-2';
    aspectRatio: string;
    images: SnapgenBananaImage[];
  }): Promise<{ uuid: string; url?: string }>;
  poll(uuid: string): Promise<{ url: string }>;
  status(stage: 'submit' | 'poll'): Promise<void>;
}

/** Public Pro/Lite packages follow Banana 2; submit only once, never replay. */
export async function generateBananaSnapgen(
  input: { model: SnapgenBananaModel; mode: 't2i' | 'i2i'; prompt: string; ratio: string; images: SnapgenBananaImage[] },
  api: SnapgenBananaApi,
): Promise<string> {
  if (!['nano-banana-pro', 'nano-banana-2', 'nano-banana-2-lite'].includes(input.model)) {
    throw Error('BANANA_INVALID_MODEL');
  }
  if (!input.prompt.trim() || !['1:1', '16:9', '9:16', '4:3', '3:4'].includes(input.ratio)) {
    throw Error('BANANA_INVALID_INPUT');
  }
  if (!['t2i', 'i2i'].includes(input.mode)
    || (input.mode === 'i2i' ? input.images.length < 1 || input.images.length > 2 : input.images.length !== 0)) {
    throw Error('BANANA_INVALID_REFERENCES');
  }
  if (input.images.some(image => !image.buffer.length || image.buffer.length > 10 * 1024 * 1024
    || !['image/jpeg', 'image/png'].includes(image.mime))) {
    throw Error('BANANA_INVALID_IMAGE');
  }
  if (!api.available) throw Error('BANANA_UNAVAILABLE');
  await api.status('submit');
  const task = await api.submit({
    model: 'nano-banana-2', prompt: input.prompt.trim(),
    aspectRatio: input.ratio, images: input.images,
  });
  if (!task.uuid) throw Error('BANANA_SUBMIT_NO_ID');
  if (task.url) return task.url;
  await api.status('poll');
  const result = await api.poll(task.uuid);
  if (!result.url) throw Error('BANANA_NO_RESULT_URL');
  return result.url;
}
