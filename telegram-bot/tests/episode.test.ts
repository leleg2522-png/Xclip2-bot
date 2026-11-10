import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import { Telegraf } from 'telegraf';
import {
  EPISODE_MINUTES_MAX, SHOTS_PER_MINUTE, STORY_BEAT_BATCH_SIZE, STORY_BEATS_PER_MINUTE, storyActRanges,
  newEpisode, episodeProject, type Bible, type Episode, type EpisodeProject, type StoryBeat,
} from '../src/episode-types';
import { validateBible, validateBeatBatch, validateScene, lockedPrompt, EpisodeDirector, type Director } from '../src/episode-director';
import { FILM_DIRECTOR_ROLE } from '../src/film-director-role';
import { EpisodeEngine, type EpisodeStore } from '../src/episode-engine';
import { EpisodeMedia, parseTranscript, dialogueIssues, episodeSrt } from '../src/episode-media';
import { DeapiEpisodeApi, type EpisodeRequest } from '../src/episode-api';
import { registerEpisode, episodeButtons, episodeSummary } from '../src/episode-bot';
import type { DramaProject } from '../src/microdrama-store';

const clone = <T>(v: T): T => v === undefined ? v : JSON.parse(JSON.stringify(v));
function bible(minutes = 1, includeBeats = true): Bible {
  return validateBible({ title: 'Rahasia Rumah', synopsis: 'Raka mengetahui rahasia keluarganya.', style: 'Warm cinematic realism',
    arc: {
      prologue: 'Raka discovers a letter in his family home.',
      centralConflict: 'Raka must decide whether to expose the family secret.',
      acts: storyActRanges(minutes).map(a => ({ purpose: `Develop act ${a.number}`, turningPoint: `Turn ${a.number}` })),
      climax: 'Raka confronts the person who hid the truth.',
      epilogue: 'The secret is resolved and Raka chooses a new path.',
      endingType: 'closed',
    },
    cast: [{ id: 'RAKA', name: 'Raka', age: 30, look: 'Short black hair, navy shirt, square face', voice: 'Low calm male voice', personality: 'Protective' }],
    locations: [{ id: 'HOUSE', description: 'Small living room, wooden table, amber lamp on the left' }],
    beats: includeBeats ? Array.from({ length: minutes * STORY_BEATS_PER_MINUTE }, (_, i) =>
      ({ objective: `Emotional development ${i}`, location: 'HOUSE', cast: ['RAKA'] })) : [] }, minutes);
}
function scene(e: Episode, n: number) {
  return validateScene({ shots: [0, 1, 2].map(i => ({ camera: 'Medium close-up, static camera',
    action: 'Raka looks at the letter', startState: 'Raka stands beside the table', endState: 'Raka holds the letter',
    imagePrompt: 'Raka beside a wooden table, amber lamp, navy shirt',
    videoPrompt: 'Raka picks up the letter, restrained shock, stable camera',
    negativePrompt: 'No changing Raka face, no extra fingers gripping the letter, no letter duplication or wrong-speaker mouth movement.',
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
    async beats(e, start, count) {
      const b = e.bible!;
      return Array.from({ length: count }, (_, i) => b.beats[start + i] || {
        objective: `Beat ${start + i + 1} advances the conflict.`,
        location: b.locations[0].id, cast: [b.cast[0].id],
      });
    },
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
    async assemble(p: EpisodeProject, files: string[]) { assert.equal(files.length, p.episode.minutes * SHOTS_PER_MINUTE); return { video: 'episode.mp4', subtitles: 'episode.srt' }; },
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
  for (const n of [1, 2, 7, 15, 20, 30, 100]) {
    const e = newEpisode(n); e.bible = bible(n);
    assert.equal(e.bible.beats.length, n * 2);
    assert.equal(e.bible.arc!.acts.length, n < 3 ? 2 : Math.min(5, Math.max(2, Math.ceil(n / 3))));
    assert.ok(e.bible.arc!.prologue && e.bible.arc!.epilogue);
    for (let s = 0; s < n * 2; s++) e.shots.push(...scene(e, s).map(shot => ({ shot, takes: [] })));
    assert.equal(e.shots.length, n * SHOTS_PER_MINUTE);
    assert.equal(e.shots.filter(w => w.shot.continuation).length, n * STORY_BEATS_PER_MINUTE);
  }
  for (const n of [0, EPISODE_MINUTES_MAX + 1, 1.5, NaN]) assert.throws(() => newEpisode(n));
  {
    const f = fixture(), p = await f.store.create(42, 42, 'gpt-6-luna', newEpisode(100));
    p.episode.bible = bible(100, false); p.episode.refsLocked = true; p.episode.phase = 'planning';
    f.store.rows.set(p.id, clone(p));
    const starts: number[] = []; let interrupted = false;
    f.director.beats = async (e, start, count) => {
      starts.push(start);
      if (start === 10 && !interrupted) { interrupted = true; throw new Error('fixture interruption'); }
      const b = e.bible!;
      return Array.from({ length: count }, (_, i) => ({
        objective: `Beat ${start + i + 1} advances the conflict.`,
        location: b.locations[0].id, cast: [b.cast[0].id],
      }));
    };
    await f.engine.act(p.id, 42, 'plan');
    assert.equal(f.store.get(p.id).episode.bible!.beats.length, 10, 'Completed story-outline batches persist before the next request');
    assert.equal(f.store.get(p.id).episode.shots.length, 0, 'Storyboard generation waits until the complete beat map exists');
    await f.engine.act(p.id, 42, 'recover');
    await f.engine.act(p.id, 42, 'resume');
    const done = f.store.get(p.id).episode;
    assert.equal(done.bible!.beats.length, 200);
    assert.equal(done.shots.length, 600);
    assert.equal(starts[0], 0);
    assert.equal(starts.filter(x => x === 0).length, 1, 'Resume must not regenerate a saved beat batch');
    assert.equal(starts.filter(x => x === 10).length, 2, 'Only the ambiguous batch is explicitly resumed');
  }
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
  console.log('PASS 1–100 minute story planning, approvals, reference locking, replay safety, budgets, pause/resume, QA, retakes, delivery and roles');
}
async function contracts() {
  {
    const e = newEpisode(100); e.bible = bible(100, false);
    const batch = Array.from({ length: STORY_BEAT_BATCH_SIZE }, (_, i) => ({
      objective: `Beat ${i + 1} advances the central conflict.`,
      location: 'HOUSE', cast: ['RAKA'],
    }));
    assert.equal(validateBeatBatch({ beats: batch }, e, 0, STORY_BEAT_BATCH_SIZE).length, STORY_BEAT_BATCH_SIZE);
    assert.throws(() => validateBeatBatch({ beats: batch.slice(0, -1) }, e, 0, STORY_BEAT_BATCH_SIZE));
    assert.throws(() => validateBeatBatch({ beats: batch }, e, 191, STORY_BEAT_BATCH_SIZE));
    assert.throws(() => validateBeatBatch({ beats: batch.map(b => ({ ...b, cast: ['UNKNOWN'] })) }, e, 0, STORY_BEAT_BATCH_SIZE));
  }
  {
    const e = newEpisode(1); e.bible = bible();
    const messages: any[] = [];
    const requests: any[] = [];
    const client = new EpisodeDirector('offline-fixture-key', (async (url: any, init: any) => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
      const body = JSON.parse(init.body);
      requests.push(body);
      messages.push(body.messages);
      const output = messages.length === 1 ? bible()
        : messages.length === 2 ? { shots: scene(e, 0).map(s => ({
          ...s, dialogue: s.dialogue.map(d => ({ ...d, subtitleId: 'Terjemahan bahasa Indonesia.' })),
        })) }
        : { pass: false, issues: ['Fixture identity mismatch'], repair: 'Use the approved character reference.' };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }));
    }) as any, false, 'ko');
    await client.bible('story', 1, 'fixture-model');
    await client.scene(e, 0, 'fixture-model');
    await client.review('fixture-model', 'Inspect fixture only', [Buffer.from('fixture-jpeg')]);
    assert.equal(messages.length, 3);
    for (const m of messages) {
      assert.ok(m[0].content.startsWith(FILM_DIRECTOR_ROLE), 'Bible, shot prompts and review share the film-production role');
      assert.match(m[0].content, /CURRENT TASK:/);
    }
    assert.match(messages[0][0].content, /authentic contemporary Korean TV drama/);
    assert.match(messages[0][0].content, /high-retention Chinese vertical short-drama format/);
    assert.match(messages[0][0].content, /first 3 seconds/);
    assert.match(messages[0][0].content, /exactly 2 beats and 6 ten-second shots/);
    assert.match(messages[0][0].content, /Beat 1 \(0–30s, shots 1–3\)/);
    assert.match(messages[0][0].content, /Beat 2 \(30–60s, shots 4–6\)/);
    assert.match(messages[0][0].content, /prologue\/opening/);
    assert.match(messages[0][0].content, /epilogue showing the changed outcome/);
    assert.match(messages[0][0].content, /do not finish on a cliffhanger/);
    assert.match(messages[1][0].content, /subtitleId/);
    assert.match(messages[1][0].content, /professional production brief/);
    assert.match(messages[1][0].content, /5-12 likely or costly visible defects/);
    assert.match(messages[1][0].content, /shots 1–3 of a one-minute story/);
    assert.match(messages[1][0].content, /shot 1 begins with the hook inside its first 3 seconds/);
    const sceneContext = JSON.parse(messages[1][1].content);
    assert.equal(sceneContext.story.arc.prologue, 'Raka discovers a letter in his family home.');
    assert.equal(sceneContext.story.arc.epilogue, 'The secret is resolved and Raka chooses a new path.');
    assert.equal(sceneContext.beatNumber, 1);
    assert.deepEqual(requests.map(r => r.max_tokens), [8192, 8192, 2048],
      'Use stage-appropriate response budgets for bible, scene and review calls');
  }
  {
    const e = newEpisode(15); e.bible = bible(15, false);
    let requestBody: any;
    const client = new EpisodeDirector('offline-fixture-key', (async (url: any, init: any) => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
      requestBody = JSON.parse(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
        beats: Array.from({ length: 10 }, (_, i) => ({
          objective: `Beat ${i + 1} advances the central conflict.`, location: 'HOUSE', cast: ['RAKA'],
        })),
      }) } }] }));
    }) as any);
    const beats = await client.beats(e, 0, 10, 'fixture-model');
    assert.equal(beats.length, 10);
    assert.equal(requestBody.max_tokens, 4200, 'A ten-beat batch has a larger bounded output budget');
  }
  {
    const e = newEpisode(1); e.bible = bible();
    const messages: any[] = [];
    const client = new EpisodeDirector('offline-fixture-key', (async (url: any, init: any) => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'fixture-model' }] }));
      const body = JSON.parse(init.body); messages.push(body.messages);
      const output = messages.length === 1 ? bible()
        : { shots: scene(e, 0).map(s => ({
          ...s, dialogue: s.dialogue.map(d => ({ ...d, text: '我知道真正的答案。' })),
        })) };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(output) } }] }));
    }) as any, false, 'zh');
    await client.bible('new story', 1, 'fixture-model');
    await client.scene(e, 0, 'fixture-model');
    assert.match(messages[0][0].content, /contemporary Chinese short-form TV drama/);
    assert.match(messages[1][0].content, /Simplified Chinese/);
    assert.match(messages[1][0].content, /No subtitleId, subtitles, captions/);
    assert.match(messages[1][0].content, /negativePrompt<=850 characters per shot/);
    assert.match(messages[1][0].content, /5-12 likely or costly defects for that shot/);
    assert.match(messages[1][0].content, /supplied full-story context/);
    assert.match(messages[1][0].content, /opening beat: stage the prologue/);
    assert.ok(JSON.parse(messages[1][1].content).story.arc.epilogue);
  }
  {
    const e = newEpisode(1); e.bible = bible();
    const shots = scene(e, 0);
    const longCamera = { shots: shots.map(s => ({ ...s, camera: 'C'.repeat(450) })) };
    assert.equal(validateScene(longCamera, e, 0)[0].camera.length, 450);
    const input = { shots: shots.map(s => ({ ...s, action: 'A'.repeat(734) })) };
    assert.equal(validateScene(input, e, 0)[0].action.length, 734, 'Preserve moderately verbose action without rewriting');
    assert.match(validateScene(input, e, 0)[0].negativePrompt!, /letter duplication/);
    const videoPrompt = lockedPrompt(e, validateScene(input, e, 0)[0], true);
    assert.match(videoPrompt, /Shot-specific negative constraints/);
    assert.match(videoPrompt, /Application-added global visual-quality guard/);
    assert.match(videoPrompt, /Keep the intended action, expression, dialogue, speaker and required prop use intact/);
    const koreanInput = { shots: input.shots.map(s => ({
      ...s, dialogue: s.dialogue.map(d => ({ ...d, subtitleId: 'Terjemahan Indonesia.' })),
    })) };
    assert.match(lockedPrompt(e, validateScene(koreanInput, e, 0, false, true)[0], true, '', 'ko'),
      /Korean spoken dialogue in Hangul/);
    assert.throws(() => validateScene(input, e, 0, false, true), /DIRECTOR_FORMAT/,
      'Korean spoken lines require Indonesian subtitle text');
    const chineseInput = { shots: input.shots.map(s => ({
      ...s, dialogue: s.dialogue.map(d => ({ ...d, text: '我知道真正的答案。' })),
    })) };
    assert.doesNotThrow(() => validateScene(chineseInput, e, 0, false, 'zh'));
    assert.match(lockedPrompt(e, validateScene(chineseInput, e, 0, false, 'zh')[0], true, '', 'zh'),
      /Mandarin Chinese dialogue in Simplified Chinese\. No subtitles/);
    assert.throws(() => validateScene(input, e, 0, false, 'zh'), /DIRECTOR_FORMAT/,
      'Mandarin dialogue must contain Han characters');
    const missingNegative = { shots: input.shots.map(s => ({ ...s, negativePrompt: undefined })) };
    assert.throws(() => validateScene(missingNegative, e, 0), /DIRECTOR_FORMAT/);
    assert.equal(validateBible({ ...e.bible, synopsis: 'A'.repeat(771) }, 1).synopsis.length, 771);
    assert.throws(() => validateBible({ ...e.bible, synopsis: 'A'.repeat(1001) }, 1), /DIRECTOR_FORMAT/);
    input.shots[0].action = 'A'.repeat(901);
    assert.throws(() => validateScene(input, e, 0), /DIRECTOR_FORMAT/, 'Still reject unbounded actions');
  }
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
  const ltxSettings = { model: 'Ltx2_5_22B_Dist_INT8', width: 768, height: 1344, frames: 241, fps: 24 };
  const ltxApi = new DeapiEpisodeApi(source, (async (url: any, init: any) => {
    seen.push({ url, init });
    return new Response(JSON.stringify({ data: url.endsWith('/price') ? { price: 0.01, is_estimated: false } : { request_id: 'ltx-job' } }));
  }) as typeof fetch, ltxSettings, 'zh');
  await ltxApi.quote({ kind: 'video', prompt: 'Mandarin audio', images: [b], seed: 9 });
  const ltxBody = seen.at(-1)!.init.body as FormData;
  assert.equal(ltxBody.get('model'), 'Ltx2_5_22B_Dist_INT8');
  assert.equal(ltxBody.get('width'), '768'); assert.equal(ltxBody.get('height'), '1344');
  assert.equal(ltxBody.get('frames'), '241'); assert.equal(ltxBody.get('fps'), '24');
  await ltxApi.quote({ kind: 'transcript', prompt: '', seed: 71 });
  assert.equal((seen.at(-1)!.init.body as FormData).get('lang'), 'zh');
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
    await message('/microdrama 101', 43); assert.equal(await f.store.latest(43), undefined);
    await message('/microdrama 1', 44, 'group'); assert.equal(await f.store.latest(44), undefined);
    admin = false; await message('/microdrama 1', 45); assert.equal(await f.store.latest(45), undefined);
    admin = true; await message('/microdrama', 47);
    assert.ok(JSON.stringify(sent).includes('ep:new:100'), 'Duration menu exposes the 100-minute option');
    await message('/microdrama 100', 46);
    assert.equal((await f.store.latest(46))?.episode?.minutes, 100, 'The Telegram command accepts 100 minutes');
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
