export const FLORA_AUTO_UPSCALE_MODEL = 'video-upscaler-topaz';

export type UpscaleFacts = { width: number; height: number; duration: number };
export type UpscaleResult = { url: string; upscaled: boolean };

export interface FloraAutoUpscaleDependencies {
  key(skip: Set<string>): Promise<string | null>;
  disable(key: string): Promise<void>;
  download(url: string): Promise<Buffer>;
  inspect(bytes: Buffer): Promise<UpscaleFacts>;
  models(key: string): Promise<any[]>;
  workspace(key: string): Promise<{ workspaceId: string; projectId: string }>;
  upload(key: string, workspaceId: string, bytes: Buffer): Promise<string>;
  generate(key: string, workspace: { workspaceId: string; projectId: string },
    model: string, params: Record<string, unknown>): Promise<string>;
  poll(key: string, runId: string): Promise<string>;
  normalize(source: Buffer, output: Buffer): Promise<Buffer>;
  publish(bytes: Buffer): Promise<string>;
  log(event: string): void;
}

/** Integer factors avoid provider-specific fractional-scale rounding. */
export function flora1080Factor(facts: UpscaleFacts): number {
  const edge = Math.min(facts.width, facts.height);
  if (![facts.width, facts.height, facts.duration].every(Number.isFinite)
    || edge <= 0 || facts.duration <= 0) throw Error('FLORA_UPSCALE_INVALID_VIDEO');
  const factor = Math.ceil(1080 / edge);
  if (factor > 4) throw Error('FLORA_UPSCALE_SOURCE_TOO_SMALL');
  return Math.max(1, factor);
}

export function supportsFlora1080(models: any[], factor: number): boolean {
  const model = models.find(row => row.model_id === FLORA_AUTO_UPSCALE_MODEL);
  const scale = model?.params?.find((param: any) => param.name === 'upscale_factor');
  return !!model?.capabilities?.includes('video-upscaler')
    && !!model.params?.some((param: any) => param.name === 'video_url')
    && !!scale && ['float', 'int', 'number'].includes(scale.type)
    && factor >= (scale.min ?? 1) && factor <= (scale.max ?? 4);
}

function acceptedTask(error: any): boolean {
  const body = error?.response?.data;
  return !!(body?.run_id || body?.id || body?.data?.run_id || body?.data?.id);
}

function keyRejected(error: any): boolean {
  const status = error?.response?.status;
  const body = JSON.stringify(error?.response?.data ?? {}).toLowerCase();
  return status === 401 || status === 402
    || (status === 403 && /invalid_credentials|invalid.api.key|insufficient|quota|billing_not_enough_credits/.test(body));
}

function failedRunBilling(error: unknown): boolean {
  return /BILLING_NOT_ENOUGH_CREDITS|INSUFFICIENT_CREDITS/i.test(String(error));
}

/** Optional finishing only; callers retain their existing fallback/refund policy. */
export async function generateFlora1080(
  sourceUrl: string,
  deps: FloraAutoUpscaleDependencies,
): Promise<UpscaleResult> {
  const original = { url: sourceUrl, upscaled: false };
  const skipped = new Set<string>();
  try {
    const source = await deps.download(sourceUrl);
    const facts = await deps.inspect(source);
    const factor = flora1080Factor(facts);
    // Already meets the delivery tier, even if the Flora pool is empty.
    if (factor === 1) return { url: sourceUrl, upscaled: true };
    for (let attempt = 0; attempt < 5; attempt++) {
      const key = await deps.key(skipped);
      if (!key) {
        deps.log('flora_pool_empty');
        return original;
      }
      let stage = 'prepare';
      let submitting = false;
      let runId: string | undefined;
      try {
        stage = 'catalog';
        if (!supportsFlora1080(await deps.models(key), factor)) {
          skipped.add(key);
          deps.log('flora_upscale_model_unavailable');
          continue; // Free discovery only; do not disable a valid key.
        }
        stage = 'workspace';
        const ws = await deps.workspace(key);
        stage = 'upload';
        const videoUrl = await deps.upload(key, ws.workspaceId, source);
        stage = 'submit';
        submitting = true;
        runId = await deps.generate(key, ws, FLORA_AUTO_UPSCALE_MODEL,
          { video_url: videoUrl, upscale_factor: factor });
        if (!runId) throw Error('FLORA_UPSCALE_AMBIGUOUS_SUBMIT');
        submitting = false;
        stage = 'poll';
        const outputUrl = await deps.poll(key, runId);
        stage = 'output';
        const output = await deps.download(outputUrl);
        const normalized = await deps.normalize(source, output);
        const url = await deps.publish(normalized);
        deps.log('flora_upscale_completed');
        return { url, upscaled: true };
      } catch (error) {
        const rejected = ['catalog', 'workspace', 'upload', 'submit', 'poll'].includes(stage)
          && keyRejected(error);
        if (rejected || (stage === 'poll' && failedRunBilling(error))) {
          await deps.disable(key).catch(() => {});
        }
        // An accepted job, missing ID, network timeout, or output failure must
        // never submit the same finishing job again through another key.
        if (runId || acceptedTask(error) || (submitting && !rejected)) {
          deps.log(`flora_upscale_failed_${stage}`);
          return original;
        }
        if (rejected) {
          skipped.add(key);
          continue;
        }
        deps.log(`flora_upscale_failed_${stage}`);
        return original;
      }
    }
  } catch {
    deps.log('flora_upscale_unavailable');
  }
  return original;
}
