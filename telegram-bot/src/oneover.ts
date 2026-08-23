import axios from 'axios';

const ONEOVER_BASE_URL = (process.env.ONEOVER_BASE_URL || 'https://mjuwtqkfhtpgavwjrual.supabase.co/functions/v1')
  .replace(/\/+$/, '');
const ONEOVER_API_KEY = process.env.ONEOVER_API_KEY?.trim();
const ONEOVER_COOKIE = process.env.ONEOVER_COOKIE?.trim();

export const ONEOVER_SEEDANCE_25 = {
  model: 'seedance-2.5',
  label: 'Seedance 2.5 I2V',
  duration: 30,
  resolution: '480p',
  aspectRatio: 'wide',
  generateAudio: true,
} as const;

const http = axios.create({ timeout: 120_000, validateStatus: () => true });

type OneOverSubmission = {
  predictionUrl: string;
  videoProvider: string;
  videoModel: string;
  projectId?: string;
  requestId?: string;
  source?: string;
};

function headers(): Record<string, string> {
  if (!ONEOVER_API_KEY) throw new Error('ONEOVER_NO_CREDENTIAL');
  return {
    apikey: ONEOVER_API_KEY,
    'content-type': 'application/json',
    ...(ONEOVER_COOKIE ? { cookie: ONEOVER_COOKIE } : {}),
  };
}

function safeError(prefix: string, status: number, data: unknown): Error {
  const reason = typeof (data as any)?.error === 'string'
    ? (data as any).error
    : typeof (data as any)?.message === 'string'
      ? (data as any).message
      : 'provider rejected request';
  return new Error(`${prefix} ${status}: ${reason}`.slice(0, 300));
}

export function oneoverConfigured(): boolean {
  return Boolean(ONEOVER_API_KEY);
}

export async function submitOneOverSeedanceI2v(input: {
  prompt: string;
  referenceImage: string;
}): Promise<OneOverSubmission> {
  if (!input.referenceImage.startsWith('data:image/')) throw new Error('ONEOVER_INVALID_IMAGE');
  const r = await http.post(`${ONEOVER_BASE_URL}/video-generate`, {
    prompt: input.prompt,
    model: ONEOVER_SEEDANCE_25.model,
    duration: ONEOVER_SEEDANCE_25.duration,
    resolution: ONEOVER_SEEDANCE_25.resolution,
    aspect_ratio: ONEOVER_SEEDANCE_25.aspectRatio,
    generate_audio: ONEOVER_SEEDANCE_25.generateAudio,
    video_draft: false,
    reference_image: input.referenceImage,
    auto_prompt: true,
  }, { headers: headers() });

  const body = r.data as any;
  if (r.status < 200 || r.status >= 300 || typeof body?.prediction_url !== 'string') {
    throw safeError('ONEOVER_SUBMIT_FAILED', r.status, body);
  }
  return {
    predictionUrl: body.prediction_url,
    videoProvider: String(body.video_provider || ''),
    videoModel: String(body.video_model || ONEOVER_SEEDANCE_25.model),
    projectId: typeof body.project_id === 'string' ? body.project_id : undefined,
    requestId: typeof body.request_id === 'string' ? body.request_id : undefined,
    source: typeof body.source === 'string' ? body.source : undefined,
  };
}

export async function pollOneOverSeedanceI2v(
  submission: OneOverSubmission,
  prompt: string,
  onPoll?: (elapsedSeconds: number) => void
): Promise<{ url: string; credits?: number }> {
  const startedAt = Date.now();
  const intervalMs = 2_500;
  const maxAttempts = 300; // 12.5 minutes; HAR completion was about 9 minutes.

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise(resolve => setTimeout(resolve, intervalMs));
    onPoll?.(Math.round((Date.now() - startedAt) / 1000));
    const r = await http.post(`${ONEOVER_BASE_URL}/video-poll`, {
      prediction_url: submission.predictionUrl,
      video_provider: submission.videoProvider,
      video_model: submission.videoModel,
      duration: ONEOVER_SEEDANCE_25.duration,
      resolution: ONEOVER_SEEDANCE_25.resolution,
      aspect_ratio: ONEOVER_SEEDANCE_25.aspectRatio,
      generate_audio: ONEOVER_SEEDANCE_25.generateAudio,
      video_draft: false,
      prompt,
      source: submission.source,
      project_id: submission.projectId,
      request_id: submission.requestId,
    }, { headers: headers() });

    const body = r.data as any;
    if (r.status < 200 || r.status >= 300) throw safeError('ONEOVER_POLL_FAILED', r.status, body);
    const status = String(body?.status || body?.replicate_status || '').toLowerCase();
    if (status === 'complete' || status === 'completed' || status === 'success') {
      if (typeof body?.url !== 'string' || !body.url.startsWith('http')) throw new Error('ONEOVER_NO_RESULT_URL');
      return { url: body.url, credits: typeof body?.credits_charged === 'number' ? body.credits_charged : undefined };
    }
    if (['failed', 'error', 'cancelled', 'canceled'].includes(status)) {
      throw safeError('ONEOVER_GENERATION_FAILED', r.status, body);
    }
  }
  throw new Error('ONEOVER_TIMEOUT');
}