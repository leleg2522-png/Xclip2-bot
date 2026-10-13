export type RenderfulUpscaleResult = { url: string; upscaled: boolean };

export interface RenderfulUpscaleDependencies {
  key(skip: Set<string>): Promise<string | null>;
  disable(key: string): Promise<void>;
  download(url: string): Promise<Buffer>;
  inspect(bytes: Buffer): Promise<{ width: number; height: number; duration: number }>;
  publish(bytes: Buffer): Promise<string>;
  submit(key: string, videoUrl: string): Promise<{ id?: string; pollUrl?: string }>;
  poll(key: string, taskId: string, pollUrl?: string): Promise<string>;
  normalize(source: Buffer, output: Buffer): Promise<Buffer>;
  log(event: string): void;
}

function acceptedTask(error: any): boolean {
  const body = error?.response?.data;
  return !!(body?.id || body?.task_id || body?.data?.id || body?.data?.task_id);
}

function keyRejected(error: any): boolean {
  const status = error?.response?.status;
  const body = JSON.stringify(error?.response?.data ?? {}).toLowerCase();
  return status === 401 || status === 402
    || (status === 403 && /invalid_credentials|invalid.api.key|insufficient|quota|billing_not_enough_credits/.test(body));
}

/** Callers retain native fallback or mandatory-1080p refund policies. */
export async function generateRenderful1080(
  sourceUrl: string,
  deps: RenderfulUpscaleDependencies,
): Promise<RenderfulUpscaleResult> {
  const original = { url: sourceUrl, upscaled: false };
  const skipped = new Set<string>();
  try {
    const source = await deps.download(sourceUrl);
    const facts = await deps.inspect(source);
    if (![facts.width, facts.height, facts.duration].every(Number.isFinite)
      || facts.width <= 0 || facts.height <= 0 || facts.duration <= 0) {
      throw Error('RENDERFUL_UPSCALE_INVALID_VIDEO');
    }
    if (Math.min(facts.width, facts.height) >= 1080) {
      return { url: sourceUrl, upscaled: true };
    }
    let hostedSource: string | undefined;
    for (let attempt = 0; attempt < 5; attempt++) {
      const key = await deps.key(skipped);
      if (!key) {
        deps.log('renderful_pool_empty');
        return original;
      }
      let stage = 'input';
      let submitting = false;
      let taskId: string | undefined;
      try {
        // Host our own bytes once. Never give Renderful a Telegram-token URL.
        hostedSource ??= await deps.publish(source);
        stage = 'submit';
        submitting = true;
        const task = await deps.submit(key, hostedSource);
        taskId = task.id;
        if (!taskId) throw Error('RENDERFUL_UPSCALE_AMBIGUOUS_SUBMIT');
        submitting = false;
        stage = 'poll';
        const outputUrl = await deps.poll(key, taskId, task.pollUrl);
        stage = 'output';
        const output = await deps.download(outputUrl);
        const normalized = await deps.normalize(source, output);
        const url = await deps.publish(normalized);
        deps.log('renderful_upscale_completed');
        return { url, upscaled: true };
      } catch (error) {
        const rejected = ['submit', 'poll'].includes(stage) && keyRejected(error);
        if (rejected) await deps.disable(key).catch(() => {});
        // Never replay an accepted or ambiguous paid job, even if auth is lost.
        if (taskId || acceptedTask(error) || (submitting && !rejected)) {
          deps.log(`renderful_upscale_failed_${stage}`);
          return original;
        }
        if (rejected) {
          skipped.add(key);
          continue;
        }
        deps.log(`renderful_upscale_failed_${stage}`);
        return original;
      }
    }
  } catch {
    deps.log('renderful_upscale_unavailable');
  }
  return original;
}
