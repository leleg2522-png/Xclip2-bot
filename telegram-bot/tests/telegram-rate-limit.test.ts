import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { retryTelegramRateLimit, isTelegramRateLimitError, telegramRetryAfterSeconds } from '../src/telegram-rate-limit';
import { retryTelegramFileRead } from '../src/telegram-file-retry';

function limited(seconds: unknown = 8) {
  return Object.assign(Error('Too Many Requests'), {
    response: { error_code: 429, parameters: { retry_after: seconds } },
  });
}

async function main() {
  for (const retry of [retryTelegramFileRead, retryTelegramRateLimit]) {
    let calls = 0;
    const delays: number[] = [];
    assert.equal(await retry(async () => {
      if (++calls === 1) throw limited();
      return 'ok';
    }, async ms => { delays.push(ms); }), 'ok');
    assert.deepEqual(delays, [8000]);
    assert.equal(calls, 2);
    calls = 0; delays.length = 0;
    await assert.rejects(retry(async () => { calls++; throw limited(); },
      async ms => { delays.push(ms); }));
    assert.equal(calls, 4);
    assert.deepEqual(delays, [8000, 8000, 8000], 'Retries are bounded and honor Telegram');
  }
  for (const error of [
    limited(61), limited('8'), limited(-1), limited(NaN),
    Object.assign(Error('timeout'), { code: 'ETIMEDOUT' }),
    Object.assign(Error('bad file'), { response: { error_code: 400 } }),
  ]) {
    let calls = 0;
    await assert.rejects(retryTelegramRateLimit(async () => { calls++; throw error; },
      async () => { assert.fail('Should not wait'); }), e => e === error);
    assert.equal(calls, 1, 'Never retry ambiguous sends or permanent errors');
  }

  // Exercise the actual global handler, not a duplicate implementation.
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  const start = source.indexOf('bot.catch(async (err, ctx) => {');
  assert.ok(start >= 0);
  const end = source.indexOf('// Last-resort guards', start);
  let handler: any, replies = 0, warnings = 0;
  vm.runInNewContext(ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, {
    bot: { catch(fn: any) { handler = fn; } },
    isTransientNetworkError: () => false, isTelegramRateLimitError, telegramRetryAfterSeconds,
    console: { warn() { warnings++; }, error() {} },
  });
  await handler(limited(), { updateType: 'message', reply: async () => { replies++; } });
  assert.equal(replies, 0, 'Do not send another error message during a rate limit');
  assert.equal(warnings, 1);
  await handler(Error('other'), { reply: async () => { replies++; throw limited(); } });
  assert.equal(replies, 1, 'Fallback rejection must be awaited and contained');
  console.log('PASS Telegram 429: retry_after, bounded reads/sends, no network-send retry, no error-reply loop.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
