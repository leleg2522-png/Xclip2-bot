import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ts from 'typescript';
import { generateXclipMotionFlora, resolveXclipMotionModel, type XclipMotionApi } from '../src/xclip-motion-flora';
import { XCLIP_MOTION, prepareXclipMotionReference, xclipMotionVideoError, type XclipMotionReference } from '../src/xclip-motion-media';

const source = fs.readFileSync(path.resolve(__dirname, '../src/index.ts'), 'utf8');
const compile = (text: string) => ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const catalog = { models: [{
  model_id: 'm2v-wan-3-0-gateway', type: 'video', capabilities: ['mixed-to-video'],
  params: [
    ...['image_urls', 'video_urls', 'audio_urls'].map(name => ({ name, type: 'string[]' })),
    { name: 'duration', options: ['3', '10', '11', '15', '30'].map(value => ({ value })) },
    { name: 'resolution', options: [{ value: '480p' }] },
    { name: 'aspect_ratio', options: ['9:16', '16:9'].map(value => ({ value })) },
  ],
}] };
const media = (name: string, mime: string) => ({ buf: Buffer.from(name), name, mime });
const reference: XclipMotionReference = {
  video: media('reference.mp4', 'video/mp4'), audio: media('reference.mp3', 'audio/mpeg'),
  referenceSeconds: 11.2, outputSeconds: 11, ratio: '9:16',
};
const input = { image: media('character.jpg', 'image/jpeg'), reference, prompt: 'Keep the camera fixed.' };

function harness(failure?: string) {
  const events = { keys: [] as string[], submissions: [] as any[], uploads: [] as string[], polls: [] as string[], dead: [] as string[], statuses: [] as string[] };
  const api: XclipMotionApi = {
    getKey: async skip => {
      const key = skip.has('first') ? 'second' : 'first'; events.keys.push(key); return key;
    },
    markDead: async key => { events.dead.push(key); },
    workspace: async key => {
      if (failure === 'workspace' && key === 'first') throw Error('FLORA_NO_PROJECT: missing');
      return { workspaceId: 'ws', projectId: 'prj' };
    },
    models: async () => failure === 'catalog' ? { models: [] } : catalog,
    upload: async (key, _ws, _buf, name) => {
      events.uploads.push(name);
      if (failure === 'upload-auth' && key === 'first') throw Error('401 unauthorized');
      return `https://example.test/${name}`;
    },
    generate: async (key, _ws, model, params, prompt, type) => {
      events.submissions.push({ key, model, params, prompt, type });
      if (failure === 'submit-timeout') throw Error('ETIMEDOUT');
      return 'run_paid';
    },
    poll: async (_key, run, budget) => {
      assert.equal(budget, 20 * 60 * 1000); events.polls.push(run);
      if (failure === 'poll-auth') throw Error('401 unauthorized');
      if (failure === 'billing') throw Error('BILLING_NOT_ENOUGH_CREDITS');
      return 'https://example.test/native480.mp4';
    },
    exhausted: error => /401|BILLING_NOT_ENOUGH_CREDITS/.test(String(error)),
    status: async text => { events.statuses.push(text); },
  };
  return { api, events };
}

async function contractTests() {
  assert.equal(xclipMotionVideoError(1000, 3), undefined);
  assert.equal(xclipMotionVideoError(1000, 15), undefined);
  for (const seconds of [2, 16, 30, NaN]) assert.ok(xclipMotionVideoError(1000, seconds));
  assert.ok(xclipMotionVideoError(16 * 1024 * 1024, 10));
  assert.equal(resolveXclipMotionModel(catalog, 11, '9:16', true), 'm2v-wan-3-0-gateway');
  assert.throws(() => resolveXclipMotionModel(catalog, 12, '9:16', true), /XCLIP_MODEL_UNSUPPORTED/);
  const h = harness();
  assert.equal(await generateXclipMotionFlora(input, h.api), 'https://example.test/native480.mp4');
  assert.equal(h.events.submissions.length, 1);
  const job = h.events.submissions[0];
  assert.equal(job.model, 'm2v-wan-3-0-gateway'); assert.equal(job.type, 'video');
  assert.deepEqual(job.params.image_urls, ['https://example.test/character.jpg']);
  assert.deepEqual(job.params.video_urls, ['https://example.test/reference.mp4']);
  assert.deepEqual(job.params.audio_urls, ['https://example.test/reference.mp3']);
  assert.equal(job.params.duration, '11'); assert.equal(job.params.resolution, '480p');
  assert.equal(job.params.aspect_ratio, '9:16');
  assert.match(job.prompt, /Image 1/); assert.match(job.prompt, /Video 1/); assert.match(job.prompt, /Audio 1/);
  assert.match(job.prompt, /Keep the camera fixed/);
  assert.doesNotMatch(h.events.statuses.join(' '), /Flora|Wan|Kling|1080|upscale/i);
  const silent = harness();
  await generateXclipMotionFlora({ ...input, reference: { ...reference, audio: undefined } }, silent.api);
  assert.equal(silent.events.submissions[0].params.audio_urls, undefined);
  assert.equal(silent.events.uploads.length, 2);
  const boundary = harness();
  await generateXclipMotionFlora({ ...input, reference: { ...reference, referenceSeconds: 15, outputSeconds: 15 } }, boundary.api);
  assert.equal(boundary.events.submissions[0].params.duration, '15');
  const invalid = harness();
  await assert.rejects(generateXclipMotionFlora({ ...input, reference: { ...reference, referenceSeconds: 30 } }, invalid.api), /XCLIP_REFERENCE_DURATION/);
  assert.equal(invalid.events.keys.length, 0);
  for (const failure of ['poll-auth', 'billing', 'submit-timeout', 'catalog']) {
    const fail = harness(failure);
    await assert.rejects(generateXclipMotionFlora(input, fail.api));
    assert.equal(fail.events.keys.length, 1, `No replay after ${failure}`);
    assert.equal(fail.events.submissions.length, failure === 'catalog' ? 0 : 1);
    if (failure === 'poll-auth' || failure === 'billing') assert.deepEqual(fail.events.dead, ['first']);
  }
  for (const failure of ['upload-auth', 'workspace']) {
    const retry = harness(failure);
    await generateXclipMotionFlora(input, retry.api);
    assert.deepEqual(retry.events.keys, ['first', 'second']);
    assert.equal(retry.events.submissions.length, 1);
  }
}

async function billingTests(outcome: string) {
  const events = { charges: [] as number[], refunds: [] as number[], releases: 0, successes: 0, submissions: 0, deliveries: 0, messages: [] as string[] };
  const ctx = vm.createContext({
    Buffer, MODEL_PRICES: { xclip_motion: 2500 }, XCLIP_MOTION, xclipMotionVideoError,
    beginCharge: async (_id: number, amount: number) => { events.charges.push(amount); return { ok: outcome !== 'insufficient', reason: 'insufficient' }; },
    chargeFailMsg: () => 'Saldo tidak cukup',
    bot: { telegram: {
      editMessageText: async (_chat: number, _msg: number, _unused: any, text: string) => { events.messages.push(text); },
      sendMessage: async (_chat: number, text: string) => { events.messages.push(text); },
      deleteMessage: async () => {}, getFileLink: async (id: string) => ({ href: `https://example.test/${id}` }),
    } },
    downloadBuffer: async () => ({ buf: Buffer.from('fixture'), ext: 'jpg', mime: 'image/jpeg' }),
    sharp: () => ({ metadata: async () => ({ format: 'jpeg', width: 600, height: 800 }) }),
    prepareXclipMotionReference: async () => {
      if (outcome === 'actual-duration') throw Error('XCLIP_REFERENCE_DURATION');
      return reference;
    },
    generateXclipMotionFlora: async () => {
      events.submissions++;
      if (outcome === 'provider') throw Error('Flora error https://provider.example.test/private');
      return 'https://example.test/native480.mp4';
    },
    getNextFloraKey() {}, markFloraKeyDead() {}, floraGetWorkspace() {}, floraUploadAsset() {}, floraGenerate() {}, floraPollRun() {},
    isFloraKeyExhaustedError: () => false,
    sendResult: async (_chat: number, url: string, caption: string) => {
      events.deliveries++; assert.equal(url, 'https://example.test/native480.mp4');
      assert.match(caption, /Xclip Motion.*11 detik.*480p/);
      assert.doesNotMatch(caption, /1080|Wan|Flora|Kling/i);
      return outcome !== 'delivery';
    },
    upscaleGeneratedVideo: async () => { assert.fail('Xclip Motion must never upscale'); },
    addSaldo: async (_id: number, amount: number) => { events.refunds.push(amount); },
    releaseGenerating: () => { events.releases++; }, markGenSuccess: () => { events.successes++; },
    formatRupiah: () => 'Rp2.500', describeError: () => 'sanitized',
    console: { error() {} },
  });
  const start = source.indexOf('async function runXclipMotion(');
  const end = source.indexOf('// ─── Background: Kling Motion V3 Standard', start);
  vm.runInContext(compile(source.slice(start, end)), ctx);
  await ctx.runXclipMotion(1, 2, 3, 4, 'photo', 'video', outcome === 'metadata-duration' ? 30 : undefined, 'move');
  assert.deepEqual(events.charges, outcome === 'metadata-duration' ? [] : [2500]);
  assert.deepEqual(events.refunds, ['success', 'insufficient', 'metadata-duration'].includes(outcome) ? [] : [2500]);
  assert.equal(events.releases, ['insufficient', 'metadata-duration'].includes(outcome) ? 0 : 1);
  assert.equal(events.successes, outcome === 'success' ? 1 : 0);
  assert.equal(events.deliveries, ['success', 'delivery'].includes(outcome) ? 1 : 0);
  assert.doesNotMatch(events.messages.join(' '), /Flora|Wan|Kling|provider\.example/i);
}

async function realMediaTests() {
  const exec = promisify(execFile);
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'xclip-test-'));
  try {
    async function fixture(seconds: number, audio: boolean) {
      const file = path.join(dir, `source-${seconds}-${audio}.mp4`);
      await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=256x448:rate=30',
        ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100'] : []),
        '-t', String(seconds), '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
        ...(audio ? ['-c:a', 'aac'] : ['-an']), file], { timeout: 60000 });
      return fsp.readFile(file);
    }
    const prepared = await prepareXclipMotionReference(await fixture(15, true));
    assert.equal(prepared.outputSeconds, 15); assert.equal(prepared.referenceSeconds, 15);
    assert.equal(prepared.ratio, '9:16'); assert.ok(prepared.audio);
    for (const [name, buf] of [['video.mp4', prepared.video.buf], ['audio.mp3', prepared.audio!.buf]] as const) {
      const file = path.join(dir, name); await fsp.writeFile(file, buf);
      const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file]);
      assert.ok(Number(JSON.parse(stdout).format.duration) <= 15, `${name} exceeds upstream limit`);
    }
    const silent = await prepareXclipMotionReference(await fixture(3, false));
    assert.equal(silent.outputSeconds, 3); assert.equal(silent.audio, undefined);
    await assert.rejects(prepareXclipMotionReference(await fixture(16, false)), /XCLIP_REFERENCE_DURATION/);
    await assert.rejects(prepareXclipMotionReference(await fixture(2, false)), /XCLIP_REFERENCE_DURATION/);
  } finally { await fsp.rm(dir, { recursive: true, force: true }); }
}

async function main() {
  assert.match(source, /Xclip Motion \(3–15 detik · 480p\)/);
  assert.match(source, /Xclip Motion · 480p/);
  assert.match(source, /return runXclipMotion\(/);
  assert.doesNotMatch(source.slice(source.indexOf('async function runXclipMotion('), source.indexOf('// ─── Background: Kling Motion V3 Standard')), /upscaleGeneratedVideo|generateKlingV3StandardFlora/);
  await contractTests();
  for (const outcome of ['success', 'delivery', 'provider', 'insufficient', 'metadata-duration', 'actual-duration']) await billingTests(outcome);
  await realMediaTests();
  console.log('Xclip Motion: live-schema routing, native 480p, 3–15s boundaries, audio/no-audio, refunds, no paid replay and real FFmpeg media checks passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
