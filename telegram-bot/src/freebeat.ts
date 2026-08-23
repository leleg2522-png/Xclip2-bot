import axios from 'axios';
import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';

const FREEBEAT_WEB_BASE = 'https://freebeat.ai/api/proxy/v1';
const FREEBEAT_UPLOAD_BASE = 'https://api.freebeatfit.com/api/v2';
const http = axios.create({ timeout: 30_000, validateStatus: () => true });

export const FREEBEAT_MINIMAX_H3 = {
  model: 'hailuo-3',
  modelId: 131,
  label: 'MiniMax H3 I2V',
  duration: 15,
  resolution: '768p',
  aspectRatio: '16:9',
  generationType: 0,
  watermark: 0,
} as const;

export type FreebeatSubmission = {
  providerRef: string;
};

export type FreebeatWebCredentials = {
  token: string;
  udt: string;
};

type FreebeatEnvelope<T> = {
  code?: number;
  msg?: string;
  data?: T;
};

function errorCode(prefix: string, message?: string): Error {
  const detail = String(message || '').replace(/[\r\n]+/g, ' ').slice(0, 300);
  return new Error(detail ? `${prefix}: ${detail}` : prefix);
}

function webHeaders(session: FreebeatWebCredentials): Record<string, string> {
  return {
    token: session.token,
    udt: session.udt,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'fb-language': 'en',
    'x-platform-type': 'WEB',
    Origin: 'https://freebeat.ai',
    Referer: 'https://freebeat.ai/ai-video-generator',
  };
}

async function postWeb<T>(path: string, body: unknown, session: FreebeatWebCredentials): Promise<T> {
  const response = await http.post<FreebeatEnvelope<T>>(`${FREEBEAT_WEB_BASE}${path}`, body, {
    headers: webHeaders(session),
  });
  const envelope = response.data;
  if (response.status < 200 || response.status >= 300) {
    throw errorCode('FREEBEAT_WEB_API_FAILED', envelope?.msg || `HTTP ${response.status}`);
  }
  if (!envelope || envelope.code !== 0 || envelope.data === undefined) {
    throw errorCode('FREEBEAT_WEB_API_FAILED', envelope?.msg || `code ${String(envelope?.code)}`);
  }
  return envelope.data;
}

export async function uploadFreebeatImage(input: {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}): Promise<string> {
  const extension = extname(input.filename) || '.jpg';
  const objectKey = `dance/aivideo/${Date.now()}_${randomUUID().slice(0, 12)}${extension}`;
  const signResponse = await http.post<FreebeatEnvelope<Array<{ signURL: string; finalStaticUrl: string }>>>(
    `${FREEBEAT_UPLOAD_BASE}/file/genUploadSignUrl`,
    { reqList: [{ key: objectKey, fileName: input.filename, bucketName: 'freebeat-static' }] },
  );
  const envelope = signResponse.data;
  if (signResponse.status < 200 || signResponse.status >= 300 || !envelope || envelope.code !== 0 || !envelope.data?.[0]) {
    throw errorCode('FREEBEAT_UPLOAD_URL_FAILED', envelope?.msg || `HTTP ${signResponse.status}`);
  }
  const signItems = envelope.data;
  const target = signItems[0];
  if (!target?.signURL || !target.finalStaticUrl) throw new Error('FREEBEAT_UPLOAD_URL_MISSING');

  const upload = await axios.put(target.signURL, input.buffer, {
    timeout: 300_000,
    validateStatus: () => true,
    headers: {
      'Content-Type': input.mimeType || 'image/jpeg',
      ...(new URL(target.signURL).searchParams
        .get('X-Amz-SignedHeaders')
        ?.split(';')
        .map(header => header.trim().toLowerCase())
        .includes('x-amz-acl')
        ? { 'x-amz-acl': 'public-read' }
        : {}),
    },
  });
  if (upload.status < 200 || upload.status >= 300) {
    throw new Error(`FREEBEAT_UPLOAD_FAILED: HTTP ${upload.status}`);
  }
  return target.finalStaticUrl;
}

export async function submitFreebeatMinimaxH3(input: {
  prompt: string;
  imageUrl: string;
}, session: FreebeatWebCredentials): Promise<FreebeatSubmission> {
  const providerRef = await postWeb<string>(
    '/aiVideo/createAiVideo',
    {
      generationType: FREEBEAT_MINIMAX_H3.generationType,
      model: FREEBEAT_MINIMAX_H3.model,
      modelId: FREEBEAT_MINIMAX_H3.modelId,
      duration: FREEBEAT_MINIMAX_H3.duration,
      resolution: FREEBEAT_MINIMAX_H3.resolution,
      style: '',
      images: [input.imageUrl],
      prompt: input.prompt,
      watermark: FREEBEAT_MINIMAX_H3.watermark,
      name: `telegram-h3-${Date.now()}`,
      aspectRatio: FREEBEAT_MINIMAX_H3.aspectRatio,
      extraParams: {},
    },
    session
  );
  if (!providerRef.trim()) throw new Error('FREEBEAT_SUBMIT_REJECTED');
  return { providerRef };
}

export async function pollFreebeatVideo(
  submission: FreebeatSubmission,
  session: FreebeatWebCredentials,
  onPoll?: (elapsedSeconds: number) => void | Promise<void>
): Promise<{ url: string; credits?: number }> {
  const startedAt = Date.now();
  for (let attempt = 0; attempt < 240; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 15_000));
    await onPoll?.(Math.round((Date.now() - startedAt) / 1000));

    const result = await postWeb<{
      list?: Array<{
        taskId?: string;
        serialNo?: string;
        status?: string | number;
        useCredits?: number;
        videoUrl?: string;
      }>;
    }>(
      '/aiVideo/list',
      { limit: 50, anchor: 0 },
      session
    );
    const item = result.list?.find(row => row.taskId === submission.providerRef || row.serialNo === submission.providerRef);
    if (!item) continue;
    if (typeof item.videoUrl === 'string' && item.videoUrl.startsWith('http')) {
      return { url: item.videoUrl, credits: item.useCredits };
    }

    const status = String(item.status || '').toLowerCase();
    if (['failed', 'error', 'rejected', 'cancelled', 'canceled'].includes(status)) {
      throw errorCode('FREEBEAT_GENERATION_FAILED', status);
    }
    if (typeof item.status === 'number' && item.status >= 100) {
      if (item.status === 100) throw new Error('FREEBEAT_NO_RESULT_URL');
      throw errorCode('FREEBEAT_GENERATION_FAILED', String(item.status));
    }
  }
  throw new Error('FREEBEAT_TIMEOUT');
}

export function isFreebeatAuthFailure(error: unknown): boolean {
  const message = String((error as Error)?.message || error || '').toLowerCase();
  return message.includes('unauthorized')
    || message.includes('forbidden')
    || message.includes('invalid token')
    || message.includes('expired')
    || message.includes('login')
    || message.includes('invalid uid');
}