type Queryable = {
  query(sql: string, params?: any[]): Promise<{ rows: any[]; rowCount: number | null }>;
};
export interface VivareelPoolKey { id: number; apiKey: string }
export interface VivareelKeySource {
  next(): Promise<VivareelPoolKey | null>;
  disable(id: number): Promise<boolean>;
}

/** Reusable credentials. Selection is atomic across bot replicas, not one-use. */
export class VivareelKeyPool implements VivareelKeySource {
  constructor(private readonly db: Queryable) {}

  private async query(sql: string, params?: any[]) {
    try { return await this.db.query(sql, params); }
    catch { throw Error('VIVAREEL_POOL_DATABASE_FAILED'); }
  }

  async ensureSchema(): Promise<void> {
    await this.query(`CREATE TABLE IF NOT EXISTS vivareel_key_pool (
      id SERIAL PRIMARY KEY,
      api_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'dead')),
      last_used_at TIMESTAMPTZ,
      dead_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  }

  async addKeys(keys: string[]): Promise<number> {
    const clean = [...new Set(keys.map(key => key.trim()))];
    if (!clean.length || clean.some(key => key.length < 8 || key.length > 2048 || /[\s"'`<>\\]/.test(key))) {
      throw Error('VIVAREEL_POOL_INVALID_KEY_FORMAT');
    }
    const result = await this.query(
      `INSERT INTO vivareel_key_pool (api_key)
       SELECT unnest($1::text[]) ON CONFLICT (api_key) DO NOTHING RETURNING id`, [clean],
    );
    return result.rowCount ?? 0;
  }

  async next(): Promise<VivareelPoolKey | null> {
    const result = await this.query(
      `UPDATE vivareel_key_pool SET last_used_at = clock_timestamp()
       WHERE id = (
         SELECT id FROM vivareel_key_pool WHERE status = 'available'
         ORDER BY last_used_at ASC NULLS FIRST, id
         LIMIT 1 FOR UPDATE SKIP LOCKED
       ) RETURNING id, api_key`,
    );
    const row = result.rows[0];
    return row ? { id: row.id, apiKey: row.api_key } : null;
  }

  async disable(id: number): Promise<boolean> {
    const result = await this.query(
      `UPDATE vivareel_key_pool SET status = 'dead', dead_at = NOW() WHERE id = $1 RETURNING id`, [id],
    );
    return !!result.rowCount;
  }

  async restore(id: number): Promise<boolean> {
    const result = await this.query(
      `UPDATE vivareel_key_pool SET status = 'available', dead_at = NULL WHERE id = $1 RETURNING id`, [id],
    );
    return !!result.rowCount;
  }

  async stats(): Promise<{ available: number; dead: number }> {
    const result = await this.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'available')::int AS available,
       COUNT(*) FILTER (WHERE status = 'dead')::int AS dead FROM vivareel_key_pool`,
    );
    return result.rows[0];
  }

  async list(): Promise<Array<{ id: number; status: string }>> {
    return (await this.query('SELECT id, status FROM vivareel_key_pool ORDER BY id LIMIT 100')).rows;
  }
}
