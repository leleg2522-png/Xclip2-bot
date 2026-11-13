export const POSBOT_SEEDANCE25_PRICE = 7_000;
export const POSBOT_SEEDANCE25_API_BASE = 'https://api.posbot.web.id/api/v1';
export const POSBOT_SEEDANCE25_MAX_PROMPT = 8_000;
export const POSBOT_SEEDANCE25_MAX_IMAGES_I2V = 2;
export const POSBOT_SEEDANCE25_MAX_IMAGES_R2V = 9;
export const POSBOT_SEEDANCE25_MAX_MEDIA_BYTES = 19 * 1024 * 1024;
export const POSBOT_SEEDANCE25_MAX_TOTAL_BYTES = 100 * 1024 * 1024;
export const POSBOT_SEEDANCE25_MAX_VIDEO_SECONDS = 30;

export type PosbotSeedance25Mode = 'i2v' | 'r2v';
export type PosbotSeedance25Ratio = '9:16' | '16:9' | '1:1';
export type PosbotSeedance25Asset = {
  kind: 'image' | 'video';
  url: string;
};

export type PosbotSeedance25Request = {
  model: string;
  prompt: string;
  mode?: 'i2v';
  image_url?: string;
  image_urls?: string[];
  video_url?: string;
  aspect_ratio: PosbotSeedance25Ratio;
  notify_telegram: false;
};

function validPublicHttpsUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function validatePosbotSeedance25Prompt(value: string): string {
  const prompt = value.trim();
  if (prompt.length < 3) throw Error('Tulis prompt minimal 3 karakter.');
  if (prompt.length > POSBOT_SEEDANCE25_MAX_PROMPT) {
    throw Error(`Prompt maksimal ${POSBOT_SEEDANCE25_MAX_PROMPT.toLocaleString('id-ID')} karakter.`);
  }
  return prompt;
}

export function buildPosbotSeedance25Request(input: {
  mode: PosbotSeedance25Mode;
  prompt: string;
  ratio: PosbotSeedance25Ratio;
  imageUrls: string[];
  videoUrl?: string;
}): PosbotSeedance25Request {
  const prompt = validatePosbotSeedance25Prompt(input.prompt);
  if (!(['9:16', '16:9', '1:1'] as string[]).includes(input.ratio)) {
    throw Error('Pilih rasio video yang tersedia.');
  }
  if (input.imageUrls.some(url => !validPublicHttpsUrl(url))) {
    throw Error('URL foto referensi tidak valid.');
  }
  if (input.mode === 'i2v') {
    if (input.videoUrl || input.imageUrls.length < 1
      || input.imageUrls.length > POSBOT_SEEDANCE25_MAX_IMAGES_I2V) {
      throw Error('Seedance 2.5 P3 I2V membutuhkan 1–2 foto referensi.');
    }
    return {
      model: 's2_seedance_25_30s',
      prompt,
      mode: 'i2v',
      ...(input.imageUrls.length === 1
        ? { image_url: input.imageUrls[0] }
        : { image_urls: [...input.imageUrls] }),
      aspect_ratio: input.ratio,
      notify_telegram: false,
    };
  }

  if (!input.videoUrl || !validPublicHttpsUrl(input.videoUrl)
    || input.imageUrls.length > POSBOT_SEEDANCE25_MAX_IMAGES_R2V) {
    throw Error('Seedance 2.5 P3 R2V membutuhkan 1 video dan maksimal 9 foto referensi.');
  }
  return {
    model: 'seedance_25_30s_r2v',
    prompt,
    video_url: input.videoUrl,
    ...(input.imageUrls.length ? { image_urls: [...input.imageUrls] } : {}),
    aspect_ratio: input.ratio,
    notify_telegram: false,
  };
}

export type PosbotSeedance25ProviderOptions = {
  apiKey: string;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  maxPollAttempts?: number;
  onPoll?: (status: string, progress?: number) => void;
};

function safeJobCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}

function safeResultUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password
      && (url.hostname === 'posbot.web.id' || url.hostname.endsWith('.posbot.web.id'));
  } catch {
    return false;
  }
}

async function responseJson(response: Response, code: string): Promise<any> {
  if (!response.ok) throw Error(`${code}_HTTP_${response.status}`);
  try { return await response.json(); }
  catch { throw Error(`${code}_INVALID_RESPONSE`); }
}

/** Submit exactly once, then poll the acknowledged job_code; never replay a paid submit. */
export async function generatePosbotSeedance25(
  input: Parameters<typeof buildPosbotSeedance25Request>[0],
  options: PosbotSeedance25ProviderOptions,
): Promise<{ jobCode: string; resultUrl: string }> {
  if (!options.apiKey?.trim()) throw Error('POSBOT_API_KEY_MISSING');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const body = buildPosbotSeedance25Request(input);

  let submitResponse: Response;
  try {
    submitResponse = await fetchImpl(`${POSBOT_SEEDANCE25_API_BASE}/generate`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
  } catch {
    // The provider may have accepted a request before the connection was lost.
    // Do not retry or submit the same paid task a second time.
    throw Error('POSBOT_SUBMIT_UNCERTAIN');
  }
  const accepted = await responseJson(submitResponse, 'POSBOT_SUBMIT');
  const jobCode = accepted?.job_code ?? accepted?.data?.job_code;
  if (!safeJobCode(jobCode)) throw Error('POSBOT_SUBMIT_UNCERTAIN');

  const attempts = options.maxPollAttempts ?? 225;
  const interval = options.pollIntervalMs ?? 8_000;
  for (let attempt = 0; attempt < attempts; attempt++) {
    await sleep(interval);
    let response: Response;
    try {
      response = await fetchImpl(
        `${POSBOT_SEEDANCE25_API_BASE}/status/${encodeURIComponent(jobCode)}`,
        {
          headers: { Authorization: `Bearer ${options.apiKey}` },
          signal: AbortSignal.timeout(45_000),
        },
      );
    } catch {
      if (attempt === attempts - 1) throw Error('POSBOT_POLL_NETWORK');
      continue;
    }
    if (response.status === 429 || response.status >= 500) {
      if (attempt === attempts - 1) throw Error(`POSBOT_POLL_HTTP_${response.status}`);
      continue;
    }
    const state = await responseJson(response, 'POSBOT_POLL');
    const status = String(state?.status ?? state?.data?.status ?? '').toLowerCase();
    const progressValue = Number(state?.progress ?? state?.data?.progress);
    options.onPoll?.(status || 'processing', Number.isFinite(progressValue) ? progressValue : undefined);
    if (status === 'failed' || status === 'error' || status === 'cancelled') {
      throw Error('POSBOT_GENERATION_FAILED');
    }
    if (status === 'completed') {
      const resultUrl = state?.result_url ?? state?.data?.result_url;
      if (!safeResultUrl(resultUrl)) throw Error('POSBOT_RESULT_INVALID');
      return { jobCode, resultUrl };
    }
  }
  throw Error('POSBOT_POLL_TIMEOUT');
}
