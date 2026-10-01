import assert from 'node:assert/strict';
import {
  buildFlora480VideoParams,
  FLORA_480_VIDEO_MODELS,
  resolveFlora480VideoModel,
  type Flora480VideoModelKey,
} from '../src/flora-video-models';

// Relevant schema fields captured from the authenticated live Flora catalog.
function fixture(key: Flora480VideoModelKey, id: string) {
  const cfg = FLORA_480_VIDEO_MODELS[key];
  return {
    model_id: id,
    name: key === 'minimax_h3_480' ? 'MiniMax H3 Max' : 'WAN 3.0',
    type: 'video',
    capabilities: ['audio-image-to-video'],
    params: [
      { name: 'image_urls', type: 'string[]', required: false, default: [] },
      { name: 'duration', type: 'string', options: [{ value: String(cfg.durationSeconds) }] },
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

for (const key of ['minimax_h3_480', 'wan_v3_480'] as const) {
  const endpoint = fixture(key, `account-specific-${key}`);
  const audioOnly = { ...endpoint, model_id: 'wrong-audio-only', capabilities: ['audio-to-video'] };
  assert.equal(resolveFlora480VideoModel(key, { models: [audioOnly, endpoint] }), endpoint.model_id);
  assert.equal(resolveFlora480VideoModel(key, [endpoint]), endpoint.model_id);
  assert.throws(() => resolveFlora480VideoModel(key, [audioOnly]), /MODEL_UNAVAILABLE/);
  assert.throws(() => resolveFlora480VideoModel(key, []), /MODEL_UNAVAILABLE/);
  assert.throws(() => resolveFlora480VideoModel(key, {
    models: [{ ...endpoint, params: endpoint.params.filter(p => p.name !== 'duration') }],
  }), /UNSUPPORTED_PARAMETERS/);
  assert.throws(() => resolveFlora480VideoModel(key, [{
    ...endpoint,
    params: endpoint.params.map(p => p.name === 'duration' ? { ...p, options: [{ value: '5' }] } : p),
  }]), /UNSUPPORTED_PARAMETERS/);
  assert.throws(() => resolveFlora480VideoModel(key, [{
    ...endpoint,
    params: endpoint.params.map(p => p.name === 'resolution' ? { ...p, options: [{ value: '720p' }] } : p),
  }]), /UNSUPPORTED_PARAMETERS/);
  assert.throws(() => resolveFlora480VideoModel(key, [{
    ...endpoint, params: [...endpoint.params, { name: 'audio_url', type: 'string', required: true }],
  }]), /UNSUPPORTED_PARAMETERS/);
}

console.log('Flora native 480p model catalog and payload checks passed.');