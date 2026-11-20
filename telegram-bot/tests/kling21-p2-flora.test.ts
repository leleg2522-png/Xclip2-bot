import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ALRIZ_KLING_25_P2,
  generateAlrizKling25P2,
  generateAlrizKling25P2FromPool,
} from '../src/alriz-kling-i2v';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

assert.match(source, /kling_21_p2:\s*3000/);
assert.match(source, /Markup\.button\.callback\('🎬 Kling 2\.1 P2 \(10 detik\)', 'mode_kling21p2'\)/);
assert.match(source, /mode:\s*'kling21p2_wait_image'/);
assert.match(source, /mode:\s*'kling21p2_wait_prompt'/);
assert.match(source, /Harga: \*\$\{formatRupiah\(MODEL_PRICES\.kling_21_p2\)\}\*/);

const runnerStart = source.indexOf('async function runKling21P2');
const runnerEnd = source.indexOf('\n// ─── Background: Gemini Omni Flash 1.1', runnerStart);
assert.ok(runnerStart > 0 && runnerEnd > runnerStart, 'Kling 2.1 P2 runner block missing');
const runner = source.slice(runnerStart, runnerEnd);
assert.match(runner, /beginCharge\(dbUserId, PRICE, 3\)/);
assert.match(runner, /generateAlrizKling25P2FromPool/);
assert.match(runner, /pool:\s*alrizKeyPool/);
assert.match(runner, /publishMedia\(bytes, false, undefined, true\)/);
assert.match(runner, /if \(refund\)[\s\S]*addSaldo\(dbUserId, PRICE\)/);
assert.equal(runner.includes('floraUploadImage'), false);
assert.equal(runner.includes('floraGenerate'), false);
assert.equal(runner.includes('Flora AI'), false);

assert.deepEqual(ALRIZ_KLING_25_P2, {
  model: 'kling-2.5-turbo',
  duration: 10,
  resolution: 720,
  credits: 750,
});

function makeHarness(outcome = 'success') {
  const events = {
    submits: 0, reads: 0, published: 0,
    disabled: [] as number[], skipped: [] as number[][], statuses: [] as string[],
  };
  const api = {
    apiKey: 'fixture-private-key',
    maxPolls: 3,
    wait: async (ms: number) => assert.equal(ms, 5000),
    publish: async (bytes: Buffer) => {
      events.published++;
      assert.deepEqual(bytes, Buffer.from('photo'));
      return 'https://our-domain.test/dl/image.jpg';
    },
    status: async (text: string) => { events.statuses.push(text); },
    http: {
      post: async (url: string, body: any, config: any) => {
        events.submits++;
        assert.equal(url, 'https://alrizmotion.my.id/api/jobs');
        assert.equal(config.headers['X-API-Key'], 'fixture-private-key');
        assert.equal(config.headers['Content-Type'], 'application/json');
        assert.equal(config.proxy, false);
        assert.deepEqual(body, {
          model: 'kling-2.5-turbo',
          image_url: 'https://our-domain.test/dl/image.jpg',
          prompt: 'A short scene',
          op: 'i2v',
          duration: 10,
          resolution: 720,
        });
        assert.doesNotMatch(JSON.stringify(body), /fixture-private-key|telegram/i);
        if (outcome === 'submit-timeout') throw Error('ETIMEDOUT fixture-private-key');
        if (outcome === 'submit-401') return { status: 401, data: { private: 'response' } };
        if (outcome === 'submit-503') return { status: 503, data: { private: 'response' } };
        if (outcome === 'missing-job-id') return { status: 202, data: {} };
        return { status: 202, data: { job_id: 'ALRIZ_i2v_test' } };
      },
      get: async (url: string) => {
        events.reads++;
        assert.ok(url.startsWith('https://alrizmotion.my.id/api/jobs/ALRIZ_i2v_test'));
        if (outcome === 'poll-401') return { status: 401, data: {} };
        if (outcome === 'poll-timeout') return { status: 200, data: { status: 'PROCESSING' } };
        return {
          status: 200,
          data: {
            status: 'DONE',
            result_url: outcome === 'bad-result-url' ? 'http://localhost/private' : 'https://cdn.alrizmotion.my.id/result.mp4',
          },
        };
      },
    },
  };
  return { api, events };
}

async function main() {
  {
    const h = makeHarness();
    assert.equal(
      await generateAlrizKling25P2({ image: Buffer.from('photo'), prompt: ' A short scene ' }, h.api),
      'https://cdn.alrizmotion.my.id/result.mp4',
    );
    assert.equal(h.events.submits, 1, 'exactly one paid submit');
    assert.equal(h.events.reads, 1);
    assert.equal(h.events.published, 1);
    assert.doesNotMatch(h.events.statuses.join(' '), /Alriz|provider|fixture-private-key|https?:/i);
  }

  {
    const h = makeHarness('submit-401');
    const poolApi = {
      ...h.api,
      pool: {
        next: async (skipIds: number[]) => {
          h.events.skipped.push([...skipIds]);
          return skipIds.length < 2 ? { id: skipIds.length + 1, apiKey: 'fixture-private-key' } : null;
        },
        disable: async (id: number) => { h.events.disabled.push(id); return true; },
      },
    };
    await assert.rejects(generateAlrizKling25P2FromPool({
      image: Buffer.from('photo'), prompt: 'A short scene',
    }, poolApi), /ALRIZ_POOL_NO_AVAILABLE_KEY/);
    assert.deepEqual(h.events.disabled, [1, 2], 'only explicit rejected keys are disabled');
    assert.equal(h.events.submits, 2);
  }

  for (const outcome of ['submit-timeout', 'submit-503', 'missing-job-id', 'bad-result-url', 'poll-401', 'poll-timeout']) {
    const h = makeHarness(outcome);
    await assert.rejects(generateAlrizKling25P2({
      image: Buffer.from('photo'), prompt: 'A short scene',
    }, h.api), error => {
      assert.doesNotMatch(String(error), /fixture-private-key|ETIMEDOUT|https?:/);
      return true;
    });
    assert.equal(h.events.submits, 1, 'failed/ambiguous submissions are never replayed');
  }

  const invalid = makeHarness();
  await assert.rejects(
    generateAlrizKling25P2({ image: Buffer.alloc(0), prompt: 'Test' }, invalid.api),
    /ALRIZ_INVALID_IMAGE_SIZE/,
  );
  assert.equal(invalid.events.published, 0);
  assert.equal(invalid.events.submits, 0);

  console.log('Kling 2.1 P2 Alriz Kling 2.5 Turbo 720p API and submit-safety tests passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });