import assert from 'node:assert/strict';
import {
  generateKlingMotionEdan,
  klingMotionEdanRequest,
  KLING_MOTION_EDAN,
  type KlingMotionEdanAsset,
} from '../src/kling-motion-edan';

const image: KlingMotionEdanAsset = {
  type: 'image', url: 'https://edanbot.digital/uploads/character.png', name: 'character.png', size: 1024,
};
const video: KlingMotionEdanAsset = {
  type: 'video', url: 'https://edanbot.digital/uploads/driver.mp4', name: 'driver.mp4', size: 2048,
};
const imageMedia = { buffer: Buffer.from('image'), name: 'character.png', mime: 'image/png' };
const videoMedia = { buffer: Buffer.from('video'), name: 'driver.mp4', mime: 'video/mp4' };

const request = klingMotionEdanRequest('follow the reference', image, video, 14.3);
assert.equal(request.model, 'kling-motion-26-pro');
assert.match(request.request_id, /^[\da-f-]{36}$/i);
assert.deepEqual(request.fields, {
  prompt: 'follow the reference',
  image_url: image,
  video_url: video,
  reference_video_duration: 14.3,
  character_orientation: 'video',
  keep_original_sound: true,
});
assert.equal(KLING_MOTION_EDAN.minReferenceSeconds, 3);
assert.equal(KLING_MOTION_EDAN.maxReferenceSeconds, 30);

for (const duration of [2.99, 30.01, Number.NaN]) {
  assert.throws(() => klingMotionEdanRequest('', image, video, duration), /INVALID_INPUT/);
}
assert.throws(() => klingMotionEdanRequest('', { ...image, type: 'video' }, video, 10), /INVALID_INPUT/);
assert.throws(() => klingMotionEdanRequest('', image, { ...video, url: 'https://evil.example/driver.mp4' }, 10), /INVALID_INPUT/);
assert.throws(() => klingMotionEdanRequest('', image, { ...video, url: 'http://edanbot.digital/driver.mp4' }, 10), /INVALID_INPUT/);

async function providerTests() {
  const state = { uploads: 0, submits: 0, polls: 0, markedDead: [] as number[], stages: [] as string[] };
  const result = await generateKlingMotionEdan('follow', imageMedia, videoMedia, 14.3, {
    cookies: async () => [{ id: 1, cookie: 'session-one' }],
    markDead: async id => { state.markedDead.push(id); },
    upload: async (_cookie, media) => {
      state.uploads++;
      assert.equal(media, state.uploads === 1 ? imageMedia : videoMedia);
      return state.uploads === 1 ? image : video;
    },
    submit: async (_cookie, body) => {
      state.submits++;
      assert.equal(body.model, 'kling-motion-26-pro');
      assert.equal(body.fields.reference_video_duration, 14.3);
      return 'accepted-job';
    },
    poll: async (_cookie, id) => {
      state.polls++;
      assert.equal(id, 'accepted-job');
      return 'https://cdn.example/result.mp4';
    },
    onStatus: stage => { state.stages.push(stage); },
  });
  assert.deepEqual(result, { url: 'https://cdn.example/result.mp4', jobId: 'accepted-job' });
  assert.deepEqual(state, {
    uploads: 2, submits: 1, polls: 1, markedDead: [], stages: ['upload', 'submit', 'poll'],
  });

  const rotated: number[] = [];
  let validUploads = 0;
  const failover = await generateKlingMotionEdan('follow', imageMedia, videoMedia, 14.3, {
    cookies: async () => [{ id: 3, cookie: 'expired' }, { id: 4, cookie: 'valid' }],
    markDead: async id => { rotated.push(id); },
    upload: async cookie => {
      if (cookie === 'expired') throw Object.assign(new Error('expired'), { response: { status: 401 } });
      return validUploads++ === 0 ? image : video;
    },
    submit: async () => 'accepted-after-rotation',
    poll: async () => 'https://cdn.example/result.mp4',
  });
  assert.equal(failover.jobId, 'accepted-after-rotation');
  assert.deepEqual(rotated, [3]);

  for (const failure of ['submit-timeout', 'poll-failure', 'poll-auth'] as const) {
    let submits = 0;
    await assert.rejects(generateKlingMotionEdan('follow', imageMedia, videoMedia, 14.3, {
      cookies: async () => [{ id: 1, cookie: 'one' }, { id: 2, cookie: 'two' }],
      markDead: async () => {},
      upload: async (_cookie, media) => media === imageMedia ? image : video,
      submit: async () => {
        submits++;
        if (failure === 'submit-timeout') throw new Error('ETIMEDOUT');
        return 'accepted-once';
      },
      poll: async () => {
        if (failure === 'poll-auth') throw Object.assign(new Error('expired after submit'), { response: { status: 401 } });
        throw new Error('poll failed');
      },
    }));
    assert.equal(submits, 1, `${failure} must never resubmit an accepted or ambiguous request`);
  }
}

providerTests().then(() => {
  console.log('Kling MC Edanbot: HAR request, asset upload, cookie failover and no-replay checks passed.');
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
