/** Only explicit, unaccepted HTTP 429 responses permit a fresh submit. */
export class DeapiRateLimitError extends Error {
  constructor(readonly phase: 'QUOTE' | 'SUBMIT', readonly retryAt: number) {
    super(`DEAPI_${phase}_HTTP_429`);
  }
}

export function deapiRetryAt(headers: Headers, now = Date.now()): number {
  const retry = headers.get('retry-after');
  const seconds = retry ? Number(retry) : NaN;
  const date = retry ? Date.parse(retry) : NaN;
  const candidates = [
    Number.isFinite(seconds) ? now + Math.max(0, seconds) * 1000 : date,
    Number(headers.get('x-ratelimit-reset')) * 1000,
    // A daily reset can be present even when the daily quota is NOT exhausted.
    headers.get('x-ratelimit-daily-remaining') !== null && Number(headers.get('x-ratelimit-daily-remaining')) > 0
      ? NaN : Number(headers.get('x-ratelimit-daily-reset')) * 1000,
  ].filter(value => Number.isFinite(value) && value > now);
  // The next request can retry the key after the provider's indicated window.
  return candidates.length ? Math.max(...candidates) : now + 60_000;
}

export function explicitDeapiRateRejection(body: unknown): boolean {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  const root = body as Record<string, unknown>;
  if (typeof root.message !== 'string' && !root.error) return false;
  function accepted(value: unknown): boolean {
    if (!value || typeof value !== 'object') return false;
    return Object.entries(value).some(([key, child]) =>
      (['id', 'request_id', 'task_id', 'job_id'].includes(key) && child != null && child !== '')
      || (key === 'status' && ['pending', 'queued', 'processing', 'running', 'done', 'completed'].includes(String(child)))
      || accepted(child));
  }
  return !accepted(body);
}
