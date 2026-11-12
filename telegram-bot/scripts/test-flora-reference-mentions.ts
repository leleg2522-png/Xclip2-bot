/**
 * Explicitly authorized two-case experiment. Never import the bot's entry point.
 * Credentials stay in memory; resumable state contains only account/run IDs.
 * --preflight reads metadata only; --case A|B submits at most once per case.
 * --poll A|B resumes an already accepted run, never submits another.
 */
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import axios from 'axios';
import FormData from 'form-data';
import sharp from 'sharp';
import { Client } from 'pg';

const base = 'https://app.flora.ai/api/v1';
const out = path.resolve(process.cwd(), '../generated-artifacts/flora-reference-mentions');
const ledgerPath = path.join(out, 'experiment.json');
const http = axios.create({ timeout: 45_000 });
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
type State = {
  accountId: number; modelId: string; workspaceId: string; projectId: string;
  duration: number; seed: number; imageUrls?: string[];
  cases: Record<string, { prompt: string; status: string; runId?: string; chargedCost?: number; file?: string; error?: string }>;
};
let state: State;
let key = '';
let db: Client;
const headers = () => ({ Authorization: `Bearer ${key}` });
async function save() { await writeFile(ledgerPath, JSON.stringify(state, null, 2)); }
function code(value: unknown) {
  return String(typeof value === 'string' ? value : JSON.stringify(value))
    .match(/BILLING_NOT_ENOUGH_CREDITS|GENERATION_INPUT_VALIDATION|GENERATION_INVALID_PARAMS|INSUFFICIENT_CREDITS|CONTENT_POLICY_VIOLATION|RATE_LIMIT_EXCEEDED/)?.[0] ?? 'PROVIDER_ERROR';
}
async function preflight() {
  const rows = await db.query("SELECT id, api_key FROM flora_key_pool WHERE status='available' ORDER BY id LIMIT 5");
  for (const account of rows.rows) {
    key = account.api_key;
    try {
      const models = (await http.get(`${base}/models`, { headers: headers() })).data;
      const model = (Array.isArray(models) ? models : models.models ?? []).find((row: any) =>
        row.type === 'video'
        && String(row.name ?? row.display_name ?? '').toLowerCase().replace(/[^a-z0-9]/g, '') === 'seedance20reference'
        && row.capabilities?.includes('mixed-to-video')
        && row.params?.some((p: any) => p.name === 'image_urls' && p.type === 'string[]')
        && ['480p'].every(value => row.params?.find((p: any) => p.name === 'resolution')?.options?.some((o: any) => o.value === value))
        && row.params?.find((p: any) => p.name === 'duration')?.options?.some((o: any) => String(o.value) === '4')
        && row.params?.find((p: any) => p.name === 'aspect_ratio')?.options?.some((o: any) => o.value === '16:9')
      );
      if (!model) continue;
      const workspaces = (await http.get(`${base}/workspaces`, { headers: headers() })).data;
      const workspace = workspaces.workspaces?.[0] ?? workspaces?.[0];
      if (!workspace) continue;
      const workspaceId = workspace.workspace_id ?? workspace.id;
      const projects = (await http.get(`${base}/projects`, {
        headers: headers(), params: { workspace_id: workspaceId },
      })).data;
      const project = projects.projects?.[0] ?? projects?.[0];
      const projectId = project?.project_id ?? project?.id;
      if (!projectId?.startsWith('prj_')) continue;
      state = { accountId: account.id, modelId: model.model_id, workspaceId, projectId,
        duration: 4, seed: 473821, cases: {} };
      await save();
      const pricing = Object.fromEntries(Object.entries(model)
        .filter(([name, value]) => /price|cost|credit/i.test(name) && (typeof value === 'number' || typeof value === 'string')));
      console.log(JSON.stringify({ stage: 'preflight_ready', model: state.modelId, duration: 4,
        resolution: '480p', inputs: 2, maximumPaidJobs: 2, pricing }));
      return;
    } catch (error: any) {
      console.log(JSON.stringify({ stage: 'preflight_account_skipped', httpStatus: error.response?.status ?? 0 }));
    }
  }
  throw Error('NO_READY_ACCOUNT');
}
async function references() {
  if (state.imageUrls) return;
  const svgs = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="768"><rect width="768" height="768" fill="#eeeae3"/><ellipse cx="384" cy="650" rx="180" ry="25" fill="#cac5bf"/><g stroke="#68131e" stroke-width="8" stroke-linejoin="round"><path d="M305 555v85h60v-85m38 0v85h60v-85" fill="#d83043"/><rect x="270" y="340" width="228" height="225" rx="35" fill="#ec2940"/><rect x="242" y="168" width="284" height="182" rx="35" fill="#f43b50"/><path d="M384 168v-48" fill="none"/><circle cx="384" cy="106" r="19" fill="#ffdc28"/><path d="M270 365l-65 50v130h50V445m243-80 65 50v130h-50V445" fill="#d82c40"/><circle cx="322" cy="247" r="30" fill="#5dff78"/><circle cx="445" cy="247" r="30" fill="#5dff78"/><path d="M333 304h102" fill="none"/><path d="m384 390 60 108H324z" fill="#ffe22d"/></g></svg>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="768" height="768"><rect width="768" height="768" fill="#eeeae3"/><ellipse cx="384" cy="650" rx="180" ry="25" fill="#cac5bf"/><g stroke="#123c87" stroke-width="8" stroke-linejoin="round"><path d="M493 550q140-55 92-175" fill="none" stroke-width="36"/><ellipse cx="384" cy="490" rx="119" ry="140" fill="#267ceb"/><ellipse cx="323" cy="625" rx="57" ry="30" fill="#267ceb"/><ellipse cx="445" cy="625" rx="57" ry="30" fill="#267ceb"/><path d="m257 220 3-113 111 85m140 28-3-113-111 85" fill="#267ceb"/><ellipse cx="384" cy="281" rx="151" ry="121" fill="#318cff"/><ellipse cx="320" cy="274" rx="29" ry="37" fill="#ffaf26"/><ellipse cx="448" cy="274" rx="29" ry="37" fill="#ffaf26"/><path d="m369 318 15 15 15-15zm15 15v26m-65-24-86-12m216 12 86-12" fill="none"/><path d="M406 427a50 50 0 1 0 0 93 47 47 0 0 1 0-93" fill="#fff" stroke="none"/></g></svg>`,
  ];
  state.imageUrls = [];
  for (let i = 0; i < svgs.length; i++) {
    const file = `image-${i + 1}.png`;
    const buffer = await sharp(Buffer.from(svgs[i])).png().toBuffer();
    await writeFile(path.join(out, file), buffer);
    const asset = (await http.post(`${base}/assets`, {
      source: 'signed-url', workspace_id: state.workspaceId, name: file, content_type: 'image/png',
    }, { headers: headers() })).data;
    const form = new FormData();
    for (const [name, value] of Object.entries(asset.upload.form_fields)) form.append(name, String(value));
    form.append(asset.upload.file_field ?? 'file', buffer, { filename: file, contentType: 'image/png' });
    await http.post(asset.upload.url, form, { headers: form.getHeaders(), maxBodyLength: Infinity });
    const complete = (await http.post(`${base}/assets/${asset.asset_id}/complete`, {}, { headers: headers() })).data;
    const url = complete.url ?? asset.url;
    if (!url?.startsWith('https://')) throw Error('UPLOAD_NO_FINAL_URL');
    state.imageUrls.push(url);
  }
  await save();
  console.log(JSON.stringify({ stage: 'references_uploaded', count: 2 }));
}
async function poll(label: string) {
  const test = state.cases[label];
  if (!test?.runId) throw Error('NO_ACCEPTED_RUN_TO_POLL');
  if (test.status === 'completed') return;
  const deadline = Date.now() + 20 * 60_000;
  while (Date.now() < deadline) {
    await pause(10_000);
    let result: any;
    try { result = (await http.get(`${base}/runs/${test.runId}`, { headers: headers() })).data; }
    catch (error: any) {
      if (error.response?.status === 429) { await pause(20_000); continue; }
      throw Error(`POLL_HTTP_${error.response?.status ?? 0}_NO_RESUBMIT`);
    }
    const status = String(result.status).toLowerCase();
    if (test.status !== status) {
      test.status = status;
      await save();
      console.log(JSON.stringify({ stage: 'run_status', case: label, status }));
    }
    if (status === 'failed' || status === 'error' || status === 'cancelled') {
      test.error = code(result.error);
      await save();
      console.log(JSON.stringify({ case: label, status, error: test.error, resubmitted: false }));
      return;
    }
    if (status !== 'completed') continue;
    const url = result.outputs?.[0]?.url ?? result.output?.url ?? result.result?.url;
    if (!url) throw Error('COMPLETED_NO_OUTPUT');
    const video = await http.get(url, { responseType: 'arraybuffer', timeout: 120_000, maxContentLength: 100 * 1024 * 1024 });
    test.file = `case-${label}.mp4`;
    await writeFile(path.join(out, test.file), Buffer.from(video.data));
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(out, test.file),
      '-vf', 'fps=1,scale=640:-1,tile=2x2', '-frames:v', '1', path.join(out, `case-${label}-frames.jpg`)]);
    await save();
    console.log(JSON.stringify({ case: label, status, file: test.file, chargedCost: test.chargedCost }));
    return;
  }
  throw Error('POLL_TIMEOUT_RESUME_SAME_RUN_ONLY');
}
async function main() {
  await mkdir(out, { recursive: true });
  db = new Client({ connectionString: process.env.RAILWAY_DATABASE_URL,
    ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 10_000 });
  await db.connect();
  try {
    try { await access(ledgerPath); state = JSON.parse(await readFile(ledgerPath, 'utf8')); }
    catch { await preflight(); }
    const accounts = await db.query('SELECT api_key FROM flora_key_pool WHERE id=$1', [state.accountId]);
    key = accounts.rows[0]?.api_key;
    if (!key) throw Error('ORIGINAL_ACCOUNT_UNAVAILABLE');
    if (process.argv.includes('--preflight')) return;
    const polling = process.argv.indexOf('--poll');
    const label = process.argv[polling >= 0 ? polling + 1 : process.argv.indexOf('--case') + 1];
    if (!['A', 'B'].includes(label)) throw Error('CHOOSE_CASE_A_OR_B');
    if (polling >= 0) { await poll(label); return; }
    if (state.cases[label]) throw Error('CASE_ALREADY_ATTEMPTED_USE_POLL_NO_RESUBMIT');
    if (label === 'B' && (state.cases.A?.status !== 'completed' || !state.cases.A.file)) throw Error('CASE_A_MUST_COMPLETE_FIRST');
    await references();
    const left = label === 'A' ? '@1' : '@2', right = label === 'A' ? '@2' : '@1';
    const prompt = `Use both uploaded image references as two separate toy characters in one continuous shot. The character from ${left} must stand entirely on the LEFT half of the frame. The character from ${right} must stand entirely on the RIGHT half of the frame. Preserve each referenced character's original colors, body shape and chest emblem. Both characters face the camera, full bodies visible, and gently wave. Keep their assigned left and right positions throughout. Plain light gray studio, locked camera, no cuts, no other characters, no text, no merging or swapping appearances.`;
    state.cases[label] = { prompt, status: 'submitting' };
    await save(); // Claim case before sending; ambiguous POST is never repeated.
    const result = (await http.post(`${base}/generate`, {
      model: state.modelId, workspace_id: state.workspaceId, project_id: state.projectId,
      type: 'video', prompt, params: { image_urls: state.imageUrls, duration: '4',
        resolution: '480p', aspect_ratio: '16:9', seed: state.seed, bitrate_mode: 'standard' },
    }, { headers: headers(), timeout: 90_000 })).data;
    const runId = result.run_id ?? result.id;
    if (!runId) throw Error('SUBMIT_NO_RUN_ID_DO_NOT_RESUBMIT');
    state.cases[label] = { ...state.cases[label], runId, status: 'accepted',
      ...(typeof result.charged_cost === 'number' ? { chargedCost: result.charged_cost } : {}) };
    await save();
    console.log(JSON.stringify({ stage: 'accepted', case: label, chargedCost: state.cases[label].chargedCost }));
    await poll(label);
  } finally { await db.end(); }
}
main().catch(error => {
  // Never print Axios config/headers, raw provider responses, workspace or signed URLs.
  console.error(JSON.stringify({ stage: 'stopped', code: error.isAxiosError
    ? `HTTP_${error.response?.status ?? 0}_${code(error.response?.data)}` : String(error.message).slice(0, 90),
    resubmitted: false }));
  process.exitCode = 1;
});
