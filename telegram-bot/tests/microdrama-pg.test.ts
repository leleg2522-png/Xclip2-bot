/** Optional integration check: isolated disposable schema in Replit DEVELOPMENT DB only. */
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { PgDramaStore } from '../src/microdrama-store';
import { DeapiKeyPool } from '../src/deapi-key-pool';

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString || connectionString === process.env.RAILWAY_DATABASE_URL) {
    throw new Error('A separate DEVELOPMENT DATABASE_URL is required; production is never used by this test');
  }
  const schema = `microdrama_test_${randomBytes(8).toString('hex')}`;
  assert.match(schema, /^[a-z0-9_]+$/);
  const admin = new Pool({ connectionString, max: 1, connectionTimeoutMillis: 10_000 });
  const pool = new Pool({ connectionString, max: 6, options: `-c search_path=${schema}`, connectionTimeoutMillis: 10_000 });
  try {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const store = new PgDramaStore(pool);
    await store.ensureSchema();
    const keys = new DeapiKeyPool(pool);
    await keys.ensureSchema();
    assert.equal(await keys.addKeys(['fixture-deapi-key-1', 'fixture-deapi-key-2', 'fixture-deapi-key-1']), 2);
    assert.equal(await keys.addKeys(['fixture-deapi-key-1']), 0);
    const key1 = await keys.next(), key2 = await keys.next();
    assert.notEqual(key1!.id, key2!.id);
    await keys.disable(key1!.id);
    assert.equal((await keys.get(key1!.id))!.apiKey, key1!.apiKey);
    assert.equal((await keys.next())!.id, key2!.id);
    await keys.restore(key1!.id);
    assert.deepEqual(await keys.stats(), { available: 2, dead: 0 });
    assert.ok((await keys.list()).every(k => !('api_key' in k)));
    const p = await store.create(1, 1, 'test-model');
    await assert.rejects(store.create(1, 1, 'test-model'), (e: any) => e.code === '23505');
    let release!: () => void, acquired!: () => void;
    const barrier = new Promise<void>(r => { release = r; });
    const ready = new Promise<void>(r => { acquired = r; });
    const worker = store.withLock(p.id, 1, async (project, save) => {
      project.status = 'rendering'; project.jobs[0] = { attempted: true, id: 'saved-job-id' };
      await save(); acquired(); await barrier;
    });
    await ready;
    assert.equal(await store.withLock(p.id, 1, async () => { throw new Error('duplicate worker'); }), false);
    const restarted = new PgDramaStore(pool);
    const restored = await restarted.latest(1);
    assert.equal(restored!.jobs[0].id, 'saved-job-id');
    assert.equal(await store.withLock(p.id, 2, async () => { throw new Error('wrong owner'); }), false);
    release(); await worker;
    await store.withLock(p.id, 1, async (project, save) => { project.status = 'cancelled'; await save(); });
    const second = await store.create(1, 1, 'test-model');
    const third = await store.create(2, 2, 'test-model');
    const fourth = await store.create(3, 3, 'test-model');
    let free1!: () => void, free2!: () => void, enter1!: () => void, enter2!: () => void;
    const b1 = new Promise<void>(r => { free1 = r; }), b2 = new Promise<void>(r => { free2 = r; });
    const r1 = new Promise<void>(r => { enter1 = r; }), r2 = new Promise<void>(r => { enter2 = r; });
    const w1 = store.withLock(second.id, 1, async () => { enter1(); await b1; });
    await r1;
    const w2 = store.withLock(third.id, 2, async () => { enter2(); await b2; });
    await r2;
    assert.equal(await store.withLock(fourth.id, 3, async () => { throw new Error('no third slot'); }), false);
    free1(); free2(); await Promise.all([w1, w2]);
    assert.equal(await store.withLock(fourth.id, 3, async () => {}), true);
    console.log('PASS real DEVELOPMENT PostgreSQL: schema, unique active owner, ownership, cross-connection locks, two-slot limit and restart state.');
  } finally {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  }
}
main().catch(() => { console.error('Microdrama isolated development PG check failed (connection details withheld).'); process.exitCode = 1; });
