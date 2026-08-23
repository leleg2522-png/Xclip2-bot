import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const provider = readFileSync(new URL('../src/freebeat.ts', import.meta.url), 'utf8');
const bot = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

assert.match(provider, /FREEBEAT_MINIMAX_H3/);
assert.match(provider, /modelId: 'hailuo-3'/);
assert.match(provider, /duration: 15/);
assert.match(provider, /resolution: '768p'/);
assert.match(provider, /aspectRatio: '16:9'/);
assert.match(provider, /generationType: 0/);
assert.match(provider, /\/v1\/mcp\/agent\/genUploadSignUrl/);
assert.match(provider, /\/v1\/ai\/cli\/createVideoBatch/);
assert.match(provider, /\/v1\/ai\/cli\/queryBatch/);
assert.match(provider, /Authorization: key/);
assert.match(provider, /accepted/);
assert.match(provider, /videoUrl/);

assert.match(bot, /mode_freebeat_h3/);
assert.match(bot, /freebeat_wait_image/);
assert.match(bot, /freebeat_wait_prompt/);
assert.match(bot, /runFreebeatMinimaxH3/);
assert.match(bot, /freebeat_minimax_h3: 6000/);
assert.match(bot, /MiniMax H3 I2V \(Freebeat\)/);
assert.match(bot, /FREEBEAT_NO_API_KEY/);
assert.match(bot, /Saldo .*dikembalikan/);

console.log('Freebeat MiniMax H3 I2V contract tests passed.');