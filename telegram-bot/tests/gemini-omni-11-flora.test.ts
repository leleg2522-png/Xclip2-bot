import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve(__dirname, '../src/index.ts'), 'utf8');

assert.match(source, /gemini_omni_11_flora:\s*3000/);
assert.match(source, /Gemini Omni Flash 1\.1 • 10 detik • 1080p/);
assert.match(source, /mode_gomni11_flora/);
assert.match(source, /gomni11_flora_wait_ratio/);
assert.match(source, /gomni11_flora_wait_image/);
assert.match(source, /gomni11_flora_wait_prompt/);

const start = source.indexOf('async function runGeminiOmni11Flora');
const end = source.indexOf('\n// ─── Background:', start + 1);
assert.ok(start > 0 && end > start, 'Gemini Omni Flash 1.1 Flora runner block missing');
const runner = source.slice(start, end);

assert.match(runner, /const PRICE = MODEL_PRICES\.gemini_omni_11_flora/);
assert.match(runner, /'i2v-gengateway-omni-1-1-flash-gg'/);
assert.match(runner, /image_urls:\s*\[uploadedImageUrl\]/);
assert.match(runner, /aspect_ratio:\s*ratio/);
assert.match(runner, /resolution:\s*'1080p'/);
assert.match(runner, /duration:\s*'10'/);
assert.match(runner, /beginCharge\(dbUserId,\s*PRICE,\s*3\)/);
assert.match(runner, /if\s*\(acceptedRunId\)/);
assert.match(runner, /if\s*\(refund\)/);
assert.doesNotMatch(runner, /Flora AI/);

console.log('Gemini Omni Flash 1.1 Flora backend contract tests passed.');