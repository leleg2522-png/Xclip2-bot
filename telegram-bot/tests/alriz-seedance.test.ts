import assert from 'node:assert/strict';
import { buildAlrizSeedance25, generateAlrizSeedance25, SEEDANCE25_RATIOS, type Seedance25Settings } from '../src/alriz-seedance';

const settings: Seedance25Settings = { mode: 't2v', resolution: 1080, audio: false, ratio: '21:9' };
const image = 'https://cdn.example.test/start.jpg';
assert.deepEqual(buildAlrizSeedance25(settings, ' hello ', []), {
  model: 'seedance-2.5-t2v', op: 't2v', prompt: 'hello',
  duration: 30, resolution: 1080, audio: false, aspect_ratio: '21:9',
});
for (const ratio of SEEDANCE25_RATIOS) {
  assert.equal(buildAlrizSeedance25({ ...settings, ratio }, 'text', []).aspect_ratio, ratio);
}
assert.deepEqual(buildAlrizSeedance25({ ...settings, mode: 'start', ratio: 'auto' }, 'text', [image]).start_url, image);
const end = buildAlrizSeedance25({ ...settings, mode: 'start_end' }, 'text', [image, image]);
assert.equal(end.end_url, image);
assert.equal(end.resolution, 1080);
assert.throws(() => buildAlrizSeedance25({ ...settings, resolution: 720 as 1080 }, 'text', []), /INVALID_SETTINGS/);
assert.deepEqual(buildAlrizSeedance25({ ...settings, mode: 'reference' }, 'text', [image, image, image]).ref_urls, [image, image, image]);
for (const [mode, count] of [['t2v', 1], ['start', 0], ['start_end', 1], ['reference', 4]] as const) {
  assert.throws(() => buildAlrizSeedance25({ ...settings, mode }, 'text', Array(count).fill(image)), /INVALID_IMAGES/);
}
assert.throws(() => buildAlrizSeedance25({ ...settings, ratio: 'auto' }, 'text', []), /INVALID_SETTINGS/);
assert.throws(() => buildAlrizSeedance25(settings, '', []), /INVALID_SETTINGS/);

async function run(outcome: string) {
  let submits = 0;
  let disables = 0;
  let polls = 0;
  const accepted: string[] = [];
  const status: string[] = [];
  const transport = {
    post: async (_url: string, body: any) => {
      submits++;
      assert.equal(body.model, 'seedance-2.5-t2v');
      if (outcome === 'ambiguous') throw Error('network timeout');
      if (outcome === 'auth' && submits === 1) return { status: 401, data: {} };
      if (outcome === 'missing-id') return { status: 202, data: {} };
      return { status: 202, data: { job_id: 'ALRIZ_TEST_1' } };
    },
    get: async (url: string) => {
      polls++;
      if (outcome === 'poll-auth') return { status: 401, data: {} };
      if (outcome === 'failed') return { status: 200, data: { status: 'FAILED' } };
      if (outcome === 'saving' && polls === 1) return { status: 200, data: { status: 'SAVING' } };
      if (url.endsWith('/result')) return { status: 200, data: { result_url: 'https://cdn.example.test/video.mp4' } };
      return { status: 200, data: { status: 'DONE', result_url: outcome === 'result-endpoint' ? null : 'https://cdn.example.test/video.mp4' } };
    },
  };
  let nextId = 0;
  const api = {
    pool: {
      next: async () => ({ id: ++nextId, apiKey: 'fixture-only' }),
      disable: async () => { disables++; return true; },
    },
    publish: async (_bytes: Buffer) => image,
    status: async (text: string) => { status.push(text); },
    onAccepted: (id: string) => accepted.push(id),
    http: transport,
    wait: async () => {},
    maxPolls: 3,
  };
  let result: string | undefined;
  let error: unknown;
  try { result = await generateAlrizSeedance25({ settings, prompt: 'test', images: [] }, api); }
  catch (e) { error = e; }
  return { submits, disables, polls, accepted, result, error, status };
}
async function main() {
  for (const scenario of ['success', 'auth', 'saving', 'result-endpoint']) {
    const r = await run(scenario);
    assert.equal(r.result, 'https://cdn.example.test/video.mp4');
    assert.equal(r.submits, scenario === 'auth' ? 2 : 1);
    assert.equal(r.disables, scenario === 'auth' ? 1 : 0);
    assert.equal(r.accepted.length, 1);
    assert.ok(r.status.every(x => !x.includes('Alriz')));
  }
  for (const scenario of ['ambiguous', 'missing-id', 'poll-auth', 'failed']) {
    const r = await run(scenario);
    assert.ok(r.error, scenario);
    assert.equal(r.submits, 1, `Do not replay ${scenario}`);
    assert.equal(r.accepted.length, scenario === 'ambiguous' || scenario === 'missing-id' ? 0 : 1);
  }
  console.log('Alriz Seedance 2.5 parameter, mode, and paid-submit safety tests passed');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
