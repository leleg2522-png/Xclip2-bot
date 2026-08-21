import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PICSART_I2V_MODELS,
  buildPicsartI2vParams,
  extractPicsartVideoUrl,
  isPicsartPostSubmitAuthFailure,
} from '../src/picsart';

const imageUrl = 'https://cdn.example.test/reference.jpg';
const prompt = 'A subject moves gracefully through the scene';

const expectedModels = [
  'seedance_2_mini',
  'seedance_2_fast',
  'seedance_2',
  'grok_imagine',
  'kling_v3_turbo',
  'kling_v26_pro',
  'kling_v3',
  'wan_v2',
] as const;

assert.deepEqual(Object.keys(PICSART_I2V_MODELS).sort(), [...expectedModels].sort());
assert.equal('pika' in PICSART_I2V_MODELS, false);

const botSource = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
assert.equal(botSource.includes('menu_picsart_i2v'), false);
assert.equal(botSource.includes('Picsart I2V (8 Model)'), false);
assert.equal(botSource.includes("Markup.button.callback('🧩 Picsart"), false);
assert.equal(botSource.includes('`🧩 *Picsart'), false);
for (const model of expectedModels) {
  assert.equal(botSource.includes(`mode_pi2v_${model}`), true);
}

const seedanceMini = buildPicsartI2vParams('seedance_2_mini', prompt, imageUrl);
assert.deepEqual(seedanceMini, {
  model: 'seedance_2_0_mini',
  content: [
    { type: 'image_url', image_url: { url: imageUrl }, role: 'reference_image' },
    { type: 'text', text: prompt },
  ],
  ratio: '9:16',
  duration: 15,
  resolution: '720p',
  generate_audio: true,
  options: {},
});

const seedanceFast = buildPicsartI2vParams('seedance_2_fast', prompt, imageUrl);
assert.deepEqual(seedanceFast, {
  model: 'seedance_2_0_fast',
  content: [
    { type: 'image_url', image_url: { url: imageUrl }, role: 'reference_image' },
    { type: 'text', text: prompt },
  ],
  ratio: '9:16',
  duration: 15,
  resolution: '480p',
  generate_audio: true,
  options: {},
});

const seedance = buildPicsartI2vParams('seedance_2', prompt, imageUrl);
assert.deepEqual(seedance, {
  model: 'seedance_2_0',
  content: [
    { type: 'image_url', image_url: { url: imageUrl }, role: 'reference_image' },
    { type: 'text', text: prompt },
  ],
  ratio: '9:16',
  duration: 15,
  resolution: '480p',
  generate_audio: true,
  options: {},
});

const grok = buildPicsartI2vParams('grok_imagine', prompt, imageUrl);
assert.deepEqual(grok, {
  model: 'grok-imagine-video',
  prompt,
  image: imageUrl,
  duration: 15,
  aspect_ratio: '9:16',
  options: {},
});

const klingTurbo = buildPicsartI2vParams('kling_v3_turbo', prompt, imageUrl);
assert.deepEqual(klingTurbo, {
  prompt,
  aspect_ratio: '9:16',
  duration: '12',
  model_name: 'kling-v3-turbo',
  resolution: '720p',
  image: imageUrl,
  options: {},
});

const klingPro = buildPicsartI2vParams('kling_v26_pro', prompt, imageUrl);
assert.deepEqual(klingPro, {
  prompt,
  aspect_ratio: '9:16',
  duration: '10',
  model_name: 'kling-v2-6',
  image: imageUrl,
  sound: 'on',
  mode: 'pro',
  cfg_scale: 0.5,
  options: {},
});

const klingV3 = buildPicsartI2vParams('kling_v3', prompt, imageUrl);
assert.deepEqual(klingV3, {
  prompt,
  aspect_ratio: '9:16',
  duration: '12',
  model_name: 'kling-v3',
  image: imageUrl,
  sound: 'on',
  mode: 'std',
  multi_shot: false,
  shot_type: 'customize',
  options: {},
});

const wan = buildPicsartI2vParams('wan_v2', prompt, imageUrl);
assert.deepEqual(wan, {
  media: [{ type: 'first_frame', url: imageUrl }],
  resolution: '720P',
  duration: 15,
  prompt_extend: true,
  prompt,
  options: {},
});

assert.equal(
  extractPicsartVideoUrl({ status: 'COMPLETED', result: { video_url: 'https://video.example.test/a.mp4' } }),
  'https://video.example.test/a.mp4'
);
assert.equal(
  extractPicsartVideoUrl({ status: 'COMPLETED', result: { videoUrl: 'https://video.example.test/b.mp4' } }),
  'https://video.example.test/b.mp4'
);
assert.equal(
  extractPicsartVideoUrl({ status: 'COMPLETED', result: { urls: ['https://video.example.test/c.mp4'] } }),
  'https://video.example.test/c.mp4'
);
assert.equal(extractPicsartVideoUrl({ status: 'COMPLETED', result: {} }), null);

assert.equal(isPicsartPostSubmitAuthFailure(new Error('PICSART_AUTH_DEAD status 401')), true);
assert.equal(isPicsartPostSubmitAuthFailure(new Error('PICSART_REFRESH_DEAD status 403')), true);
assert.equal(isPicsartPostSubmitAuthFailure(new Error('PICSART_SUBMIT_FAILED status 422')), false);

console.log('Picsart I2V HAR contract tests passed.');