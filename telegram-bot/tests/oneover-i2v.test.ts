import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isOneOverAuthFailure, resolveOneOverAccountId } from '../src/oneover';

const provider = readFileSync(new URL('../src/oneover.ts', import.meta.url), 'utf8');
const bot = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

assert.match(provider, /model: 'seedance-2\.5'/);
assert.match(provider, /duration: 30/);
assert.match(provider, /resolution: '480p'/);
assert.match(provider, /aspectRatio: 'wide'/);
assert.match(provider, /generateAudio: true/);
assert.match(provider, /video-generate/);
assert.match(provider, /ONEOVER_SUBMIT_TIMEOUT_MS/);
assert.match(provider, /ONEOVER_SUBMIT_TIMEOUT/);
assert.match(provider, /browserContextHeaders/);
assert.match(provider, /origin: 'https:\/\/oneover\.com'/);
assert.match(provider, /referer: 'https:\/\/oneover\.com\/'/);
assert.match(provider, /reference_image: input\.referenceImage/);
assert.match(provider, /video-poll/);
assert.match(provider, /prediction_url: submission\.predictionUrl/);
assert.match(provider, /maxAttempts = 300/);
assert.match(provider, /ONEOVER_API_KEY/);
assert.match(provider, /ONEOVER_AUTHORIZATION/);
assert.match(provider, /ONEOVER_COOKIE/);
assert.match(provider, /ONEOVER_NO_SESSION/);
assert.match(provider, /credentials: OneOverCredentials/);
assert.match(provider, /isOneOverAuthFailure/);
assert.equal(isOneOverAuthFailure(new Error('ONEOVER_SUBMIT_FAILED 401: expired')), true);
assert.equal(isOneOverAuthFailure(new Error('ONEOVER_POLL_FAILED 403: forbidden')), true);
assert.equal(isOneOverAuthFailure(new Error('ONEOVER_TIMEOUT')), false);
assert.equal(
  resolveOneOverAccountId({
    apiKey: 'test',
    authorization: 'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJhY2NvdW50LTQyIn0.signature',
  }),
  'account-42'
);
assert.equal(resolveOneOverAccountId({ apiKey: 'test', authorization: 'opaque-token' }), null);

assert.match(bot, /oneover_seedance_25: 6000/);
assert.match(bot, /Seedance 2\.5 I2V 🔥PROMO/);
assert.match(bot, /mode_oneover_seedance25/);
assert.match(bot, /oneover_wait_image/);
assert.match(bot, /oneover_wait_prompt/);
assert.match(bot, /runOneOverSeedance25/);
assert.match(bot, /beginCharge\(dbUserId, PRICE, MAX_PARALLEL_GENERATIONS_PER_USER\)/);
assert.match(bot, /submitOneOverSeedanceI2v/);
assert.match(bot, /server masih menyiapkan permintaan/);
assert.match(bot, /pollOneOverSeedanceI2v/);
assert.match(bot, /Saldo .*dikembalikan/);
assert.match(bot, /const activeDraft = getSession\(userId\);/);
assert.match(bot, /if \(activeDraft\.mode !== 'oneover_wait_prompt'\) return;/);
assert.match(bot, /const dbUserId = activeDraft\.dbUserId;/);
assert.match(bot, /setSession\(userId, \{ mode: 'idle', oneoverImageUrl: undefined \}\);\s+const statusMsg = await ctx\.reply/s);
assert.match(bot, /CREATE TABLE IF NOT EXISTS oneover_session_pool/);
assert.match(bot, /provider_user_id\s+TEXT UNIQUE NOT NULL/);
assert.match(bot, /ON CONFLICT \(provider_user_id\) DO UPDATE/);
assert.match(bot, /FOR UPDATE SKIP LOCKED/);
assert.match(bot, /FOR UPDATE SKIP LOCKED/);
assert.match(bot, /claim_token = \$1/);
assert.match(bot, /lease_expires_at = NOW\(\) \+ INTERVAL/);
assert.match(bot, /renewOneOverSessionLease/);
assert.match(bot, /await markOneOverSessionDead\(poolSession\)/);
assert.match(bot, /while \(!submission\)/);
assert.match(bot, /if \(providerAccepted && oneover\.isOneOverAuthFailure\(err\)\)/);
assert.match(bot, /pollOneOverSeedanceI2v\(submission, prompt, pollingSession\.credentials/);
assert.match(bot, /bot\.command\('oneoverpool'/);

console.log('OneOver Seedance 2.5 I2V contract tests passed.');