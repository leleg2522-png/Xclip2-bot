import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

const expectedModels = [
  'Flux 2 Klein 4B',
  'Flux 2 Klein 9B',
  'Flux 2 Turbo',
  'GPT Image',
  'GPT Image 1.5',
  'GPT Image 2',
  'Grok Imagine',
  'Grok Imagine Quality',
  'Ideogram 3.0',
  'Ideogram 4.0',
  'Imagen 3',
  'Imagen 4',
  'Kling O1',
  'Krea 2 Large',
  'Krea 2 References Large',
  'Krea 2 References Medium',
  'Nano Banana',
  'Nano Banana 2',
  'Nano Banana 2 Lite',
  'Nano Banana Pro',
  'Qwen Image 2.0',
  'Recraft V4',
  'Recraft V4 Pro',
  'Recraft V4.1',
  'Recraft V4.1 Pro',
  'Recraft V4.1 Utility',
  'Reve 2.1',
  'Riverflow 2.0 Fast',
  'Riverflow 2.0 Pro',
  'Riverflow 2.5 Pro',
  'Seedream 3.0',
  'Seedream 4.0',
  'Seedream 4.5',
  'Seedream 5.0 Lite',
  'Stable Diffusion 3.5',
  'Uni-1',
  'Uni-1 Max',
  'Wan 2.2',
  'Z-Image Turbo',
];

assert.match(source, /flora_image:\s*500/);
assert.match(source, /menu_flora_image/);
assert.match(source, /floraimg_wait_prompt/);
assert.match(source, /GET.*\/models|floraHttp\.get\(`\$\{FLORA_BASE\}\/models`/);
assert.match(source, /params:\s*\{\s*type:\s*'image'\s*\}/);
assert.match(source, /floraGenerate\(apiKey,\s*ws,\s*modelId,\s*\{\},\s*prompt,\s*'image'\)/);
assert.match(source, /const PRICE = MODEL_PRICES\.flora_image/);
assert.match(source, /if \(acceptedRunId\)/);

for (const model of expectedModels) {
  assert.ok(source.includes(`name: '${model}'`), `missing Flora image model: ${model}`);
}

console.log(`Flora image generation catalog tests passed (${expectedModels.length} models).`);