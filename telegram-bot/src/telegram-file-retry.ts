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
      if (attempt >= 3 || !transient.has(code)) throw error;
      await wait(1000 * 2 ** attempt);
    }
  }
}

export function redactTelegramToken(text: string): string {
  return text.replace(/(\/(?:file\/)?bot)\d+:[A-Za-z0-9_-]+/gi, '$1[REDACTED]');
}
