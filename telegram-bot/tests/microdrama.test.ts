import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BuatSimpelWriter, parseDramaPlan, scenePrompt, type DramaPlan } from '../src/microdrama-plan';
import { MicrodramaEngine, dramaError } from '../src/microdrama-engine';
import { DeapiDramaRenderer } from '../src/microdrama-deapi';
import { FfmpegDramaMedia } from '../src/microdrama-media';
import { registerMicrodrama, dramaButtons } from '../src/microdrama-bot';
import { PgDramaStore, type DramaProject, type DramaStore } from '../src/microdrama-store';

const exec = promisify(execFile);
const copy = <T>(value: T): T => value === undefined ? value : JSON.parse(JSON.stringify(value));
const plan: DramaPlan = {
  title: 'Rumah Ibu', synopsis: 'Dua saudara mengungkap alasan penjualan rumah.',
  setting: 'A modest Indonesian living room at night, warm amber light.',
  characters: [
    { id: 'RAKA', name: 'Raka', age: 32, description: 'Short black hair, square face, black jacket, deep male voice, left side.' },
    { id: 'ADI', name: 'Adi', age: 27, description: 'Long black hair in ponytail, burgundy hoodie, lighter male voice, right side.' },
  ],
  scenes: [
    { action: 'Raka points at Adi. Both remain standing.', dialogue: [
      { speaker: 'RAKA', text: 'Kamu jual rumah ibu?' }, { speaker: 'ADI', text: 'Dengarkan dulu!' },
    ] },
    { action: 'Adi shows a hospital bill. Raka freezes.', dialogue: [
      { speaker: 'ADI', text: 'Ini untuk operasi ibu.' }, { speaker: 'RAKA', text: 'Kenapa baru bilang?' },
    ] },
  ],
};

class MemoryStore implements DramaStore {
  ready = true;
  rows = new Map<string, DramaProject>();
  locks = new Set<string>();
  settings = new Map<number, string>();
  async model(owner: number) { return this.settings.get(owner) || 'gpt-6-luna'; }
  async setModel(owner: number, model: string) { this.settings.set(owner, model); }
  async create(owner = 42, chat = 42, model = 'gpt-6-luna') {
    if ([...this.rows.values()].some(p => p.owner === owner && !['failed', 'delivered', 'cancelled'].includes(p.status))) {
      throw new Error('active project already exists');
    }
    const p: DramaProject = { id: randomUUID(), owner, chat, model, status: 'idea', jobs: [{}, {}] };
    this.rows.set(p.id, copy(p));
    return p;
  }
  async latest(owner: number) { return copy([...this.rows.values()].filter(p => p.owner === owner).at(-1)); }
  get(id: string) { return copy(this.rows.get(id)!); }
  async withLock(id: string, owner: number, fn: (p: DramaProject, save: () => Promise<void>) => Promise<void>) {
    if (this.locks.has(id) || this.rows.get(id)?.owner !== owner) return false;
    this.locks.add(id);
    try {
      const p = this.get(id);
      await fn(p, async () => { this.rows.set(id, copy(p)); });
      return true;
    } finally { this.locks.delete(id); }
  }
}

function fixture() {
  const store = new MemoryStore();
  const seen = { writes: 0, quotes: 0, submits: [] as Array<{ prompt: string; frame?: Buffer }>,
    polls: [] as string[], delivered: 0, messages: [] as string[], authorized: true };
  const renderer = {
    async quote() { seen.quotes++; return 0.218; },
    async submit(prompt: string, seed: number, frame?: Buffer) {
      seen.submits.push({ prompt, frame }); return `job-${seen.submits.length}`;
    },
    async poll(id: string) { seen.polls.push(id); return `https://cdn.example/${id}.mp4`; },
    async download(url: string) { return Buffer.from(url); },
  };
  const media = {
    async check() {},
    async placeholder() { return Buffer.from('placeholder'); },
    async lastFrame(video: Buffer) { return Buffer.from(`last-frame:${video}`); },
    async assemble(videos: Buffer[]) { assert.equal(videos.length, 2); return Buffer.from('final-video'); },
  };
  const writer = { async write(idea: string, model: string, previous?: DramaPlan) {
    seen.writes++; return copy({ ...plan, ...(previous ? { title: 'Revised title' } : {}) });
  } };
  const deps = {
    store, renderer, media, writer,
    async authorized() { return seen.authorized; },
    async notify(p: DramaProject, text: string) { seen.messages.push(text); },
    async present() {},
    async deliver(p: DramaProject, video: Buffer) { seen.delivered++; return 'telegram-file-id'; },
  };
  return { store, seen, renderer, media, writer, deps, engine: new MicrodramaEngine(deps) };
}

async function prepared(f: ReturnType<typeof fixture>, quoted = true) {
  const p = await f.store.create();
  await f.engine.act(p.id, p.owner, 'write', 'Dua saudara dan rumah ibu');
  if (quoted) await f.engine.act(p.id, p.owner, 'quote');
  return p;
}

async function planTests() {
  assert.deepEqual(parseDramaPlan(JSON.stringify(plan)), plan);
  assert.deepEqual(parseDramaPlan('```json\n' + JSON.stringify(plan) + '\n```'), plan);
  for (const mutate of [
    (p: any) => { p.scenes = [p.scenes[0]]; },
    (p: any) => { p.characters[0].age = 17; },
    (p: any) => { p.characters[1].id = 'RAKA'; },
    (p: any) => { p.scenes[0].dialogue[0].speaker = 'STRANGER'; },
    (p: any) => { p.scenes[0].dialogue[0].text = 'x'.repeat(100); },
    (p: any) => { p.characters[0] = null; },
    (p: any) => { p.scenes[0].dialogue[0] = null; },
    (p: any) => { p.setting = ''; },
    (p: any) => { p.scenes[0].action = 'x'.repeat(901); },
  ]) {
    const bad = copy(plan); mutate(bad);
    assert.throws(() => parseDramaPlan(JSON.stringify(bad)));
  }
  const prompt = scenePrompt(plan, 1);
  assert.match(prompt, /Continue directly from the provided last frame/);
  assert.match(prompt, /RAKA says: "Kenapa baru bilang\?"/);
  assert.match(prompt, /black jacket/);
  assert.match(prompt, /burgundy hoodie/);
  assert.match(prompt, /no overlapping voices/);
  assert.match(dramaError(new Error('LLM_HTTP_401')), /naskah/);
}

async function providerTests() {
  const calls: Array<{ url: string; options: any }> = [];
  const response = (data: any, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
  const writer = new BuatSimpelWriter('not-a-real-key', (async (url: any, options: any) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith('/models')) return response({ data: [
      { id: 'gpt-6-luna', enabled: true, available: true }, { id: 'off', enabled: false, available: true },
    ] });
    return response({ choices: [{ message: { content: JSON.stringify(plan) } }] });
  }) as any);
  await writer.write('idea', 'gpt-6-luna');
  const body = JSON.parse(calls[1].options.body);
  assert.equal(body.model, 'gpt-6-luna');
  assert.equal(body.stream, true);
  assert.equal(body.messages.length, 2);
  assert.equal(body.response_format, undefined, 'Do not presume gateway supports structured-output extensions');
  await assert.rejects(writer.write('idea', 'off'), /UNAVAILABLE/);
  assert.equal(calls.filter(c => c.url.endsWith('completions')).length, 1);
  let writeRequests = 0;
  const brokenWriter = new BuatSimpelWriter('not-a-real-key', (async (url: any) => {
    if (String(url).endsWith('models')) return response({ data: [{ id: 'm', enabled: true, available: true }] });
    writeRequests++; throw new Error('timeout');
  }) as any);
  await assert.rejects(brokenWriter.write('idea', 'm'));
  assert.equal(writeRequests, 1, 'Never automatically retry a possibly billed LLM request');

  const videoCalls: Array<{ url: string; options: any }> = [];
  let polls = 0, sleeps = 0;
  const client = new DeapiDramaRenderer('not-a-real-key', (async (url: any, options: any) => {
    videoCalls.push({ url: String(url), options });
    if (String(url).endsWith('/price')) return response({ data: { price: 0.218, is_estimated: false } });
    if (String(url).includes('/jobs/')) {
      if (++polls === 1) return response({}, 429, { 'retry-after': '60' });
      return response({ data: { status: 'done', result_url: 'https://cdn.example/result.mp4' } });
    }
    return response({ data: { request_id: 'accepted-id' } });
  }) as any, async () => { sleeps++; });
  assert.equal(await client.quote('prompt'), 0.218);
  assert.equal(await client.quote('prompt', Buffer.from('png')), 0.218);
  assert.equal(await client.submit('prompt', 71, Buffer.from('png')), 'accepted-id');
  assert.match(videoCalls[0].url, /generations\/price$/);
  assert.match(videoCalls[1].url, /animations\/price$/);
  const form = videoCalls[2].options.body as FormData;
  assert.equal(form.get('model'), 'MiniMaxH3_33B_Turbo_INT8');
  assert.equal(form.get('frames'), '240');
  assert.equal(form.get('width'), '768');
  assert.ok(form.get('first_frame_image') instanceof Blob);
  assert.equal(await client.poll('accepted-id'), 'https://cdn.example/result.mp4');
  assert.equal(sleeps, 1);
  assert.equal(videoCalls.filter(c => /\/animations$/.test(c.url)).length, 1);
  const estimated = new DeapiDramaRenderer('key', (async () => response({ data: { price: 0.2, is_estimated: true } })) as any);
  await assert.rejects(estimated.quote('prompt'), /QUOTE_OVER_LIMIT/);
  const costly = new DeapiDramaRenderer('key', (async () => response({ data: { price: 0.4, is_estimated: false } })) as any);
  await assert.rejects(costly.quote('prompt'), /QUOTE_OVER_LIMIT/);
}

async function engineTests() {
  {
    const f = fixture(), p = await prepared(f, false);
    assert.equal(f.store.get(p.id).status, 'draft');
    assert.equal(f.seen.submits.length, 0, 'Writing never renders video');
    await f.engine.act(p.id, p.owner, 'approve');
    assert.equal(f.seen.submits.length, 0, 'No quote means no approval');
    await f.engine.act(p.id, p.owner, 'revise');
    await f.engine.act(p.id, p.owner, 'write', 'Buat lebih dramatis');
    assert.equal(f.store.get(p.id).plan!.title, 'Revised title');
    await f.engine.act(p.id, p.owner, 'quote');
    assert.equal(f.seen.quotes, 2);
    assert.equal(f.seen.submits.length, 0, 'Quote is non-billable and does not submit');
    await f.engine.act(p.id, p.owner, 'approve');
    assert.equal(f.store.get(p.id).status, 'delivered');
    assert.equal(f.seen.submits.length, 2);
    assert.equal(f.seen.submits[0].frame, undefined);
    assert.match(f.seen.submits[1].frame!.toString(), /^last-frame:/);
    assert.equal(f.store.get(p.id).fileId, 'telegram-file-id');
    await f.engine.act(p.id, p.owner, 'approve');
    await f.engine.act(p.id, p.owner, 'resume');
    assert.equal(f.seen.submits.length, 2, 'Replayed buttons never regenerate delivered clips');
  }
  {
    const f = fixture(), p = await prepared(f);
    assert.equal(await f.engine.act(p.id, 999, 'approve'), false, 'Project ownership enforced');
    f.seen.authorized = false;
    await assert.rejects(f.engine.act(p.id, p.owner, 'approve'), /ADMIN_REVOKED/);
    assert.equal(f.seen.submits.length, 0);
  }
  {
    const f = fixture(), p = await prepared(f);
    f.store.rows.get(p.id)!.quotedAt = Date.now() - 11 * 60_000;
    await f.engine.act(p.id, p.owner, 'approve');
    assert.equal(f.store.get(p.id).status, 'draft');
    assert.equal(f.seen.submits.length, 0);
  }
  {
    const f = fixture(), p = await prepared(f);
    f.renderer.quote = async () => 0.219;
    await f.engine.act(p.id, p.owner, 'approve');
    assert.equal(f.seen.submits.length, 0, 'Price increases block submit');
    assert.equal(f.store.get(p.id).status, 'paused');
  }
  {
    const f = fixture(), p = await prepared(f);
    let attempts = 0;
    f.renderer.submit = async () => { attempts++; throw new Error('timeout'); };
    await f.engine.act(p.id, p.owner, 'approve');
    assert.equal(f.store.get(p.id).status, 'uncertain');
    assert.equal(f.store.get(p.id).jobs[0].attempted, true);
    await f.engine.act(p.id, p.owner, 'resume');
    await f.engine.act(p.id, p.owner, 'approve');
    assert.equal(attempts, 1, 'Ambiguous submission must never be retried');
  }
  {
    const f = fixture(), p = await prepared(f);
    f.renderer.poll = async () => { throw new Error('DEAPI_POLL_HTTP_403'); };
    await f.engine.act(p.id, p.owner, 'approve');
    assert.equal(f.store.get(p.id).status, 'paused');
    assert.equal(f.seen.submits.length, 1);
    // Simulate a process restart by creating a new engine around persisted state.
    f.renderer.poll = async id => { f.seen.polls.push(id); return `https://cdn.example/${id}.mp4`; };
    const resumed = new MicrodramaEngine(f.deps);
    await resumed.act(p.id, p.owner, 'resume');
    assert.equal(f.store.get(p.id).status, 'delivered');
    assert.equal(f.seen.submits.length, 2, 'Accepted scene 1 is polled, not resubmitted');
    assert.deepEqual(f.seen.polls, ['job-1', 'job-2']);
  }
  {
    const f = fixture(), p = await prepared(f);
    f.renderer.poll = async () => { throw new Error('DEAPI_JOB_FAILED'); };
    await f.engine.act(p.id, p.owner, 'approve');
    assert.equal(f.store.get(p.id).status, 'failed');
    assert.equal(f.store.get(p.id).jobs[0].failed, true);
    await f.engine.act(p.id, p.owner, 'resume');
    assert.equal(f.seen.submits.length, 1, 'Terminal failures do not trigger replacement jobs');
  }
  {
    const f = fixture(), p = await prepared(f);
    let deliveries = 0;
    f.deps.deliver = async () => { if (++deliveries === 1) throw new Error('Telegram timeout'); return 'file-id'; };
    await f.engine.act(p.id, p.owner, 'approve');
    assert.equal(f.store.get(p.id).status, 'paused');
    await f.engine.act(p.id, p.owner, 'resume');
    assert.equal(f.store.get(p.id).status, 'delivered');
    assert.equal(f.seen.submits.length, 2, 'Delivery retry cannot create new paid jobs');
    assert.equal(deliveries, 2);
  }
  {
    const f = fixture(), p = await prepared(f);
    let unblock!: () => void;
    const barrier = new Promise<void>(r => { unblock = r; });
    f.renderer.poll = async id => { await barrier; return `https://cdn.example/${id}.mp4`; };
    const first = f.engine.act(p.id, p.owner, 'approve');
    for (let i = 0; i < 10 && !f.seen.submits.length; i++) await new Promise(r => setImmediate(r));
    assert.equal(await f.engine.act(p.id, p.owner, 'approve'), false, 'Double tap cannot acquire project lock');
    unblock(); await first;
    assert.equal(f.seen.submits.length, 2);
  }
  {
    const f = fixture(), p = await prepared(f);
    await f.engine.act(p.id, p.owner, 'cancel');
    await f.engine.act(p.id, p.owner, 'approve');
    assert.equal(f.store.get(p.id).status, 'cancelled');
    assert.equal(f.seen.submits.length, 0);
    const newProject = await f.store.create();
    f.store.rows.get(newProject.id)!.status = 'writing';
    await f.engine.act(newProject.id, p.owner, 'recover');
    assert.equal(f.store.get(newProject.id).status, 'idea');
    assert.equal(f.seen.writes, 1, 'Recovering a stranded writer does not consume new LLM quota');
  }
}

async function handlerTests() {
  const oldBuat = process.env.BUATSIMPEL_API_KEY, oldDeapi = process.env.DEAPI_API_KEY;
  process.env.BUATSIMPEL_API_KEY = 'offline-key'; delete process.env.DEAPI_API_KEY;
  try {
    const f = fixture();
    const commands = new Map<string, any>();
    const actions: Array<{ pattern: any; handler: any }> = [];
    const middleware: any[] = [];
    const sent: string[] = [];
    let onText: any, admin = true, passed = 0;
    const bot: any = {
      use(fn: any) { middleware.push(fn); },
      on(type: string, fn: any) { assert.equal(type, 'text'); onText = fn; },
      command(names: any, fn: any) { (Array.isArray(names) ? names : [names]).forEach(n => commands.set(n, fn)); },
      action(pattern: any, handler: any) { actions.push({ pattern, handler }); },
      telegram: { async sendMessage(chat: number, text: string) { sent.push(text); } },
    };
    registerMicrodrama(bot, f.store as any, async () => admin, async () => admin, f.deps.deliver,
      { writer: { ...f.writer, async models() { return ['gpt-6-luna', 'other-model']; } } as any,
        renderer: f.renderer as any, media: f.media as any });
    const ctx: any = { from: { id: 42 }, chat: { id: 42, type: 'private' }, message: { text: '' },
      async reply(text: string) { sent.push(text); }, async answerCbQuery() {} };
    async function dispatch(fn: any) { return middleware[0](ctx, fn); }
    async function command(name: string, text = `/${name}`) {
      ctx.message = { text }; ctx.callbackQuery = undefined;
      await dispatch(() => commands.get(name)(ctx));
    }
    async function action(data: string) {
      ctx.message = undefined; ctx.callbackQuery = { data };
      const match = actions.find(a => typeof a.pattern === 'string' ? a.pattern === data : a.pattern.test(data))!;
      ctx.match = typeof match.pattern === 'string' ? undefined : data.match(match.pattern);
      await dispatch(() => match.handler(ctx));
      await new Promise(r => setTimeout(r, 5));
    }
    async function text(value: string) {
      ctx.message = { text: value }; ctx.callbackQuery = undefined;
      await dispatch(() => onText(ctx, async () => { passed++; }));
      await new Promise(r => setTimeout(r, 5));
    }
    admin = false; await command('microdrama');
    assert.equal(sent.length, 0);
    await action('md:new'); assert.equal(f.store.rows.size, 0);
    admin = true; ctx.chat.type = 'group';
    await command('microdrama'); assert.match(sent.at(-1)!, /chat pribadi/);
    ctx.chat.type = 'private';
    await command('microdrama'); assert.match(sent.at(-1)!, /uji khusus admin/);
    await action('md:new');
    const p = await f.store.latest(42);
    assert.equal(p!.status, 'idea');
    await text('Ide dua saudara');
    assert.equal(f.seen.writes, 1);
    assert.equal(f.store.get(p!.id).status, 'draft');
    assert.equal(f.seen.submits.length, 0);
    await action(`md:revise:${p!.id}`);
    await text('Ubah akhir cerita');
    assert.equal(f.seen.writes, 2);
    await action(`md:quote:${p!.id}`);
    assert.match(sent.at(-1)!, /Estimasi render/);
    await action(`md:approve:${p!.id}`);
    assert.equal(f.store.get(p!.id).status, 'delivered');
    await command('microdramamodel', '/microdramamodel other-model');
    assert.equal(await f.store.model(42), 'other-model');
    await action('md:new');
    const p2 = await f.store.latest(42);
    assert.equal(p2!.model, 'other-model');
    // Other menus/commands must not leak ordinary generation prompts into microdrama.
    ctx.message = { text: '/menu' }; ctx.callbackQuery = undefined;
    await dispatch(async () => {});
    await text('Normal video prompt');
    assert.equal(passed, 1);
    assert.equal(f.seen.writes, 2);
    await command('microdrama');
    admin = false;
    await text('Access revoked');
    assert.equal(f.seen.writes, 2);
    const allButtons = dramaButtons(f.store.get(p!.id)).reply_markup.inline_keyboard.flat();
    assert.ok(allButtons.every(b => !('callback_data' in b) || Buffer.byteLength(b.callback_data) <= 64));
    assert.ok(sent.every(s => s.length <= 4096));
  } finally {
    if (oldBuat === undefined) delete process.env.BUATSIMPEL_API_KEY; else process.env.BUATSIMPEL_API_KEY = oldBuat;
    if (oldDeapi === undefined) delete process.env.DEAPI_API_KEY; else process.env.DEAPI_API_KEY = oldDeapi;
  }
}

async function storeTests() {
  const statements: Array<{ sql: string; params?: any[] }> = [];
  const p: DramaProject = { id: randomUUID(), owner: 42, chat: 42, model: 'model', status: 'draft', jobs: [{}, {}] };
  let locked = true, released = false;
  const client = {
    on() {},
    removeListener() {},
    async query(sql: string, params?: any[]) {
      statements.push({ sql, params });
      if (sql.includes('AS slot_locked')) return { rows: [{ slot_locked: true }] };
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked }] };
      if (sql.startsWith('SELECT data')) return { rows: params![1] === 42 ? [{ data: copy(p) }] : [] };
      return { rows: [] };
    },
    release() { released = true; },
  };
  const store = new PgDramaStore({ connect: async () => client, query: client.query } as any);
  await store.ensureSchema();
  assert.equal(store.ready, true);
  assert.ok(statements.some(q => q.sql.includes('CREATE UNIQUE INDEX') && q.sql.includes('WHERE status NOT IN')));
  await store.withLock(p.id, 42, async (project, save) => { project.status = 'quoted'; await save(); });
  assert.ok(statements.some(q => q.sql.includes('UPDATE microdrama_projects') && q.params![1] === 42));
  assert.ok(statements.some(q => q.sql.includes('pg_advisory_unlock')));
  assert.equal(released, true);
  assert.equal(await store.withLock(p.id, 100, async () => { throw new Error('must not run'); }), false);
  locked = false;
  assert.equal(await store.withLock(p.id, 42, async () => { throw new Error('must not run'); }), false);
}

async function mediaTests() {
  const media = new FfmpegDramaMedia();
  await media.check();
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'drama-test-'));
  try {
    const input = path.join(dir, 'fixture.mp4');
    await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=768x1344:r=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '10', '-c:v', 'libx264',
      '-preset', 'ultrafast', '-threads', '2', '-c:a', 'aac', '-pix_fmt', 'yuv420p', input], { timeout: 60_000 });
    const fixture = await fs.readFile(input);
    const frame = await media.lastFrame(fixture);
    assert.equal(frame.subarray(1, 4).toString(), 'PNG');
    const output = await media.assemble([fixture, fixture]);
    const outFile = path.join(dir, 'out.mp4');
    await fs.writeFile(outFile, output);
    const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', outFile]);
    const info = JSON.parse(stdout);
    const video = info.streams.find((s: any) => s.codec_type === 'video');
    assert.equal(video.width, 756);
    assert.equal(video.height, 1344);
    assert.equal(video.width / video.height, 9 / 16);
    assert.ok(info.streams.some((s: any) => s.codec_type === 'audio'));
    assert.ok(Number(info.format.duration) >= 20 && Number(info.format.duration) < 21);
    await assert.rejects(media.assemble([fixture]), /MEDIA_INVALID/);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
}

async function main() {
  for (const [label, run] of Object.entries({
    'plan validation': planTests, 'provider contracts': providerTests, 'workflow replay safety': engineTests,
    'Telegram admin journey': handlerTests, 'Postgres lock contract': storeTests, 'real ffmpeg assembly': mediaTests,
  })) {
    await run();
    console.log(`PASS ${label}`);
  }
  const source = await fs.readFile(path.join(__dirname, '../src/microdrama-engine.ts'), 'utf8');
  assert.doesNotMatch(source, /deductSaldo|addSaldo/);
  console.log('Microdrama tests passed; no live provider jobs submitted, no saldo writes.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
