import { validateSeedance25Prompt } from './seedance25-prompt';

export const SEEDANCE25_P2 = {
  label: 'Seedance 2.5 P2', duration: 30,
  ratios: ['16:9', '9:16'], maxImages: 10, maxVideos: 10,
  maxBytes: 19 * 1024 * 1024, maxTotalBytes: 100 * 1024 * 1024,
  maxVideoSeconds: 30,
} as const;
// Retained only for the legacy Edanbot request helper below. Public P2 jobs
// now use the shared Picsart Seedance 2.5 route and its 1080p finishing step.
const LEGACY_EDANBOT_SEEDANCE25 = { model: 'seedance-2.5', resolution: '720p' } as const;
export type P2Ratio = typeof SEEDANCE25_P2.ratios[number];
export type P2Reference = {
  kind: 'image' | 'video'; fileId: string; size: number; duration?: number; order: number;
};
export type P2Asset = { kind: 'image' | 'video'; url: string };

export function validateP2References(refs: P2Reference[]) {
  if (!refs.length) throw Error('Kirim setidaknya satu gambar atau video referensi.');
  if (refs.filter(r => r.kind === 'image').length > SEEDANCE25_P2.maxImages
    || refs.filter(r => r.kind === 'video').length > SEEDANCE25_P2.maxVideos) {
    throw Error('Maksimal 10 gambar dan 10 video referensi.');
  }
  if (refs.some(r => !['image', 'video'].includes(r.kind) || !r.fileId
    || !Number.isSafeInteger(r.size) || r.size <= 0 || r.size > SEEDANCE25_P2.maxBytes)) {
    throw Error('Referensi tidak valid atau melebihi 19MB per file.');
  }
  if (new Set(refs.map(r => r.fileId)).size !== refs.length) throw Error('Referensi yang sama sudah diterima.');
  if (refs.reduce((n, r) => n + r.size, 0) > SEEDANCE25_P2.maxTotalBytes) {
    throw Error('Ukuran gabungan referensi maksimal 100MB.');
  }
  const videos = refs.filter(r => r.kind === 'video');
  if (videos.some(r => !Number.isFinite(r.duration) || r.duration! < 2)
    || videos.reduce((n, r) => n + r.duration!, 0) > SEEDANCE25_P2.maxVideoSeconds) {
    throw Error('Video minimal 2 detik per file; total durasi video maksimal 30 detik.');
  }
}

export function seedance25P2Request(prompt: string, ratio: P2Ratio, assets: P2Asset[]) {
  const text = validateSeedance25Prompt(prompt);
  if (!SEEDANCE25_P2.ratios.includes(ratio) || !assets.length
    || assets.filter(a => a.kind === 'image').length > SEEDANCE25_P2.maxImages
    || assets.filter(a => a.kind === 'video').length > SEEDANCE25_P2.maxVideos) {
    throw Error('SEEDANCE25_P2_INVALID_INPUT');
  }
  for (const asset of assets) {
    let url: URL;
    try { url = new URL(asset.url); } catch { throw Error('SEEDANCE25_P2_INVALID_ASSET'); }
    if (!['image', 'video'].includes(asset.kind) || url.protocol !== 'https:'
      || url.username || url.password) throw Error('SEEDANCE25_P2_INVALID_ASSET');
  }
  return {
    model: LEGACY_EDANBOT_SEEDANCE25.model,
    fields: {
      prompt: text, aspect_ratio: ratio, duration: SEEDANCE25_P2.duration,
      resolution: LEGACY_EDANBOT_SEEDANCE25.resolution,
      reference_images: assets.filter(a => a.kind === 'image').map(a => a.url),
      reference_videos: assets.filter(a => a.kind === 'video').map(a => a.url),
    },
  };
}

export type P2ProviderDeps = {
  cookies(): Promise<{ id: number; cookie: string }[]>;
  markDead(id: number): Promise<void>;
  upload(cookie: string, reference: P2Reference): Promise<P2Asset>;
  submit(cookie: string, body: ReturnType<typeof seedance25P2Request>): Promise<string>;
  poll(cookie: string, jobId: string): Promise<string>;
  accepted?(jobId: string): void;
};

export async function generateSeedance25P2(
  prompt: string, ratio: P2Ratio, refs: P2Reference[], deps: P2ProviderDeps,
) {
  validateP2References(refs);
  validateSeedance25Prompt(prompt);
  if (!SEEDANCE25_P2.ratios.includes(ratio)) throw Error('SEEDANCE25_P2_INVALID_RATIO');
  const cookies = await deps.cookies();
  for (const entry of cookies) {
    let jobId: string | undefined;
    try {
      const assets: P2Asset[] = [];
      for (const ref of refs) {
        const asset = await deps.upload(entry.cookie, ref);
        if (asset.kind !== ref.kind) throw Error('SEEDANCE25_P2_INVALID_ASSET');
        assets.push(asset);
      }
      jobId = await deps.submit(entry.cookie, seedance25P2Request(prompt, ratio, assets));
      if (typeof jobId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(jobId)) {
        throw Error('SEEDANCE25_P2_UNKNOWN_SUBMIT');
      }
      deps.accepted?.(jobId);
      const url = await deps.poll(entry.cookie, jobId);
      if (!url || new URL(url).protocol !== 'https:') throw Error('SEEDANCE25_P2_NO_RESULT');
      return { url, jobId };
    } catch (error: any) {
      if ([401, 403].includes(error?.response?.status)) {
        await deps.markDead(entry.id).catch(() => {});
        if (!jobId) continue;
      }
      // An unknown submit outcome is not a reason to try a different account.
      if (jobId) throw Error('SEEDANCE25_P2_ACCEPTED_JOB_FAILED', { cause: error });
      throw error;
    }
  }
  throw Error('SEEDANCE25_P2_NO_SESSION');
}
