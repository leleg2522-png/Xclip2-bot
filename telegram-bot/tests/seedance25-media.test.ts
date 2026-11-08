import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import vm from 'node:vm';
import ts from 'typescript';
import * as limits from '../src/seedance25-picsart';
import { inspectFloraSeedance25Video, inspectSeedance25Media } from '../src/seedance25-media';

const exec = promisify(execFile);
const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
function fragment(start: string, end: string) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a);
  return source.slice(a, b);
}
function compile(text: string) {
  return ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}
const handler = compile(fragment('async function handleSeedance25Reference(', '// Label model gambar'));
const done = compile(`async function done(ctx, userId) {
  const data = 'seedance25_inputs_done';
  ${fragment("if (data === 'seedance25_inputs_done') {", "if (data.startsWith('picsart_duration_'))")}
}`);
function harness() {
  let session: any = {
    mode: 'oneover_wait_image', seedance25Step: 'media', seedance25ImageFileIds: [],
    seedance25Videos: [], seedance25Audios: [],
    seedance25Settings: { provider: 'picsart', mode: 'reference', resolution: 1080, audio: true, ratio: '9:16' },
  };
  const messages: string[] = [];
  let duration = 3, invalid = false, reads = 0;
  let gate: Promise<void> = Promise.resolve();
  const context = vm.createContext({
    Buffer, ...limits,
    getSession: () => session,
    setSession: (_: number, data: any) => { session = { ...session, ...data }; },
    telegramHttp: { get: async () => { reads++; await gate; return { data: Buffer.from('media') }; } },
    inspectSeedance25Media: async () => { if (invalid) throw Error('INVALID_MEDIA'); return duration; },
    seedance25InputKeyboard: () => ({}),
  });
  vm.runInContext(handler + done, context);
  const ctx = {
    from: { id: 1 }, telegram: { getFileLink: async () => ({ href: 'https://example.test/ref' }) },
    reply: async (text: string) => { messages.push(text); },
    editMessageText: async (text: string) => { messages.push(text); },
  };
  return {
    session: () => session, messages, reads: () => reads,
    set: (data: any) => { session = { ...session, ...data }; },
    duration: (value: number) => { duration = value; },
    invalid: () => { invalid = true; },
    block: () => { let release!: () => void; gate = new Promise<void>(resolve => { release = resolve; }); return release; },
    add: (kind: 'audio' | 'video', id = 'file', extra: any = {}) =>
      context.handleSeedance25Reference(ctx, kind, {
        file_id: id, mime_type: kind === 'audio' ? 'audio/ogg' : 'video/mp4', duration: 3, ...extra,
      }),
    done: () => context.done(ctx, 1),
  };
}

async function checkBotIntake() {
  const h = harness();
  await h.done(); assert.equal(h.session().mode, 'oneover_wait_image');
  await h.add('audio', 'voice'); await h.add('video', 'video');
  assert.equal(h.session().seedance25Audios[0].mime, 'audio/ogg');
  assert.equal(h.session().seedance25Videos[0].duration, 3);
  assert.equal(h.session().seedance25Audios[0].fileId, 'voice');
  assert.ok(!JSON.stringify(h.session()).includes('https:'));
  await h.add('audio', 'voice'); assert.equal(h.session().seedance25Audios.length, 1);
  await h.done(); assert.equal(h.session().mode, 'oneover_wait_prompt');
  assert.match(h.messages.at(-1)!, /0 gambar, 1 video, 1 audio/);

  const audioOnly = harness(); await audioOnly.add('audio'); await audioOnly.done();
  assert.equal(audioOnly.session().mode, 'oneover_wait_prompt');
  const full = harness();
  for (let i = 0; i < 10; i++) await full.add('video', String(i));
  assert.equal(full.session().seedance25Videos.length, 10);
  await full.add('video', 'overflow'); assert.equal(full.session().seedance25Videos.length, 10);
  assert.equal(full.reads(), 10);
  const total = harness(); total.duration(16);
  await total.add('audio', '1'); await total.add('audio', '2');
  assert.equal(total.session().seedance25Audios.length, 1);
  const metadata = harness();
  await metadata.add('video', 'size', { file_size: limits.SEEDANCE25_MAX_MEDIA_BYTES + 1 });
  await metadata.add('audio', 'long', { duration: 31 });
  assert.equal(metadata.reads(), 0);
  const bad = harness(); bad.invalid(); await bad.add('audio');
  assert.equal(bad.session().seedance25Audios.length, 0);
  assert.equal(bad.session().seedance25PendingUploads, 0);

  const pending = harness(); const release = pending.block();
  const upload = pending.add('video');
  await pending.done(); assert.equal(pending.session().mode, 'oneover_wait_image');
  assert.match(pending.messages.at(-1)!, /masih diperiksa/);
  release(); await upload; await pending.done();
  assert.equal(pending.session().mode, 'oneover_wait_prompt');
  const cancelled = harness(); const unblock = cancelled.block();
  const old = cancelled.add('audio');
  cancelled.set({ mode: 'idle' }); unblock(); await old;
  assert.equal(cancelled.session().seedance25Audios.length, 0);
  const restarted = harness(); const unblockNew = restarted.block();
  const oldDraft = restarted.add('video');
  restarted.set({ seedance25Settings: { ...restarted.session().seedance25Settings } });
  unblockNew(); await oldDraft; assert.equal(restarted.session().seedance25Videos.length, 0);
  const race = harness();
  await Promise.all([race.add('audio', 'same'), race.add('audio', 'same')]);
  assert.equal(race.session().seedance25Audios.length, 1);
  assert.equal(race.session().seedance25PendingUploads, 0);

  assert.match(source, /handleSeedance25Reference\(ctx, 'video', vid\)/);
  assert.match(source, /handleSeedance25Reference\(ctx, 'audio', ctx.message.audio\)/);
  assert.match(source, /handleSeedance25Reference\(ctx, 'audio', \{\s*\.\.\.ctx.message.voice/);
  assert.match(source, /handleSeedance25Reference\(ctx, 'video', doc\)/);
  assert.match(source, /handleSeedance25Reference\(ctx, 'audio', doc\)/);
  assert.equal(limits.seedance25ReferenceName('audio', 'audio/ogg'), 'reference.ogg');
  assert.equal(limits.seedance25ReferenceName('audio', 'audio/x-wav'), 'reference.wav');
}

async function checkActualBytes() {
  const dir = await mkdtemp(join(tmpdir(), 'seedance25-test-'));
  try {
    const video = join(dir, 'clip.mp4'), videoReference = join(dir, 'reference-2s.mp4');
    const audio = join(dir, 'audio.wav'), long = join(dir, 'long.wav');
    await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=5', '-t', '1', '-c:v', 'libx264', video]);
    await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=5', '-t', '2', '-c:v', 'libx264', videoReference]);
    await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000', '-t', '1', audio]);
    await exec('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=8000', '-t', '31', long]);
    const vb = await readFile(video), videoReferenceBuffer = await readFile(videoReference), ab = await readFile(audio);
    assert.ok(await inspectSeedance25Media(vb, 'video') <= 1.1);
    assert.ok(await inspectSeedance25Media(ab, 'audio') <= 1.1);
    assert.ok(await inspectFloraSeedance25Video(videoReferenceBuffer) >= 1.8);
    await assert.rejects(() => inspectFloraSeedance25Video(vb));
    await assert.rejects(() => inspectFloraSeedance25Video(ab));
    await assert.rejects(() => inspectFloraSeedance25Video(Buffer.from('broken')));
    await assert.rejects(() => inspectFloraSeedance25Video(Buffer.alloc(limits.SEEDANCE25_MAX_MEDIA_BYTES + 1)));
    await assert.rejects(() => inspectSeedance25Media(ab, 'video'));
    await assert.rejects(() => inspectSeedance25Media(vb, 'audio'));
    await assert.rejects(() => inspectSeedance25Media(Buffer.from('broken'), 'video'));
    await assert.rejects(() => inspectSeedance25Media(Buffer.alloc(0), 'audio'));
    await assert.rejects(() => inspectSeedance25Media(Buffer.alloc(limits.SEEDANCE25_MAX_MEDIA_BYTES + 1), 'audio'));
    const lb = await readFile(long);
    await assert.rejects(() => inspectSeedance25Media(lb, 'audio'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
async function main() {
  await checkBotIntake(); await checkActualBytes();
  console.log('PASS Seedance 2.5 media: bot intake, mixed/audio-only refs, caps, duration probes, duplicate/cancel/concurrency guards.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
