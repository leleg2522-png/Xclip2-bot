import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolveFlora480VideoModelContract, buildFlora480VideoParams } from '../src/flora-video-models';
import { validateFloraSeedance2Mentions, FLORA_SEEDANCE2_MAX_IMAGES } from '../src/flora-seedance2-references';

const mixed = {
  model_id: 'live-mixed-reference', name: 'Seedance 2.0 Reference', type: 'video', capabilities: ['mixed-to-video'],
  params: [
    ...['image_urls', 'video_urls', 'audio_urls'].map(name => ({ name, type: 'string[]', default: [] })),
    { name: 'duration', options: [{ value: '15' }] },
    { name: 'resolution', options: [{ value: '480p' }] },
    { name: 'aspect_ratio', options: [{ value: '9:16' }, { value: '16:9' }] },
  ],
};
const single = { ...mixed, model_id: 'single-image', capabilities: ['image-to-video'],
  params: [...mixed.params.filter(p => p.name !== 'image_urls'), { name: 'image_url', type: 'string' }] };
for (const count of [1, 2, FLORA_SEEDANCE2_MAX_IMAGES]) {
  for (const audio of [0, 1]) for (const video of [false, true]) {
    const contract = resolveFlora480VideoModelContract('seedance_2_480', [single, mixed], 15, video, true, audio, count);
    assert.equal(contract.modelId, mixed.model_id, 'Numbered photos must use the verified reference route');
    const urls = Array.from({ length: count }, (_, i) => `https://example.test/reference-${i + 1}.jpg`);
    const params = buildFlora480VideoParams('seedance_2_480', urls[0], '16:9', 15,
      video ? { url: 'https://example.test/reference.mp4', parameter: contract.videoReferenceParam!,
        imageParameter: contract.imageReferenceParam } : undefined,
      audio ? { urls: ['https://example.test/reference.mp3'], parameter: contract.audioReferenceParam!,
        imageParameter: contract.imageReferenceParam } : undefined,
      { urls, parameter: contract.imageReferenceParam! });
    assert.deepEqual(params.image_urls, urls);
    assert.equal(params.image_url, undefined);
    assert.equal(Boolean(params.audio_urls), Boolean(audio));
    assert.equal(Boolean(params.video_urls), video);
    assert.equal(params.duration, '15');
  }
}
for (const count of [-1, 0, 10, 1.5, NaN]) {
  assert.throws(() => resolveFlora480VideoModelContract('seedance_2_480', [mixed], 15, false, true, 0, count));
}
assert.throws(() => resolveFlora480VideoModelContract('seedance_2_480', [single], 15, false, true, 0, 2));
assert.throws(() => buildFlora480VideoParams('seedance_2_480', '', '9:16', 15, undefined, undefined,
  { urls: ['https://example.test/one.jpg'], parameter: { name: 'image_url', type: 'string' } }));
for (const prompt of ['Use @1', '@2 left, @1 right.', 'Karakter @1 memakai baju @2.', 'user@1.com',
  'Pakai @1\nkemudian @2', '@Image1 is not rewritten']) {
  assert.equal(validateFloraSeedance2Mentions(prompt, 2), prompt);
}
for (const prompt of ['Use @3', '@0', '@01', '@999999999999999999999', '人物 @3']) {
  assert.throws(() => validateFloraSeedance2Mentions(prompt, 2));
}
assert.throws(() => validateFloraSeedance2Mentions('@1', 0));
const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const photos = source.slice(source.indexOf("bot.on('photo'"), source.indexOf("bot.on('video'"));
const reserve = photos.indexOf("draft.mode === 'flora_seedance_2_480_wait_image'");
assert.ok(reserve >= 0 && reserve < photos.indexOf('await ctx.telegram.getFileLink'), 'Reserve references before asynchronous file links');
assert.match(photos.slice(reserve, photos.indexOf('await ctx.telegram.getFileLink')), /return handleImageInput\(ctx, '', photo\.file_id\)/);
console.log('Flora multi-image: ordered array payloads, indexed reference route, 9-photo limit, exact prompt preservation and invalid mention guards passed.');
