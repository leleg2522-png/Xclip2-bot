import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

assert.match(source, /kling_21_pro:\s*3000/);
assert.match(source, /Markup\.button\.callback\('🎬 Kling 2\.1 Pro \(10 detik\)', 'mode_kling21'\)/);
assert.match(source, /mode:\s*'kling21_wait_image'/);
assert.match(source, /mode:\s*'kling21_wait_prompt'/);
assert.match(source, /'f2v-kling-2\.1-pro'/);
assert.match(source, /\{\s*image_url:\s*assetUrl,\s*duration:\s*'10'\s*\}/);
assert.match(source, /floraUploadImage\([\s\S]*?image\.mime/);

const runner = source.slice(source.indexOf('async function runKling21Pro'));
const acceptedRunIndex = runner.indexOf('acceptedRunId = await floraGenerate');
const preventReplayIndex = runner.indexOf('if (acceptedRunId)');
const preSubmitFailoverIndex = runner.indexOf('if (isFloraKeyExhaustedError(desc))', preventReplayIndex);
assert.ok(acceptedRunIndex >= 0, 'Kling 2.1 Pro must submit a Flora run');
assert.ok(preventReplayIndex > acceptedRunIndex, 'A submitted run must be handled before any retry');
assert.ok(preSubmitFailoverIndex > preventReplayIndex, 'Only pre-submit failures may fail over to another key');

assert.equal(source.includes("Markup.button.callback('🎬 Flora"), false);
assert.equal(source.includes('`🎬 *Flora'), false);

console.log('Kling 2.1 Pro Flora contract tests passed.');