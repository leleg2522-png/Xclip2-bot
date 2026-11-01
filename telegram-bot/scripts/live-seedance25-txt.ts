// One authorized paid request. Persist before submission; resume polling only.
import fs from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';
import axios from 'axios';
import { initPicsart, getCredits, submitSeedance, pollSeedanceResult } from '../src/picsart';
import { decodeSeedance25Txt } from '../src/seedance25-prompt';

if (!process.argv.includes('--paid')) throw Error('PAID_AUTHORIZATION_REQUIRED');
const dir = path.resolve(__dirname, '../../generated-artifacts/seedance25-txt-live');
fs.mkdirSync(dir, { recursive: true });
const stateFile = path.join(dir, 'state.json');
let state: any = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : {};
function save(update: Record<string, unknown>) {
  state = { ...state, ...update };
  fs.writeFileSync(stateFile + '.tmp', JSON.stringify(state, null, 2));
  fs.renameSync(stateFile + '.tmp', stateFile);
}
const db = new Pool({
  connectionString: process.env.RAILWAY_DATABASE_URL,
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000,
});
initPicsart(db);

async function main() {
  if (state.status === 'completed') { console.log('ALREADY_COMPLETED'); return; }
  if (!state.jobId) {
    if (state.submitAttempted) throw Error('PRIOR_SUBMIT_DO_NOT_REPLAY');
    const first = 'Create one continuous photorealistic 30-second vertical film of a quiet tropical garden at sunrise. A small yellow kite is caught on a low branch beside a stone path. A gentle breeze moves the leaves and kite. No people, captions, logos, or dialogue. Natural garden ambience. Keep every detail consistent throughout.\n\n';
    let text = first;
    for (let i = 1; text.length < 20000; i++) {
      text += `Direction ${i}: Preserve the same tropical garden, stone path, low branch and small yellow kite. Use a very slow stable camera movement and warm soft sunrise light. Keep the kite yellow, the leaves natural green, and the path gray. Show realistic fine leaf veins, small dew droplets, soft shadows, and gentle breeze. Maintain continuity without cuts, new locations, additional subjects, text overlays, or sudden changes. Let the garden ambience remain soft and consistent. These are descriptive refinements of the same single scene, not separate scenes.\n`;
    }
    const tail = '\nFinal shot: the small yellow kite remains visible on the same low branch.';
    text = text.slice(0, 20000 - tail.length) + tail;
    fs.writeFileSync(path.join(dir, 'prompt.txt'), '\ufeff' + text, 'utf8');
    const prompt = decodeSeedance25Txt(fs.readFileSync(path.join(dir, 'prompt.txt')));
    if (prompt.length !== 20000 || prompt !== text) throw Error('PROMPT_ROUNDTRIP_FAILED');
    console.log('REAL_TXT_DECODED', prompt.length);
    const candidates = await db.query("SELECT id FROM picsart_credentials WHERE status = 'available' ORDER BY tier_credits DESC NULLS LAST, id DESC LIMIT 20");
    let chosen: number | undefined;
    for (const row of candidates.rows) {
      try {
        const balance = await getCredits(row.id);
        if (balance.credits >= 130) { chosen = row.id; break; }
      } catch { console.log('PREFLIGHT_ACCOUNT_UNAVAILABLE'); }
    }
    if (!chosen) throw Error('NO_READY_PICSART_ACCOUNT');
    save({ accountId: chosen, promptCharacters: prompt.length, botSaldoCharged: false,
      resolution: '480p', duration: 30, ratio: '9:16', submitAttempted: true,
      startedAt: new Date().toISOString() });
    console.log('ONE_PAID_SUBMIT_START');
    const jobId = await submitSeedance(chosen, {
      prompt, imageUrls: [], duration: 30, ratio: '9:16',
      resolution: '480p', generateAudio: true, outputName: 'seedance25-txt-20000-test.mp4',
    });
    save({ jobId, status: 'accepted' });
    console.log('PAID_JOB_ACCEPTED', jobId);
  } else { console.log('RESUME_POLL_ONLY', state.jobId); }
  let last = -1;
  const result = await pollSeedanceResult(state.accountId, state.jobId, {
    maxAttempts: 300, intervalMs: 5000,
    onTick: ms => {
      const minute = Math.floor(ms / 60000);
      if (minute !== last) { last = minute; console.log('POLL_ELAPSED_MINUTES', minute); }
    },
  });
  save({ status: 'native_completed', creditsUsed: result.credits });
  const response = await axios.get(result.url, {
    responseType: 'arraybuffer', proxy: false, timeout: 300000,
    maxContentLength: 250 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(dir, 'native.mp4'), Buffer.from(response.data));
  save({ status: 'completed', nativeBytes: response.data.length, completedAt: new Date().toISOString() });
  console.log('NATIVE_COMPLETED', JSON.stringify({ credits: result.credits, bytes: response.data.length }));
}
main().catch((error: any) => {
  const message = String(error?.message ?? 'UNKNOWN');
  const safe = message.replace(/https?:\/\/\S+/g, '[URL]')
    .replace(/Bearer\s+\S+/gi, '[AUTH]').slice(0, 1200);
  save({ status: 'stopped', diagnostic: safe });
  console.error('TEST_STOPPED', safe);
  process.exitCode = 1;
}).finally(() => db.end());
