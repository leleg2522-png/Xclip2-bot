import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { Telegraf } from 'telegraf';
import { newEpisode, episodeProject, type Bible, type Episode, type EpisodeProject } from '../src/episode-types';
import { validateBible, validateScene, type Director } from '../src/episode-director';
import { EpisodeEngine, type EpisodeStore } from '../src/episode-engine';
import { EpisodeMedia, parseTranscript, dialogueIssues, episodeSrt } from '../src/episode-media';
import { DeapiEpisodeApi, type EpisodeRequest } from '../src/episode-api';
import { registerEpisode, episodeButtons, episodeSummary } from '../src/episode-bot';
import type { DramaProject } from '../src/microdrama-store';

const clone = <T>(v: T): T => v === undefined ? v : JSON.parse(JSON.stringify(v));
function bible(minutes = 1): Bible {
  return validateBible({ title: 'Rahasia Rumah', synopsis: 'Raka mengetahui rahasia keluarganya.', style: 'Warm cinematic realism',
    cast: [{ id: 'RAKA', name: 'Raka', age: 30, look: 'Short black hair, navy shirt, square face', voice: 'Low calm male voice', personality: 'Protective' }],
    locations: [{ id: 'HOUSE', description: 'Small living room, wooden table, amber lamp on the left' }],
    beats: Array.from({ length: minutes * 2 }, (_, i) => ({ objective: `Emotional development ${i}`, location: 'HOUSE', cast: ['RAKA'] })) }, minutes);
}
function scene(e: Episode, n: number) {
  return validateScene({ shots: [0, 1, 2].map(i => ({ camera: 'Medium close-up, static camera',
    action: 'Raka looks at the letter', startState: 'Raka stands beside the table', endState: 'Raka holds the letter',
    imagePrompt: 'Raka beside a wooden table, amber lamp, navy shirt',
    videoPrompt: 'Raka picks up the letter, restrained shock, stable camera',
    continuation: i === 1, dialogue: [{ speaker: 'RAKA', text: 'Aku tahu rahasianya.' }] })) }, e, n);
}
class Store implements EpisodeStore {
  ready = true; rows = new Map<string, DramaProject>(); assets = new Map<string, Buffer>(); locks = new Set<string>(); pauses = new Set<string>();
  async create(owner: number, chat: number, model: string, episode?: Episode) {
    if ([...this.rows.values()].some(p => p.owner === owner && !['cancelled', 'delivered', 'failed'].includes(p.status))) throw new Error('active');
    const p: DramaProject = { id: randomUUID(), owner, chat, model, status: 'idea', jobs: [{}, {}], episode };
    this.rows.set(p.id, clone(p)); return p;
  }
  async model() { return 'gpt-6-luna'; }
  async latest(owner: number) { return clone([...this.rows.values()].filter(p => p.owner === owner).at(-1)); }
  get(id: string) { return episodeProject(clone(this.rows.get(id)!)); }
  async withLock(id: string, owner: number, fn: any) {
    if (this.locks.has(id) || this.rows.get(id)?.owner !== owner) return false;
    this.locks.add(id);
    try { const p = clone(this.rows.get(id)!); await fn(p, async () => { this.rows.set(id, clone(p)); }); return true; }
    finally { this.locks.delete(id); }
  }
  async putAsset(id: string, name: string, bytes: Buffer) { if (!this.assets.has(id + name)) this.assets.set(id + name, bytes); }
  async asset(id: string, name: string) { const b = this.assets.get(id + name); if (!b) throw new Error('missing'); return b; }
  async requestPause(id: string, owner: number, value = true) { if (this.rows.get(id)?.owner === owner) { if (value) this.pauses.add(id); else this.pauses.delete(id); } }
  async paused(id: string) { return this.pauses.has(id); }
}
function fixture() {
  const store = new Store(), cache = new Map<string, string>();
  const seen = { submit: [] as Array<{ req: EpisodeRequest; keyId: number }>, results: [] as string[], delivered: 0,
    messages: [] as string[], previews: 0, authorized: true, badStory: 0, badVideo: 0, writes: 0 };
  const jobs = new Map<string, EpisodeRequest>();
  const director: Director = {
    async bible(idea, minutes) { seen.writes++; return bible(minutes); },
    async scene(e, n) { return scene(e, n); },
    async review(model, instructions) {
      const bad = instructions.startsWith('Storyboard') ? seen.badStory-- > 0 : seen.badVideo-- > 0;
      return { pass: !bad, issues: bad ? ['Wrong wardrobe'] : [], repair: bad ? 'Restore the navy shirt' : '' };
    },
  };
  const api = {
    async quote(r: EpisodeRequest) { return { price: r.kind === 'image' ? 0.007 : r.kind === 'video' ? 0.218 : 0.005, keyId: 9 }; },
    async submit(req: EpisodeRequest, keyId: number) {
      const persisted = [...store.rows.values()].find(p => !!p.episode)!;
      const all = [...Object.values(persisted.episode!.refs), ...persisted.episode!.shots.flatMap(w => w.takes.flatMap(t => [t.image, t.video, t.transcriptJob]))];
      assert.ok(all.some(j => j.attempted && j.keyId === keyId && !j.id), 'Write-ahead account marker required BEFORE submit');
      seen.submit.push({ req, keyId }); const id = `job-${seen.submit.length}`; jobs.set(id, req); return id;
    },
    async result(id: string, keyId: number) {
      assert.equal(keyId, 9); seen.results.push(id);
      return jobs.get(id)?.kind === 'transcript' ? Buffer.from(JSON.stringify({ segments: [{ start: 0.4, end: 3.6, text: 'Aku tahu rahasianya.' }] })) : Buffer.from(id);
    },
  };
  const media = {
    async check() {}, async jpeg(b: Buffer) { return b; }, async placeholder() { return Buffer.from('frame'); },
    async cache(id: string, shot: number, take: number, bytes?: Buffer) {
      const key = `${id}_${shot}_${take}`; if (bytes) cache.set(key, key); return cache.get(key);
    },
    async frame() { return Buffer.from('lastframe'); }, async audio() { return Buffer.from('audio'); }, async probe() {},
    async assemble(p: EpisodeProject, files: string[]) { assert.equal(files.length, p.episode.minutes * 6); return { video: 'episode.mp4', subtitles: 'episode.srt' }; },
    async cleanup() {},
  };
  const deps = { store, api, director, media: media as any as EpisodeMedia, authorized: async () => seen.authorized,
    notify: async (p: EpisodeProject, text: string) => { seen.messages.push(text); }, present: async () => {},
    preview: async () => { seen.previews++; }, deliver: async () => { seen.delivered++; } };
  return { store, seen, api, media, director, deps, engine: new EpisodeEngine(deps), cache };
}
async function prepared(f: ReturnType<typeof fixture>, minutes = 1) {
  const p = await f.store.create(42, 42, 'gpt-6-luna', newEpisode(minutes));
  await f.engine.act(p.id, 42, 'write', 'Seorang pria menemukan surat.');
  await f.engine.act(p.id, 42, 'quote_refs'); assert.equal(f.seen.submit.length, 0);
  await f.engine.act(p.id, 42, 'make_refs'); assert.equal(f.seen.submit.length, 2);
  await f.engine.act(p.id, 42, 'lock_refs'); assert.equal(f.seen.submit.length, 2);
  await f.engine.act(p.id, 42, 'quote'); assert.equal(f.seen.submit.length, 2);
  return f.store.get(p.id);
}
async function workflow() {
  for (const n of [1, 2, 7, 20]) {
    const e = newEpisode(n); e.bible = bible(n);
    assert.equal(e.bible.beats.length, n * 2);
    for (let s = 0; s < n * 2; s++) e.shots.push(...scene(e, s).map(shot => ({ shot, takes: [] })));
    assert.equal(e.shots.length, n * 6);
    assert.equal(e.shots.filter(w => w.shot.continuation).length, n * 2);
  }
  for (const n of [0, 21, 1.5, NaN]) assert.throws(() => newEpisode(n));
  {
    const f = fixture(), p = await prepared(f);
    await f.engine.act(p.id, 42, 'render');
    const final = f.store.get(p.id), e = final.episode;
    assert.equal(final.status, 'delivered'); assert.equal(e.shots.length, 6);
    assert.equal(f.seen.submit.filter(s => s.req.kind === 'video').length, 6);
    assert.equal(f.seen.submit.filter(s => s.req.kind === 'image').length, 6, '2 references + 4 anchor frames');
    assert.equal(f.seen.submit.filter(s => s.req.kind === 'transcript').length, 6);
    assert.ok(e.spent <= e.budget!); assert.equal(f.seen.delivered, 1);
    assert.equal(e.shots.filter(w => w.accepted !== undefined).length, 6);
    assert.ok(episodeSrt(final).includes('00:00:50,400'));
    await f.engine.act(p.id, 42, 'render'); await f.engine.act(p.id, 42, 'resume');
    assert.equal(f.seen.submit.length, 18); assert.equal(f.seen.delivered, 1);
  }
  {
    const f = fixture(), p = await prepared(f);
    let attempts = 0;
    f.api.submit = async () => { attempts++; throw new Error('ambiguous timeout'); };
    await f.engine.act(p.id, 42, 'render'); assert.equal(f.store.get(p.id).status, 'uncertain');
    await f.engine.act(p.id, 42, 'resume'); await f.engine.act(p.id, 42, 'render');
    assert.equal(attempts, 1, 'Ambiguous paid submit must never replay');
  }
  {
    const f = fixture(), p = await prepared(f), result = f.api.result;
    let once = true;
    f.api.result = async (id, key) => { if (id === 'job-4' && once) { once = false; throw new Error('poll auth lost'); } return result(id, key); };
    await f.engine.act(p.id, 42, 'render'); assert.equal(f.store.get(p.id).status, 'paused');
    const submits = f.seen.submit.length;
    await new EpisodeEngine(f.deps).act(p.id, 42, 'resume');
    assert.equal(f.store.get(p.id).status, 'delivered'); assert.equal(f.seen.submit.length, 18);
    assert.ok(f.seen.results.filter(id => id === 'job-4').length >= 1);
    assert.equal(submits, 4);
  }
  {
    const f = fixture(), p = await prepared(f), submit = f.api.submit;
    f.api.submit = async (r, key) => { const id = await submit(r, key); if (r.kind === 'video') await f.store.requestPause(p.id, 42); return id; };
    await f.engine.act(p.id, 42, 'render');
    assert.equal(f.store.get(p.id).status, 'paused'); assert.equal(f.seen.submit.length, 4);
    await f.store.requestPause(p.id, 42, false); f.api.submit = submit;
    await f.engine.act(p.id, 42, 'resume'); assert.equal(f.store.get(p.id).status, 'delivered'); assert.equal(f.seen.submit.length, 18);
  }
  {
    const f = fixture(), p = await prepared(f), price = f.api.quote;
    f.api.quote = async r => { const q = await price(r); return { ...q, price: q.price * 2 }; };
    await f.engine.act(p.id, 42, 'render'); assert.equal(f.seen.submit.length, 2); assert.equal(f.store.get(p.id).status, 'paused');
  }
  {
    const f = fixture(), p = await prepared(f);
    f.seen.badStory = 5;
    await f.engine.act(p.id, 42, 'render');
    assert.equal(f.store.get(p.id).episode.phase, 'quality_hold');
    assert.equal(f.seen.submit.filter(s => s.req.kind === 'video').length, 0, 'Rejected storyboard must not reach video submit');
    assert.equal(f.store.get(p.id).episode.retakes, 1);
    await f.engine.act(p.id, 42, 'retry', '1');
    assert.equal(f.store.get(p.id).episode.retakes, 2);
    const count = f.seen.submit.length;
    await f.engine.act(p.id, 42, 'retry', '1'); assert.equal(f.seen.submit.length, count, 'No third retake');
  }
  {
    const f = fixture(), p = await prepared(f);
    f.seen.badVideo = 2;
    await f.engine.act(p.id, 42, 'render'); assert.equal(f.store.get(p.id).episode.phase, 'quality_hold');
    await f.engine.act(p.id, 42, 'accept', '1');
    assert.equal(f.store.get(p.id).status, 'delivered');
    assert.equal(f.store.get(p.id).episode.shots[0].takes[1].quality!.overridden, true);
  }
  {
    const f = fixture(), p = await prepared(f);
    f.seen.authorized = false;
    await assert.rejects(() => f.engine.act(p.id, 42, 'render'));
    assert.equal(f.seen.submit.length, 2);
    assert.equal(await f.engine.act(p.id, 99, 'render'), false);
  }
  {
    const f = fixture(), p = await prepared(f);
    let tries = 0; f.deps.deliver = async () => { if (++tries === 1) throw new Error('telegram timeout'); };
    await f.engine.act(p.id, 42, 'render'); assert.equal(f.store.get(p.id).episode.phase, 'complete');
    f.cache.clear(); await f.engine.act(p.id, 42, 'resume');
    assert.equal(f.store.get(p.id).status, 'delivered'); assert.equal(f.seen.submit.length, 18, 'Delivery retry/cache loss cannot resubmit');
  }
  {
    const f = fixture(), p = await f.store.create(42, 42, 'gpt-6-luna', newEpisode(1));
    f.director.bible = async () => { throw new Error('LLM timeout'); };
    await f.engine.act(p.id, 42, 'write', 'story'); assert.equal(f.store.get(p.id).episode.busy, 'bible');
    await f.engine.act(p.id, 42, 'write', 'story'); assert.equal(f.store.get(p.id).episode.llmCalls, 1);
    await f.engine.act(p.id, 42, 'recover');
    f.director.bible = async () => bible(1); await f.engine.act(p.id, 42, 'write', 'story');
    assert.equal(f.store.get(p.id).episode.phase, 'bible');
  }
  console.log('PASS 1–20 minute planning, approvals, reference locking, replay safety, budgets, pause/resume, QA, retakes, delivery and roles');
}
async function contracts() {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  let priceOnly = false, failSubmit = false;
  const source = { next: async () => ({ id: 9, apiKey: 'fixture' }), get: async () => ({ id: 9, apiKey: 'fixture' }),
    disable: async () => false, markLimited: async () => {} };
  const api = new DeapiEpisodeApi(source, (async (url: any, init: any) => {
    seen.push({ url, init });
    if (failSubmit && !url.endsWith('/price')) throw new Error('socket');
    return new Response(JSON.stringify({ data: url.endsWith('/price') ? { price: 0.005, ...(priceOnly ? {} : { is_estimated: false }) } : { request_id: 'bound-job' } }));
  }) as typeof fetch);
  const b = Buffer.from('jpeg');
  await api.quote({ kind: 'image', prompt: 'single frame', images: [b, b, b], seed: 1 });
  const f = seen.at(-1)!.init.body as FormData;
  assert.equal(f.getAll('images[]').length, 3); assert.equal(f.get('model'), 'Flux_2_Klein_4B_BF16');
  await api.submit({ kind: 'video', prompt: 'native audio', images: [b], seed: 1 }, 9);
  assert.ok((seen.at(-1)!.init.body as FormData).get('first_frame_image'));
  priceOnly = true;
  await api.quote({ kind: 'transcript', prompt: '', seed: 1 });
  assert.equal((seen.at(-1)!.init.body as FormData).get('duration_seconds'), '10');
  await assert.rejects(() => api.quote({ kind: 'image', prompt: 'frame', seed: 1 }));
  failSubmit = true;
  const before = seen.length;
  await assert.rejects(() => api.submit({ kind: 'video', prompt: 'x', images: [b], seed: 1 }, 9));
  assert.equal(seen.length, before + 1);
  const transcript = parseTranscript(Buffer.from('{"segments":[{"start":0.4,"end":3.6,"text":"Aku tahu rahasianya."}]}'));
  const e = newEpisode(1); e.bible = bible();
  const w = { shot: scene(e, 0)[0], takes: [] };
  assert.deepEqual(dialogueIssues(w, transcript), []);
  assert.ok(dialogueIssues(w, [{ start: 0, end: 2, text: 'Kalimat yang salah.' }]).length);
  console.log('PASS image multi-reference, I2V, transcription price-only schema and no submit retries');
}
async function telegram() {
  const f = fixture(), bot = new Telegraf('fixture:token');
  bot.botInfo = { id: 999, is_bot: true, first_name: 'Fixture', username: 'fixture', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false } as any;
  const sent: any[] = [];
  (bot.telegram as any).callApi = async (method: string, data: any) => { sent.push({ method, data }); return { message_id: 1 }; };
  // Telegraf creates an isolated Telegram client for each update; intercept that too.
  const original = Object.getPrototypeOf(bot.telegram).callApi;
  Object.getPrototypeOf(bot.telegram).callApi = (bot.telegram as any).callApi;
  const prior = process.env.BUATSIMPEL_API_KEY; process.env.BUATSIMPEL_API_KEY = 'fixture';
  let admin = true, update = 0;
  try {
    registerEpisode(bot, f.store as any, async () => admin, async () => admin, f.api, f.deps.deliver,
      { director: f.director, media: f.media as any });
    async function message(value: string, owner = 42, type = 'private') {
      const command = value.startsWith('/') ? [{ offset: 0, length: value.split(' ')[0].length, type: 'bot_command' }] : undefined;
      await bot.handleUpdate({ update_id: ++update, message: { message_id: update, date: 1, chat: { id: owner, type }, from: { id: owner, is_bot: false, first_name: 'Test' }, text: value, entities: command } } as any);
      await new Promise(r => setTimeout(r, 30));
    }
    await message('/microdrama 7'); assert.equal((await f.store.latest(42))?.episode?.minutes, 7);
    await message('Rahasia surat di ruang tamu.'); assert.equal((await f.store.latest(42))?.episode?.phase, 'bible');
    await message('/microdrama 21', 43); assert.equal(await f.store.latest(43), undefined);
    await message('/microdrama 1', 44, 'group'); assert.equal(await f.store.latest(44), undefined);
    admin = false; await message('/microdrama 1', 45); assert.equal(await f.store.latest(45), undefined);
    const p = f.store.get((await f.store.latest(42))!.id);
    assert.ok(JSON.stringify(episodeButtons(p)).includes('quote_refs')); assert.ok(episodeSummary(p).includes('7 menit'));
    assert.ok(!JSON.stringify(sent).includes('parse_mode'), 'Model text must remain plain Telegram text');
    assert.equal(f.seen.submit.length, 0);
  } finally { Object.getPrototypeOf(bot.telegram).callApi = original; if (prior === undefined) delete process.env.BUATSIMPEL_API_KEY; else process.env.BUATSIMPEL_API_KEY = prior; }
  console.log('PASS real Telegraf command/input routing, admin/private guards, durations and plain-text rendering');
}
async function ffmpeg() {
  const exec = promisify(execFile), media = new EpisodeMedia(), id = randomUUID(), dir = await media.directory(id);
  try {
    await media.check();
    const source = dir + '/source.mp4';
    await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=768x1344:r=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '10.1', '-threads', '2',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source], { timeout: 90_000 });
    await media.probe(source); assert.ok((await media.frame(source, 8.5)).length); assert.ok((await media.audio(source)).length);
    const e = newEpisode(1); e.bible = bible();
    for (let n = 0; n < 2; n++) e.shots.push(...scene(e, n).map(shot => ({ shot, accepted: 0,
      takes: [{ image: {}, video: {}, transcriptJob: {}, transcript: [{ start: 0.4, end: 2.5, text: 'Aku tahu rahasianya.' }] }] })));
    const p = { id, owner: 42, chat: 42, status: 'ready', model: 'fixture', jobs: [], episode: e } as EpisodeProject;
    const out = await media.assemble(p, Array(6).fill(source));
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', out.video]);
    const data = JSON.parse(stdout);
    assert.ok(Math.abs(Number(data.format.duration) - 60) < 1);
    assert.equal(data.streams.find((s: any) => s.codec_type === 'video').width, 756);
    assert.ok(data.streams.some((s: any) => s.codec_type === 'subtitle'));
    assert.ok((await fs.readFile(out.subtitles, 'utf8')).includes('00:00:50,400'));
  } finally { await media.cleanup(id); }
  console.log('PASS real 60-second 9:16 episode assembly, native audio normalization and timestamped subtitles');
}
(async () => { await workflow(); await contracts(); await telegram(); await ffmpeg(); })()
  .catch(e => { console.error(e); process.exitCode = 1; });
