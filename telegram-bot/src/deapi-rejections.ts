import { explicitDeapiRateRejection } from './deapi-rate-limit';

/** A suspension is a pre-validation refusal, not an accepted paid job. */
export class DeapiAccountSuspendedError extends Error {
  constructor(readonly phase: 'QUOTE' | 'SUBMIT', readonly retryAt = Date.now() + 15 * 60_000) {
    super(`DEAPI_${phase}_HTTP_403_ACCOUNT_SUSPENDED`);
  }
}

export function explicitDeapiSuspension(body: unknown): boolean {
  if (!explicitDeapiRateRejection(body)) return false; // Recursively rejects any accepted job ID/status.
  const root = body as Record<string, unknown>;
  return root.code === 'account_suspended' || root.code === 'client_suspended'
    || (typeof root.message === 'string' && /^(?:client\s+)?account is suspended(?:[.!]|$)/i.test(root.message.trim()));
}
