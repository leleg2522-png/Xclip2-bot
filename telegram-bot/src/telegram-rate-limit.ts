// Only explicit Telegram rejections are safe to retry for message sends.
// A network timeout may have delivered the message already: never retry it here.
export function isTelegramRateLimitError(error: unknown): boolean {
  return (error as any)?.response?.error_code === 429;
}

export function telegramRetryAfterSeconds(error: unknown): number | undefined {
  if (!isTelegramRateLimitError(error)) return undefined;
  const seconds = (error as any)?.response?.parameters?.retry_after;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0
    ? seconds : undefined;
}

export async function retryTelegramRateLimit<T>(
  request: () => Promise<T>,
  wait: (ms: number) => Promise<void> = ms => new Promise(resolve => setTimeout(resolve, ms)),
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await request();
    } catch (error) {
      const seconds = telegramRetryAfterSeconds(error);
      // Do not sleep indefinitely or retry earlier than Telegram allows.
      if (attempt >= 3 || seconds === undefined || seconds > 60) throw error;
      await wait(Math.max(250, seconds * 1000));
    }
  }
}
