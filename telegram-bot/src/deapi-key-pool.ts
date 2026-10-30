type Queryable = { query(sql: string, params?: any[]): Promise<{ rows: any[]; rowCount: number | null }> };
export interface DeapiPoolKey { id: number; apiKey: string }
export interface DeapiKeySource {
  next(skipIds?: number[]): Promise<DeapiPoolKey | null>;
  get(id: number): Promise<DeapiPoolKey | null>;
  disable(id: number): Promise<boolean>;
}

/** Reusable immutable account credentials. IDs remain available for accepted-job recovery. */
export class DeapiKeyPool implements DeapiKeySource {
  constructor(private db: Queryable) {}

  private async query(sql: string, params?: any[]) {
    try { return await this.db.query(sql, params); }
    catch { throw new Error('DEAPI_POOL_DATABASE_FAILED'); }
  }

  async ensureSchema() {
    await this.query(`CREATE TABLE IF NOT EXISTS deapi_key_pool (
      id SERIAL PRIMARY KEY, api_key TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','dead')),
      last_used_at TIMESTAMPTZ, dead_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  }

  async addKeys(keys: string[]): Promise<number> {
    const clean = [...new Set(keys.map(k => k.trim()))];
    if (!clean.length || clean.length > 100 || clean.some(k => k.length < 8 || k.length > 2048 || /[\s"'`<>\\]/.test(k))) {
      throw new Error('DEAPI_POOL_INVALID_KEY_FORMAT');
    }
    const r = await this.query(`INSERT INTO deapi_key_pool(api_key)
      SELECT unnest($1::text[]) ON CONFLICT(api_key) DO NOTHING RETURNING id`, [clean]);
    return r.rowCount ?? 0;
  }

  async next(skipIds: number[] = []): Promise<DeapiPoolKey | null> {
    const r = await this.query(`UPDATE deapi_key_pool SET last_used_at=NOW()
      WHERE id=(SELECT id FROM deapi_key_pool WHERE status='available' AND NOT(id=ANY($1::int[]))
        ORDER BY last_used_at ASC NULLS FIRST,id LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id,api_key`, [skipIds]);
    return this.key(r.rows[0]);
  }

  async get(id: number): Promise<DeapiPoolKey | null> {
    if (!Number.isSafeInteger(id) || id < 1) return null;
    // Disabled keys are excluded from NEW jobs, not from polling jobs they already own.
    const r = await this.query('SELECT id,api_key FROM deapi_key_pool WHERE id=$1', [id]);
    return this.key(r.rows[0]);
  }

  private key(row: any): DeapiPoolKey | null {
    return row ? { id: Number(row.id), apiKey: row.api_key } : null;
  }

  async disable(id: number): Promise<boolean> {
    const r = await this.query("UPDATE deapi_key_pool SET status='dead',dead_at=NOW() WHERE id=$1 RETURNING id", [id]);
    return !!r.rowCount;
  }

  async restore(id: number): Promise<boolean> {
    const r = await this.query("UPDATE deapi_key_pool SET status='available',dead_at=NULL WHERE id=$1 RETURNING id", [id]);
    return !!r.rowCount;
  }

  async stats(): Promise<{ available: number; dead: number }> {
    const r = await this.query(`SELECT COUNT(*) FILTER(WHERE status='available')::int AS available,
      COUNT(*) FILTER(WHERE status='dead')::int AS dead FROM deapi_key_pool`);
    return r.rows[0];
  }

  async list(): Promise<Array<{ id: number; status: string }>> {
    const r = await this.query('SELECT id,status FROM deapi_key_pool ORDER BY id LIMIT 100');
    return r.rows;
  }
}
