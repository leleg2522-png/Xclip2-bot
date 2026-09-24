import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

assert.match(source, /kling_p2:\s*4000/);
assert.match(source, /kling_p3:\s*4000/);
assert.match(source, /mode_klingp2/);
assert.match(source, /Kling MC V3 PRO P2/);
const modelMatches = source.match(/model:\s*'kling-motion-26-pro'/g) ?? [];
assert.equal(modelMatches.length, 2, 'P2 and P3 must both use the latest HAR-verified model');
assert.doesNotMatch(source, /kling-motion-26-pro--secondary/);
assert.match(source, /const edanbotHttp = axios\.create\(\{ timeout: 120_000, proxy: false \}\)/);
assert.match(source, /origin: 'https:\/\/edanbot\.digital'/);
assert.match(source, /referer: 'https:\/\/edanbot\.digital\/dashboard'/);
assert.match(source, /const PRICE = variant\.price/);
assert.match(source, /let submitted = false/);
assert.match(source, /if \(submitted\)/);
assert.match(source, /const EDANBOT_JOB_TIMEOUT_MS = 20 \* 60 \* 1000/);
assert.match(source, /pollEdanbotJob\(cookie, jobId, EDANBOT_JOB_TIMEOUT_MS\)/);
assert.match(source, /klingP2VideoFileId:[\s\S]*mode: 'klingp2_wait_prompt'/);
assert.match(source, /klingP3VideoFileId:[\s\S]*mode: 'klingp3_wait_prompt'/);
assert.match(source, /Kirim \*prompt teks\* \(deskripsi gerakan\/adegan\)/);
assert.match(source, /runKlingP2\(ctx\.chat\.id, userId, session\.dbUserId!, statusMsg\.message_id, characterUrlP2, videoFileIdP2, videoDurationP2, prompt\)/);
assert.match(source, /runKlingP3\(ctx\.chat\.id, userId, session\.dbUserId!, statusMsg\.message_id, characterUrlP3, videoFileIdP3, videoDurationP3, prompt\)/);
assert.match(source, /const prompt = raw === '-' \? '' : raw/g);
assert.match(source, /fields: \{\s*prompt,\s*image_url:/);

console.log('Kling MC V3 PRO P2 contract tests passed.');