import { randomUUID } from 'node:crypto';

type Database = {
  query(sql: string, params?: any[]): Promise<{ rows: any[]; rowCount: number | null }>;
};
export type ChinaKeyLease = { id: number; apiKey: string; token: string };

/** Shared Railway pool, with one leased job per key across bot instances. */
export class ChinaApiKeyPool {
  constructor(private readonly database: Database) {}
  private async query(sql: string, params?: any[]) {
    try { return await this.database.query(sql, params); }
    catch { throw new Error('CHINA_POOL_DATABASE_ERROR'); } // PG detail can contain a key.
  }
  async ensureSchema(): Promise<void> {
    await this.query(`
      CREATE TABLE IF NOT EXISTS chinaapi_key_pool (
        id SERIAL PRIMARY KEY,
        api_key TEXT NOT NULL UNIQUE CHECK (length(api_key) BETWEEN 16 AND 512),
        status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'dead')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        last_used_at TIMESTAMPTZ,
        dead_at TIMESTAMPTZ,
        dead_reason TEXT,
        consumed_at TIMESTAMPTZ,
        lease_token TEXT,
        lease_until TIMESTAMPTZ
      );
      ALTER TABLE chinaapi_key_pool ADD COLUMN IF NOT EXISTS consumed_at TIMESTAMPTZ;
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint
          WHERE conname = 'chinaapi_key_pool_single_use_check'
            AND conrelid = 'chinaapi_key_pool'::regclass) THEN
          ALTER TABLE chinaapi_key_pool ADD CONSTRAINT chinaapi_key_pool_single_use_check
            CHECK (consumed_at IS NULL OR status = 'dead');
        END IF;
      END $$;
      CREATE INDEX IF NOT EXISTS chinaapi_key_pool_available_idx
        ON chinaapi_key_pool (status, last_used_at, id);
    `);
  }
  async addKeys(keys: string[]): Promise<number> {
    const unique = [...new Set(keys.map(key => key.trim()).filter(Boolean))];
    if (!unique.length || unique.some(key => !/^[A-Za-z0-9._=-]{16,512}$/.test(key))) {
      throw new Error('CHINA_POOL_INVALID_KEYS');
    }
    const result = await this.query(
      `INSERT INTO chinaapi_key_pool (api_key)
       SELECT unnest($1::text[]) ON CONFLICT (api_key) DO NOTHING`, [unique],
    );
    return result.rowCount ?? 0;
  }
  async hasAvailable(): Promise<boolean> {
    const result = await this.query(
      `SELECT EXISTS(SELECT 1 FROM chinaapi_key_pool
       WHERE status = 'available' AND consumed_at IS NULL AND (lease_until IS NULL OR lease_until <= NOW())) AS available`,
    );
    return result.rows[0]?.available === true;
  }
  async acquire(skipIds: number[] = []): Promise<ChinaKeyLease | null> {
    const token = randomUUID();
    const result = await this.query(
      `WITH candidate AS (
         SELECT id FROM chinaapi_key_pool
         WHERE status = 'available' AND consumed_at IS NULL AND (lease_until IS NULL OR lease_until <= NOW())
           AND id <> ALL($1::integer[])
         ORDER BY last_used_at NULLS FIRST, id FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE chinaapi_key_pool p
       SET last_used_at = NOW(), lease_token = $2, lease_until = NOW() + INTERVAL '1 hour'
       FROM candidate c WHERE p.id = c.id
       RETURNING p.id, p.api_key`, [skipIds, token],
    );
    const row = result.rows[0];
    return row ? { id: row.id, apiKey: row.api_key, token } : null;
  }
  async consume(lease: ChinaKeyLease): Promise<void> {
    // Commit BEFORE the paid request. An ambiguous DB response means no submit.
    // A crash/timeout/restart must never make this credential available again.
    const result = await this.query(
      `UPDATE chinaapi_key_pool SET consumed_at = NOW(), status = 'dead',
       dead_at = NOW(), dead_reason = 'single_use_consumed'
       WHERE id = $1 AND lease_token = $2 AND status = 'available'
         AND consumed_at IS NULL AND lease_until > NOW() RETURNING id`,
      [lease.id, lease.token],
    );
    if (!result.rowCount) throw new Error('CHINA_POOL_KEY_ALREADY_USED_OR_NOT_OWNED');
  }
  async retirePreviouslyUsed(apiKey: string): Promise<number> {
    const result = await this.query(
      `UPDATE chinaapi_key_pool SET consumed_at = NOW(), status = 'dead',
       dead_at = NOW(), dead_reason = 'previously_used'
       WHERE api_key = $1 AND consumed_at IS NULL
         AND (lease_until IS NULL OR lease_until <= NOW())`, [apiKey],
    );
    return result.rowCount ?? 0;
  }
  async release(lease: ChinaKeyLease, deadReason?: string): Promise<void> {
    // Compare ownership so an expired job cannot release a newer job's lease.
    const safeReason = deadReason ? 'authentication_or_quota_rejected' : null;
    await this.query(
      `UPDATE chinaapi_key_pool
       SET lease_token = NULL, lease_until = NULL,
           status = CASE WHEN $3::text IS NULL THEN status ELSE 'dead' END,
           dead_at = CASE WHEN $3::text IS NULL THEN dead_at ELSE NOW() END,
           dead_reason = CASE WHEN consumed_at IS NOT NULL THEN dead_reason ELSE COALESCE($3::text, dead_reason) END
       WHERE id = $1 AND lease_token = $2`, [lease.id, lease.token, safeReason],
    );
  }
  async stats(): Promise<{ available: number; busy: number; dead: number; used: number }> {
    const result = await this.query(
      `SELECT
        COUNT(*) FILTER (WHERE status = 'available' AND (lease_until IS NULL OR lease_until <= NOW()))::int AS available,
        COUNT(*) FILTER (WHERE status = 'available' AND lease_until > NOW())::int AS busy,
        COUNT(*) FILTER (WHERE status = 'dead' AND consumed_at IS NULL)::int AS dead,
        COUNT(*) FILTER (WHERE consumed_at IS NOT NULL)::int AS used
       FROM chinaapi_key_pool`,
    );
    return result.rows[0];
  }
  async list(): Promise<Array<{ id: number; status: string; busy: boolean }>> {
    const result = await this.query(
      `SELECT id, CASE WHEN consumed_at IS NOT NULL THEN 'used' ELSE status END AS status,
       COALESCE(lease_until > NOW(), false) AS busy
       FROM chinaapi_key_pool ORDER BY id LIMIT 100`,
    );
    return result.rows;
  }
  async disable(id: number): Promise<boolean> {
    const result = await this.query(
      `UPDATE chinaapi_key_pool SET status = 'dead', dead_at = NOW(), dead_reason = 'admin_disabled'
       WHERE id = $1 RETURNING id`, [id],
    );
    return !!result.rowCount;
  }
  async restore(id: number): Promise<boolean> {
    const result = await this.query(
      `UPDATE chinaapi_key_pool SET status = 'available', dead_at = NULL, dead_reason = NULL,
       lease_token = NULL, lease_until = NULL
       WHERE id = $1 AND consumed_at IS NULL AND (lease_until IS NULL OR lease_until <= NOW()) RETURNING id`, [id],
    );
    return !!result.rowCount;
  }
}
