import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import type { Pool } from 'pg';

export const FREEBEAT_BRIDGE_MODEL = 'seedance-2.5';
const LEASE_MINUTES = 20;

export type BridgeJob = {
  id: string;
  dbUserId: number;
  telegramUserId: number;
  chatId: number;
  statusMessageId: number;
  prompt: string;
  telegramFileId: string;
  price: number;
  state: string;
  outputUrl: string | null;
};

export type BridgeAgent = {
  id: string;
  name: string;
};

type JobRow = {
  id: string;
  db_user_id: number;
  telegram_user_id: string;
  chat_id: string;
  status_message_id: number;
  prompt: string;
  telegram_file_id: string;
  price: number;
  state: string;
  output_url: string | null;
};

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function toJob(row: JobRow): BridgeJob {
  return {
    id: row.id,
    dbUserId: Number(row.db_user_id),
    telegramUserId: Number(row.telegram_user_id),
    chatId: Number(row.chat_id),
    statusMessageId: Number(row.status_message_id),
    prompt: row.prompt,
    telegramFileId: row.telegram_file_id,
    price: Number(row.price),
    state: row.state,
    outputUrl: row.output_url,
  };
}

export class FreebeatBridgeQueue {
  constructor(private readonly db: Pool) {}

  async ensureSchema(): Promise<void> {
    await this.db.query(`
      CREATE TABLE IF NOT EXISTS freebeat_bridge_enrollments (
        code_hash TEXT PRIMARY KEY,
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS freebeat_bridge_agents (
        id UUID PRIMARY KEY,
        name TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        last_seen_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (status IN ('active', 'disabled'))
      );

      CREATE TABLE IF NOT EXISTS freebeat_bridge_jobs (
        id UUID PRIMARY KEY,
        model TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued',
        db_user_id INTEGER NOT NULL,
        telegram_user_id BIGINT NOT NULL,
        chat_id BIGINT NOT NULL,
        status_message_id INTEGER NOT NULL,
        prompt TEXT NOT NULL,
        telegram_file_id TEXT NOT NULL,
        price INTEGER NOT NULL,
        agent_id UUID REFERENCES freebeat_bridge_agents(id),
        lease_expires_at TIMESTAMPTZ,
        provider_ref TEXT,
        output_url TEXT,
        error_message TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        accepted_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        delivered_at TIMESTAMPTZ,
        refunded_at TIMESTAMPTZ,
        CHECK (state IN ('queued', 'claimed', 'accepted', 'completed', 'failed', 'refunded')),
        CHECK (price > 0)
      );
      CREATE INDEX IF NOT EXISTS freebeat_bridge_jobs_claim_idx
        ON freebeat_bridge_jobs (state, created_at);
      CREATE INDEX IF NOT EXISTS freebeat_bridge_jobs_agent_idx
        ON freebeat_bridge_jobs (agent_id, state, lease_expires_at);
    `);
    await this.db.query(`ALTER TABLE freebeat_bridge_jobs ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ`);
  }

  async createEnrollmentCode(): Promise<string> {
    const code = randomBytes(18).toString('base64url');
    await this.db.query(
      `INSERT INTO freebeat_bridge_enrollments (code_hash, expires_at)
       VALUES ($1, NOW() + INTERVAL '15 minutes')`,
      [hash(code)]
    );
    return code;
  }

  async enroll(code: string, requestedName: string): Promise<{ agentId: string; agentSecret: string } | null> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const enrollment = await client.query(
        `SELECT code_hash FROM freebeat_bridge_enrollments
         WHERE code_hash = $1 AND used_at IS NULL AND expires_at > NOW()
         FOR UPDATE`,
        [hash(code)]
      );
      if (enrollment.rowCount !== 1) {
        await client.query('ROLLBACK');
        return null;
      }
      const agentId = randomUUID();
      const agentSecret = randomBytes(32).toString('base64url');
      const name = requestedName.trim().slice(0, 80) || 'Windows Bridge';
      await client.query(
        `INSERT INTO freebeat_bridge_agents (id, name, secret_hash, last_seen_at)
         VALUES ($1, $2, $3, NOW())`,
        [agentId, name, hash(agentSecret)]
      );
      await client.query(
        `UPDATE freebeat_bridge_enrollments SET used_at = NOW() WHERE code_hash = $1`,
        [hash(code)]
      );
      await client.query('COMMIT');
      return { agentId, agentSecret };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async authenticate(agentId: string, agentSecret: string): Promise<BridgeAgent | null> {
    const result = await this.db.query(
      `SELECT id, name, secret_hash FROM freebeat_bridge_agents
       WHERE id = $1 AND status = 'active'`,
      [agentId]
    );
    const row = result.rows[0] as { id: string; name: string; secret_hash: string } | undefined;
    if (!row || !secureEqual(row.secret_hash, hash(agentSecret))) return null;
    await this.db.query(`UPDATE freebeat_bridge_agents SET last_seen_at = NOW() WHERE id = $1`, [agentId]);
    return { id: row.id, name: row.name };
  }

  async enqueue(input: Omit<BridgeJob, 'id' | 'state' | 'outputUrl'>): Promise<BridgeJob> {
    const id = randomUUID();
    const result = await this.db.query(
      `INSERT INTO freebeat_bridge_jobs (
        id, model, db_user_id, telegram_user_id, chat_id, status_message_id,
        prompt, telegram_file_id, price
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *`,
      [
        id,
        FREEBEAT_BRIDGE_MODEL,
        input.dbUserId,
        input.telegramUserId,
        input.chatId,
        input.statusMessageId,
        input.prompt,
        input.telegramFileId,
        input.price,
      ]
    );
    return toJob(result.rows[0] as JobRow);
  }

  async claim(agent: BridgeAgent): Promise<BridgeJob | null> {
    const result = await this.db.query(
      `WITH candidate AS (
        SELECT id FROM freebeat_bridge_jobs
        WHERE state = 'queued' AND model = $1
        ORDER BY created_at
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      UPDATE freebeat_bridge_jobs AS jobs
      SET state = 'claimed',
          agent_id = $2,
          lease_expires_at = NOW() + INTERVAL '${LEASE_MINUTES} minutes'
      FROM candidate
      WHERE jobs.id = candidate.id
      RETURNING jobs.*`,
      [FREEBEAT_BRIDGE_MODEL, agent.id]
    );
    return result.rows[0] ? toJob(result.rows[0] as JobRow) : null;
  }

  async renewLease(agent: BridgeAgent, jobId: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE freebeat_bridge_jobs
       SET lease_expires_at = NOW() + INTERVAL '${LEASE_MINUTES} minutes'
       WHERE id = $1 AND agent_id = $2 AND state IN ('claimed', 'accepted')
       RETURNING id`,
      [jobId, agent.id]
    );
    return result.rowCount === 1;
  }

  async getImageFileId(agent: BridgeAgent, jobId: string): Promise<string | null> {
    const result = await this.db.query(
      `SELECT telegram_file_id FROM freebeat_bridge_jobs
       WHERE id = $1 AND agent_id = $2 AND state IN ('claimed', 'accepted')`,
      [jobId, agent.id]
    );
    return result.rows[0]?.telegram_file_id ? String(result.rows[0].telegram_file_id) : null;
  }

  async markAccepted(agent: BridgeAgent, jobId: string, providerRef: string | null): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE freebeat_bridge_jobs
       SET state = 'accepted', accepted_at = NOW(),
           provider_ref = NULLIF($3, ''),
           lease_expires_at = NOW() + INTERVAL '${LEASE_MINUTES} minutes'
       WHERE id = $1 AND agent_id = $2 AND state = 'claimed'
       RETURNING id`,
      [jobId, agent.id, providerRef?.slice(0, 200) ?? '']
    );
    return result.rowCount === 1;
  }

  async complete(agent: BridgeAgent, jobId: string, videoUrl: string): Promise<BridgeJob | null> {
    const result = await this.db.query(
      `UPDATE freebeat_bridge_jobs
       SET state = 'completed', output_url = $3, completed_at = NOW(), lease_expires_at = NULL
       WHERE id = $1 AND agent_id = $2 AND state = 'accepted'
       RETURNING *`,
      [jobId, agent.id, videoUrl]
    );
    return result.rows[0] ? toJob(result.rows[0] as JobRow) : null;
  }

  async fail(agent: BridgeAgent, jobId: string, message: string): Promise<BridgeJob | null> {
    const result = await this.db.query(
      `UPDATE freebeat_bridge_jobs
       SET state = 'failed', error_message = $3, lease_expires_at = NULL
       WHERE id = $1 AND agent_id = $2 AND state IN ('claimed', 'accepted')
       RETURNING *`,
      [jobId, agent.id, message.slice(0, 500)]
    );
    return result.rows[0] ? toJob(result.rows[0] as JobRow) : null;
  }

  async failCompletedDelivery(jobId: string, message: string): Promise<BridgeJob | null> {
    const result = await this.db.query(
      `UPDATE freebeat_bridge_jobs
       SET state = 'failed', error_message = $2
       WHERE id = $1 AND state = 'completed'
       RETURNING *`,
      [jobId, message.slice(0, 500)]
    );
    return result.rows[0] ? toJob(result.rows[0] as JobRow) : null;
  }

  async markDelivered(jobId: string): Promise<boolean> {
    const result = await this.db.query(
      `UPDATE freebeat_bridge_jobs SET delivered_at = NOW()
       WHERE id = $1 AND state = 'completed' AND delivered_at IS NULL`,
      [jobId]
    );
    return result.rowCount === 1;
  }

  async refund(jobId: string): Promise<BridgeJob | null> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE freebeat_bridge_jobs
         SET state = 'refunded', refunded_at = NOW()
         WHERE id = $1 AND state = 'failed'
         RETURNING *`,
        [jobId]
      );
      const row = result.rows[0] as JobRow | undefined;
      if (!row) {
        await client.query('ROLLBACK');
        return null;
      }
      await client.query(`UPDATE users SET saldo = saldo + $1 WHERE id = $2`, [row.price, row.db_user_id]);
      await client.query('COMMIT');
      return toJob(row);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async refundExpired(): Promise<BridgeJob[]> {
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(
        `UPDATE freebeat_bridge_jobs
         SET state = 'failed',
             error_message = 'Bridge tidak menyelesaikan order tepat waktu',
             lease_expires_at = NULL
         WHERE (
           state IN ('queued', 'claimed', 'accepted')
           OR (state = 'completed' AND delivered_at IS NULL)
         )
           AND created_at < NOW() - INTERVAL '45 minutes'
         RETURNING *`
      );
      const jobs: BridgeJob[] = [];
      for (const row of result.rows as JobRow[]) {
        await client.query(`UPDATE users SET saldo = saldo + $1 WHERE id = $2`, [row.price, row.db_user_id]);
        await client.query(`UPDATE freebeat_bridge_jobs SET state = 'refunded', refunded_at = NOW() WHERE id = $1`, [row.id]);
        jobs.push({ ...toJob(row), state: 'refunded' });
      }
      await client.query('COMMIT');
      return jobs;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}