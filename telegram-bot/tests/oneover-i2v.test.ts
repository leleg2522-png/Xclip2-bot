import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const provider = readFileSync(new URL('../src/oneover.ts', import.meta.url), 'utf8');
const bot = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

assert.match(provider, /model: 'seedance-2\.5'/);
assert.match(provider, /duration: 30/);
assert.match(provider, /resolution: '480p'/);
assert.match(provider, /aspectRatio: 'wide'/);
assert.match(provider, /generateAudio: true/);
assert.match(provider, /video-generate/);
assert.match(provider, /reference_image: input\.referenceImage/);
assert.match(provider, /video-poll/);
assert.match(provider, /prediction_url: submission\.predictionUrl/);
assert.match(provider, /maxAttempts = 300/);
assert.match(provider, /ONEOVER_API_KEY/);
assert.match(provider, /ONEOVER_AUTHORIZATION/);
assert.match(provider, /ONEOVER_COOKIE/);
assert.match(provider, /ONEOVER_NO_SESSION/);

assert.match(bot, /oneover_seedance_25: 6000/);
assert.match(bot, /Seedance 2\.5 I2V 🔥PROMO/);
assert.match(bot, /mode_oneover_seedance25/);
assert.match(bot, /oneover_wait_image/);
assert.match(bot, /oneover_wait_prompt/);
assert.match(bot, /runOneOverSeedance25/);
assert.match(bot, /beginCharge\(dbUserId, PRICE, MAX_PARALLEL_GENERATIONS_PER_USER\)/);
assert.match(bot, /submitOneOverSeedanceI2v/);
assert.match(bot, /pollOneOverSeedanceI2v/);
assert.match(bot, /Saldo .*dikembalikan/);
assert.match(bot, /const activeDraft = getSession\(userId\);/);
assert.match(bot, /if \(activeDraft\.mode !== 'oneover_wait_prompt'\) return;/);
assert.match(bot, /const dbUserId = activeDraft\.dbUserId;/);
assert.match(bot, /setSession\(userId, \{ mode: 'idle', oneoverImageUrl: undefined \}\);\s+const statusMsg = await ctx\.reply/s);

console.log('OneOver Seedance 2.5 I2V contract tests passed.');