import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

const expectedModels = ['Lipsync 2 Pro', 'VEED Lipsync', 'Fabric 1.0', 'Sync 3'];

assert.match(source, /lipsync:\s*3000/);
assert.match(source, /menu_lipsync/);
assert.match(source, /floraListLipsyncModels/);
assert.match(source, /params:\s*\{\s*type:\s*'video'\s*\}/);
assert.match(source, /lipsync_wait_media/);
assert.match(source, /lipsync_wait_audio/);
assert.match(source, /bot\.on\('audio'/);
assert.match(source, /bot\.on\('voice'/);
assert.match(source, /audio_url/);
assert.match(source, /image_url:\s*mediaUrl/);
assert.match(source, /video_url:\s*mediaUrl/);
assert.match(source, /runFloraLipsync/);
assert.match(source, /if \(acceptedRunId\)/);

for (const model of expectedModels) {
  assert.ok(source.includes(`name: '${model}'`), `missing lipsync model: ${model}`);
}

console.log(`Lipsync catalog tests passed (${expectedModels.length} models at Rp3.000).`);