import { telegramRetryAfterSeconds } from './telegram-rate-limit';

// Only wrap idempotent Telegram file reads, never generation or delivery.
export async function retryTelegramFileRead<T>(
  read: () => Promise<T>,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<T> {
  const transient = new Set([
    'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED', 'EPIPE', 'EAI_AGAIN',
    'ECONNREFUSED', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET',
  ]);
  for (let attempt = 0; ; attempt++) {
    try {
      return await read();
    } catch (error) {
      const e = error as any;
      const code = e?.code ?? e?.cause?.code ?? e?.errno;
      const seconds = telegramRetryAfterSeconds(error);
      if (attempt >= 3) throw error;
      if (seconds !== undefined) {
        if (seconds > 60) throw error;
        await wait(Math.max(250, seconds * 1000));
      } else {
        if (!transient.has(code)) throw error;
        await wait(1000 * 2 ** attempt);
      }
    }
  }
}

export function redactTelegramToken(text: string): string {
  return text.replace(/(\/(?:file\/)?bot)\d+:[A-Za-z0-9_-]+/gi, '$1[REDACTED]');
}
