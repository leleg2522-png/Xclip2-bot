import { Client } from 'pg';
import { AlrizKeyPool } from '../src/alriz-key-pool';

async function main() {
  if (!process.argv.includes('--apply')) throw Error('Explicit --apply is required');
  if (!process.env.RAILWAY_DATABASE_URL || !process.env.ALRIZ_API_KEY) throw Error('Required setup secrets are unavailable');
  const client = new Client({
    connectionString: process.env.RAILWAY_DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });
  try {
    await client.connect();
    const target = await client.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('users', 'flora_key_pool')`);
    if (target.rows.length !== 2) throw Error('Unexpected target database');
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '30s'");
    await client.query('SELECT pg_advisory_xact_lock(807240005)');
    const pool = new AlrizKeyPool(client);
    await pool.ensureSchema();
    const added = await pool.addKeys([process.env.ALRIZ_API_KEY]);
    const stats = await pool.stats();
    await client.query('COMMIT');
    console.log(JSON.stringify({ target: 'Railway bot database', pool: 'Alriz', added, stats }));
  } catch {
    await client.query('ROLLBACK').catch(() => {});
    throw Error('Alriz pool setup failed; credential details withheld');
  } finally { await client.end(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
