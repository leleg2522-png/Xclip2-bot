// Return only allowlisted codes and numeric statuses. Provider messages and
// Axios configs can contain cookies, signed URLs, prompts and Telegram tokens.
export function seedance25P2Diagnostic(error: unknown) {
  const known = new Set([
    'SEEDANCE25_P2_INVALID_RATIO', 'SEEDANCE25_P2_INVALID_INPUT',
    'SEEDANCE25_P2_INVALID_ASSET', 'SEEDANCE25_P2_UNKNOWN_SUBMIT',
    'SEEDANCE25_P2_ACCEPTED_JOB_FAILED', 'SEEDANCE25_P2_NO_RESULT',
    'SEEDANCE25_P2_NO_SESSION', 'SEEDANCE25_P2_REFERENCE_CHANGED',
    'SEEDANCE25_P2_DELIVERY_FAILED', 'INVALID_IMAGE',
    'EDANBOT_JOB_FAILED', 'EDANBOT_JOB_TIMEOUT',
  ]);
  const transport = new Set([
    'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EPIPE', 'EAI_AGAIN',
    'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET',
  ]);
  const result: {
    errorCode: string; causeCode?: string; httpStatus?: number;
    telegramCode?: number; retryAfter?: number; transportCode?: string;
  } = { errorCode: 'UNCLASSIFIED' };
  const seen = new Set<unknown>();
  let current: any = error;
  for (let depth = 0; current && depth < 4 && !seen.has(current); depth++) {
    seen.add(current);
    const prefix = typeof current.message === 'string'
      ? current.message.match(/^([A-Z][A-Z0-9_]+)(?=:|$)/)?.[1] : undefined;
    if (prefix && known.has(prefix)) {
      if (depth === 0) result.errorCode = prefix;
      else result.causeCode = prefix;
    }
    const status = current.response?.status;
    if (Number.isInteger(status) && status >= 400 && status <= 599) result.httpStatus = status;
    const telegramCode = current.response?.error_code;
    if (Number.isInteger(telegramCode) && telegramCode >= 400 && telegramCode <= 599) {
      result.telegramCode = telegramCode;
      const seconds = current.response?.parameters?.retry_after;
      if (telegramCode === 429 && typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0) {
        result.retryAfter = seconds;
      }
    }
    if (transport.has(current.code)) result.transportCode = current.code;
    current = current.cause;
  }
  return result;
}
