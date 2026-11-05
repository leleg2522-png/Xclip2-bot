type Queryable = { query(sql: string, params?: any[]): Promise<{ rows: any[]; rowCount: number | null }> };
export interface DeapiPoolKey { id: number; apiKey: string }
export interface DeapiCooldown { scope: string; limited_at: string; retry_at: string }
export interface DeapiKeySource {
  next(skipIds?: number[], scopes?: string[]): Promise<DeapiPoolKey | null>;
  markLimited(keyId: number, scope: string, retryAt: number): Promise<void>;
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
    await this.query(`CREATE TABLE IF NOT EXISTS deapi_key_cooldowns (
      key_id INTEGER NOT NULL REFERENCES deapi_key_pool(id),
      scope TEXT NOT NULL,
      limited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      retry_at TIMESTAMPTZ NOT NULL,
      PRIMARY KEY(key_id,scope))`);
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

  async next(skipIds: number[] = [], scopes: string[] = []): Promise<DeapiPoolKey | null> {
    const r = await this.query(`UPDATE deapi_key_pool SET last_used_at=NOW()
      WHERE id=(SELECT id FROM deapi_key_pool WHERE status='available' AND NOT(id=ANY($1::int[]))
        AND NOT EXISTS (SELECT 1 FROM deapi_key_cooldowns c WHERE c.key_id=deapi_key_pool.id
          AND c.retry_at>NOW() AND (c.scope='account' OR cardinality($2::text[])=0 OR c.scope=ANY($2::text[])))
        ORDER BY last_used_at ASC NULLS FIRST,id LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id,api_key`, [skipIds, scopes]);
    return this.key(r.rows[0]);
  }

  async markLimited(keyId: number, scope: string, retryAt: number): Promise<void> {
    if (!Number.isSafeInteger(keyId) || keyId < 1 || !scope || scope.length > 200
      || !Number.isFinite(retryAt) || !Number.isFinite(new Date(retryAt).getTime())) {
      throw new Error('DEAPI_POOL_INVALID_COOLDOWN');
    }
    await this.query(`INSERT INTO deapi_key_cooldowns(key_id,scope,limited_at,retry_at)
      VALUES($1,$2,NOW(),$3::timestamptz)
      ON CONFLICT(key_id,scope) DO UPDATE SET limited_at=NOW(),
        retry_at=GREATEST(deapi_key_cooldowns.retry_at,EXCLUDED.retry_at)`,
    [keyId, scope, new Date(retryAt).toISOString()]);
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

  async list(): Promise<Array<{ id: number; status: string; cooldowns: DeapiCooldown[] }>> {
    const r = await this.query(`SELECT p.id,p.status,
      COALESCE((SELECT json_agg(json_build_object('scope',c.scope,'limited_at',c.limited_at,'retry_at',c.retry_at)
        ORDER BY c.retry_at DESC) FROM deapi_key_cooldowns c WHERE c.key_id=p.id AND c.retry_at>NOW()),'[]'::json) AS cooldowns
      FROM deapi_key_pool p ORDER BY p.id LIMIT 100`);
    return r.rows;
  }
}
