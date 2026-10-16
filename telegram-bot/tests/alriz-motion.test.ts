import assert from 'node:assert/strict';
import { ALRIZ_KLING_P5, generateKlingAlriz, type AlrizMotionApi } from '../src/alriz-motion';

const input = { image: Buffer.from('photo'), video: Buffer.from('motion'), prompt: 'follow movement', seconds: 10 };
const BASE = 'https://alrizmotion.my.id/api';

function harness(outcome = 'success') {
  const events = { submits: 0, reads: 0, publishes: [] as boolean[], statuses: [] as string[] };
  const api: AlrizMotionApi = {
    apiKey: outcome === 'missing-key' ? undefined : 'fixture-private-key',
    maxPolls: 3,
    wait: async ms => { assert.equal(ms, 5000); },
    publish: async (bytes, video) => {
      assert.deepEqual(bytes, video ? input.video : input.image);
      events.publishes.push(video);
      if (outcome === 'publish') throw Error('hosting failed');
      if (outcome === 'telegram-url') return 'https://api.telegram.org/file/botPRIVATE/input';
      if (outcome === 'local-url') return 'http://localhost:3000/dl/input';
      return `https://our-domain.test/dl/${video ? 'video' : 'image'}`;
    },
    status: async text => { events.statuses.push(text); },
    http: {
      post: async (url, body, config) => {
        events.submits++;
        assert.equal(url, `${BASE}/jobs`);
        assert.equal(config.headers['X-API-Key'], 'fixture-private-key');
        assert.equal(config.headers['Content-Type'], 'application/json');
        assert.equal(config.proxy, false);
        assert.deepEqual(body, {
          model: 'mc-kling-2.6-pro',
          image_url: 'https://our-domain.test/dl/image',
          video_url: 'https://our-domain.test/dl/video',
          prompt: input.prompt,
        });
        assert.doesNotMatch(JSON.stringify(body), /telegram|PRIVATE|fixture-private-key/i);
        if (outcome === 'submit-timeout') throw Error('ETIMEDOUT fixture-private-key');
        if (outcome === 'submit-auth') return { status: 401, data: { error: { message: 'private provider details' } } };
        if (outcome === 'submit-limit') return { status: 429, data: {} };
        return { status: 202, data: { job_id: outcome === 'no-id' ? undefined : 'ALRIZ_fixture' } };
      },
      get: async (url, config) => {
        events.reads++;
        assert.equal(config.headers['X-API-Key'], 'fixture-private-key');
        assert.ok(url.startsWith(`${BASE}/jobs/ALRIZ_fixture`));
        if (outcome === 'poll-auth') return { status: 401, data: {} };
        if (outcome === 'poll-transient' && events.reads === 1) throw Error('ECONNRESET');
        if (outcome === 'poll-limit' && events.reads === 1) return { status: 429, data: {} };
        if (outcome === 'timeout') return { status: 200, data: { status: 'PROCESSING' } };
        if (outcome === 'failed' || outcome === 'no-stock') {
          return { status: 200, data: { status: outcome === 'failed' ? 'FAILED' : 'NO_STOCK', error: 'private details' } };
        }
        if (outcome === 'result-endpoint' && !url.endsWith('/result')) {
          return { status: 200, data: { status: 'DONE' } };
        }
        return { status: 200, data: {
          status: 'DONE',
          result_expired: outcome === 'expired',
          result_url: outcome === 'bad-result' ? 'not-a-url' : 'https://cdn.alrizmotion.my.id/results/output.mp4',
        } };
      },
    },
  };
  return { api, events };
}

async function main() {
  assert.equal(ALRIZ_KLING_P5.label, 'Kling MC 2.6 Pro P5');
  assert.equal(ALRIZ_KLING_P5.model, 'mc-kling-2.6-pro');
  for (const outcome of ['success', 'result-endpoint', 'poll-transient', 'poll-limit']) {
    const h = harness(outcome);
    assert.equal(await generateKlingAlriz(input, h.api), 'https://cdn.alrizmotion.my.id/results/output.mp4');
    assert.equal(h.events.submits, 1);
    assert.deepEqual(h.events.publishes, [false, true]);
    assert.doesNotMatch(h.events.statuses.join(' '), /Alriz|provider|fixture-private-key|https?:/i);
  }
  for (const outcome of [
    'missing-key', 'publish', 'telegram-url', 'local-url', 'submit-timeout', 'submit-auth',
    'submit-limit', 'no-id', 'poll-auth', 'timeout', 'failed', 'no-stock', 'expired', 'bad-result',
  ]) {
    const h = harness(outcome);
    await assert.rejects(generateKlingAlriz(input, h.api), error => {
      assert.doesNotMatch(String(error), /fixture-private-key|private provider details|https?:/);
      return true;
    });
    assert.equal(h.events.submits, ['missing-key', 'publish', 'telegram-url', 'local-url'].includes(outcome) ? 0 : 1,
      'Never replay an accepted or ambiguous paid submission');
    if (outcome === 'missing-key') assert.equal(h.events.publishes.length, 0);
  }
  for (const seconds of [2, 31, NaN]) {
    const h = harness();
    await assert.rejects(generateKlingAlriz({ ...input, seconds }, h.api), /INVALID_VIDEO_DURATION/);
    assert.equal(h.events.submits, 0);
  }
  for (const media of [
    { image: Buffer.alloc(0) }, { image: Buffer.alloc(10 * 1024 * 1024 + 1) },
    { video: Buffer.alloc(0) }, { video: Buffer.alloc(15 * 1024 * 1024 + 1) },
  ]) {
    const h = harness();
    await assert.rejects(generateKlingAlriz({ ...input, ...media }, h.api), /INVALID_(IMAGE|VIDEO)_SIZE/);
    assert.equal(h.events.submits, 0);
  }
  console.log('Alriz P5: mc-kling-2.6-pro, safe reference hosting, X-API-Key auth, single paid submit, polling, expiry and error redaction passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
