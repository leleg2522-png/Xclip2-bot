import assert from 'node:assert/strict';
import { Client } from 'pg';
import { DeapiKeyPool } from '../src/deapi-key-pool';

async function main() {
  if (!process.argv.includes('--apply')) throw new Error('Explicit --apply is required');
  if (!process.env.RAILWAY_DATABASE_URL) throw new Error('Railway database secret is unavailable');
  const client = new Client({
    connectionString: process.env.RAILWAY_DATABASE_URL, ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15_000,
  });
  try {
    await client.connect();
    const target = await client.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema='public' AND table_name IN ('users','flora_key_pool')`);
    if (target.rows.length !== 2) throw new Error('Unexpected target database');
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout='10s'; SET LOCAL statement_timeout='30s'");
    await client.query('SELECT pg_advisory_xact_lock(807240007)');
    const pool = new DeapiKeyPool(client);
    await pool.ensureSchema();
    const stats = await pool.stats();
    // All test rows live only in temporary tables; no real key values are read.
    await client.query(`CREATE TEMP TABLE deapi_key_pool (
      id INTEGER PRIMARY KEY, api_key TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'available',
      last_used_at TIMESTAMPTZ, dead_at TIMESTAMPTZ, created_at TIMESTAMPTZ DEFAULT NOW()
    ) ON COMMIT DROP`);
    await client.query(`CREATE TEMP TABLE deapi_key_cooldowns (
      key_id INTEGER NOT NULL REFERENCES deapi_key_pool(id), scope TEXT NOT NULL,
      limited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), retry_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY(key_id,scope)
    ) ON COMMIT DROP`);
    await client.query(`INSERT INTO deapi_key_pool(id,api_key) VALUES
      (1,'test-only-fixture-one'),(2,'test-only-fixture-two')`);
    const scope = 'videos/animations:test-model';
    const retryAt = Date.now() + 3600_000;
    await pool.markLimited(1, scope, retryAt);
    const restartedPool = new DeapiKeyPool(client);
    assert.equal((await restartedPool.next([], ['quotes', scope]))?.id, 2);
    assert.equal((await restartedPool.get(1))?.id, 1, 'Existing jobs keep their key despite cooldown');
    assert.equal((await restartedPool.next([2], ['unrelated-model']))?.id, 1);
    const row = (await restartedPool.list()).find(r => r.id === 1)!;
    assert.equal(row.status, 'available', 'Rate limit does not discard a valid key');
    assert.equal(row.cooldowns.length, 1);
    assert.equal(new Date(row.cooldowns[0].retry_at).getTime(), retryAt);
    await restartedPool.markLimited(1, scope, retryAt - 30_000);
    const unchanged = (await restartedPool.list()).find(r => r.id === 1)!;
    assert.equal(new Date(unchanged.cooldowns[0].retry_at).getTime(), retryAt, 'Concurrent shorter cooldown cannot shorten a limit');
    await client.query("UPDATE deapi_key_cooldowns SET retry_at=NOW()-INTERVAL '1 second' WHERE key_id=1");
    assert.equal((await new DeapiKeyPool(client).next([2], ['quotes', scope]))?.id, 1, 'Expired key automatically returns');
    assert.equal((await restartedPool.list()).find(r => r.id === 1)!.cooldowns.length, 0);
    await client.query('COMMIT');
    console.log(JSON.stringify({ target: 'Railway bot database', cooldownSchema: 'ready', stats,
      postgresTests: 'cross-instance selection, retained keys, scoped limits, expiry and timestamps passed' }));
  } catch {
    await client.query('ROLLBACK').catch(() => {});
    throw new Error('DeAPI cooldown setup or verification failed; credential details withheld');
  } finally { await client.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
