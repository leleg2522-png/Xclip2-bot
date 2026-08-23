import axios from 'axios';

const ONEOVER_BASE_URL = (process.env.ONEOVER_BASE_URL || 'https://mjuwtqkfhtpgavwjrual.supabase.co/functions/v1')
  .replace(/\/+$/, '');
const ONEOVER_API_KEY = process.env.ONEOVER_API_KEY?.trim();
const ONEOVER_AUTHORIZATION = process.env.ONEOVER_AUTHORIZATION?.trim();
const ONEOVER_COOKIE = process.env.ONEOVER_COOKIE?.trim();
const ONEOVER_REFRESH_TOKEN = process.env.ONEOVER_REFRESH_TOKEN?.trim();
const ONEOVER_AUTH_BASE_URL = ONEOVER_BASE_URL.replace(/\/functions\/v1$/, '');

export const ONEOVER_SEEDANCE_25 = {
  model: 'seedance-2.5',
  label: 'Seedance 2.5 I2V',
  duration: 30,
  resolution: '480p',
  aspectRatio: 'wide',
  generateAudio: true,
} as const;

const http = axios.create({ timeout: 120_000, validateStatus: () => true });
// Submit bisa lebih lambat daripada polling, khususnya ketika upstream sedang
// menyiapkan model. Jangan menyamakan batasnya: timeout submit yang terlalu
// pendek membuat job yang mungkin sedang diterima terlihat gagal.
const configuredSubmitTimeout = Number(process.env.ONEOVER_SUBMIT_TIMEOUT_MS);
export const ONEOVER_SUBMIT_TIMEOUT_MS = Number.isFinite(configuredSubmitTimeout)
  ? Math.min(600_000, Math.max(120_000, configuredSubmitTimeout))
  : 300_000;
const submitHttp = axios.create({ timeout: ONEOVER_SUBMIT_TIMEOUT_MS, validateStatus: () => true });
// This endpoint is consumed by the web app and the captured successful browser
// request carries these non-secret context headers. Railway's bare Node request
// can otherwise be held at the edge until it times out.
const browserContextHeaders = {
  accept: '*/*',
  'accept-language': 'id,en-US;q=0.9,en;q=0.8,pt;q=0.7',
  origin: 'https://oneover.com',
  referer: 'https://oneover.com/',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
} as const;

export type OneOverCredentials = {
  apiKey: string;
  authorization?: string;
  cookie?: string;
  refreshToken?: string;
  userId?: string;
};

export type OneOverSubmission = {
  predictionUrl: string;
  videoProvider: string;
  videoModel: string;
  projectId?: string;
  requestId?: string;
  source?: string;
};

export function getEnvironmentCredentials(): OneOverCredentials | null {
  if (!ONEOVER_API_KEY || (!ONEOVER_AUTHORIZATION && !ONEOVER_COOKIE)) return null;
  return {
    apiKey: ONEOVER_API_KEY,
    authorization: ONEOVER_AUTHORIZATION,
    cookie: ONEOVER_COOKIE,
    refreshToken: ONEOVER_REFRESH_TOKEN,
    userId: process.env.ONEOVER_USER_ID?.trim() || undefined,
  };
}

export function resolveOneOverAccountId(credentials: OneOverCredentials): string | null {
  if (credentials.userId?.trim()) return credentials.userId.trim();
  const rawAuthorization = credentials.authorization?.trim().replace(/^Bearer\s+/i, '');
  if (!rawAuthorization) return null;
  const parts = rawAuthorization.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload?.sub === 'string' && payload.sub.trim() ? payload.sub.trim() : null;
  } catch {
    return null;
  }
}

export function oneOverAccessTokenExpiresAt(credentials: OneOverCredentials): number | null {
  const raw = credentials.authorization?.trim().replace(/^Bearer\s+/i, '');
  const payload = raw?.split('.')[1];
  if (!payload) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof parsed?.exp === 'number' ? parsed.exp * 1000 : null;
  } catch {
    return null;
  }
}

export function oneOverTokenNeedsRefresh(credentials: OneOverCredentials, now = Date.now()): boolean {
  const expiresAt = oneOverAccessTokenExpiresAt(credentials);
  return expiresAt !== null && expiresAt <= now + 5 * 60_000;
}

export async function refreshOneOverCredentials(credentials: OneOverCredentials): Promise<OneOverCredentials> {
  if (!credentials.refreshToken?.trim()) throw new Error('ONEOVER_NO_REFRESH_TOKEN');
  let response;
  try {
    response = await axios.post(
      `${ONEOVER_AUTH_BASE_URL}/auth/v1/token?grant_type=refresh_token`,
      { refresh_token: credentials.refreshToken.trim() },
      {
        timeout: 30_000,
        validateStatus: () => true,
        headers: {
          apikey: credentials.apiKey,
          'content-type': 'application/json',
          ...browserContextHeaders,
        },
      }
    );
  } catch (error: any) {
    throw new Error(error?.code === 'ECONNABORTED' ? 'ONEOVER_REFRESH_TIMEOUT' : 'ONEOVER_REFRESH_FAILED');
  }
  const body = response.data as any;
  if (response.status < 200 || response.status >= 300 || typeof body?.access_token !== 'string') {
    throw new Error(`ONEOVER_REFRESH_FAILED ${response.status}`);
  }
  const refreshed: OneOverCredentials = {
    ...credentials,
    authorization: `Bearer ${body.access_token}`,
    refreshToken: typeof body.refresh_token === 'string' && body.refresh_token.trim()
      ? body.refresh_token
      : credentials.refreshToken,
  };
  const originalUser = resolveOneOverAccountId(credentials);
  const refreshedUser = resolveOneOverAccountId(refreshed);
  if (originalUser && refreshedUser && originalUser !== refreshedUser) {
    throw new Error('ONEOVER_REFRESH_ACCOUNT_MISMATCH');
  }
  return refreshed;
}

function headers(credentials: OneOverCredentials): Record<string, string> {
  if (!credentials.apiKey?.trim()) throw new Error('ONEOVER_NO_CREDENTIAL');
  if (!credentials.authorization?.trim() && !credentials.cookie?.trim()) throw new Error('ONEOVER_NO_SESSION');
  return {
    ...browserContextHeaders,
    apikey: credentials.apiKey.trim(),
    'content-type': 'application/json',
    ...(credentials.authorization?.trim()
      ? {
        authorization: credentials.authorization.trim().startsWith('Bearer ')
          ? credentials.authorization.trim()
          : `Bearer ${credentials.authorization.trim()}`,
      }
      : {}),
    ...(credentials.cookie?.trim() ? { cookie: credentials.cookie.trim() } : {}),
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
  return getEnvironmentCredentials() !== null;
}

export function isOneOverAuthFailure(error: unknown): boolean {
  const message = String((error as any)?.message ?? error ?? '');
  return /ONEOVER_(SUBMIT|POLL)_FAILED (401|403)|invalid.*token|token.*expired|unauthori[sz]ed|forbidden|authentication/i.test(message);
}

export async function submitOneOverSeedanceI2v(input: {
  prompt: string;
  referenceImage: string;
  credentials: OneOverCredentials;
}): Promise<OneOverSubmission> {
  if (!input.referenceImage.startsWith('data:image/')) throw new Error('ONEOVER_INVALID_IMAGE');
  let r;
  try {
    r = await submitHttp.post(`${ONEOVER_BASE_URL}/video-generate`, {
      prompt: input.prompt,
      model: ONEOVER_SEEDANCE_25.model,
      duration: ONEOVER_SEEDANCE_25.duration,
      resolution: ONEOVER_SEEDANCE_25.resolution,
      aspect_ratio: ONEOVER_SEEDANCE_25.aspectRatio,
      generate_audio: ONEOVER_SEEDANCE_25.generateAudio,
      video_draft: false,
      reference_image: input.referenceImage,
      auto_prompt: true,
    }, { headers: headers(input.credentials) });
  } catch (error: any) {
    if (error?.code === 'ECONNABORTED') throw new Error('ONEOVER_SUBMIT_TIMEOUT');
    throw error;
  }

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
  credentials: OneOverCredentials,
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
    }, { headers: headers(credentials) });

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