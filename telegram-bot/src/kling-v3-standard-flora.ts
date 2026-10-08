import { isFloraWorkspaceSetupError, type KlingP4Api } from './kling-p4-flora';

export const KLING_V3_STANDARD = {
  label: 'Kling MC V3 Pro P5',
  modelId: 'iv2v-kling-v3-standard-motion',
  minSeconds: 3,
  maxSeconds: 30,
  maxVideoBytes: 15 * 1024 * 1024,
  maxImageBytes: 10 * 1024 * 1024,
} as const;

export function klingV3StandardVideoError(size?: number, seconds?: number): string | undefined {
  if (size && size > KLING_V3_STANDARD.maxVideoBytes) return 'Video referensi maksimal 15MB. Potong atau kompres dulu.';
  if (seconds !== undefined && (!Number.isFinite(seconds) || seconds < 3 || seconds > 30)) {
    return 'Durasi video referensi harus 3–30 detik.';
  }
}

/** This is actual Kling 3.0 Standard, not the separate P4 Kling 2.6 route. */
export async function generateKlingV3StandardFlora(
  input: { image: { buf: Buffer; name: string; mime: string }; video: { buf: Buffer; name: string; mime: string }; prompt: string; seconds?: number },
  api: KlingP4Api
): Promise<string> {
  const invalid = klingV3StandardVideoError(input.video.buf.length, input.seconds);
  if (invalid) throw new Error(invalid);
  if (input.image.buf.length > KLING_V3_STANDARD.maxImageBytes) throw new Error('Foto karakter maksimal 10MB.');
  const skipped = new Set<string>();
  for (let attempt = 0; attempt < 5; attempt++) {
    const key = await api.getKey(skipped);
    if (!key) throw new Error('KLING_V3_STANDARD_UNAVAILABLE');
    let runId: string | undefined;
    let workspaceReady = false;
    try {
      const ws = await api.workspace(key);
      workspaceReady = true;
      await api.status(`⏳ ${KLING_V3_STANDARD.label}: mengunggah foto dan video referensi...`);
      const imageUrl = await api.upload(key, ws.workspaceId, input.image.buf, input.image.name, input.image.mime);
      const videoUrl = await api.upload(key, ws.workspaceId, input.video.buf, input.video.name, input.video.mime);
      await api.status(`⏳ ${KLING_V3_STANDARD.label}: mengirim perintah...`);
      runId = await api.generate(key, ws, KLING_V3_STANDARD.modelId, {
        image_url: imageUrl, video_url: videoUrl, character_orientation: 'video',
      }, input.prompt.trim() || 'Follow the motion in the reference video.', 'video');
      if (!runId) throw new Error('KLING_V3_STANDARD_SUBMIT_NO_ID');
      await api.status(`⏳ ${KLING_V3_STANDARD.label}: video sedang dibuat.\nHasil dikirim otomatis (~5–20 menit).`);
      return await api.poll(key, runId, 20 * 60 * 1000);
    } catch (error) {
      const exhausted = api.exhausted(error);
      if (exhausted) await api.markDead(key).catch(() => {});
      // Once accepted, credential or billing failure must refund, not resubmit.
      const missingSetup = !workspaceReady && isFloraWorkspaceSetupError(error);
      if (runId || (!exhausted && !missingSetup)) throw error;
      skipped.add(key);
    }
  }
  throw new Error('KLING_V3_STANDARD_UNAVAILABLE');
}
