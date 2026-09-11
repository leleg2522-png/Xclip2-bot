import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

assert.match(source, /kling_21_pro:\s*3500/);
assert.match(source, /Markup\.button\.callback\('🎬 Kling 2\.1 Pro \(10 detik\)', 'mode_kling21'\)/);
assert.match(source, /mode:\s*'kling21_wait_image'/);
assert.match(source, /mode:\s*'kling21_wait_prompt'/);
const runnerStart = source.indexOf('async function runKling21Pro');
const runnerEnd = source.indexOf('\n// ─── Background: Flora image generation', runnerStart);
const runner = source.slice(runnerStart, runnerEnd);
assert.match(runner, /model:\s*'kling_v21_pro'/);
assert.match(runner, /priceKey:\s*'kling_21_pro'/);
assert.equal(runner.includes('getNextFloraKey'), false);
assert.equal(runner.includes('floraGenerate'), false);

assert.equal(source.includes("Markup.button.callback('🎬 Flora"), false);
assert.equal(source.includes('`🎬 *Flora'), false);

console.log('Kling 2.1 Pro Picsart contract tests passed.');