import assert from 'node:assert/strict';
import { VivareelKeyPool, type VivareelKeySource } from '../src/vivareel-key-pool';
import { registerVivareelAdmin } from '../src/vivareel-admin';
import { generateVivareelWan, VIVAREEL_WAN_MODEL } from '../src/vivareel-wan';
import { generationErrorMessage } from '../src/generation-errors';
import { readFileSync } from 'node:fs';

const json = (data: unknown) => new Response(JSON.stringify({ code: 200, data }));
const catalog = { video_models: [{
  name: VIVAREEL_WAN_MODEL, is_available: true, allowed_resolutions: ['480P'],
  capabilities: ['text_to_video'], max_duration_seconds: { text_to_video: 30 },
}] };

async function main() {
  const rows: Array<{ id: number; api_key: string; status: string; used: number }> = [];
  let clock = 0;
  const sql: string[] = [];
  const pool = new VivareelKeyPool({ query: async (query, params = []) => {
    sql.push(query);
    if (query.startsWith('CREATE')) return { rows: [], rowCount: 0 };
    if (query.startsWith('INSERT')) {
      let count = 0;
      for (const key of params[0]) if (!rows.some(row => row.api_key === key)) {
        rows.push({ id: rows.length + 1, api_key: key, status: 'available', used: 0 }); count++;
      }
      return { rows: [], rowCount: count };
    }
    if (query.includes('SET last_used_at')) {
      assert.match(query, /FOR UPDATE SKIP LOCKED/);
      const row = rows.filter(row => row.status === 'available').sort((a, b) => a.used - b.used || a.id - b.id)[0];
      if (row) row.used = ++clock;
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (query.startsWith('UPDATE')) {
      const row = rows.find(row => row.id === params[0]);
      if (row) row.status = query.includes("status = 'dead'") ? 'dead' : 'available';
      return { rows: row ? [{ id: row.id }] : [], rowCount: row ? 1 : 0 };
    }
    if (query.includes('COUNT')) return { rows: [{
      available: rows.filter(row => row.status === 'available').length,
      dead: rows.filter(row => row.status === 'dead').length,
    }], rowCount: 1 };
    assert.match(query, /^SELECT id, status FROM vivareel_key_pool/);
    return { rows: rows.map(({ id, status }) => ({ id, status })), rowCount: rows.length };
  } });
  await pool.ensureSchema();
  assert.equal(await pool.addKeys([' fake-key-one ', 'fake-key-one', 'fake-key-two']), 2);
  assert.equal(await pool.addKeys(['fake-key-one']), 0);
  assert.deepEqual((await Promise.all([pool.next(), pool.next(), pool.next()])).map(row => row?.id), [1, 2, 1]);
  await pool.disable(1);
  assert.equal((await pool.next())?.id, 2);
  assert.equal(await pool.addKeys(['fake-key-one']), 0, 'Startup must not reactivate a disabled key');
  assert.deepEqual(await pool.stats(), { available: 1, dead: 1 });
  assert.doesNotMatch(JSON.stringify(await pool.list()), /fake-key/);
  assert.equal(await pool.restore(1), true);
  assert.equal(await pool.restore(999), false);
  for (const keys of [[], ['short'], ['key with spaces'], ['key-with-secret"quote']]) {
    const count = sql.length;
    await assert.rejects(pool.addKeys(keys), /INVALID_KEY_FORMAT/);
    assert.equal(sql.length, count);
  }
  const broken = new VivareelKeyPool({ query: async () => { throw Error('fake-sensitive-database-error'); } });
  await assert.rejects(broken.next(), error => error instanceof Error && error.message === 'VIVAREEL_POOL_DATABASE_FAILED');
  await pool.disable(1); await pool.disable(2);
  assert.equal(await pool.next(), null);
  await pool.restore(1); await pool.restore(2);

  // Real generation orchestration with fake transport: no paid requests in tests.
  for (const mode of ['success', 'empty', 'pre401', 'pre402', 'pre403', 'poll401', 'poll402', 'ambiguous', 'moderation'] as const) {
    const disabled: number[] = [], headers: string[] = [], requests: string[] = [];
    let selections = 0, submits = 0;
    const source: VivareelKeySource = {
      next: async () => { selections++; return mode === 'empty' ? null : { id: 7, apiKey: 'fake-sticky-key' }; },
      disable: async id => { disabled.push(id); return true; },
    };
    const transport: typeof fetch = async (url, options) => {
      const path = new URL(String(url)).pathname;
      requests.push(path);
      headers.push((options?.headers as Record<string, string>).Authorization);
      if (path.endsWith('/models')) {
        if (mode.startsWith('pre')) return new Response('{}', { status: Number(mode.slice(3)) });
        return json(catalog);
      }
      if (path.endsWith('/videos/generations')) {
        submits++;
        if (mode === 'ambiguous') throw Error('private transport error');
        return json({ task_id: 'accepted-once' });
      }
      if (mode.startsWith('poll')) return new Response('{}', { status: Number(mode.slice(4)) });
      if (mode === 'moderation') return json({ status: 'failed', error_message: 'Vivareel: input_text_sensitive' });
      return json({ status: 'completed', result_url: 'https://example.test/finished.mp4' });
    };
    const run = () => generateVivareelWan({ prompt: 'walk' }, source, { transport, pause: async () => {} });
    if (mode === 'success') assert.equal((await run()).url, 'https://example.test/finished.mp4');
    else await assert.rejects(run(), error => {
      assert.doesNotMatch(generationErrorMessage(error), /Vivareel|private transport error|fake-sticky-key/i);
      return true;
    });
    assert.equal(selections, 1, 'One credential for the entire job, including failures');
    assert.deepEqual(disabled, ['pre401', 'pre402', 'poll401', 'poll402'].includes(mode) ? [7] : []);
    assert.equal(submits, mode === 'empty' || mode.startsWith('pre') ? 0 : 1, 'No resubmit after acceptance or ambiguous submit');
    assert.ok(headers.every(header => header === 'Bearer fake-sticky-key'));
    if (mode === 'empty') assert.equal(requests.length, 0, 'No environment-key fallback');
  }

  const handlers = new Map<string, (ctx: any) => Promise<any>>();
  let admin = true, touched = 0, deleted = 0;
  const replies: string[] = [];
  registerVivareelAdmin({ command(name: string, handler: any) { handlers.set(name, handler); } } as any, pool,
    async () => admin);
  const ctx = (text: string, type = 'private') => ({
    chat: { type }, message: { text },
    deleteMessage: async () => { deleted++; },
    reply: async (message: string) => { replies.push(message); },
  });
  await handlers.get('addvivareelkey')!(ctx('/addvivareelkey@mybot fake-key-three,fake-key-three'));
  assert.equal(deleted, 1);
  await handlers.get('vivareelpool')!(ctx('/vivareelpool'));
  assert.doesNotMatch(replies.join('\n'), /fake-key/);
  const before = (await pool.stats()).available;
  admin = false;
  await handlers.get('addvivareelkey')!(ctx('/addvivareelkey fake-key-denied'));
  await handlers.get('nonaktifvivareelkey')!(ctx('/nonaktifvivareelkey 1'));
  assert.equal((await pool.stats()).available, before);
  admin = true;
  await handlers.get('addvivareelkey')!(ctx('/addvivareelkey fake-key-denied', 'group'));
  assert.equal((await pool.stats()).available, before);
  await handlers.get('nonaktifvivareelkey')!(ctx('/nonaktifvivareelkey 1'));
  assert.equal((await pool.stats()).dead, 1);
  await handlers.get('restorevivareelkey')!(ctx('/restorevivareelkey 1'));
  assert.equal((await pool.stats()).dead, 0);
  await handlers.get('nonaktifvivareelkey')!(ctx('/nonaktifvivareelkey -1'));
  assert.equal((await pool.stats()).dead, 0);

  const index = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert.match(index, /generateVivareelWanFromPool\(input, vivareelKeyPool\)/);
  assert.match(index, /registerVivareelAdmin\(bot, vivareelKeyPool, requireAdmin\)/);
  assert.match(index, /await vivareelKeyPool.ensureSchema\(\)/);
  console.log('Vivareel pool: rotation, deduplication, disable/restore, secret-safe admin, same-key polling, no paid replay and runtime wiring passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
