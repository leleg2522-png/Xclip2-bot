import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FLORA_AUTO_UPSCALE_MODEL, flora1080Factor, generateFlora1080, supportsFlora1080,
  type FloraAutoUpscaleDependencies,
} from '../src/flora-auto-upscale';
import { inspectFloraUpscaleVideo, normalizeFlora1080 } from '../src/flora-upscale-media';

const model = { model_id: FLORA_AUTO_UPSCALE_MODEL, capabilities: ['video-upscaler'],
  params: [{ name: 'video_url' }, { name: 'upscale_factor', type: 'float', min: 1, max: 4 }] };
const facts = { width: 854, height: 480, duration: 15 };
const rejection = (status: number, body = {}) => Object.assign(Error('rejected'), { response: { status, data: body } });

function harness(failure?: string) {
  const events = { keys: [] as string[], disabled: [] as string[], submissions: [] as any[],
    uploads: 0, downloads: 0, normalized: 0, published: 0, logs: [] as string[] };
  const deps: FloraAutoUpscaleDependencies = {
    key: async skip => {
      const key = failure === 'empty' ? undefined : ['a', 'b'].find(key => !skip.has(key));
      if (key) events.keys.push(key);
      return key ?? null;
    },
    disable: async key => { events.disabled.push(key); },
    download: async () => {
      events.downloads++;
      if (failure === 'download' || (failure === 'output-download' && events.downloads > 1)) throw Error('download');
      return Buffer.from('video');
    },
    inspect: async () => failure === 'already1080' ? { ...facts, width: 1920, height: 1080 } : facts,
    models: async key => failure === 'catalog' || (failure === 'catalog-rotate' && key === 'a') ? [] : [model],
    workspace: async () => ({ workspaceId: 'ws', projectId: 'prj_test' }),
    upload: async key => {
      events.uploads++;
      if (failure === 'upload-rotate' && key === 'a') throw rejection(401);
      return 'https://flora.example.test/source.mp4';
    },
    generate: async (key, ws, endpoint, params) => {
      events.submissions.push({ key, ws, endpoint, params });
      if (failure === 'submit-rotate' && key === 'a') throw rejection(402);
      if (failure === 'submit-403') throw rejection(403, { code: 'content_blocked' });
      if (failure === 'timeout') throw Error('timeout');
      if (failure === 'accepted-error') throw rejection(402, { run_id: 'accepted' });
      if (failure === 'missing-id') return '';
      return 'accepted';
    },
    poll: async () => {
      if (failure === 'billing') throw Error('FLORA_RUN_FAILED: BILLING_NOT_ENOUGH_CREDITS');
      if (failure === 'poll-auth') throw rejection(401);
      if (failure === 'poll') throw Error('failed');
      return 'https://flora.example.test/output.mp4';
    },
    normalize: async () => {
      events.normalized++;
      if (failure === 'dimensions') throw Error('mismatch');
      return Buffer.from('1080');
    },
    publish: async () => {
      events.published++;
      if (failure === 'publish') throw Error('storage');
      return 'https://bot.example.test/dl/final';
    },
    log: event => { events.logs.push(event); },
  };
  return { events, deps, run: () => generateFlora1080('https://source.example.test/native', deps) };
}

async function testMedia() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flora-upscale-test-'));
  try {
    for (const portrait of [false, true]) {
      const input = path.join(dir, 'input.mp4');
      const output = path.join(dir, 'output.mp4');
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
        `color=c=blue:s=${portrait ? '360x640' : '640x360'}:r=24`,
        '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
        '-t', '0.5', '-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast',
        '-c:a', 'aac', '-pix_fmt', 'yuv420p', input]);
      execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i',
        `color=c=blue:s=${portrait ? '1440x2560' : '2560x1440'}:r=24`,
        '-t', '0.5', '-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', output]);
      const [source, upscaled] = await Promise.all([fs.readFile(input), fs.readFile(output)]);
      const finished = await normalizeFlora1080(source, upscaled);
      const result = await inspectFloraUpscaleVideo(finished);
      assert.equal(Math.min(result.width, result.height), 1080);
      assert.equal(portrait ? result.height : result.width, 1920);
      assert.ok(Math.abs(result.duration - 0.5) < 0.05);
      const file = path.join(dir, 'finished.mp4');
      await fs.writeFile(file, finished);
      const probe = JSON.parse(execFileSync('ffprobe', [
        '-v', 'error', '-show_streams', '-of', 'json', file,
      ], { encoding: 'utf8' }));
      assert.ok(probe.streams.some((stream: any) => stream.codec_type === 'audio'), 'Original audio preserved');
      await assert.rejects(normalizeFlora1080(source, source), /OUTPUT_MISMATCH/, 'Never enlarge a native fallback');
    }
    await assert.rejects(inspectFloraUpscaleVideo(Buffer.alloc(0)), /INVALID_SIZE/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function main() {
  assert.equal(flora1080Factor(facts), 3);
  assert.equal(flora1080Factor({ ...facts, width: 768, height: 1366 }), 2);
  assert.equal(flora1080Factor({ ...facts, width: 1080, height: 1920 }), 1);
  assert.throws(() => flora1080Factor({ ...facts, width: 256, height: 454 }), /SOURCE_TOO_SMALL/);
  assert.throws(() => flora1080Factor({ ...facts, duration: NaN }), /INVALID_VIDEO/);
  assert.equal(supportsFlora1080([model], 3), true);
  assert.equal(supportsFlora1080([model], 5), false);
  assert.equal(supportsFlora1080([], 2), false);
  const success = harness();
  assert.deepEqual(await success.run(), { url: 'https://bot.example.test/dl/final', upscaled: true });
  assert.equal(success.events.submissions.length, 1);
  assert.deepEqual(success.events.submissions[0].params,
    { video_url: 'https://flora.example.test/source.mp4', upscale_factor: 3 });
  assert.equal(success.events.submissions[0].endpoint, 'video-upscaler-topaz');
  assert.equal(success.events.normalized, 1);
  for (const stage of ['empty', 'catalog', 'download', 'timeout', 'missing-id', 'accepted-error',
    'submit-403', 'poll', 'poll-auth', 'billing', 'output-download', 'dimensions', 'publish']) {
    const test = harness(stage);
    assert.deepEqual(await test.run(), { url: 'https://source.example.test/native', upscaled: false }, stage);
    assert.ok(test.events.submissions.length <= 1, `${stage}: Never resubmit an accepted/ambiguous paid job`);
    if (['billing', 'poll-auth', 'accepted-error'].includes(stage)) assert.deepEqual(test.events.disabled, ['a']);
    if (stage === 'submit-403') assert.deepEqual(test.events.disabled, []);
  }
  for (const stage of ['upload-rotate', 'submit-rotate', 'catalog-rotate']) {
    const test = harness(stage);
    assert.equal((await test.run()).upscaled, true);
    assert.equal(test.events.submissions.at(-1)?.key, 'b');
    assert.deepEqual(test.events.disabled, stage === 'catalog-rotate' ? [] : ['a']);
  }
  const native = harness('already1080');
  native.deps.key = async () => { throw Error('Should not need a key'); };
  assert.equal((await native.run()).upscaled, true);
  assert.equal(native.events.submissions.length, 0);
  await testMedia();
  console.log('Flora automatic 1080p finishing: pool, no paid replay, native fallback, dimensions and audio passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
