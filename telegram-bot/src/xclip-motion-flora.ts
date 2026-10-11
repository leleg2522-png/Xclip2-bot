import { isFloraWorkspaceSetupError, type KlingP4Api } from './kling-p4-flora';
import { XCLIP_MOTION, type XclipMotionReference } from './xclip-motion-media';

export interface XclipMotionApi extends KlingP4Api {
  models(key: string): Promise<unknown>;
}

/** Resolve the verified mixed-reference variant, never a generic I2V endpoint. */
export function resolveXclipMotionModel(raw: unknown, seconds: number, ratio: string, audio: boolean): string {
  const rows = Array.isArray(raw) ? raw : (raw as any)?.models;
  const model = rows?.find((r: any) => r.model_id === 'm2v-wan-3-0-gateway'
    && r.type === 'video' && r.capabilities?.includes('mixed-to-video'));
  const params = new Map<string, any>((model?.params ?? []).map((p: any) => [p.name, p]));
  const supports = (name: string, value: string) => params.get(name)?.options?.some((o: any) => String(o.value) === value);
  const allowed = new Set(['image_urls', 'video_urls', 'audio_urls', 'duration', 'resolution', 'aspect_ratio', 'audio', 'prompt_expansion', 'thinking']);
  if (!model || params.get('image_urls')?.type !== 'string[]' || params.get('video_urls')?.type !== 'string[]'
    || (audio && params.get('audio_urls')?.type !== 'string[]')
    || !supports('duration', String(seconds)) || !supports('resolution', '480p') || !supports('aspect_ratio', ratio)
    || model.params.some((p: any) => p.required && p.default == null && !allowed.has(p.name))) {
    throw Error('XCLIP_MODEL_UNSUPPORTED');
  }
  return model.model_id;
}

export async function generateXclipMotionFlora(
  input: { image: { buf: Buffer; name: string; mime: string }; reference: XclipMotionReference; prompt: string },
  api: XclipMotionApi,
): Promise<string> {
  const ref = input.reference;
  if (input.image.buf.length > XCLIP_MOTION.maxImageBytes) throw Error('XCLIP_IMAGE_TOO_LARGE');
  if (!Number.isFinite(ref.referenceSeconds) || ref.referenceSeconds < 3 || ref.referenceSeconds > 15
    || !Number.isInteger(ref.outputSeconds) || ref.outputSeconds < 3 || ref.outputSeconds > 15
    || ref.referenceSeconds + ref.outputSeconds > 30) throw Error('XCLIP_REFERENCE_DURATION');
  const skipped = new Set<string>();
  for (let attempt = 0; attempt < 5; attempt++) {
    const key = await api.getKey(skipped);
    if (!key) throw Error('XCLIP_MODEL_UNAVAILABLE');
    let runId: string | undefined;
    let workspaceReady = false;
    try {
      const ws = await api.workspace(key);
      workspaceReady = true;
      const model = resolveXclipMotionModel(await api.models(key), ref.outputSeconds, ref.ratio, !!ref.audio);
      await api.status('⏳ Xclip Motion: menyiapkan foto dan referensi gerakan...');
      const imageUrl = await api.upload(key, ws.workspaceId, input.image.buf, input.image.name, input.image.mime);
      const videoUrl = await api.upload(key, ws.workspaceId, ref.video.buf, ref.video.name, ref.video.mime);
      const audioUrl = ref.audio
        ? await api.upload(key, ws.workspaceId, ref.audio.buf, ref.audio.name, ref.audio.mime) : undefined;
      const prompt = 'Use Image 1 as the only character. Preserve the face, hairstyle and clothing of Image 1. '
        + 'Copy the dance choreography, motion sequence, gestures, body turns, footwork and timing from Video 1. '
        + 'Do not copy the appearance or outfit of the dancer in Video 1. Show the full body. '
        + (audioUrl ? 'Use Audio 1 as the soundtrack, preserving its music, vocals and beat. Synchronize the motion to Audio 1. ' : '')
        + 'No extra people or unrelated text. '
        + (input.prompt.trim() ? `Additional directions: ${input.prompt.trim()}` : '');
      await api.status('⏳ Xclip Motion: mengirim perintah...');
      runId = await api.generate(key, ws, model, {
        image_urls: [imageUrl], video_urls: [videoUrl], ...(audioUrl ? { audio_urls: [audioUrl] } : {}),
        duration: String(ref.outputSeconds), resolution: '480p', aspect_ratio: ref.ratio,
        audio: true, prompt_expansion: false, thinking: false,
      }, prompt, 'video');
      if (!runId) throw Error('XCLIP_SUBMIT_NO_ID');
      await api.status('⏳ Xclip Motion: video sedang dibuat. Hasil dikirim otomatis (~5–20 menit).');
      return await api.poll(key, runId, 20 * 60 * 1000);
    } catch (error) {
      const exhausted = api.exhausted(error);
      if (exhausted) await api.markDead(key).catch(() => {});
      const setupMissing = !workspaceReady && isFloraWorkspaceSetupError(error);
      if (runId || (!exhausted && !setupMissing)) throw error;
      skipped.add(key);
    }
  }
  throw Error('XCLIP_MODEL_UNAVAILABLE');
}
