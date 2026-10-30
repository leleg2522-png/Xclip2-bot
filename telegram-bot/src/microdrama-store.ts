import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { DramaPlan } from './microdrama-plan';

export type DramaStatus = 'idea' | 'writing' | 'draft' | 'revision' | 'quoting' | 'quoted'
  | 'rendering' | 'paused' | 'uncertain' | 'failed' | 'ready' | 'delivered' | 'cancelled';
export interface DramaJob {
  attempted?: boolean; id?: string; url?: string; price?: number; failed?: boolean;
}
export interface DramaProject {
  id: string; owner: number; chat: number; status: DramaStatus; model: string;
  idea?: string; plan?: DramaPlan; quotes?: number[]; quotedAt?: number; approvedAt?: number;
  jobs: DramaJob[]; error?: string; fileId?: string;
}
export interface DramaStore {
  create(owner: number, chat: number, model: string): Promise<DramaProject>;
  latest(owner: number): Promise<DramaProject | undefined>;
  withLock(id: string, owner: number,
    fn: (p: DramaProject, save: () => Promise<void>) => Promise<void>): Promise<boolean>;
}

export class PgDramaStore implements DramaStore {
  ready = false;
  constructor(private pool: Pool) {}

  async ensureSchema() {
    await this.pool.query(`CREATE TABLE IF NOT EXISTS microdrama_projects (
      id UUID PRIMARY KEY, owner BIGINT NOT NULL, status TEXT NOT NULL,
      data JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
    await this.pool.query(`CREATE UNIQUE INDEX IF NOT EXISTS microdrama_one_active_owner
      ON microdrama_projects(owner) WHERE status NOT IN ('delivered','failed','cancelled')`);
    await this.pool.query(`CREATE TABLE IF NOT EXISTS microdrama_models (
      owner BIGINT PRIMARY KEY, model TEXT NOT NULL)`);
    this.ready = true;
  }

  async model(owner: number): Promise<string> {
    const r = await this.pool.query('SELECT model FROM microdrama_models WHERE owner=$1', [owner]);
    return r.rows[0]?.model || process.env.MICRODRAMA_LLM_MODEL || 'gpt-6-luna';
  }

  async setModel(owner: number, model: string) {
    await this.pool.query(`INSERT INTO microdrama_models(owner,model) VALUES($1,$2)
      ON CONFLICT(owner) DO UPDATE SET model=EXCLUDED.model`, [owner, model]);
  }

  async create(owner: number, chat: number, model: string): Promise<DramaProject> {
    const p: DramaProject = { id: randomUUID(), owner, chat, model, status: 'idea', jobs: [{}, {}] };
    await this.pool.query('INSERT INTO microdrama_projects(id,owner,status,data) VALUES($1,$2,$3,$4)',
      [p.id, owner, p.status, p]);
    return p;
  }

  async latest(owner: number): Promise<DramaProject | undefined> {
    const r = await this.pool.query('SELECT data FROM microdrama_projects WHERE owner=$1 ORDER BY updated_at DESC LIMIT 1', [owner]);
    return r.rows[0]?.data;
  }

  async withLock(id: string, owner: number,
    fn: (p: DramaProject, save: () => Promise<void>) => Promise<void>): Promise<boolean> {
    const c: PoolClient = await this.pool.connect();
    let locked = false;
    let slot: number | undefined;
    let broken: Error | undefined;
    const onError = () => { broken = new Error('MICRODRAMA_LOCK_CONNECTION_FAILED'); };
    c.on('error', onError);
    try {
      const lock = await c.query('SELECT pg_try_advisory_lock(hashtextextended($1, 7821)) AS locked', [id]);
      locked = lock.rows[0].locked;
      if (!locked) return false;
      // Two long-running operations across all bot instances at most. Leave the
      // existing shared DB pool available to normal bot traffic and admin checks.
      for (let n = 0; n < 2; n++) {
        const s = await c.query('SELECT pg_try_advisory_lock(7821, $1::integer) AS slot_locked', [n]);
        if (s.rows[0].slot_locked) { slot = n; break; }
      }
      if (slot === undefined) return false;
      const r = await c.query('SELECT data FROM microdrama_projects WHERE id=$1 AND owner=$2', [id, owner]);
      if (!r.rows.length) return false;
      const p: DramaProject = r.rows[0].data;
      await fn(p, async () => {
        if (broken) throw broken;
        await c.query('UPDATE microdrama_projects SET status=$3,data=$4,updated_at=NOW() WHERE id=$1 AND owner=$2',
          [id, owner, p.status, p]);
      });
      return true;
    } finally {
      // Release a broken session from the pool rather than returning a connection with a held lock.
      if (slot !== undefined) {
        try { await c.query('SELECT pg_advisory_unlock(7821, $1::integer)', [slot]); }
        catch { broken = new Error('MICRODRAMA_LOCK_CONNECTION_FAILED'); }
      }
      if (locked) {
        try { await c.query('SELECT pg_advisory_unlock(hashtextextended($1, 7821))', [id]); }
        catch { broken = new Error('MICRODRAMA_LOCK_CONNECTION_FAILED'); }
      }
      c.removeListener('error', onError);
      c.release(broken);
    }
  }
}
