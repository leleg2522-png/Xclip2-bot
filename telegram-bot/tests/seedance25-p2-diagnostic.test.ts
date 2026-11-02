import assert from 'node:assert/strict';
import { seedance25P2Diagnostic as diagnostic } from '../src/seedance25-p2-diagnostic';

assert.deepEqual(diagnostic(Error('SEEDANCE25_P2_ACCEPTED_JOB_FAILED', {
  cause: Object.assign(Error('sensitive fixture_cookie fixture_token'), {
    response: { status: 401, data: { message: 'fixture_private_prompt' } },
    config: { headers: { cookie: 'fixture_cookie' } },
  }),
})), { errorCode: 'SEEDANCE25_P2_ACCEPTED_JOB_FAILED', httpStatus: 401 });
assert.deepEqual(diagnostic(Error('SEEDANCE25_P2_ACCEPTED_JOB_FAILED', {
  cause: Error('EDANBOT_JOB_FAILED: private provider error fixture_secret'),
})), { errorCode: 'SEEDANCE25_P2_ACCEPTED_JOB_FAILED', causeCode: 'EDANBOT_JOB_FAILED' });
assert.deepEqual(diagnostic({
  response: { error_code: 429, parameters: { retry_after: 8 } },
}), { errorCode: 'UNCLASSIFIED', telegramCode: 429, retryAfter: 8 });
assert.deepEqual(diagnostic(Error('outer', {
  cause: Object.assign(Error('https://api.telegram.org/file/bot123:fixture_secret/file'), { code: 'ECONNRESET' }),
})), { errorCode: 'UNCLASSIFIED', transportCode: 'ECONNRESET' });
for (const error of [null, undefined, 'private text', {
  message: 'SEEDANCE25_P2_fixture_secret', code: 'fixture_secret',
  response: { status: 'fixture_secret', error_code: 'fixture_secret' },
}]) assert.deepEqual(diagnostic(error), { errorCode: 'UNCLASSIFIED' });
const cyclic: any = Error('SEEDANCE25_P2_DELIVERY_FAILED');
cyclic.cause = cyclic;
assert.deepEqual(diagnostic(cyclic), { errorCode: 'SEEDANCE25_P2_DELIVERY_FAILED' });
console.log('PASS P2 safe diagnostics: nested provider/HTTP/Telegram/network errors, no raw secrets, cycle bound.');
