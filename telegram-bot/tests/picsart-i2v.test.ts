import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GEMINI_OMNI_12_DURATION_SECONDS,
  GEMINI_OMNI_12_MAX_IMAGES,
  GEMINI_OMNI_12_MODEL,
  GEMINI_OMNI_12_RESOLUTION,
  GEMINI_OMNI_MODEL,
  PICSART_I2V_MAX_IMAGES,
  PICSART_I2V_MODELS,
  buildGeminiOmni12Params,
  buildPicsartI2vParams,
  extractPicsartVideoUrl,
  getPicsartI2vExportSize,
  isPicsartPostSubmitAuthFailure,
  shouldExportPicsartI2v,
} from '../src/picsart';

const imageUrl = 'https://cdn.example.test/reference.jpg';
const prompt = 'A subject moves gracefully through the scene';

assert.equal(GEMINI_OMNI_MODEL, 'gemini-omni-flash-preview', 'legacy Gemini Omni model must remain unchanged');
assert.equal(GEMINI_OMNI_12_MODEL, 'gemini-omni-1.1-flash-preview');
assert.equal(GEMINI_OMNI_12_DURATION_SECONDS, 10);
assert.equal(GEMINI_OMNI_12_RESOLUTION, '360p');
assert.equal(GEMINI_OMNI_12_MAX_IMAGES, 5);
const gemini12Images = Array.from({ length: 6 }, (_, index) => ({
  url: `https://cdn.example.test/gemini-${index + 1}.jpg`,
  mimeType: 'image/jpeg',
}));
const gemini12Video = { url: 'https://cdn.example.test/motion.mp4', mimeType: 'video/mp4' };
assert.deepEqual(buildGeminiOmni12Params({
  prompt,
  imageReferences: gemini12Images,
  videoReference: gemini12Video,
  aspectRatio: '16:9',
}), {
  prompt,
  model: 'gemini-omni-1.1-flash-preview',
  aspectRatio: '16:9',
  durationSeconds: 10,
  resolution: '360p',
  referenceImages: gemini12Images.slice(0, 5),
  referenceVideos: [gemini12Video],
});

const expectedModels = [
  'seedance_2_mini',
  'seedance_2_fast',
  'seedance_2',
  'grok_imagine',
  'kling_v3_turbo',
  'kling_v26_pro',
  'kling_v3',
  'wan_v2',
  'wan_v3',
  'pixverse_v6',
] as const;

assert.deepEqual(Object.keys(PICSART_I2V_MODELS).sort(), [...expectedModels].sort());
assert.equal('pika' in PICSART_I2V_MODELS, false);
assert.equal(PICSART_I2V_MODELS.wan_v3.pool, null);
assert.equal(PICSART_I2V_MAX_IMAGES, 5);

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
  resolution: '480p',
  generate_audio: true,
  options: {},
});
assert.equal(buildPicsartI2vParams('seedance_2_mini', prompt, imageUrl, { ratio: '16:9' }).ratio, '16:9');
const seedanceMiniMulti = buildPicsartI2vParams('seedance_2_mini', prompt, imageUrl, {
  imageUrls: ['https://cdn.example.test/mini-1.jpg', 'https://cdn.example.test/mini-2.jpg'],
});
assert.deepEqual(seedanceMiniMulti.content, [
  { type: 'image_url', image_url: { url: 'https://cdn.example.test/mini-1.jpg' }, role: 'reference_image' },
  { type: 'image_url', image_url: { url: 'https://cdn.example.test/mini-2.jpg' }, role: 'reference_image' },
  { type: 'text', text: prompt },
]);

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
assert.equal(buildPicsartI2vParams('seedance_2_fast', prompt, imageUrl, { ratio: '16:9' }).ratio, '16:9');
assert.equal(
  (buildPicsartI2vParams('seedance_2_fast', prompt, imageUrl, {
    imageUrls: Array.from({ length: 6 }, (_, index) => `https://cdn.example.test/fast-${index + 1}.jpg`),
  }).content as unknown[]).length,
  6,
);

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
assert.equal(buildPicsartI2vParams('seedance_2', prompt, imageUrl, { ratio: '16:9' }).ratio, '16:9');
assert.equal(
  (buildPicsartI2vParams('seedance_2', prompt, imageUrl, {
    imageUrls: Array.from({ length: 6 }, (_, index) => `https://cdn.example.test/standard-${index + 1}.jpg`),
  }).content as unknown[]).length,
  6,
);

const grok = buildPicsartI2vParams('grok_imagine', prompt, imageUrl);
assert.deepEqual(grok, {
  model: 'grok-imagine-video',
  prompt,
  image: { url: imageUrl },
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

const wan3Portrait = buildPicsartI2vParams('wan_v3', prompt, imageUrl, { ratio: '9:16' });
assert.deepEqual(wan3Portrait, {
  model: 'wan3.0-video-prime',
  resolution: '480P',
  duration: 30,
  ratio: '9:16',
  audio: true,
  enable_thinking: false,
  watermark: false,
  seed: 0,
  media: [{ type: 'reference_image', url: imageUrl }],
  prompt,
  options: {
    drive: {
      name: 'wan-3-0-prime-ai-playground.mp4',
      attributes: {
        model: 'wan-3.0-video-prime',
        aiSDKPayload: JSON.stringify({
          prompt,
          duration: 30,
          resolution: '480P',
          aspectRatio: '9:16',
          generateAudio: true,
          enableThinking: false,
          watermark: false,
          seed: 0,
          imageUrls: [imageUrl],
        }),
        appId: 'com.picsart.ai-playground',
        appType: 'miniapp',
      },
      folder: { path: 'AI Playground' },
    },
  },
});

const wan3Landscape = buildPicsartI2vParams('wan_v3', prompt, imageUrl, { ratio: '16:9' });
assert.equal(wan3Landscape.ratio, '16:9');

const wan3InputUrls = Array.from({ length: 6 }, (_, index) => `https://cdn.example.test/reference-${index + 1}.jpg`);
const wan3MultiImage = buildPicsartI2vParams('wan_v3', prompt, imageUrl, {
  ratio: '16:9',
  imageUrls: wan3InputUrls,
});
const expectedWan3Urls = wan3InputUrls.slice(0, PICSART_I2V_MAX_IMAGES);
assert.deepEqual(
  wan3MultiImage.media,
  expectedWan3Urls.map((url) => ({ type: 'reference_image', url }))
);
const wan3MultiDrive = (wan3MultiImage.options as {
  drive: { attributes: { aiSDKPayload: string } };
}).drive;
assert.deepEqual(JSON.parse(wan3MultiDrive.attributes.aiSDKPayload).imageUrls, expectedWan3Urls);

const pixverse = buildPicsartI2vParams('pixverse_v6', prompt, imageUrl);
assert.equal(pixverse.model, 'v6');
assert.equal(pixverse.prompt, prompt);
assert.equal(pixverse.quality, '360p');
assert.equal(pixverse.duration, 15);
assert.equal(pixverse.generate_audio_switch, true);
assert.equal(pixverse.image_url, imageUrl);
const pixverseDrive = (pixverse.options as { drive: { name: string; attributes: { model: string; aiSDKPayload: string; appId: string; appType: string }; folder: { path: string } } }).drive;
assert.equal(pixverseDrive.name, 'pixverse-v6-image-ai-playground.mp4');
assert.equal(pixverseDrive.attributes.model, 'pixverse-v6-image');
assert.equal(pixverseDrive.attributes.appId, 'com.picsart.ai-playground');
assert.equal(pixverseDrive.attributes.appType, 'miniapp');
assert.equal(pixverseDrive.folder.path, 'AI Playground');
assert.deepEqual(JSON.parse(pixverseDrive.attributes.aiSDKPayload), {
  prompt,
  quality: '360p',
  duration: 15,
  generateAudio: true,
  imageUrls: [imageUrl],
  outputMegapixels: 1.032192,
});
assert.equal(shouldExportPicsartI2v('pixverse_v6'), true);
const portraitExport = getPicsartI2vExportSize('9:16');
const landscapeExport = getPicsartI2vExportSize('16:9');
assert.deepEqual(portraitExport, { width: 1080, height: 1920 });
assert.deepEqual(landscapeExport, { width: 1920, height: 1080 });
assert.equal(portraitExport.width * 16, portraitExport.height * 9, 'portrait export must remain exact 9:16');
assert.equal(landscapeExport.width * 9, landscapeExport.height * 16, 'landscape export must remain exact 16:9');
assert.match(botSource, /mode_pi2v_wan_v3/);
assert.match(botSource, /mode_pi2v_pixverse_v6/);
assert.match(botSource, /picsart_wan_v3: 5000/);
assert.match(botSource, /picsart_seedance_2_mini: 3500/);
assert.match(botSource, /picsart_seedance_2: 4000/);
assert.match(botSource, /gemini_omni: 2500/);
assert.match(botSource, /gemini_omni_12: 3500/);
assert.match(botSource, /mode_gomni12/);
assert.match(botSource, /GEMINI_OMNI_12_MAX_IMAGES/);
assert.match(botSource, /mengekstrak hasil ke 1080p/);
assert.match(botSource, /Wan 3\.0 1080p/);
assert.match(botSource, /Seedance 2\.0 Mini 1080p/);
assert.match(botSource, /Seedance 2\.0 Fast 1080p/);
assert.match(botSource, /Seedance 2\.0 1080p/);
assert.match(botSource, /picsart_ratio_916/);
assert.match(botSource, /picsart_ratio_169/);
assert.match(botSource, /supportsMultiplePicsartI2vImages/);
assert.match(botSource, /picsart_i2v_add_photo/);
assert.match(botSource, /PICSART_I2V_MAX_IMAGES/);
assert.match(botSource, /mode_oneover_seedance25[\s\S]*picsart_i2v_wait_ratio/);
assert.match(botSource, /picsart_seedance_25[\s\S]*picsart_ratio_169/);
assert.match(botSource, /seedance_2_mini[\s\S]*picsart_i2v_wait_ratio/);
assert.match(botSource, /seedance_2_fast[\s\S]*picsart_i2v_wait_ratio/);
assert.match(botSource, /seedance_2[\s\S]*picsart_i2v_wait_ratio/);
const picsartSource = readFileSync(new URL('../src/picsart.ts', import.meta.url), 'utf8');
assert.match(picsartSource, /generateGeminiOmni12[\s\S]*submitPicsartI2vExport/);
assert.match(picsartSource, /\/gw-v2\/workflows\/\$\{cfg\.workflowPath\}/);
assert.match(picsartSource, /x-sub-package-id': 'subscription_pro_monthly'/);
assert.match(picsartSource, /x-app-authorization/);

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