import pg from 'pg';
import { inviteEmailToPicsart, acceptPicsartInviteFromGmail, extractPicsartRefreshToken } from './browser-use.js';
import { encrypt, decrypt, isEncrypted } from './crypto.js';

const { Pool } = pg;

type InviteStatus =
  | 'pending'
  | 'inviting'
  | 'invited'
  | 'accepting'
  | 'accepted'
  | 'extracting'
  | 'in_pool'
  | 'failed';

export interface InviteJobRow {
  id: number;
  email: string;
  gmail_password: string;
  status: InviteStatus;
  error_message: string | null;
  credential_id: number | null;
  invited_at: string | null;
  accepted_at: string | null;
  pooled_at: string | null;
  created_at: string;
  updated_at: string;
}

let pool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (pool) return pool;
  const url = process.env.RAILWAY_DATABASE_URL || process.env.DATABASE_URL;
  if (!url) throw new Error('No database URL (RAILWAY_DATABASE_URL or DATABASE_URL)');
  pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  return pool;
}

export async function ensureInviteSchema(): Promise<void> {
  const db = getPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS invite_jobs (
      id SERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      gmail_password TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      error_message TEXT,
      credential_id INTEGER,
      invited_at TIMESTAMPTZ,
      accepted_at TIMESTAMPTZ,
      pooled_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

async function setStatus(id: number, status: InviteStatus, extra?: {
  errorMessage?: string;
  invitedAt?: boolean;
  acceptedAt?: boolean;
  pooledAt?: boolean;
  credentialId?: number;
}): Promise<void> {
  const db = getPool();
  const parts: string[] = [`status = $2`, `updated_at = NOW()`, `error_message = $3`];
  const params: unknown[] = [id, status, extra?.errorMessage ?? null];

  if (extra?.invitedAt) { parts.push(`invited_at = NOW()`); }
  if (extra?.acceptedAt) { parts.push(`accepted_at = NOW()`); }
  if (extra?.pooledAt) { parts.push(`pooled_at = NOW()`); }
  if (extra?.credentialId != null) {
    params.push(extra.credentialId);
    parts.push(`credential_id = $${params.length}`);
  }

  await db.query(`UPDATE invite_jobs SET ${parts.join(', ')} WHERE id = $1`, params);
}

async function insertRefreshToken(email: string, rt: string): Promise<number> {
  const db = getPool();

  let token = rt.trim();
  if (/%[0-9a-f]{2}/i.test(token)) {
    try { token = decodeURIComponent(token); } catch {}
  }
  if (!token.startsWith('rt:')) throw new Error(`RT_INVALID: does not start with rt:`);

  const r = await db.query(
    `INSERT INTO picsart_credentials (refresh_token, label, status)
     VALUES ($1, $2, 'available')
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [token, email]
  );
  if (r.rows[0]?.id) return r.rows[0].id as number;

  const existing = await db.query(
    `SELECT id FROM picsart_credentials WHERE refresh_token = $1 LIMIT 1`,
    [token]
  );
  if (existing.rows[0]?.id) return existing.rows[0].id as number;
  throw new Error('INSERT_RT_FAILED: no id returned');
}

const runningJobs = new Set<number>();

export async function runJob(jobId: number): Promise<InviteJobRow> {
  if (runningJobs.has(jobId)) {
    const db = getPool();
    const r = await db.query(`SELECT * FROM invite_jobs WHERE id = $1`, [jobId]);
    return r.rows[0] as InviteJobRow;
  }

  runningJobs.add(jobId);

  const db = getPool();
  const r = await db.query(`SELECT * FROM invite_jobs WHERE id = $1`, [jobId]);
  const job = r.rows[0] as InviteJobRow | undefined;
  if (!job) {
    runningJobs.delete(jobId);
    throw new Error(`JOB_NOT_FOUND: ${jobId}`);
  }

  const ownerEmail = process.env.PICSART_OWNER_EMAIL;
  const ownerPassword = process.env.PICSART_OWNER_PASSWORD;
  if (!ownerEmail || !ownerPassword) {
    runningJobs.delete(jobId);
    throw new Error('PICSART_OWNER_EMAIL and PICSART_OWNER_PASSWORD must be set');
  }

  (async () => {
    try {
      if (job.status === 'pending' || job.status === 'failed') {
        await setStatus(jobId, 'inviting');
        await inviteEmailToPicsart(ownerEmail, ownerPassword, job.email);
        await setStatus(jobId, 'invited', { invitedAt: true });
      }

      const plainPassword = isEncrypted(job.gmail_password)
        ? decrypt(job.gmail_password)
        : job.gmail_password;

      if (job.status !== 'accepted' && job.status !== 'extracting' && job.status !== 'in_pool') {
        await setStatus(jobId, 'accepting');
        await acceptPicsartInviteFromGmail(job.email, plainPassword);
        await setStatus(jobId, 'accepted', { acceptedAt: true });
      }

      if (job.status !== 'in_pool') {
        await setStatus(jobId, 'extracting');
        const rt = await extractPicsartRefreshToken(job.email, plainPassword);
        const credId = await insertRefreshToken(job.email, rt);
        await setStatus(jobId, 'in_pool', { pooledAt: true, credentialId: credId });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await setStatus(jobId, 'failed', { errorMessage: msg.slice(0, 500) });
    } finally {
      runningJobs.delete(jobId);
    }
  })();

  await new Promise(res => setTimeout(res, 200));
  const updated = await db.query(`SELECT * FROM invite_jobs WHERE id = $1`, [jobId]);
  return updated.rows[0] as InviteJobRow;
}

export async function runAllPendingJobs(): Promise<number> {
  const db = getPool();
  const r = await db.query(
    `SELECT id FROM invite_jobs WHERE status IN ('pending', 'failed') ORDER BY id`
  );
  const ids = r.rows.map((row: { id: number }) => row.id);
  for (const id of ids) {
    runJob(id).catch(() => {});
  }
  return ids.length;
}

export async function listJobs(): Promise<InviteJobRow[]> {
  const db = getPool();
  const r = await db.query(
    `SELECT id, email, status, error_message, credential_id,
            invited_at, accepted_at, pooled_at, created_at, updated_at
       FROM invite_jobs ORDER BY id DESC`
  );
  return r.rows as InviteJobRow[];
}

export async function createJobs(entries: Array<{ email: string; gmailPassword: string }>): Promise<InviteJobRow[]> {
  const db = getPool();
  const result: InviteJobRow[] = [];
  for (const { email, gmailPassword } of entries) {
    const encryptedPassword = encrypt(gmailPassword);
    const r = await db.query(
      `INSERT INTO invite_jobs (email, gmail_password, status)
       VALUES ($1, $2, 'pending')
       ON CONFLICT (email) DO UPDATE
         SET gmail_password = EXCLUDED.gmail_password,
             status = CASE WHEN invite_jobs.status = 'in_pool' THEN 'in_pool' ELSE 'pending' END,
             updated_at = NOW()
       RETURNING id, email, status, error_message, credential_id,
                 invited_at, accepted_at, pooled_at, created_at, updated_at`,
      [email, encryptedPassword]
    );
    result.push(r.rows[0] as InviteJobRow);
  }
  return result;
}

export async function deleteJob(id: number): Promise<void> {
  const db = getPool();
  await db.query(`DELETE FROM invite_jobs WHERE id = $1`, [id]);
}
