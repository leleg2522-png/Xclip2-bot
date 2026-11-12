import assert from 'node:assert/strict';
import { resolveFlora480VideoModelContract, buildFlora480VideoParams } from '../src/flora-video-models';
import { createSeedanceAudioHandler, supportsSeedance2Audio } from '../src/seedance-reference-audio';

const media = ['image_urls', 'video_urls', 'audio_urls'].map(name => ({ name, type: 'string[]', default: [] }));
const settings = [
  { name: 'duration', options: [{ value: '15' }] },
  { name: 'resolution', options: [{ value: '480p' }] },
  { name: 'aspect_ratio', options: [{ value: '9:16' }, { value: '16:9' }] },
];
const row = (capability: string, params: any[] = [...media, ...settings]) => ({
  model_id: `live-${capability}`, name: 'Seedance 2.0 Reference', type: 'video', capabilities: [capability], params,
});
for (const [image, video, capability] of [
  [true, false, 'audio-image-to-video'], [false, true, 'audio-video-to-video'], [true, true, 'mixed-to-video'],
] as const) {
  const catalog = { models: [row('image-to-video'), row(capability)] };
  const contract = resolveFlora480VideoModelContract('seedance_2_480', catalog, 15, video, image, 3);
  assert.equal(contract.modelId, `live-${capability}`);
  const urls = Array(3).fill('https://assets.example.test/audio.ogg');
  const params = buildFlora480VideoParams('seedance_2_480', image ? 'https://assets.example.test/photo.jpg' : '',
    '9:16', 15, video ? { url: 'https://assets.example.test/video.mp4', parameter: contract.videoReferenceParam!,
      imageParameter: contract.imageReferenceParam } : undefined,
    { urls, parameter: contract.audioReferenceParam!, imageParameter: contract.imageReferenceParam });
  assert.deepEqual(params.audio_urls, urls);
  assert.equal(Boolean(params.image_urls), image);
  assert.equal(Boolean(params.video_urls), video);
  assert.equal(params.duration, '15');
  assert.equal(params.resolution, '480p');
  assert.equal(params.image_url, undefined, 'Array input must not be sent as the single-image endpoint');
}
const missingAudio = row('mixed-to-video', [...media.filter(p => p.name !== 'audio_urls'), ...settings]);
const unknownRequired = row('mixed-to-video', [...media, ...settings, { name: 'unknown_required', required: true }]);
for (const candidate of [missingAudio, unknownRequired, row('image-to-video')]) {
  assert.throws(() => resolveFlora480VideoModelContract('seedance_2_480', [candidate], 15, false, true, 1));
}
assert.throws(() => resolveFlora480VideoModelContract('seedance_2_480', [row('mixed-to-video')], 15, false, false, 1));
assert.throws(() => resolveFlora480VideoModelContract('seedance_2_5_480', [row('mixed-to-video')], 15, false, true, 1));
assert.throws(() => buildFlora480VideoParams('seedance_2_480', 'image', '9:16', 15, undefined,
  { urls: ['http://invalid.test/audio'], parameter: { name: 'audio_urls', type: 'string[]' } }));

async function main() {
  for (const mode of ['flora_seedance_2_480_wait_image', 'flora_seedance_2_480_wait_prompt']) {
    let session: any = { mode };
    const messages: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const handler = createSeedanceAudioHandler({
      getSession: () => session, setSession: (_id, patch) => { session = { ...session, ...patch }; },
      download: async () => { await gate; return Buffer.from('audio fixture'); }, inspect: async () => 5,
    });
    const ctx = { from: { id: 1 }, reply: async (text: string) => { messages.push(text); } };
    assert.equal(supportsSeedance2Audio(session), true);
    const jobs = ['a', 'b', 'c', 'd'].map(file_id => handler(ctx, { file_id, mime_type: 'audio/ogg' }));
    assert.equal(session.seedanceAudioDraft.pending.length, 3);
    release(); await Promise.all(jobs);
    assert.equal(session.seedanceAudioDraft.refs.length, 3);
    assert.equal(session.seedanceAudioDraft.pending.length, 0);
    assert.doesNotMatch(messages.join('\n'), /Flora|Picsart/i);
  }
  assert.equal(supportsSeedance2Audio({ mode: 'flora_seedance_2_5_480_wait_prompt' }), false);
  assert.equal(supportsSeedance2Audio({ mode: 'flora_seedance_2_480_wait_ratio' }), false);
  console.log('Flora Seedance 2 audio: live-shaped contracts, three media combinations, unsupported catalogs and concurrent intake passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
