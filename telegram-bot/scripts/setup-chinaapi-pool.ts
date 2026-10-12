import { Client } from 'pg';
import { ChinaApiKeyPool } from '../src/chinaapi-key-pool';

async function main() {
  if (!process.argv.includes('--apply')) throw Error('Explicit --apply is required');
  if (!process.env.RAILWAY_DATABASE_URL) throw Error('Missing Railway database secret');
  const client = new Client({ connectionString: process.env.RAILWAY_DATABASE_URL, connectionTimeoutMillis: 15000 });
  try {
    await client.connect();
    const target = await client.query(`SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('users', 'flora_key_pool')`);
    if (target.rows.length !== 2) throw Error('Target is not the documented bot database');
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '30s'");
    await client.query('SELECT pg_advisory_xact_lock(807240003)');
    const pool = new ChinaApiKeyPool(client);
    await pool.ensureSchema();
    const added = process.env.CHINAAPI_API_KEY ? await pool.addKeys([process.env.CHINAAPI_API_KEY]) : 0;
    const stats = await pool.stats();
    await client.query('COMMIT');
    console.log(JSON.stringify({ target: 'Railway bot database', table: 'chinaapi_key_pool', added, stats }));
  } catch {
    await client.query('ROLLBACK').catch(() => {});
    throw Error('ChinaAPI pool setup failed; credential details withheld');
  } finally {
    await client.end();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
