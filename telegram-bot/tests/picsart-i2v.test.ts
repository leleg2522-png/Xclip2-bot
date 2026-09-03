import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  GEMINI_OMNI_12_DURATION_SECONDS,
  GEMINI_OMNI_12_MAX_IMAGES,
  GEMINI_OMNI_12_MODEL,
  GEMINI_OMNI_12_RESOLUTION,
  GEMINI_OMNI_MODEL,
  KLING_MOTION_CONTROL_POOL,
  MINIMAX_H3_DURATION_SECONDS,
  MINIMAX_H3_MODEL,
  MINIMAX_H3_NATIVE_RESOLUTION,
  VEO_31_LITE_DURATION_SECONDS,
  VEO_31_LITE_MODEL,
  VEO_31_LITE_RESOLUTION,
  PICSART_I2V_MAX_IMAGES,
  PICSART_I2V_MODELS,
  SEEDANCE_2_MINI_EDIT_DURATION_SECONDS,
  SEEDANCE_2_MINI_EDIT_MAX_IMAGES,
  SEEDANCE_2_MINI_EDIT_MODEL,
  SEEDANCE_2_MINI_EDIT_RESOLUTION,
  SEEDANCE_2_FAST_EDIT_DURATION_SECONDS,
  SEEDANCE_2_FAST_EDIT_MAX_IMAGES,
  SEEDANCE_2_FAST_EDIT_MODEL,
  SEEDANCE_2_FAST_EDIT_RESOLUTION,
  SEEDANCE_2_EDIT_DURATION_SECONDS,
  SEEDANCE_2_EDIT_MAX_IMAGES,
  SEEDANCE_2_EDIT_MODEL,
  SEEDANCE_2_EDIT_RESOLUTION,
  buildGeminiOmni12Params,
  buildMinimaxH3Params,
  buildVeo31LiteParams,
  buildPicsartI2vParams,
  buildSeedanceMiniVideoEditParams,
  buildSeedanceFastVideoEditParams,
  buildSeedance2VideoEditParams,
  extractPicsartVideoUrl,
  getPicsartExportSize,
  getPicsartI2vExportSize,
  isPicsartPostSubmitAuthFailure,
  shouldExportPicsartI2v,
} from '../src/picsart';

const imageUrl = 'https://cdn.example.test/reference.jpg';
const prompt = 'A subject moves gracefully through the scene';
const videoUrl = 'https://cdn.example.test/reference.mp4';

assert.equal(GEMINI_OMNI_MODEL, 'gemini-omni-flash-preview', 'legacy Gemini Omni model must remain unchanged');
assert.equal(GEMINI_OMNI_12_MODEL, 'gemini-omni-1.1-flash-preview');
assert.equal(GEMINI_OMNI_12_DURATION_SECONDS, 10);
assert.equal(GEMINI_OMNI_12_RESOLUTION, '360p');
assert.equal(GEMINI_OMNI_12_MAX_IMAGES, 5);
assert.equal(MINIMAX_H3_MODEL, 'minimax-h3-max');
assert.equal(MINIMAX_H3_DURATION_SECONDS, 15);
assert.equal(MINIMAX_H3_NATIVE_RESOLUTION, '480p');
const minimaxH3Params = buildMinimaxH3Params({
  prompt,
  startFrameUrl: imageUrl,
  endFrameUrl: 'https://cdn.example.test/end-frame.jpg',
  aspectRatio: '9:16',
  outputName: 'minimax-h3-test.mp4',
}) as any;
assert.equal(minimaxH3Params.prompt, prompt);
assert.equal(minimaxH3Params.prompt_expansion_mode, 'balanced');
assert.equal(minimaxH3Params.duration, 15);
assert.equal(minimaxH3Params.resolution, '480p');
assert.equal(minimaxH3Params.image_url, imageUrl);
assert.equal(minimaxH3Params.end_image_url, 'https://cdn.example.test/end-frame.jpg');
assert.equal(minimaxH3Params.enable_safety_checker, true);
assert.equal(minimaxH3Params.options.drive.attributes.model, 'minimax-h3-max');
assert.equal(minimaxH3Params.options.drive.name, 'minimax-h3-test.mp4');
assert.deepEqual(JSON.parse(minimaxH3Params.options.drive.attributes.aiSDKPayload), {
  prompt,
  resolution: '480p',
  duration: 15,
  aspectRatio: '9:16',
  promptExpansionMode: 'balanced',
  seed: -1,
  enableSafetyChecker: true,
  startFrame: imageUrl,
  outputMegapixels: 0.91392,
  endFrame: 'https://cdn.example.test/end-frame.jpg',
});
assert.equal(VEO_31_LITE_MODEL, 'veo-3.1-lite-generate-preview');
assert.equal(VEO_31_LITE_DURATION_SECONDS, 8);
assert.equal(VEO_31_LITE_RESOLUTION, '720p');
assert.deepEqual(buildVeo31LiteParams({
  prompt,
  imageReference: { url: imageUrl, mimeType: 'image/jpeg' },
  aspectRatio: '9:16',
}), {
  model: 'veo-3.1-lite-generate-preview',
  prompt,
  count: 1,
  image: { url: imageUrl, mimeType: 'image/jpeg' },
  parameters: {
    resolution: '720p',
    aspectRatio: '9:16',
    durationSeconds: 8,
  },
});
assert.equal(KLING_MOTION_CONTROL_POOL, 'p100');
assert.equal(PICSART_I2V_MODELS.seedance_2_mini.pool, 'p500');
assert.equal(PICSART_I2V_MODELS.seedance_2_fast.pool, 'p500');
assert.equal(PICSART_I2V_MODELS.seedance_2.pool, 'p500');
assert.equal(PICSART_I2V_MODELS.wan_v2.pool, 'p500');
assert.equal(PICSART_I2V_MODELS.wan_v3.pool, 'p500');
assert.equal(shouldExportPicsartI2v('grok_imagine'), true);
assert.equal(SEEDANCE_2_MINI_EDIT_MODEL, 'seedance_2_0_mini');
assert.equal(SEEDANCE_2_MINI_EDIT_DURATION_SECONDS, 15);
assert.equal(SEEDANCE_2_MINI_EDIT_RESOLUTION, '480p');
assert.equal(SEEDANCE_2_MINI_EDIT_MAX_IMAGES, 5);
assert.equal(SEEDANCE_2_FAST_EDIT_MODEL, 'seedance_2_0_fast');
assert.equal(SEEDANCE_2_FAST_EDIT_DURATION_SECONDS, 15);
assert.equal(SEEDANCE_2_FAST_EDIT_RESOLUTION, '480p');
assert.equal(SEEDANCE_2_FAST_EDIT_MAX_IMAGES, 5);
assert.equal(SEEDANCE_2_EDIT_MODEL, 'seedance_2_0');
assert.equal(SEEDANCE_2_EDIT_DURATION_SECONDS, 15);
assert.equal(SEEDANCE_2_EDIT_RESOLUTION, '480p');
assert.equal(SEEDANCE_2_EDIT_MAX_IMAGES, 5);
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
assert.equal(PICSART_I2V_MODELS.wan_v3.pool, 'p500');
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

const seedanceMiniEdit = buildSeedanceMiniVideoEditParams({
  prompt,
  videoUrl,
  imageUrl,
  ratio: '16:9',
  outputName: 'seedance-mini-edit.mp4',
});
assert.equal(seedanceMiniEdit.model, 'seedance_2_0_mini');
assert.equal(seedanceMiniEdit.ratio, '16:9');
assert.equal(seedanceMiniEdit.resolution, '480p');
assert.equal(seedanceMiniEdit.duration, 15);
assert.equal(seedanceMiniEdit.generate_audio, true);
assert.deepEqual(seedanceMiniEdit.content, [
  { type: 'text', text: prompt },
  { type: 'video_url', video_url: { url: videoUrl }, role: 'reference_video' },
  { type: 'image_url', image_url: { url: imageUrl }, role: 'reference_image' },
]);
const seedanceMiniEditDrive = (seedanceMiniEdit.options as {
  drive: { name: string; attributes: { model: string; aiSDKPayload: string } };
}).drive;
assert.equal(seedanceMiniEditDrive.name, 'seedance-mini-edit.mp4');
assert.equal(seedanceMiniEditDrive.attributes.model, 'seedance-2.0-mini-video-edit');
assert.deepEqual(JSON.parse(seedanceMiniEditDrive.attributes.aiSDKPayload), {
  prompt,
  aspectRatio: '16:9',
  resolution: '480p',
  duration: 15,
  generateAudio: true,
  returnLastFrame: false,
  videoUrl,
  imageUrls: [imageUrl],
});
const seedanceMiniEditWithoutImage = buildSeedanceMiniVideoEditParams({
  prompt,
  videoUrl,
  ratio: '9:16',
});
assert.deepEqual(seedanceMiniEditWithoutImage.content, [
  { type: 'text', text: prompt },
  { type: 'video_url', video_url: { url: videoUrl }, role: 'reference_video' },
]);
assert.equal(
  'imageUrls' in JSON.parse(
    ((seedanceMiniEditWithoutImage.options as { drive: { attributes: { aiSDKPayload: string } } })
      .drive.attributes.aiSDKPayload)
  ),
  false
);

// Captured Seedance 2 Fast Video Edit HAR contract.
const seedanceFastEdit = buildSeedanceFastVideoEditParams({
  prompt,
  videoUrl,
  imageUrl,
  ratio: '9:16',
  outputName: 'seedance-fast-edit.mp4',
});
assert.equal(seedanceFastEdit.model, 'seedance_2_0_fast');
assert.equal(seedanceFastEdit.ratio, '9:16');
assert.equal(seedanceFastEdit.resolution, '480p');
assert.equal(seedanceFastEdit.duration, 15);
assert.equal(seedanceFastEdit.generate_audio, true);
assert.deepEqual(seedanceFastEdit.content, [
  { type: 'text', text: prompt },
  { type: 'video_url', video_url: { url: videoUrl }, role: 'reference_video' },
  { type: 'image_url', image_url: { url: imageUrl }, role: 'reference_image' },
]);
const seedanceFastEditDrive = (seedanceFastEdit.options as {
  drive: { name: string; attributes: { model: string; aiSDKPayload: string } };
}).drive;
assert.equal(seedanceFastEditDrive.name, 'seedance-fast-edit.mp4');
assert.equal(seedanceFastEditDrive.attributes.model, 'seedance-2.0-fast-video-edit');
assert.deepEqual(JSON.parse(seedanceFastEditDrive.attributes.aiSDKPayload), {
  prompt,
  aspectRatio: '9:16',
  resolution: '480p',
  duration: 15,
  generateAudio: true,
  returnLastFrame: false,
  videoUrl,
  imageUrls: [imageUrl],
});

// Captured Seedance 2 Video Edit HAR contract.
const seedance2Edit = buildSeedance2VideoEditParams({
  prompt,
  videoUrl,
  imageUrl,
  ratio: '9:16',
  outputName: 'seedance-2-edit.mp4',
});
assert.equal(seedance2Edit.model, 'seedance_2_0');
assert.equal(seedance2Edit.ratio, '9:16');
assert.equal(seedance2Edit.resolution, '480p');
assert.equal(seedance2Edit.duration, 15);
assert.equal(seedance2Edit.generate_audio, true);
assert.deepEqual(seedance2Edit.content, [
  { type: 'text', text: prompt },
  { type: 'video_url', video_url: { url: videoUrl }, role: 'reference_video' },
  { type: 'image_url', image_url: { url: imageUrl }, role: 'reference_image' },
]);
const seedance2EditDrive = (seedance2Edit.options as {
  drive: { name: string; attributes: { model: string; aiSDKPayload: string } };
}).drive;
assert.equal(seedance2EditDrive.name, 'seedance-2-edit.mp4');
assert.equal(seedance2EditDrive.attributes.model, 'seedance-2.0-video-edit');
assert.deepEqual(JSON.parse(seedance2EditDrive.attributes.aiSDKPayload), {
  prompt,
  aspectRatio: '9:16',
  resolution: '480p',
  duration: 15,
  generateAudio: true,
  returnLastFrame: false,
  videoUrl,
  imageUrls: [imageUrl],
});

const sixEditImageUrls = Array.from(
  { length: 6 },
  (_, index) => `https://cdn.example.test/edit-reference-${index + 1}.jpg`
);
for (const [builder, expectedModel] of [
  [buildSeedanceMiniVideoEditParams, 'seedance_2_0_mini'],
  [buildSeedanceFastVideoEditParams, 'seedance_2_0_fast'],
  [buildSeedance2VideoEditParams, 'seedance_2_0'],
] as const) {
  const params = builder({ prompt, videoUrl, imageUrls: sixEditImageUrls, ratio: '16:9' });
  assert.equal(params.model, expectedModel);
  const imageContent = (params.content as Array<{ type: string }>).filter((item) => item.type === 'image_url');
  assert.equal(imageContent.length, 5);
  const drive = (params.options as { drive: { attributes: { aiSDKPayload: string } } }).drive;
  assert.deepEqual(JSON.parse(drive.attributes.aiSDKPayload).imageUrls, sixEditImageUrls.slice(0, 5));
}

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

const grok = buildPicsartI2vParams('grok_imagine', prompt, imageUrl, { ratio: '16:9' });
assert.deepEqual(grok, {
  model: 'grok-imagine-video',
  prompt,
  image: { url: imageUrl },
  duration: 15,
  aspect_ratio: '16:9',
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
assert.deepEqual(getPicsartExportSize('9:16', '4K'), { width: 2160, height: 3840 });
assert.deepEqual(getPicsartExportSize('16:9', '4K'), { width: 3840, height: 2160 });
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
assert.match(botSource, /mode_veo31/);
assert.match(botSource, /mode_minimax_h3/);
assert.match(botSource, /picsart_minimax_h3:\s*4000/);
assert.match(botSource, /mh3_mode_i2v/);
assert.match(botSource, /mh3_mode_start_end/);
assert.match(botSource, /mh3_ratio_916/);
assert.match(botSource, /mh3_ratio_169/);
assert.match(botSource, /mh3_res_4k/);
assert.match(botSource, /Output: \*4K\*/);
assert.match(botSource, /minimax_h3_wait_start_frame/);
assert.match(botSource, /minimax_h3_wait_end_frame/);
assert.match(botSource, /minimax_h3_wait_prompt/);
assert.match(botSource, /picsart_veo31_4k:\s*2500/);
assert.match(botSource, /Veo 3\.1 4K/);
assert.match(botSource, /v31_ratio_916/);
assert.match(botSource, /v31_ratio_169/);
assert.match(botSource, /gemini_omni_12_4k:\s*4000/);
assert.match(botSource, /go12_res_1080/);
assert.match(botSource, /go12_res_4k/);
assert.match(botSource, /gomniResolution/);
assert.match(botSource, /GEMINI_OMNI_12_MAX_IMAGES/);
assert.match(botSource, /menyiapkan video akhir \$\{opts\.exportResolution\}/);
assert.match(botSource, /Wan 3\.0 1080p/);
assert.match(botSource, /Seedance 2\.0 Mini 1080p/);
assert.match(botSource, /Seedance 2 Mini Video Edit 1080p/);
assert.match(botSource, /mode_seedance_mini_edit/);
assert.match(botSource, /seedance_edit_ratio_916/);
assert.match(botSource, /seedance_edit_ratio_169/);
assert.match(botSource, /seedance_edit_skip_image/);
assert.match(botSource, /picsart_seedance_2_mini_edit: 3500/);
assert.match(botSource, /Seedance 2 Fast Video Edit 1080p/);
assert.match(botSource, /mode_seedance_fast_edit/);
assert.match(botSource, /seedance_fast_edit_wait_ratio/);
assert.match(botSource, /seedance_fast_edit_wait_video/);
assert.match(botSource, /seedance_fast_edit_wait_image/);
assert.match(botSource, /seedance_fast_edit_wait_prompt/);
assert.match(botSource, /seedance_fast_edit_ratio_916/);
assert.match(botSource, /seedance_fast_edit_ratio_169/);
assert.match(botSource, /seedance_fast_edit_skip_image/);
assert.match(botSource, /picsart_seedance_2_fast_edit: 4000/);
assert.match(botSource, /Seedance 2 Video Edit 1080p/);
assert.match(botSource, /mode_seedance_2_edit/);
assert.match(botSource, /seedance_2_edit_wait_ratio/);
assert.match(botSource, /seedance_2_edit_wait_video/);
assert.match(botSource, /seedance_2_edit_wait_image/);
assert.match(botSource, /seedance_2_edit_wait_prompt/);
assert.match(botSource, /seedance_2_edit_ratio_916/);
assert.match(botSource, /seedance_2_edit_ratio_169/);
assert.match(botSource, /seedance_2_edit_skip_image/);
assert.match(botSource, /picsart_seedance_2_video_edit: 4500/);
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
assert.match(picsartSource, /generateVeo31Lite4K[\s\S]*submitPicsartI2vExport/);
assert.match(picsartSource, /gw-v2\/workflows\/minimax\/h3-max\/image-to-video\/submit/);
assert.match(picsartSource, /generateMinimaxH3[\s\S]*submitPicsartI2vExport[\s\S]*'4K'[\s\S]*useGateway: true/);
assert.match(picsartSource, /gw-v2\/workflows\/veo-t2v\/submit/);
assert.match(picsartSource, /generateSeedanceVideoEdit[\s\S]*submitPicsartI2vExport/);
assert.match(picsartSource, /seedance-2\.0-mini-video-edit/);
assert.match(picsartSource, /seedance-2\.0-fast-video-edit/);
assert.match(picsartSource, /generateSeedanceFastVideoEdit/);
assert.match(picsartSource, /seedance-2\.0-video-edit/);
assert.match(picsartSource, /generateSeedance2VideoEdit/);
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