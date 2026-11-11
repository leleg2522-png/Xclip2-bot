import assert from 'node:assert/strict';
import {
  buildFlora480VideoParams,
  FLORA_480_VIDEO_MODELS,
  resolveFlora480VideoModel,
  resolveFlora480VideoModelContract,
  type Flora480VideoModelKey,
} from '../src/flora-video-models';

// Relevant schema fields captured from the authenticated live Flora catalog.
function fixture(key: Flora480VideoModelKey, id: string) {
  const cfg = FLORA_480_VIDEO_MODELS[key];
  const singleImageInput = key === 'seedance_2_480' || key === 'seedance_2_5_480';
  const durations = cfg.durationOptionsSeconds ?? [cfg.durationSeconds!];
  return {
    model_id: id,
    name: key === 'minimax_h3_480'
      ? 'MiniMax H3 Max'
      : key === 'seedance_2_480'
        ? 'Seedance 2.0'
        : key === 'seedance_2_5_480'
          ? 'Seedance 2.5'
          : 'WAN 3.0',
    type: 'video',
    capabilities: [key === 'seedance_2_5_480'
      ? 'reference-to-video'
      : singleImageInput ? 'image-to-video' : 'audio-image-to-video'],
    params: [
      { name: singleImageInput ? 'image_url' : 'image_urls', type: singleImageInput ? 'string' : 'string[]', required: false },
      ...(key === 'seedance_2_5_480' ? [{ name: 'video_urls', type: 'string[]', required: false }] : []),
      { name: 'duration', type: 'string', options: durations.map((value) => ({ value: String(value) })) },
      { name: 'resolution', type: 'string', options: [{ value: cfg.resolution }] },
      { name: 'aspect_ratio', type: 'string', options: [{ value: '9:16' }, { value: '16:9' }] },
    ],
  };
}

const imageUrl = 'https://example.test/reference.jpg';
assert.deepEqual(buildFlora480VideoParams('minimax_h3_480', imageUrl, '9:16'), {
  image_urls: [imageUrl],
  duration: '15',
  resolution: '480P',
  aspect_ratio: '9:16',
  prompt_expansion_mode: 'balanced',
});
assert.deepEqual(buildFlora480VideoParams('wan_v3_480', imageUrl, '16:9'), {
  image_urls: [imageUrl],
  duration: '30',
  resolution: '480p',
  aspect_ratio: '16:9',
  audio: true,
  prompt_expansion: true,
  thinking: false,
});
assert.throws(() => buildFlora480VideoParams('wan_v3_480', '', '9:16'), /IMAGE_REQUIRED/);
assert.throws(() => buildFlora480VideoParams('wan_v3_480', imageUrl, '1:1' as any), /INVALID_ASPECT/);
for (const ratio of ['9:16', '16:9'] as const) {
  assert.deepEqual(buildFlora480VideoParams('seedance_2_480', imageUrl, ratio), {
    image_url: imageUrl, duration: '15', resolution: '480p', aspect_ratio: ratio, bitrate_mode: 'standard',
  });
}
assert.equal(FLORA_480_VIDEO_MODELS.seedance_2_480.autoUpscale, true);
assert.equal(FLORA_480_VIDEO_MODELS.seedance_2_480.label, 'Seedance 2 Uncensored');
assert.equal(FLORA_480_VIDEO_MODELS.seedance_2_480.deliveryResolution, '1080p');
assert.equal(FLORA_480_VIDEO_MODELS.seedance_2_5_480.label, 'Seedance 2.5 Uncensored');
assert.equal(FLORA_480_VIDEO_MODELS.seedance_2_5_480.autoUpscale, true);
assert.equal(FLORA_480_VIDEO_MODELS.seedance_2_5_480.mandatoryUpscale, true);
assert.equal(FLORA_480_VIDEO_MODELS.seedance_2_5_480.deliveryResolution, '1K');
for (const duration of [10, 15, 30]) {
  assert.deepEqual(buildFlora480VideoParams('seedance_2_5_480', imageUrl, '9:16', duration), {
    image_url: imageUrl,
    duration: String(duration),
    resolution: '480p',
    aspect_ratio: '9:16',
  });
}
assert.throws(() => buildFlora480VideoParams('seedance_2_5_480', imageUrl, '9:16', 20), /INVALID_DURATION/);
const videoUrl = 'https://example.test/reference.mp4';
const videoParam = { name: 'video_urls', type: 'string[]' } as const;
assert.deepEqual(buildFlora480VideoParams('seedance_2_5_480', imageUrl, '9:16', 10, {
  url: videoUrl, parameter: videoParam,
}), {
  image_url: imageUrl,
  duration: '10',
  resolution: '480p',
  aspect_ratio: '9:16',
  video_urls: [videoUrl],
});
assert.deepEqual(buildFlora480VideoParams('seedance_2_5_480', imageUrl, '16:9', 15, {
  url: videoUrl, parameter: { name: 'video_url', type: 'string' },
}).video_url, videoUrl);
assert.throws(() => buildFlora480VideoParams('wan_v3_480', imageUrl, '9:16', undefined, {
  url: videoUrl, parameter: videoParam,
}), /VIDEO_REFERENCE_UNSUPPORTED/);

for (const key of ['minimax_h3_480', 'wan_v3_480', 'seedance_2_480', 'seedance_2_5_480'] as const) {
  const endpoint = fixture(key, `account-specific-${key}`);
  const audioOnly = { ...endpoint, model_id: 'wrong-audio-only', capabilities: ['audio-to-video'] };
  const selectedDuration = key === 'seedance_2_5_480' ? 10 : undefined;
  assert.equal(resolveFlora480VideoModel(key, { models: [audioOnly, endpoint] }, selectedDuration), endpoint.model_id);
  assert.equal(resolveFlora480VideoModel(key, [endpoint], selectedDuration), endpoint.model_id);
  assert.throws(() => resolveFlora480VideoModel(key, [audioOnly], selectedDuration), /MODEL_UNAVAILABLE/);
  assert.throws(() => resolveFlora480VideoModel(key, [], selectedDuration), /MODEL_UNAVAILABLE/);
  assert.throws(() => resolveFlora480VideoModel(key, {
    models: [{ ...endpoint, params: endpoint.params.filter(p => p.name !== 'duration') }],
  }, selectedDuration), /UNSUPPORTED_PARAMETERS/);
  assert.throws(() => resolveFlora480VideoModel(key, [{
    ...endpoint,
    params: endpoint.params.map(p => p.name === 'duration' ? { ...p, options: [{ value: '5' }] } : p),
  }], selectedDuration), /UNSUPPORTED_PARAMETERS/);
  assert.throws(() => resolveFlora480VideoModel(key, [{
    ...endpoint,
    params: endpoint.params.map(p => p.name === 'resolution' ? { ...p, options: [{ value: '720p' }] } : p),
  }], selectedDuration), /UNSUPPORTED_PARAMETERS/);
  assert.throws(() => resolveFlora480VideoModel(key, [{
    ...endpoint, params: [...endpoint.params, { name: 'audio_url', type: 'string', required: true }],
  }], selectedDuration), /UNSUPPORTED_PARAMETERS/);
  if (key === 'seedance_2_5_480') {
    for (const duration of [10, 15, 30]) {
      assert.equal(resolveFlora480VideoModel(key, [endpoint], duration), endpoint.model_id);
    }
    assert.throws(() => resolveFlora480VideoModel(key, [endpoint], 20), /INVALID_DURATION/);
    assert.throws(() => resolveFlora480VideoModel(key, [{
      ...endpoint,
      params: endpoint.params.map(p => p.name === 'duration' ? { ...p, options: [{ value: '10' }] } : p),
    }], 30), /UNSUPPORTED_PARAMETERS/);
    const contract = resolveFlora480VideoModelContract(key, [endpoint], 10, true);
    assert.equal(contract.modelId, endpoint.model_id);
    assert.deepEqual(contract.videoReferenceParam, { name: 'video_urls', type: 'string[]' });
    assert.throws(() => resolveFlora480VideoModelContract(key, [{
      ...endpoint,
      params: endpoint.params.filter(p => p.name !== 'video_urls'),
    }], 10, true), /UNSUPPORTED_PARAMETERS/);
    const requiredVideo = {
      ...endpoint,
      params: endpoint.params.map(p => p.name === 'video_urls' ? { ...p, required: true } : p),
    };
    assert.throws(() => resolveFlora480VideoModelContract(key, [requiredVideo], 10), /UNSUPPORTED_PARAMETERS/);
    assert.equal(resolveFlora480VideoModelContract(key, [requiredVideo], 10, true).modelId, endpoint.model_id);
  }
}

// Synthetic video-mode contracts: field names must come from the live catalog,
// never from the public documentation alone.
for (const name of ['video_url', 'video_urls', 'reference_video_url', 'reference_video_urls']) {
  for (const type of ['string', 'string[]'] as const) {
    const videoModel = {
      ...fixture('seedance_2_480', 'account-video-endpoint'),
      capabilities: ['video-to-video'],
      params: [
        ...fixture('seedance_2_480', 'unused').params.filter(p => p.name !== 'image_url'),
        { name, type, required: true },
      ],
    };
    const photoModel = fixture('seedance_2_480', 'account-photo-endpoint');
    const contract = resolveFlora480VideoModelContract('seedance_2_480', [photoModel, videoModel], 15, true);
    assert.equal(contract.modelId, 'account-video-endpoint');
    assert.deepEqual(contract.videoReferenceParam, { name, type });
    assert.deepEqual(buildFlora480VideoParams('seedance_2_480', '', '9:16', 15, {
      url: videoUrl, parameter: contract.videoReferenceParam!,
    }), {
      [name]: type === 'string' ? videoUrl : [videoUrl],
      duration: '15', resolution: '480p', aspect_ratio: '9:16',
    });
    assert.equal(resolveFlora480VideoModel('seedance_2_480', [videoModel, photoModel]), photoModel.model_id);
    assert.throws(() => resolveFlora480VideoModelContract('seedance_2_480', [photoModel], 15, true), /MODEL_UNAVAILABLE/);
    assert.throws(() => resolveFlora480VideoModelContract('seedance_2_480', [{
      ...videoModel, params: [...videoModel.params, { name: 'image_url', type: 'string', required: true }],
    }], 15, true), /UNSUPPORTED_PARAMETERS/);
    assert.throws(() => resolveFlora480VideoModelContract('seedance_2_480', [{
      ...videoModel, params: videoModel.params.filter(p => p.name !== name),
    }], 15, true), /UNSUPPORTED_PARAMETERS/);
    assert.throws(() => resolveFlora480VideoModelContract('seedance_2_480', [{
      ...videoModel, params: videoModel.params.map(p => p.name === 'duration'
        ? { ...p, options: [{ value: '10' }] } : p),
    }], 15, true), /UNSUPPORTED_PARAMETERS/);
  }
}
assert.throws(() => buildFlora480VideoParams('seedance_2_480', '', '9:16', 15, {
  url: '', parameter: videoParam,
}), /REFERENCE_VIDEO_REQUIRED/);

console.log('Flora native 480p model catalog and payload checks passed.');