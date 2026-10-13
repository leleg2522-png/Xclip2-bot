import assert from 'node:assert/strict';
import { generateRenderful1080, type RenderfulUpscaleDependencies } from '../src/renderful-auto-upscale';

const rejection = (status: number, data = {}) =>
  Object.assign(Error('rejected'), { response: { status, data } });

function harness(failure?: string) {
  const events = { disabled: [] as string[], submissions: [] as string[],
    downloads: 0, published: 0, normalized: 0, logs: [] as string[] };
  const deps: RenderfulUpscaleDependencies = {
    key: async skip => failure === 'empty' ? null : ['a', 'b'].find(key => !skip.has(key)) ?? null,
    disable: async key => { events.disabled.push(key); },
    download: async () => {
      events.downloads++;
      if (failure === 'download' || (failure === 'output-download' && events.downloads > 1)) throw Error('download');
      return Buffer.from('video');
    },
    inspect: async () => ({
      width: failure === 'already1080' ? 1920 : 854,
      height: failure === 'already1080' ? 1080 : 480,
      duration: failure === 'invalid-source' ? NaN : 15,
    }),
    publish: async () => {
      events.published++;
      if (failure === 'input-publish' || (failure === 'output-publish' && events.published > 1)) throw Error('publish');
      return 'https://bot.example.test/dl/media';
    },
    submit: async (key, url) => {
      assert.equal(url, 'https://bot.example.test/dl/media');
      events.submissions.push(key);
      if (failure === 'submit-rotate' && key === 'a') throw rejection(402);
      if (failure === 'auth-rotate' && key === 'a') throw rejection(401);
      if (failure === 'timeout') throw Error('timeout');
      if (failure === 'missing-id') return {};
      if (failure === 'accepted-error') throw rejection(402, { id: 'accepted' });
      if (failure === 'content-403') throw rejection(403, { code: 'content_blocked' });
      if (failure === 'rate-limit') throw rejection(429);
      return { id: 'accepted', pollUrl: '/api/v1/generations/accepted' };
    },
    poll: async (_key, id, url) => {
      assert.equal(id, 'accepted');
      assert.equal(url, '/api/v1/generations/accepted');
      if (failure === 'poll') throw Error('failed');
      if (failure === 'poll-auth') throw rejection(401);
      if (failure === 'poll-billing') throw rejection(402);
      return 'https://provider.example.test/output';
    },
    normalize: async () => {
      events.normalized++;
      if (failure === 'dimensions') throw Error('OUTPUT_MISMATCH');
      return Buffer.from('1080');
    },
    log: event => { events.logs.push(event); },
  };
  return { events, run: () => generateRenderful1080('https://source.example.test/native', deps) };
}

async function main() {
  const success = harness();
  assert.deepEqual(await success.run(), { url: 'https://bot.example.test/dl/media', upscaled: true });
  assert.deepEqual(success.events.submissions, ['a']);
  assert.equal(success.events.normalized, 1);
  assert.equal(success.events.published, 2);
  for (const failure of ['empty', 'download', 'invalid-source', 'input-publish', 'timeout', 'missing-id',
    'accepted-error', 'content-403', 'rate-limit', 'poll', 'poll-auth', 'poll-billing',
    'output-download', 'dimensions', 'output-publish']) {
    const h = harness(failure);
    assert.deepEqual(await h.run(), { url: 'https://source.example.test/native', upscaled: false }, failure);
    assert.ok(h.events.submissions.length <= 1, `${failure}: never replay accepted/ambiguous job`);
    if (['accepted-error', 'poll-auth', 'poll-billing'].includes(failure)) {
      assert.deepEqual(h.events.disabled, ['a']);
    }
    if (['content-403', 'rate-limit', 'timeout'].includes(failure)) assert.deepEqual(h.events.disabled, []);
  }
  for (const failure of ['submit-rotate', 'auth-rotate']) {
    const h = harness(failure);
    assert.equal((await h.run()).upscaled, true);
    assert.deepEqual(h.events.submissions, ['a', 'b']);
    assert.deepEqual(h.events.disabled, ['a']);
    assert.equal(h.events.published, 2, 'Reuse hosted input on definite pre-submit rejection');
  }
  const hd = harness('already1080');
  assert.deepEqual(await hd.run(), { url: 'https://source.example.test/native', upscaled: true });
  assert.equal(hd.events.submissions.length, 0);
  assert.equal(hd.events.published, 0);
  console.log('Renderful automatic 1080p: pool, pre-submit rotation, no paid replay and native fallback passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
