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

/**
 * Two databases are in play:
 *  - LOCAL pool  (DATABASE_URL): the panel's own state — `invite_jobs` and
 *    `app_settings`. Always available so the panel works out of the box.
 *  - TARGET pool (Railway): where the bot's `picsart_credentials` pool lives.
 *    Its connection string is configured from the panel UI (stored in
 *    `app_settings.railway_db_url`), falling back to the RAILWAY_DATABASE_URL env.
 */

let localPool: pg.Pool | null = null;

function getLocalPool(): pg.Pool {
  if (localPool) return localPool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('No local database URL (DATABASE_URL)');
  localPool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  return localPool;
}

let targetPool: pg.Pool | null = null;
let targetPoolUrl: string | null = null;

export type DbSource = 'panel' | 'env' | 'none';

async function getConfiguredRailwayUrl(): Promise<{ url: string | null; source: DbSource }> {
  const stored = (await getSetting('railway_db_url'))?.trim();
  if (stored) {
    const url = isEncrypted(stored) ? decrypt(stored) : stored;
    return { url, source: 'panel' };
  }
  const fromEnv = process.env.RAILWAY_DATABASE_URL?.trim();
  if (fromEnv) return { url: fromEnv, source: 'env' };
  return { url: null, source: 'none' };
}

async function getTargetPool(): Promise<pg.Pool> {
  const { url } = await getConfiguredRailwayUrl();
  if (!url) {
    throw new Error('NO_TARGET_DB: Railway DB string belum diset. Buka Settings dan masukkan connection string-nya.');
  }
  if (targetPool && targetPoolUrl === url) return targetPool;
  if (targetPool) { try { await targetPool.end(); } catch { /* ignore */ } }
  targetPool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });
  targetPoolUrl = url;
  await ensureCredentialsSchema(targetPool);
  return targetPool;
}

async function ensureCredentialsSchema(db: pg.Pool): Promise<void> {
  // No-op if the bot already created the table (IF NOT EXISTS never alters it).
  await db.query(`
    CREATE TABLE IF NOT EXISTS picsart_credentials (
      id SERIAL PRIMARY KEY,
      refresh_token TEXT UNIQUE,
      label TEXT,
      status TEXT DEFAULT 'available',
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
}

export async function ensureInviteSchema(): Promise<void> {
  const db = getLocalPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
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

async function getSetting(key: string): Promise<string | null> {
  const db = getLocalPool();
  await db.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  const r = await db.query(`SELECT value FROM app_settings WHERE key = $1`, [key]);
  return r.rows[0]?.value ?? null;
}

async function setSetting(key: string, value: string): Promise<void> {
  const db = getLocalPool();
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, value]
  );
}

function maskDbUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '****';
    return u.toString();
  } catch {
    return url.replace(/:\/\/([^:@/]+):([^@/]+)@/, '://$1:****@');
  }
}

export interface DbSettings {
  configured: boolean;
  urlMasked: string | null;
  source: DbSource;
}

export async function getDbSettings(): Promise<DbSettings> {
  const { url, source } = await getConfiguredRailwayUrl();
  return { configured: !!url, urlMasked: url ? maskDbUrl(url) : null, source };
}

async function testDbConnection(url: string): Promise<{ ok: boolean; error?: string }> {
  let testPool: pg.Pool | null = null;
  try {
    testPool = new Pool({
      connectionString: url,
      ssl: { rejectUnauthorized: false },
      connectionTimeoutMillis: 8000,
    });
    await testPool.query('SELECT 1');
    return { ok: true };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (testPool) { try { await testPool.end(); } catch { /* ignore */ } }
  }
}

export interface DbSettingsResult extends DbSettings {
  ok: boolean;
  error: string | null;
}

export async function setRailwayDbUrl(rawUrl: string): Promise<DbSettingsResult> {
  const url = rawUrl.trim();

  // Empty → clear the panel override and fall back to the env value (if any).
  if (!url) {
    await setSetting('railway_db_url', '');
    if (targetPool) { try { await targetPool.end(); } catch { /* ignore */ } }
    targetPool = null;
    targetPoolUrl = null;
    const s = await getDbSettings();
    return { ok: true, error: null, ...s };
  }

  const test = await testDbConnection(url);
  if (!test.ok) {
    const s = await getDbSettings();
    return { ok: false, error: test.error ?? 'Connection failed', ...s };
  }

  await setSetting('railway_db_url', encrypt(url));
  if (targetPool) { try { await targetPool.end(); } catch { /* ignore */ } }
  targetPool = null;
  targetPoolUrl = null;

  // The connection test passed, but the target pool also ensures the
  // picsart_credentials schema — surface a failure there instead of
  // reporting success and failing silently later on real jobs.
  let initError: string | null = null;
  try {
    await getTargetPool();
  } catch (err: unknown) {
    initError = err instanceof Error ? err.message : String(err);
  }

  const s = await getDbSettings();
  return { ok: initError === null, error: initError, ...s };
}

async function setStatus(id: number, status: InviteStatus, extra?: {
  errorMessage?: string;
  invitedAt?: boolean;
  acceptedAt?: boolean;
  pooledAt?: boolean;
  credentialId?: number;
}): Promise<void> {
  const db = getLocalPool();
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
  const db = await getTargetPool();

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
    const db = getLocalPool();
    const r = await db.query(`SELECT * FROM invite_jobs WHERE id = $1`, [jobId]);
    return r.rows[0] as InviteJobRow;
  }

  runningJobs.add(jobId);

  const db = getLocalPool();
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
      // Re-fetch so we have the latest timestamps, not the snapshot from before the lock.
      const freshR = await db.query(`SELECT * FROM invite_jobs WHERE id = $1`, [jobId]);
      const fresh = freshR.rows[0] as InviteJobRow;

      // Determine remaining steps from persisted progress, not from status string.
      // This makes retries resume at the last incomplete step.
      const needsInvite  = !fresh.invited_at;
      const needsAccept  = !fresh.accepted_at;
      const needsExtract = !fresh.pooled_at;

      const plainPassword = isEncrypted(fresh.gmail_password)
        ? decrypt(fresh.gmail_password)
        : fresh.gmail_password;

      if (needsInvite) {
        await setStatus(jobId, 'inviting');
        try {
          await inviteEmailToPicsart(ownerEmail, ownerPassword, fresh.email);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          // Already a member → invite already went through; treat as success.
          if (!msg.includes('INVITE_ALREADY_MEMBER')) throw err;
        }
        await setStatus(jobId, 'invited', { invitedAt: true });
      }

      if (needsAccept) {
        await setStatus(jobId, 'accepting');
        await acceptPicsartInviteFromGmail(fresh.email, plainPassword);
        await setStatus(jobId, 'accepted', { acceptedAt: true });
      }

      if (needsExtract) {
        await setStatus(jobId, 'extracting');
        const rt = await extractPicsartRefreshToken(fresh.email, plainPassword);
        const credId = await insertRefreshToken(fresh.email, rt);
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
  const db = getLocalPool();
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
  const db = getLocalPool();
  const r = await db.query(
    `SELECT id, email, status, error_message, credential_id,
            invited_at, accepted_at, pooled_at, created_at, updated_at
       FROM invite_jobs ORDER BY id DESC`
  );
  return r.rows as InviteJobRow[];
}

export async function createJobs(entries: Array<{ email: string; gmailPassword: string }>): Promise<InviteJobRow[]> {
  const db = getLocalPool();
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
  const db = getLocalPool();
  await db.query(`DELETE FROM invite_jobs WHERE id = $1`, [id]);
}
