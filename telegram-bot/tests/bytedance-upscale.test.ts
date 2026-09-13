import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, '../src/index.ts'), 'utf8');

assert.match(source, /bytedance_upscale:\s*500/);
assert.match(source, /mode_bytedance_upscale/);
assert.match(source, /bytedance_upscale_wait_video/);
assert.match(source, /ByteDance Upscaler 1K/);
assert.match(source, /model:\s*'bytedance-video-upscaler'/);
assert.match(source, /type:\s*'video-to-video'/);
assert.match(source, /resolution:\s*'1080p'/);
assert.doesNotMatch(source, /`\$\{RENDERFUL_BASE\}\/uploads`/);
assert.match(source, /`\$\{RENDERFUL_BASE\}\/generations`/);
assert.match(source, /const bytedanceUpscalerHttp = axios\.create\(\{[\s\S]*?proxy:\s*false/);
assert.match(source, /bytedanceUpscalerHttp\.post\(\s*`\$\{RENDERFUL_BASE\}\/generations`/);
assert.match(source, /bytedanceUpscalerHttp\.get\(pollUrl/);
assert.match(source, /const videoUrl = await publishMedia\(videoBuf, true\)/);
assert.match(source, /CREATE TABLE IF NOT EXISTS renderful_key_pool/);
assert.match(source, /getNextRenderfulPoolKey/);
assert.match(source, /markRenderfulPoolKeyDead/);
assert.match(source, /if \(!submitted && isKeyExhaustedError\(desc\)\)/);
assert.match(source, /if \(refund\)[\s\S]*addSaldo\(dbUserId, PRICE\)/);
assert.doesNotMatch(source, /Layanan ByteDance Upscaler sedang tidak tersedia\. Pool API key kosong/);
assert.match(source, /ByteDance Upscaler sedang tidak tersedia\. Coba lagi nanti/);
assert.match(source, /customerSafeModelLabel[\s\S]*Renderful/);

console.log('ByteDance Upscaler 1K Renderful pool contract checks passed.');