type ImageReference = { buffer: Buffer; name?: string; mime?: string };
export type GenjutsuTimedReference = ImageReference & { duration: number };
type TimedReference = GenjutsuTimedReference;

export type GenjutsuProviderInput = {
  userId: number;
  prompt: string;
  images?: ImageReference[];
  videos?: TimedReference[];
  audios?: TimedReference[];
  taskType?: 'auto' | 'reference' | 'edit';
  generateAudio?: boolean;
  persistAccount?: boolean;
  maxProviderCredits?: number;
  maxReferenceSeconds?: 15 | 30;
  onStatus?: (stage: 'upload' | 'quote' | 'submit' | 'poll') => void;
  onPoll?: (elapsedSec: number) => void;
  onSubmitted?: (submission: { credentialId: number; taskId: string }) => void | Promise<void>;
};

export type GenjutsuEditSubmission = {
  prompt: string;
  imageUrls: string[];
  videoUrls: string[];
  audioUrls: string[];
  duration: -1;
  ratio: 'adaptive';
  resolution: '480p';
  taskType: 'edit';
  generateAudio: false;
};

export interface GenjutsuProviderDependencies {
  model: string;
  prepareVideo(video: GenjutsuTimedReference): Promise<GenjutsuTimedReference>;
  account<T>(userId: number, work: (id: number) => Promise<T>, assign: boolean): Promise<T>;
  upload(id: number, data: Buffer, name: string, mime: string): Promise<string>;
  credits(id: number): Promise<{ credits: number }>;
  quote(id: number, params: Record<string, unknown>): Promise<number>;
  submit(id: number, input: GenjutsuEditSubmission): Promise<string>;
  poll(id: number, taskId: string, tick: (elapsedMs: number) => void): Promise<{ url: string; credits?: number }>;
}

/** Standard Seedance 2.5 edit; never use the Flash/reference-generation route. */
export async function generateGenjutsuWithSeedance25(
  input: GenjutsuProviderInput,
  deps: GenjutsuProviderDependencies,
): Promise<{ url: string; credits?: number }> {
  const images = input.images ?? [], videos = input.videos ?? [];
  const max = input.maxReferenceSeconds ?? 30;
  const prompt = input.prompt.trim();
  if (!prompt || prompt.length > 20_000 || images.length < 1 || images.length > 10 || videos.length !== 1
    || (input.audios?.length ?? 0) !== 0 || (input.taskType && input.taskType !== 'edit')
    || input.generateAudio === true) throw Error('GENJUTSU_INVALID_REFERENCES');
  if (![15, 30].includes(max) || !Number.isFinite(videos[0].duration) || videos[0].duration < 3 || videos[0].duration > max) {
    throw Error('GENJUTSU_INVALID_VIDEO_DURATION');
  }
  if ([...images, ...videos].some(item => !item.buffer.length || item.buffer.length > 19 * 1024 * 1024)) {
    throw Error('GENJUTSU_INVALID_MEDIA_SIZE');
  }
  if (input.maxProviderCredits !== undefined
    && (!Number.isFinite(input.maxProviderCredits) || input.maxProviderCredits <= 0)) {
    throw Error('GENJUTSU_INVALID_CREDIT_LIMIT');
  }
  const source = await deps.prepareVideo(videos[0]);
  if (!Number.isFinite(source.duration) || source.duration < 4 || source.duration > 30
    || !source.buffer.length || source.buffer.length > 19 * 1024 * 1024) {
    throw Error('GENJUTSU_INVALID_PREPARED_VIDEO');
  }
  return deps.account(input.userId, async id => {
    input.onStatus?.('upload');
    const imageUrls: string[] = [];
    for (const [index, image] of images.entries()) {
      imageUrls.push(await deps.upload(id, image.buffer, image.name ?? `character-${index + 1}.jpg`, image.mime ?? 'image/jpeg'));
    }
    const videoUrl = await deps.upload(id, source.buffer, source.name ?? 'source.mp4', source.mime ?? 'video/mp4');
    const submission: GenjutsuEditSubmission = {
      prompt, imageUrls, videoUrls: [videoUrl], audioUrls: [],
      duration: -1, ratio: 'adaptive', resolution: '480p', taskType: 'edit', generateAudio: false,
    };
    input.onStatus?.('quote');
    const credits = await deps.quote(id, {
      model: deps.model,
      content: [
        { type: 'video_url', video_url: { url: videoUrl }, role: 'reference_video' },
        ...imageUrls.map(url => ({ type: 'image_url', image_url: { url }, role: 'reference_image' })),
        { type: 'text', text: prompt },
      ],
      ratio: 'adaptive', duration: -1, resolution: '480p', generate_audio: false,
      omni_reference_task_type: 'edit', output_format: 'mp4',
    });
    if (!Number.isFinite(credits) || credits <= 0) throw Error('GENJUTSU_INVALID_CREDIT_QUOTE');
    if (input.maxProviderCredits !== undefined && credits > input.maxProviderCredits) {
      throw Error('GENJUTSU_QUOTE_EXCEEDS_CREDIT_LIMIT');
    }
    const available = (await deps.credits(id)).credits;
    if (!Number.isFinite(available) || available < credits) throw Error('PICSART_INSUFFICIENT_CREDITS');
    input.onStatus?.('submit');
    const taskId = await deps.submit(id, submission);
    try {
      await input.onSubmitted?.({ credentialId: id, taskId });
      input.onStatus?.('poll');
      return await deps.poll(id, taskId, ms => input.onPoll?.(Math.round(ms / 1000)));
    } catch (error) {
      // The existing account runner recognizes this prefix and never resubmits.
      throw new Error(`PICSART_SEEDANCE25_POST_SUBMIT_FAILED Genjutsu job=${taskId}`, { cause: error });
    }
  }, input.persistAccount ?? true);
}
