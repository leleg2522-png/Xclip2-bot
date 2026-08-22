import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

assert.match(source, /kling_p2:\s*3500/);
assert.match(source, /kling_p3:\s*2500/);
assert.match(source, /mode_klingp2/);
assert.match(source, /Kling MC V3 PRO P2/);
assert.match(source, /model:\s*'kling-motion-26-pro--secondary'/);
assert.match(source, /model:\s*'kling-motion-26-pro'/);
assert.match(source, /const PRICE = variant\.price/);
assert.match(source, /let submitted = false/);
assert.match(source, /if \(submitted\)/);
assert.match(source, /const EDANBOT_JOB_TIMEOUT_MS = 20 \* 60 \* 1000/);
assert.match(source, /pollEdanbotJob\(cookie, jobId, EDANBOT_JOB_TIMEOUT_MS\)/);

console.log('Kling MC V3 PRO P2 contract tests passed.');