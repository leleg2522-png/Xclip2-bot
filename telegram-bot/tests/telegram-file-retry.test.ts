import assert from 'node:assert/strict';
import { retryTelegramFileRead, redactTelegramToken } from '../src/telegram-file-retry';

async function main() {
  for (const code of ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE']) {
    let calls = 0;
    const delays: number[] = [];
    const result = await retryTelegramFileRead(async () => {
      if (++calls < 4) throw Object.assign(Error('temporary'), { code });
      return 'file-url';
    }, async ms => { delays.push(ms); });
    assert.equal(result, 'file-url');
    assert.equal(calls, 4);
    assert.deepEqual(delays, [1000, 2000, 4000]);
  }
  for (const error of [
    Object.assign(Error('reset'), { code: 'ECONNRESET' }),
    Object.assign(Error('nested reset'), { cause: { code: 'ECONNRESET' } }),
    Object.assign(Error('bad file'), { response: { error_code: 400 } }),
    Object.assign(Error('unauthorized'), { code: 401 }),
    Error('non-network error'),
  ]) {
    let calls = 0;
    await assert.rejects(retryTelegramFileRead(async () => {
      calls++; throw error;
    }, async () => {}), e => e === error);
    assert.equal(calls, /reset/.test(error.message) ? 4 : 1);
  }
  for (const prefix of ['/bot', '/file/bot']) {
    const message = `request https://api.telegram.org${prefix}123456:fake_token-ABC/getFile ECONNRESET`;
    assert.equal(redactTelegramToken(message),
      `request https://api.telegram.org${prefix}[REDACTED]/getFile ECONNRESET`);
  }
  console.log('Telegram file reads: bounded transport retries, fail-fast API errors, token redaction passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
