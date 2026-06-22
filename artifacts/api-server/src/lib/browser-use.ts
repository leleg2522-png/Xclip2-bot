import axios from 'axios';

const BROWSER_USE_API_KEY = process.env.BROWSER_USE_API_KEY;
const BROWSER_USE_BASE = 'https://api.browser-use.com/api/v2';

const http = axios.create({ timeout: 30_000 });

export interface TaskResult {
  taskId: string;
  status: 'created' | 'running' | 'paused' | 'finished' | 'failed' | 'stopped';
  output?: string;
  error?: string;
}

async function createTask(description: string, sensitiveData?: Record<string, string>): Promise<string> {
  if (!BROWSER_USE_API_KEY) throw new Error('BROWSER_USE_API_KEY not set');

  const body: Record<string, unknown> = { task: description };
  if (sensitiveData) body.secrets = sensitiveData;

  const r = await http.post(`${BROWSER_USE_BASE}/tasks`, body, {
    headers: {
      'X-Browser-Use-API-Key': BROWSER_USE_API_KEY,
      'Content-Type': 'application/json',
    },
    validateStatus: () => true,
  });

  if (r.status !== 200 && r.status !== 201 && r.status !== 202) {
    throw new Error(`BROWSER_USE_CREATE_FAILED status ${r.status}: ${JSON.stringify(r.data).slice(0, 300)}`);
  }

  const taskId = r.data?.id ?? r.data?.task_id;
  if (!taskId) throw new Error(`BROWSER_USE_NO_TASK_ID: ${JSON.stringify(r.data).slice(0, 200)}`);
  return String(taskId);
}

async function pollTask(taskId: string, maxWaitMs = 300_000): Promise<TaskResult> {
  if (!BROWSER_USE_API_KEY) throw new Error('BROWSER_USE_API_KEY not set');

  const deadline = Date.now() + maxWaitMs;
  let intervalMs = 3000;

  while (Date.now() < deadline) {
    await new Promise(res => setTimeout(res, intervalMs));
    intervalMs = Math.min(intervalMs * 1.2, 10_000);

    const r = await http.get(`${BROWSER_USE_BASE}/tasks/${taskId}`, {
      headers: { 'X-Browser-Use-API-Key': BROWSER_USE_API_KEY },
      validateStatus: () => true,
    });

    if (r.status !== 200) continue;

    const status = r.data?.status as TaskResult['status'];
    const output = r.data?.output as string | undefined;
    const error = r.data?.error as string | undefined;

    if (status === 'finished') return { taskId, status, output };
    if (status === 'failed' || status === 'stopped') {
      throw new Error(`BROWSER_USE_TASK_${status.toUpperCase()} taskId=${taskId} error=${error ?? '(none)'}`);
    }
  }

  throw new Error(`BROWSER_USE_TIMEOUT taskId=${taskId}`);
}

export async function inviteEmailToPicsart(
  ownerEmail: string,
  ownerPassword: string,
  inviteEmail: string
): Promise<void> {
  const task = `
Go to https://picsart.com and sign in with email "${ownerEmail}" and password from sensitive_data["owner_password"].
After signing in, navigate to https://picsart.com/settings (the team settings page).
Find the team section that shows available seats and click the "+ Invite" button.
In the invite dialog, type "${inviteEmail}" and confirm the invite.
Wait for a success confirmation. If the email is already a member, output "ALREADY_MEMBER".
Output "SUCCESS" when the invite is sent successfully.
  `.trim();

  const taskId = await createTask(task, { owner_password: ownerPassword });
  const result = await pollTask(taskId, 600_000);

  if (result.output?.includes('ALREADY_MEMBER')) {
    throw new Error('INVITE_ALREADY_MEMBER');
  }
  if (!result.output?.includes('SUCCESS')) {
    throw new Error(`INVITE_UNEXPECTED_OUTPUT: ${result.output?.slice(0, 200)}`);
  }
}

export async function acceptPicsartInviteFromGmail(
  gmailAddress: string,
  gmailPassword: string
): Promise<void> {
  const task = `
Go to https://mail.google.com and sign in with email "${gmailAddress}" and password from sensitive_data["gmail_password"].
After signing in, search for an email from Picsart with subject containing "invite" or "join" in the inbox.
Open the most recent such email. Find and click the accept/join button or link inside the email.
Complete the account setup on Picsart if required (accept terms, etc.).
Output "SUCCESS" when the invite has been accepted successfully.
Output "NOT_FOUND" if no invite email was found after waiting.
  `.trim();

  const taskId = await createTask(task, { gmail_password: gmailPassword });
  const result = await pollTask(taskId, 600_000);

  if (result.output?.includes('NOT_FOUND')) {
    throw new Error('ACCEPT_INVITE_NOT_FOUND: No invite email found in Gmail');
  }
  if (!result.output?.includes('SUCCESS')) {
    throw new Error(`ACCEPT_UNEXPECTED_OUTPUT: ${result.output?.slice(0, 200)}`);
  }
}

export async function extractPicsartRefreshToken(
  gmailAddress: string,
  gmailPassword: string
): Promise<string> {
  const task = `
Go to https://picsart.com and sign in with email "${gmailAddress}" and password from sensitive_data["gmail_password"].
After signing in successfully, open the browser developer tools (F12), go to Application > Cookies > https://picsart.com.
Find the cookie named "REFRESH_TOKEN". Its value starts with "rt:".
Output ONLY the full cookie value starting with "rt:" — nothing else.
  `.trim();

  const taskId = await createTask(task, { gmail_password: gmailPassword });
  const result = await pollTask(taskId, 600_000);

  const output = (result.output ?? '').trim();
  if (!output.startsWith('rt:')) {
    throw new Error(`EXTRACT_RT_INVALID: got "${output.slice(0, 100)}"`);
  }
  return output;
}

export async function getPicsartTeamSlots(
  ownerEmail: string,
  ownerPassword: string
): Promise<{ available: number; total: number; members: number }> {
  const task = `
Go to https://picsart.com and sign in with email "${ownerEmail}" and password from sensitive_data["owner_password"].
After signing in, go to https://picsart.com/settings and find the team section.
Look for text that says "Seats available: N" or similar.
Output a JSON object like: {"available": 13, "total": 14, "members": 1}
  `.trim();

  const taskId = await createTask(task, { owner_password: ownerPassword });
  const result = await pollTask(taskId, 300_000);

  try {
    const m = (result.output ?? '').match(/\{[^}]+\}/);
    if (m) return JSON.parse(m[0]);
  } catch {}
  throw new Error(`GET_SLOTS_PARSE_FAILED: ${result.output?.slice(0, 200)}`);
}
