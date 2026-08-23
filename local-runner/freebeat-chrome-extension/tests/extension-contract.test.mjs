import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (file) => readFileSync(new URL(file, root), 'utf8');
const manifest = JSON.parse(read('manifest.json'));
const worker = read('background.js');
const popup = read('popup.html');

assert.equal(manifest.manifest_version, 3);
assert.ok(manifest.permissions.includes('alarms'));
assert.ok(manifest.permissions.includes('webRequest'));
assert.ok(manifest.permissions.includes('scripting'));
assert.ok(manifest.host_permissions.includes('https://freebeat.ai/*'));
assert.ok(manifest.host_permissions.includes('https://freebeat-static.s3.us-east-2.amazonaws.com/*'));
assert.ok(manifest.optional_host_permissions.includes('https://*/*'));

assert.match(worker, /\/bridge\/jobs\/claim/);
assert.match(worker, /\/bridge\/jobs\/\$\{job\.id\}\/accepted/);
assert.match(worker, /\/bridge\/jobs\/\$\{active\.id\}\/complete/);
assert.match(worker, /state === 'submitting'/);
assert.match(worker, /never resubmits/);
assert.match(worker, /findGeneration/);
assert.match(worker, /periodInMinutes: 0\.5/);
assert.match(worker, /onBeforeSendHeaders/);
assert.match(worker, /world: 'ISOLATED'/);
assert.match(worker, /session\.tabId/);
assert.doesNotMatch(worker, /playwright/i);
assert.match(popup, /Kode dari \/bridgecode/);

console.log('Freebeat Chrome extension contract tests passed.');