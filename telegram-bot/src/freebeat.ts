import axios from 'axios';
import { extname } from 'node:path';
import { randomUUID } from 'node:crypto';

const FREEBEAT_API_BASE = (process.env.FREEBEAT_API_HOST || 'https://api.freebeatfit.com').replace(/\/+$/, '');
const http = axios.create({ timeout: 30_000, validateStatus: () => true });

export const FREEBEAT_MINIMAX_H3 = {
  modelId: 'hailuo-3',
  label: 'MiniMax H3 I2V',
  duration: 15,
  resolution: '768p',
  aspectRatio: '16:9',
  generationType: 0,
  watermark: 0,
} as const;

export type FreebeatSubmission = {
  batchId: string;
  serialNo?: string;
  credits?: number;
};

type FreebeatEnvelope<T> = {
  code?: number;
  msg?: string;
  data?: T;
};

function apiKey(): string | null {
  return process.env.FREEBEAT_API_KEY?.trim() || null;
}

export function isFreebeatConfigured(): boolean {
  return Boolean(apiKey());
}

function errorCode(prefix: string, message?: string): Error {
  const detail = String(message || '').replace(/[\r\n]+/g, ' ').slice(0, 300);
  return new Error(detail ? `${prefix}: ${detail}` : prefix);
}

function headers(key: string): Record<string, string> {
  return {
    Authorization: key,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };
}

async function post<T>(path: string, body: unknown, key: string): Promise<T> {
  const response = await http.post<FreebeatEnvelope<T>>(`${FREEBEAT_API_BASE}${path}`, body, {
    headers: headers(key),
  });
  const envelope = response.data;
  if (response.status < 200 || response.status >= 300) {
    throw errorCode('FREEBEAT_API_FAILED', envelope?.msg || `HTTP ${response.status}`);
  }
  if (!envelope || envelope.code !== 0 || envelope.data === undefined) {
    throw errorCode('FREEBEAT_API_FAILED', envelope?.msg || `code ${String(envelope?.code)}`);
  }
  return envelope.data;
}

export async function uploadFreebeatImage(input: {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}): Promise<string> {
  const key = apiKey();
  if (!key) throw new Error('FREEBEAT_NO_API_KEY');

  const extension = extname(input.filename) || '.jpg';
  const objectKey = `agent/character/${Date.now()}_${randomUUID().slice(0, 12)}${extension}`;
  const signItems = await post<Array<{ signURL: string; finalStaticUrl: string }>>(
    '/v1/mcp/agent/genUploadSignUrl',
    { reqList: [{ key: objectKey, fileName: input.filename, bucketName: 'freebeat-static' }] },
    key
  );
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
}): Promise<FreebeatSubmission> {
  const key = apiKey();
  if (!key) throw new Error('FREEBEAT_NO_API_KEY');

  const created = await post<{
    batchId: string;
    acceptedCount?: number;
    items?: Array<{
      accepted?: boolean;
      serialNo?: string | null;
      needCredits?: number;
      message?: string | null;
    }>;
  }>(
    '/v1/ai/cli/createVideoBatch',
    {
      items: [{
        modelId: FREEBEAT_MINIMAX_H3.modelId,
        generationType: FREEBEAT_MINIMAX_H3.generationType,
        prompt: input.prompt,
        images: [input.imageUrl],
        duration: FREEBEAT_MINIMAX_H3.duration,
        resolution: FREEBEAT_MINIMAX_H3.resolution,
        aspectRatio: FREEBEAT_MINIMAX_H3.aspectRatio,
        style: '',
        watermark: FREEBEAT_MINIMAX_H3.watermark,
      }],
    },
    key
  );

  const accepted = created.items?.find(item => item.accepted);
  if (!created.batchId || !accepted) {
    throw errorCode('FREEBEAT_SUBMIT_REJECTED', created.items?.[0]?.message || 'Task tidak diterima');
  }
  return {
    batchId: created.batchId,
    serialNo: accepted.serialNo || undefined,
    credits: typeof accepted.needCredits === 'number' ? accepted.needCredits : undefined,
  };
}

export async function pollFreebeatVideo(
  submission: FreebeatSubmission,
  onPoll?: (elapsedSeconds: number) => void
): Promise<{ url: string; credits?: number }> {
  const key = apiKey();
  if (!key) throw new Error('FREEBEAT_NO_API_KEY');

  const startedAt = Date.now();
  for (let attempt = 0; attempt < 240; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 15_000));
    onPoll?.(Math.round((Date.now() - startedAt) / 1000));

    const result = await post<{
      items?: Array<{
        serialNo?: string;
        status?: string | number;
        usedCredits?: number;
        errorCode?: string | number;
        errorMessage?: string;
        videoUrl?: string;
      }>;
    }>(
      '/v1/ai/cli/queryBatch',
      { batchId: submission.batchId, ...(submission.serialNo ? { serialNo: submission.serialNo } : {}) },
      key
    );
    const item = submission.serialNo
      ? result.items?.find(row => row.serialNo === submission.serialNo)
      : result.items?.[0];
    if (!item) continue;
    if (typeof item.videoUrl === 'string' && item.videoUrl.startsWith('http')) {
      return { url: item.videoUrl, credits: item.usedCredits };
    }

    const status = String(item.status || '').toLowerCase();
    if (['failed', 'error', 'rejected', 'cancelled', 'canceled'].includes(status)) {
      throw errorCode('FREEBEAT_GENERATION_FAILED', item.errorMessage || String(item.errorCode || status));
    }
    if (typeof item.status === 'number' && item.status >= 100) {
      if (item.status === 100) throw new Error('FREEBEAT_NO_RESULT_URL');
      throw errorCode('FREEBEAT_GENERATION_FAILED', item.errorMessage || String(item.errorCode || item.status));
    }
  }
  throw new Error('FREEBEAT_TIMEOUT');
}