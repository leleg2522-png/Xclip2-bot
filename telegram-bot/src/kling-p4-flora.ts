export const KLING_P4 = {
  label: 'Kling MC V3 Pro P4',
  modelId: 'iv2v-kling-2.6-motion',
  minSeconds: 3,
  maxSeconds: 30,
  maxVideoBytes: 15 * 1024 * 1024,
  maxImageBytes: 10 * 1024 * 1024,
} as const;

export function klingP4VideoError(size?: number, seconds?: number): string | undefined {
  if (size && size > KLING_P4.maxVideoBytes) return 'Video referensi maksimal 15MB. Potong atau kompres dulu.';
  if (seconds !== undefined && (!Number.isFinite(seconds) || seconds < KLING_P4.minSeconds || seconds > KLING_P4.maxSeconds)) {
    return `Durasi video referensi harus ${KLING_P4.minSeconds}–${KLING_P4.maxSeconds} detik.`;
  }
}

interface Media { buf: Buffer; name: string; mime: string }
interface Workspace { workspaceId: string; projectId: string }
export interface KlingP4Api {
  getKey(skip: Set<string>): Promise<string | null>;
  markDead(key: string): Promise<void>;
  workspace(key: string): Promise<Workspace>;
  upload(key: string, workspaceId: string, buf: Buffer, name: string, mime: string): Promise<string>;
  generate(key: string, ws: Workspace, model: string, params: Record<string, any>, prompt: string, type: 'video'): Promise<string>;
  poll(key: string, runId: string, maxMs: number): Promise<string>;
  exhausted(error: unknown): boolean;
  status(text: string): Promise<void>;
}

/** Only pre-acceptance credential errors may rotate keys. Never replay a paid run. */
export async function generateKlingP4Flora(
  input: { image: Media; video: Media; prompt: string; seconds?: number },
  api: KlingP4Api
): Promise<string> {
  const invalid = klingP4VideoError(input.video.buf.length, input.seconds);
  if (invalid) throw new Error(invalid);
  if (input.image.buf.length > KLING_P4.maxImageBytes) throw new Error('Foto karakter maksimal 10MB.');
  const skipped = new Set<string>();
  for (let attempt = 0; attempt < 5; attempt++) {
    const key = await api.getKey(skipped);
    if (!key) throw new Error('KLING_P4_UNAVAILABLE');
    let runId: string | undefined;
    try {
      const ws = await api.workspace(key);
      await api.status(`⏳ ${KLING_P4.label}: mengunggah foto dan video referensi...`);
      const imageUrl = await api.upload(key, ws.workspaceId, input.image.buf, input.image.name, input.image.mime);
      const videoUrl = await api.upload(key, ws.workspaceId, input.video.buf, input.video.name, input.video.mime);
      await api.status(`⏳ ${KLING_P4.label}: mengirim perintah...`);
      runId = await api.generate(key, ws, KLING_P4.modelId, {
        image_url: imageUrl,
        video_url: videoUrl,
        character_orientation: 'video',
      }, input.prompt.trim() || 'Follow the motion in the reference video.', 'video');
      if (!runId) throw new Error('KLING_P4_SUBMIT_NO_ID');
      await api.status(`⏳ ${KLING_P4.label}: video sedang dibuat.\nHasil akan dikirim otomatis (~5–20 menit).`);
      return await api.poll(key, runId, 20 * 60 * 1000);
    } catch (error) {
      const exhausted = api.exhausted(error);
      if (exhausted) await api.markDead(key).catch(() => {});
      if (runId || !exhausted) throw error;
      skipped.add(key);
    }
  }
  throw new Error('KLING_P4_UNAVAILABLE');
}
