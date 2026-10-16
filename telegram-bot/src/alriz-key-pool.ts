type Queryable = {
  query: (sql: string, params?: any[]) => Promise<{ rows: any[]; rowCount: number | null }>;
};
export interface AlrizPoolKey { id: number; apiKey: string }
export interface AlrizKeySource {
  next: (skipIds: number[]) => Promise<AlrizPoolKey | null>;
  disable: (id: number) => Promise<boolean>;
}

/** Reusable account keys, unlike the one-use ChinaAPI pool. Never return key fragments to admins. */
export class AlrizKeyPool implements AlrizKeySource {
  constructor(private readonly db: Queryable) {}

  private async query(sql: string, params?: any[]) {
    try { return await this.db.query(sql, params); }
    catch { throw new Error('ALRIZ_POOL_DATABASE_FAILED'); }
  }

  async ensureSchema(): Promise<void> {
    await this.query(`CREATE TABLE IF NOT EXISTS alriz_key_pool (
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
    if (clean.length === 0 || clean.some(key => key.length < 8 || key.length > 2048 || /[\s"'`<>\\]/.test(key))) {
      throw new Error('ALRIZ_POOL_INVALID_KEY_FORMAT');
    }
    const result = await this.query(
      `INSERT INTO alriz_key_pool (api_key)
       SELECT unnest($1::text[]) ON CONFLICT (api_key) DO NOTHING RETURNING id`, [clean],
    );
    return result.rowCount ?? 0;
  }

  async next(skipIds: number[] = []): Promise<AlrizPoolKey | null> {
    // Atomic fair selection across replicas; account keys can service concurrent jobs.
    const result = await this.query(
      `UPDATE alriz_key_pool SET last_used_at = NOW()
       WHERE id = (
         SELECT id FROM alriz_key_pool WHERE status = 'available' AND NOT (id = ANY($1::int[]))
         ORDER BY last_used_at ASC NULLS FIRST, id
         LIMIT 1 FOR UPDATE SKIP LOCKED
       ) RETURNING id, api_key`, [skipIds],
    );
    const row = result.rows[0];
    return row ? { id: row.id, apiKey: row.api_key } : null;
  }

  async disable(id: number): Promise<boolean> {
    const result = await this.query(
      `UPDATE alriz_key_pool SET status = 'dead', dead_at = NOW() WHERE id = $1 RETURNING id`, [id],
    );
    return !!result.rowCount;
  }

  async restore(id: number): Promise<boolean> {
    const result = await this.query(
      `UPDATE alriz_key_pool SET status = 'available', dead_at = NULL WHERE id = $1 RETURNING id`, [id],
    );
    return !!result.rowCount;
  }

  async stats(): Promise<{ available: number; dead: number }> {
    const result = await this.query(
      `SELECT COUNT(*) FILTER (WHERE status = 'available')::int AS available,
       COUNT(*) FILTER (WHERE status = 'dead')::int AS dead FROM alriz_key_pool`,
    );
    return result.rows[0];
  }

  async list(): Promise<Array<{ id: number; status: string }>> {
    const result = await this.query('SELECT id, status FROM alriz_key_pool ORDER BY id LIMIT 100');
    return result.rows;
  }
}
