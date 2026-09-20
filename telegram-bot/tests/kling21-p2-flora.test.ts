import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

assert.match(source, /kling_21_p2:\s*3000/);
assert.match(source, /Markup\.button\.callback\('🎬 Kling 2\.1 P2 \(10 detik\)', 'mode_kling21p2'\)/);
assert.match(source, /mode:\s*'kling21p2_wait_image'/);
assert.match(source, /mode:\s*'kling21p2_wait_prompt'/);
assert.match(source, /Harga: \*\$\{formatRupiah\(MODEL_PRICES\.kling_21_p2\)\}\*/);

const runnerStart = source.indexOf('async function runKling21P2');
const runnerEnd = source.indexOf('\n// ─── Background: Flora image generation', runnerStart);
assert.ok(runnerStart > 0 && runnerEnd > runnerStart, 'Kling 2.1 P2 runner block missing');
const runner = source.slice(runnerStart, runnerEnd);

assert.match(runner, /'i2v-kling-2\.5'/);
assert.match(runner, /\{\s*image_url:\s*uploadedImageUrl,\s*duration:\s*'10'\s*\}/);
assert.match(runner, /const PRICE = MODEL_PRICES\.kling_21_p2/);
assert.match(runner, /beginCharge\(dbUserId, PRICE, 3\)/);
assert.match(runner, /floraUploadImage/);
assert.match(runner, /floraGenerate/);
assert.match(runner, /floraPollRun\(apiKey, acceptedRunId, 20 \* 60 \* 1000\)/);
assert.match(runner, /if \(acceptedRunId\)[\s\S]*return;/);
assert.match(runner, /if \(refund\)[\s\S]*addSaldo\(dbUserId, PRICE\)/);
assert.equal(runner.includes('Flora AI'), false, 'provider name must not appear in customer-facing runner text');

console.log('Kling 2.1 P2 Flora backend contract tests passed.');