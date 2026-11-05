import assert from 'node:assert/strict';
import { DeapiKeyPool } from '../src/deapi-key-pool';
import { PooledDeapiRenderer } from '../src/deapi-pooled-renderer';
import { registerDeapiAdmin, deapiLimitTime } from '../src/deapi-admin';
import { MicrodramaEngine } from '../src/microdrama-engine';
import type { DramaProject } from '../src/microdrama-store';
import type { DramaRenderer } from '../src/microdrama-deapi';
import { DeapiDramaRenderer } from '../src/microdrama-deapi';
import { DeapiRateLimitError, deapiRetryAt } from '../src/deapi-rate-limit';

async function databaseContract() {
  const calls: Array<{ sql: string; params?: any[] }> = [];
  const pool = new DeapiKeyPool({ async query(sql, params) {
    calls.push({ sql, params });
    if (sql.startsWith('INSERT')) return { rows: [{ id: 7 }], rowCount: 1 };
    if (sql.includes('RETURNING id,api_key') || sql.startsWith('SELECT id,api_key')) {
      return { rows: [{ id: 7, api_key: 'fixture-private-token' }], rowCount: 1 };
    }
    if (sql.includes('COUNT(*)')) return { rows: [{ available: 1, dead: 0 }], rowCount: 1 };
    if (sql.includes('AS cooldowns')) return { rows: [{ id: 7, status: 'available', cooldowns: [] }], rowCount: 1 };
    return { rows: [{ id: 7, status: 'available' }], rowCount: 1 };
  } });
  await pool.ensureSchema();
  assert.equal(await pool.addKeys([' fixture-private-token ', 'fixture-private-token']), 1);
  assert.deepEqual(calls.at(-1)!.params, [['fixture-private-token']]);
  assert.doesNotMatch(calls.at(-1)!.sql, /fixture-private-token/);
  assert.deepEqual(await pool.next([2]), { id: 7, apiKey: 'fixture-private-token' });
  assert.match(calls.at(-1)!.sql, /FOR UPDATE SKIP LOCKED/);
  assert.deepEqual(calls.at(-1)!.params, [[2], []]);
  assert.match(calls.at(-1)!.sql, /c\.retry_at>NOW\(\)/);
  assert.match(calls.at(-1)!.sql, /c\.scope='account'/, 'Account holds override every caller/model scope');
  await pool.next([], ['quotes', 'videos/animations:fixture-model']);
  assert.deepEqual(calls.at(-1)!.params, [[], ['quotes', 'videos/animations:fixture-model']]);
  const retryAt = Date.now() + 60_000;
  await pool.markLimited(7, 'quotes', retryAt);
  assert.deepEqual(calls.at(-1)!.params, [7, 'quotes', new Date(retryAt).toISOString()]);
  assert.match(calls.at(-1)!.sql, /GREATEST/);
  assert.equal(await pool.disable(7), true);
  assert.deepEqual(await pool.get(7), { id: 7, apiKey: 'fixture-private-token' });
  assert.doesNotMatch(calls.at(-1)!.sql, /status=/, 'Disabled credentials still poll their accepted jobs');
  assert.equal(await pool.get(-1), null);
  assert.equal(await pool.restore(7), true);
  assert.deepEqual(await pool.stats(), { available: 1, dead: 0 });
  assert.deepEqual(await pool.list(), [{ id: 7, status: 'available', cooldowns: [] }]);
  assert.match(calls.at(-1)!.sql, /^SELECT p.id,p.status/);
  await assert.rejects(pool.addKeys(['invalid key']), /INVALID_KEY_FORMAT/);
  const broken = new DeapiKeyPool({ query: async () => { throw new Error('credential in database error'); } });
  await assert.rejects(broken.next(), e => String(e) === 'Error: DEAPI_POOL_DATABASE_FAILED');
}

function poolFixture() {
  const events = { next: 0, get: [] as number[], disabled: [] as number[], quotes: [] as string[],
    submits: [] as string[], polls: [] as string[], downloads: [] as string[] };
  let sequence = 0;
  const pool = {
    async markLimited() {},
    async next(skip: number[] = []) {
      events.next++;
      const id = skip.length ? [1, 2].find(n => !skip.includes(n)) : (++sequence % 2 ? 1 : 2);
      return id ? { id, apiKey: `fake-key-${id}` } : null;
    },
    async get(id: number) { events.get.push(id); return [1, 2].includes(id) ? { id, apiKey: `fake-key-${id}` } : null; },
    async disable(id: number) { events.disabled.push(id); return true; },
  };
  const client = (key: string): DramaRenderer => ({
    async quote() { events.quotes.push(key); return 0.218; },
    async submit() { events.submits.push(key); return `job-${key}`; },
    async poll(id) { events.polls.push(`${key}:${id}`); return 'https://cdn.test/result.mp4'; },
    async download(url) { events.downloads.push(key); return Buffer.from(url); },
  });
  return { events, pool, client };
}

async function rotationTests() {
  for (const status of [401, 402, 403, 429, 500]) {
    const f = poolFixture();
    const pooled = new PooledDeapiRenderer(f.pool, key => {
      const c = f.client(key);
      c.quote = async () => {
        f.events.quotes.push(key);
        if (key === 'fake-key-1') throw new Error(`DEAPI_QUOTE_HTTP_${status}`);
        return 0.218;
      };
      return c;
    });
    if (status === 500) {
      await assert.rejects(pooled.prepare('prompt'), /HTTP_500/);
      assert.equal(f.events.next, 1);
    } else {
      assert.deepEqual(await pooled.prepare('prompt'), { price: 0.218, keyId: 2 });
      assert.equal(f.events.next, 2);
    }
    assert.deepEqual(f.events.disabled, status === 401 ? [1] : [], '403 permission/plan limits do not kill valid keys');
    assert.equal(f.events.submits.length, 0);
  }
  {
    const f = poolFixture();
    const pooled = new PooledDeapiRenderer(f.pool, key => {
      const c = f.client(key);
      c.submit = async () => { f.events.submits.push(key); throw new Error('DEAPI_SUBMIT_HTTP_401'); };
      c.poll = async () => { f.events.polls.push(key); throw new Error('DEAPI_POLL_HTTP_401'); };
      return c;
    });
    await pooled.prepare('prompt');
    await assert.rejects(pooled.submit('prompt', 71, undefined, 1), /SUBMIT_HTTP_401/);
    await assert.rejects(pooled.poll('accepted', 1), /POLL_HTTP_401/);
    assert.equal(f.events.next, 1, 'Neither submit nor poll can acquire another key');
    assert.deepEqual(f.events.submits, ['fake-key-1']);
    await assert.rejects(pooled.poll('legacy-no-key-id'), /JOB_KEY_UNKNOWN/);
    await assert.rejects(pooled.poll('missing', 99), /JOB_KEY_MISSING/);
    assert.equal(f.events.next, 1, 'Missing bindings never fall back to an environment key');
  }
  {
    const f = poolFixture(), pooled = new PooledDeapiRenderer(f.pool, f.client);
    const [a, b] = await Promise.all([pooled.prepare('a'), pooled.prepare('b')]);
    await Promise.all([
      pooled.submit('a', 71, undefined, a.keyId), pooled.submit('b', 71, undefined, b.keyId),
    ]);
    await Promise.all([pooled.poll('a', a.keyId), pooled.poll('b', b.keyId)]);
    assert.deepEqual(f.events.submits, ['fake-key-1', 'fake-key-2']);
    assert.deepEqual(f.events.polls, ['fake-key-1:a', 'fake-key-2:b']);
    await pooled.download('https://cdn.test/result.mp4');
    assert.deepEqual(f.events.downloads, [''], 'Downloads carry no API credential');
  }
}

async function engineBindingTests(mode: 'poll' | 'rate' | 'all-rate' | 'ambiguous' = 'poll') {
  const f = poolFixture();
  let failPoll = mode === 'poll';
  const renderer = new PooledDeapiRenderer(f.pool, key => {
    const c = f.client(key);
    c.submit = async () => {
      f.events.submits.push(key);
      if (mode === 'ambiguous') throw new Error('DEAPI_SUBMIT_HTTP_429');
      if (mode === 'all-rate' || (mode === 'rate' && key === 'fake-key-1')) {
        throw new DeapiRateLimitError('SUBMIT', Date.now() + 60_000);
      }
      return `job-${key}`;
    };
    c.poll = async id => {
      f.events.polls.push(`${key}:${id}`);
      if (failPoll) throw new Error('DEAPI_POLL_HTTP_403');
      return 'https://cdn.test/result.mp4';
    };
    return c;
  });
  let row: DramaProject = {
    id: '00000000-0000-4000-8000-000000000001', owner: 42, chat: 42, status: 'quoted', model: 'test',
    quotes: [0.218, 0.218], quotedAt: Date.now(), jobs: [{}, {}],
    plan: { title: 'Test', synopsis: 'Test', setting: 'Room',
      characters: [{ id: 'RAKA', name: 'Raka', age: 30, description: 'Black jacket' }],
      scenes: [0, 1].map(() => ({ action: 'Looks at door', dialogue: [{ speaker: 'RAKA', text: 'Siapa itu?' }] })) },
  };
  const saves: DramaProject[] = [];
  const deps = {
    store: {
      async create() { return row; }, async latest() { return row; },
      async withLock(id: string, owner: number, fn: any) {
        const p = JSON.parse(JSON.stringify(row));
        await fn(p, async () => { row = JSON.parse(JSON.stringify(p)); saves.push(row); }); return true;
      },
    },
    renderer, writer: { async write() { return row.plan!; } }, async authorized() { return true; },
    async notify() {}, async present() {}, async deliver() { return 'file-id'; },
    media: { async check() {}, async placeholder() { return Buffer.from('png'); },
      async lastFrame() { return Buffer.from('png'); }, async assemble() { return Buffer.from('video'); } },
  };
  await new MicrodramaEngine(deps).act(row.id, 42, 'approve');
  if (mode === 'rate') {
    assert.equal(row.status, 'delivered', 'Rejected 429 immediately moves to another key');
    assert.deepEqual(f.events.submits.slice(0, 2), ['fake-key-1', 'fake-key-2']);
    assert.equal(row.jobs[0].keyId, 2);
    assert(f.events.polls.every(value => value.startsWith('fake-key-2:')));
    assert(saves.some(p => !p.jobs[0].attempted && !p.jobs[0].id), 'Explicit rejection is cleared durably before retry');
    assert(saves.some(p => p.jobs[0].attempted && p.jobs[0].keyId === 2 && !p.jobs[0].id),
      'Replacement key is persisted before its paid call');
    assert.deepEqual(f.events.disabled, [], 'Rate-limited keys retain their balance and status');
    return;
  }
  if (mode === 'all-rate') {
    assert.equal(row.status, 'paused');
    assert.equal(row.jobs[0].attempted, false);
    assert.equal(row.jobs[0].id, undefined);
    assert.deepEqual(f.events.submits, ['fake-key-1', 'fake-key-2'], 'At most one submit per key, no infinite loop');
    assert.deepEqual(f.events.disabled, []);
    return;
  }
  if (mode === 'ambiguous') {
    assert.equal(row.status, 'uncertain');
    assert.equal(row.jobs[0].attempted, true);
    await new MicrodramaEngine(deps).act(row.id, 42, 'resume');
    assert.deepEqual(f.events.submits, ['fake-key-1'], 'Unverified 429 never clears the write-ahead marker');
    return;
  }
  assert.equal(row.status, 'paused');
  assert.equal(row.jobs[0].keyId, 1);
  assert.equal(row.jobs[0].id, 'job-fake-key-1');
  assert.ok(saves.some(p => p.jobs[0].attempted && p.jobs[0].keyId === 1 && !p.jobs[0].id),
    'Key ID and attempted marker must be saved before the paid call');
  failPoll = false;
  await new MicrodramaEngine(deps).act(row.id, 42, 'resume');
  assert.equal(row.status, 'delivered');
  assert.deepEqual(f.events.submits, ['fake-key-1', 'fake-key-2']);
  assert.equal(f.events.next, 2, 'Only a new scene selects another key; resumed scene keeps original');
  assert.deepEqual(f.events.polls.slice(0, 2), ['fake-key-1:job-fake-key-1', 'fake-key-1:job-fake-key-1']);
  assert.equal(row.jobs[1].keyId, 2);
}

async function rateLimitTests() {
  const now = Date.now();
  assert.equal(deapiRetryAt(new Headers({ 'retry-after': '90' }), now), now + 90_000);
  const daily = Math.floor(now / 1000) + 86400;
  assert.equal(deapiRetryAt(new Headers({ 'retry-after': '60', 'x-ratelimit-daily-reset': String(daily) }), now), daily * 1000);
  assert.equal(deapiRetryAt(new Headers(), now), now + 60_000);
  assert.equal(deapiRetryAt(new Headers({ 'retry-after': '60', 'x-ratelimit-reset': String(Math.floor(now / 1000) + 60),
    'x-ratelimit-daily-reset': String(daily), 'x-ratelimit-daily-remaining': '2' }), now), now + 60_000,
  'Minute limit does not skip a paid account until tomorrow when daily quota remains');
  for (const body of [
    { message: 'Too Many Attempts.' }, { error: { message: 'Rate limit exceeded' } },
    { message: 'Limit', data: { request_id: 'already-accepted' } },
    { message: 'Limit', data: { status: 'queued' } },
    null, '<html>proxy failure</html>',
  ]) {
    let calls = 0;
    const client = new DeapiDramaRenderer('fixture', async () => {
      calls++;
      return new Response(typeof body === 'string' ? body : JSON.stringify(body),
        { status: 429, headers: { 'Retry-After': '120' } });
    });
    const safe = !!body && typeof body === 'object' && !('data' in body);
    await assert.rejects(client.submit('prompt', 71), error =>
      safe ? error instanceof DeapiRateLimitError && error.retryAt >= now + 120_000
        : error instanceof Error && !(error instanceof DeapiRateLimitError));
    assert.equal(calls, 1);
  }
  {
    const f = poolFixture();
    let clock = now, reject = true;
    const pooled = new PooledDeapiRenderer(f.pool, key => {
      const c = f.client(key);
      c.quote = async () => {
        if (reject && key === 'fake-key-1') throw new DeapiRateLimitError('QUOTE', now + 90_000);
        return 0.218;
      };
      return c;
    }, () => clock);
    assert.equal((await pooled.prepare('prompt')).keyId, 2);
    reject = false;
    assert.equal((await pooled.prepare('prompt')).keyId, 2, 'Cooldown skips the first key even if its quote would succeed');
    clock += 90_001;
    const choices = await Promise.all([pooled.prepare('prompt'), pooled.prepare('prompt')]);
    assert(choices.some(choice => choice.keyId === 1), 'Preserved key automatically returns after reset');
    assert.deepEqual(f.events.disabled, []);
  }
  {
    const f = poolFixture();
    const pooled = new PooledDeapiRenderer(f.pool, key => {
      const c = f.client(key);
      c.quote = async () => { throw new DeapiRateLimitError('QUOTE', now + 60_000); };
      return c;
    });
    await assert.rejects(pooled.prepare('prompt'), /NO_USABLE_KEY/);
    assert.deepEqual(f.events.disabled, []);
    assert.equal(f.events.submits.length, 0);
  }
  {
    let calls = 0;
    const client = new DeapiDramaRenderer('fixture', async () => {
      calls++;
      if (calls === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '1' } });
      return Response.json({ data: { status: 'done', result_url: 'https://cdn.test/video.mp4' } });
    }, async () => {});
    assert.equal(await client.poll('accepted-job'), 'https://cdn.test/video.mp4');
    assert.equal(calls, 2, 'Polling limits retry the same job, never a fresh generation');
  }
}

async function adminTests() {
  const commands = new Map<string, any>(), messages: string[] = [], inserted: string[][] = [];
  let admin = true, deleted = 0;
  const pool = {
    async addKeys(keys: string[]) { inserted.push(keys); return keys.length; },
    async stats() { return { available: 1, dead: 0 }; }, async list() {
      return [{ id: 7, status: 'available', cooldowns: [{ scope: 'videos/animations:test-model',
        limited_at: '2026-11-05T01:00:00Z', retry_at: '2026-11-05T02:00:00Z' }] }];
    },
    async disable(id: number) { return id === 7; }, async restore(id: number) { return id === 7; },
  };
  registerDeapiAdmin({ command(name: string, fn: any) { commands.set(name, fn); } } as any, pool as any, async () => admin);
  const ctx: any = { from: { id: 42 }, chat: { type: 'private' }, message: { text: '' },
    async reply(text: string) { messages.push(text); }, async deleteMessage() { deleted++; } };
  async function command(name: string, arg = '') {
    ctx.message.text = `/${name}@test_bot ${arg}`;
    await commands.get(name)(ctx);
  }
  admin = false; await command('adddeapikey', 'private-fixture-key');
  assert.equal(inserted.length, 0);
  admin = true; ctx.chat.type = 'group';
  await command('adddeapikey', 'private-fixture-key'); assert.equal(inserted.length, 0);
  ctx.chat.type = 'private';
  await command('adddeapikey', 'private-fixture-key,other-fixture-key\nprivate-fixture-key');
  assert.deepEqual(inserted, [['private-fixture-key', 'other-fixture-key']]);
  await command('deapipool');
  assert.match(messages.at(-1)!, /Tersedia: 1/);
  assert.match(messages.at(-1)!, /Kena limit:.*08\.00\.00 WIB/);
  assert.match(messages.at(-1)!, /Coba lagi mulai:.*09\.00\.00 WIB/);
  assert.match(deapiLimitTime('2026-11-05T02:00:00Z'), /05\/11\/2026/);
  await command('nonaktifdeapikey', '7');
  assert.match(messages.at(-1)!, /dinonaktifkan/);
  await command('restoredeapikey', '7');
  assert.match(messages.at(-1)!, /diaktifkan/);
  await command('restoredeapikey', '-1');
  assert.match(messages.at(-1)!, /Format/);
  assert.ok(deleted >= 3);
  assert.ok(messages.every(m => !m.includes('private-fixture-key') && !m.includes('other-fixture-key')));
}

async function main() {
  await databaseContract(); await rotationTests(); await rateLimitTests();
  for (const mode of ['poll', 'rate', 'all-rate', 'ambiguous'] as const) await engineBindingTests(mode);
  await adminTests();
  console.log('PASS DeAPI pool: rate-limit rotation, cooldown recovery, retained keys, durable accepted-job binding, ambiguity safety and admin management (offline).');
}
main().catch(e => { console.error(e); process.exitCode = 1; });
