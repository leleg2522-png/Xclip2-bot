import { Router, type IRouter } from 'express';
import { adminAuth } from '../middleware/admin-auth.js';
import {
  ListInviteJobsResponse,
  CreateInviteJobsBody,
  RunAllInviteJobsResponse,
  DeleteInviteJobParams,
  RunInviteJobParams,
  RunInviteJobResponse,
  GetPicsartSlotsResponse,
  GetDbSettingsResponse,
  UpdateDbSettingsBody,
  UpdateDbSettingsResponse,
} from '@workspace/api-zod';
import {
  listJobs,
  createJobs,
  runJob,
  runAllPendingJobs,
  deleteJob,
  ensureInviteSchema,
  getDbSettings,
  setRailwayDbUrl,
} from '../lib/invite-runner.js';
import { getPicsartTeamSlots } from '../lib/browser-use.js';

const router: IRouter = Router();

router.use(adminAuth);

ensureInviteSchema().catch((err: unknown) => {
  console.error('[invite] schema init failed:', err);
});

function mapJob(row: Awaited<ReturnType<typeof listJobs>>[number]) {
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    errorMessage: row.error_message ?? null,
    credentialId: row.credential_id ?? null,
    invitedAt: row.invited_at ?? null,
    acceptedAt: row.accepted_at ?? null,
    pooledAt: row.pooled_at ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

router.get('/invite-jobs', async (_req, res) => {
  try {
    const jobs = await listJobs();
    const data = ListInviteJobsResponse.parse(jobs.map(mapJob));
    res.json(data);
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

router.post('/invite-jobs', async (req, res) => {
  try {
    const body = CreateInviteJobsBody.parse(req.body);
    const created = await createJobs(body.entries.map(e => ({ email: e.email, gmailPassword: e.gmailPassword })));
    const data = ListInviteJobsResponse.parse(created.map(mapJob));
    res.status(201).json(data);
  } catch (err: unknown) {
    res.status(400).json({ error: String(err) });
  }
});

router.post('/invite-jobs/run-all', async (_req, res) => {
  try {
    const queued = await runAllPendingJobs();
    const data = RunAllInviteJobsResponse.parse({ queued });
    res.json(data);
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

router.delete('/invite-jobs/:id', async (req, res) => {
  try {
    const { id } = DeleteInviteJobParams.parse({ id: Number(req.params.id) });
    await deleteJob(id);
    res.status(204).send();
  } catch (err: unknown) {
    res.status(400).json({ error: String(err) });
  }
});

router.post('/invite-jobs/:id/run', async (req, res) => {
  try {
    const { id } = RunInviteJobParams.parse({ id: Number(req.params.id) });
    const job = await runJob(id);
    const data = RunInviteJobResponse.parse(mapJob(job));
    res.json(data);
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

router.get('/settings/db', async (_req, res) => {
  try {
    const settings = await getDbSettings();
    const data = GetDbSettingsResponse.parse(settings);
    res.json(data);
  } catch (err: unknown) {
    res.status(500).json({ error: String(err) });
  }
});

router.put('/settings/db', async (req, res) => {
  try {
    const body = UpdateDbSettingsBody.parse(req.body);
    const result = await setRailwayDbUrl(body.url);
    const data = UpdateDbSettingsResponse.parse(result);
    res.status(result.ok ? 200 : 400).json(data);
  } catch (err: unknown) {
    res.status(400).json({ error: String(err) });
  }
});

router.get('/picsart-slots', async (_req, res) => {
  try {
    const ownerEmail = process.env.PICSART_OWNER_EMAIL;
    const ownerPassword = process.env.PICSART_OWNER_PASSWORD;
    if (!ownerEmail || !ownerPassword) {
      const data = GetPicsartSlotsResponse.parse({ available: 0, total: 14, members: 0 });
      res.json(data);
      return;
    }
    const slots = await getPicsartTeamSlots(ownerEmail, ownerPassword);
    const data = GetPicsartSlotsResponse.parse(slots);
    res.json(data);
  } catch (err: unknown) {
    const data = GetPicsartSlotsResponse.parse({ available: 0, total: 14, members: 0 });
    res.json(data);
  }
});

export default router;
