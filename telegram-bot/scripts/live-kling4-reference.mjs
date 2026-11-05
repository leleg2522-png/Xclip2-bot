// One authorized reference-video experiment; persisted IDs prevent paid replays.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
if (!process.argv.includes('--paid')) throw Error('PAID_AUTHORIZATION_REQUIRED');
const root = path.resolve(import.meta.dirname, '../..');
const womanDance = process.argv.includes('--woman-dance');
const fight = process.argv.includes('--fight');
if (fight && womanDance) throw Error('QA_CHOOSE_ONE_EXPERIMENT');
const ratio = fight ? '16:9' : '9:16';
const dir = path.join(root, fight ? 'generated-artifacts/kling4-fight-reference-live' : womanDance
  ? 'generated-artifacts/kling4-woman-dance-live'
  : 'generated-artifacts/kling4-reference-live');
fs.mkdirSync(dir, { recursive: true });
const statePath = path.join(dir, 'state.json');
let state = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
function save(patch) {
  state = { ...state, ...patch };
  fs.writeFileSync(statePath + '.tmp', JSON.stringify(state, null, 2));
  fs.renameSync(statePath + '.tmp', statePath);
}
const lock = fs.openSync(path.join(dir, 'running.lock'), 'wx');
const require = createRequire(path.join(root, 'telegram-bot/dist/picsart.js'));
const { Pool } = require('pg');
const axios = require('axios');
const sharp = require('sharp');
const { inspectFloraUpscaleVideo, normalizeFlora1080 } = require('../dist/flora-upscale-media.js');
const db = new Pool({ connectionString: process.env.RAILWAY_DATABASE_URL,
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
const context = vm.createContext({
  exports: {}, require, process, Buffer, URL,
  console: { log() {}, warn() {}, error() {} },
  setTimeout, clearTimeout, setInterval, clearInterval,
});
vm.runInContext(fs.readFileSync(path.join(root, 'telegram-bot/dist/picsart.js'), 'utf8')
  + '\nexports.qa = { http, preflightKling4OmniCredits, submitPicsartI2v, pollPicsartI2vResult };', context);
const picsart = context.exports;
const { http, preflightKling4OmniCredits, submitPicsartI2v, pollPicsartI2vResult } = picsart.qa;
picsart.initPicsart({
  query(sql, values) {
    if (!/^\s*SELECT\b/i.test(sql) && !/^\s*UPDATE picsart_credentials\s+SET access_token\b/i.test(sql)) {
      throw Error('QA_DATABASE_WRITE_BLOCKED');
    }
    return db.query(sql, values);
  },
});
http.interceptors.request.use(config => {
  if (/\/submit$/.test(config.url ?? '')) {
    if (state.submitAttempted) throw Error('QA_PAID_REPLAY_BLOCKED');
    save({ submitAttempted: true, submittedAt: new Date().toISOString() });
  }
  return config;
});
http.interceptors.response.use(response => {
  if (/\/options$/.test(response.config.url ?? '')) {
    const credits = response.data?.response?.credits;
    if (typeof credits === 'number') {
      save({ quotedCredits: credits });
      console.log('QUOTE_CREDITS', credits);
      if (credits > 150) throw Error('QA_QUOTE_EXCEEDS_TEST_BUDGET');
    }
  }
  if (/\/submit$/.test(response.config.url ?? '')) {
    const id = response.data?.response?.id;
    if (response.status >= 200 && response.status < 300 && typeof id === 'string' && /^[\w-]{1,160}$/.test(id)) {
      save({ jobId: id, status: 'accepted' });
      console.log('PICSART_ACCEPTED', id);
    } else console.log('PICSART_SUBMIT_HTTP', response.status);
  }
  if (/\/result$/.test(response.config.url ?? '') &&
      ['FAILED', 'ERROR', 'CANCELLED'].includes(String(response.data?.response?.status).toUpperCase())) {
    const result = response.data.response;
    // Keep only machine-code fields; never raw inputs or signed reference URLs.
    const codes = [];
    function visit(value, depth = 0) {
      if (!value || typeof value !== 'object' || depth > 5) return;
      for (const [key, child] of Object.entries(value)) {
        if (/code|reason|type/i.test(key) && typeof child === 'string' &&
            /^[A-Z][A-Z0-9_]{1,100}$/.test(child)) codes.push(child);
        if (child && typeof child === 'object') visit(child, depth + 1);
      }
    }
    visit(result);
    save({ providerFailureStatus: result.status, providerFailureCodes: [...new Set(codes)] });
    console.log('PROVIDER_FAILED', result.status, JSON.stringify([...new Set(codes)]));
  }
  return response;
});
const direct = axios.create({ proxy: false, timeout: 180000 });
const base = 'https://api.renderful.ai/api/v1';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function finish(source) {
  if (state.upscaleAttempted && !state.upscaleId) throw Error('QA_UPSCALE_AMBIGUOUS_NO_REPLAY');
  let row;
  if (state.upscaleKeyId) row = (await db.query('SELECT id, api_key FROM renderful_key_pool WHERE id=$1', [state.upscaleKeyId])).rows[0];
  else {
    for (const candidate of (await db.query("SELECT id, api_key FROM renderful_key_pool WHERE status <> 'dead' ORDER BY id")).rows) {
      try {
        const b = await direct.get(base + '/account/balance', { headers: { Authorization: `Bearer ${candidate.api_key}` } });
        if (Number(b.data.balance_available) > 0) { row = candidate; break; }
      } catch { console.log('UPSCALER_KEY_PREFLIGHT_UNAVAILABLE'); }
    }
  }
  if (!row) throw Error('QA_NO_UPSCALER_KEY');
  save({ upscaleKeyId: row.id });
  const headers = { Authorization: `Bearer ${row.api_key}` };
  if (!state.upscaleId) {
    save({ upscaleAttempted: true });
    const r = await direct.post(base + '/generations', {
      type: 'video-to-video', model: 'bytedance-video-upscaler',
      video_url: source.url, resolution: '1080p',
    }, { headers });
    const id = r.data?.id;
    if (typeof id !== 'string' || !id) throw Error('QA_UPSCALE_NO_ID_NO_REPLAY');
    save({ upscaleId: id });
    console.log('UPSCALER_ACCEPTED', id);
  }
  for (let i = 0; i < 150; i++) {
    await pause(10000);
    let response;
    try { response = await direct.get(`${base}/generations/${state.upscaleId}`, { headers }); }
    catch (e) {
      if (!e.response || e.response.status === 429 || e.response.status >= 500) continue;
      throw Error(`QA_UPSCALE_POLL_HTTP_${e.response.status}`);
    }
    const data = response.data;
    if (state.upscaleStatus !== data.status) {
      save({ upscaleStatus: data.status });
      console.log('UPSCALER_STATUS', data.status);
    }
    if (data.status === 'failed') throw Error('QA_UPSCALE_FAILED');
    if (data.status === 'completed') {
      const output = data.output ?? data.outputs?.[0];
      const url = typeof output === 'string' ? output : output?.url ?? output?.video_url;
      if (!url) throw Error('QA_UPSCALE_NO_OUTPUT');
      const outputBytes = Buffer.from((await direct.get(url, { responseType: 'arraybuffer', maxContentLength: 250 * 1024 * 1024 })).data);
      const final = await normalizeFlora1080(fs.readFileSync(path.join(dir, 'native.mp4')), outputBytes);
      fs.writeFileSync(path.join(dir, 'output-1080p.mp4'), final);
      const facts = await inspectFloraUpscaleVideo(final);
      save({ status: 'completed', facts, completedAt: new Date().toISOString() });
      console.log('FINISHED_1080P', JSON.stringify(facts));
      return;
    }
  }
  throw Error('QA_UPSCALE_POLL_TIMEOUT');
}
try {
  if (state.status === 'completed') console.log('ALREADY_COMPLETED');
  else {
    const prompt = fight
      ? 'Create a 10-second widescreen cinematic fantasy duel between the two adult characters in the reference image. Preserve their identities and costumes: the silver-haired ice warrior and the dark-haired gravity warrior. Use the reference video to guide the order, timing and choreography of their attacks, defensive dodges, rapid exchanges and camera movement. An intense energetic clash of blue ice and crimson gravitational energy in a ruined stone arena, realistic physical momentum, readable action, consistent anatomy and two characters only. Show powerful magical impacts and stone debris without blood, gore or graphic injuries. No text, no logos. Match the reference sequence as closely as possible within ten seconds.'
      : womanDance
      ? 'Create a continuous 10-second vertical dance challenge video. Use the adult woman from the reference image as the sole subject, preserving her face, black shoulder-length hair, cream long-sleeve blouse and dark gray trousers. Use the reference video to guide the timing, hand gestures, arm movements and dance rhythm. Keep her original outfit throughout. Show her dancing naturally in a simple well-lit studio with a fixed camera and her full body visible. Friendly cheerful expression, smooth coherent motion. No text, no logos, no additional people.'
      : 'Create a continuous 10-second vertical full-body animation. Use the blue robot with orange headphones in the image as the sole character. Use the reference video as guidance for the body movement and dance rhythm, not its human appearance. The friendly blue robot performs a lively dance with bent knees, alternating arm swings and small side steps. Preserve its blue body, orange headphones, glowing cyan eyes and orange chest panel. Soft neutral studio background, fixed camera, entire body visible, smooth natural movement. No text, no logos, no additional characters.';
    if (!state.jobId) {
      if (state.submitAttempted) throw Error('QA_PRIOR_SUBMIT_NO_REPLAY');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="1280" viewBox="0 0 720 1280">
      <defs><linearGradient id="b" x2="0" y2="1"><stop stop-color="#8ad4ff"/><stop offset="1" stop-color="#237dc2"/></linearGradient></defs>
      <rect width="720" height="1280" fill="#e9edf2"/><ellipse cx="360" cy="1120" rx="180" ry="32" fill="#c6cbd1"/>
      <g stroke="#174f7a" stroke-width="9" stroke-linejoin="round">
      <rect x="257" y="826" width="82" height="225" rx="36" fill="url(#b)"/><rect x="382" y="826" width="82" height="225" rx="36" fill="url(#b)"/>
      <rect x="219" y="1023" width="133" height="86" rx="26" fill="#246caf"/><rect x="370" y="1023" width="133" height="86" rx="26" fill="#246caf"/>
      <rect x="215" y="507" width="290" height="355" rx="70" fill="url(#b)"/>
      <rect x="133" y="548" width="75" height="270" rx="37" fill="url(#b)" transform="rotate(12 170 550)"/>
      <rect x="514" y="548" width="75" height="270" rx="37" fill="url(#b)" transform="rotate(-12 552 550)"/>
      <circle cx="117" cy="838" r="48" fill="#409fe0"/><circle cx="604" cy="838" r="48" fill="#409fe0"/>
      <rect x="225" y="262" width="270" height="230" rx="65" fill="url(#b)"/>
      <rect x="249" y="311" width="222" height="121" rx="32" fill="#123449"/>
      <path d="M235 357 C180 167 539 167 487 357" fill="none" stroke="#f38b2b" stroke-width="28"/>
      <rect x="199" y="334" width="40" height="94" rx="17" fill="#ff9c35" stroke="#a95d1c"/>
      <rect x="482" y="334" width="40" height="94" rx="17" fill="#ff9c35" stroke="#a95d1c"/>
      <rect x="294" y="606" width="133" height="138" rx="24" fill="#ff9c35"/>
      </g><g fill="#5ef6ff"><ellipse cx="302" cy="363" rx="18" ry="27"/><ellipse cx="418" cy="363" rx="18" ry="27"/>
      <path d="M328 399 Q360 421 392 399" fill="none" stroke="#5ef6ff" stroke-width="8" stroke-linecap="round"/></g></svg>`;
      const imageName = fight ? 'fighters.jpg' : womanDance ? 'woman.jpg' : 'robot.png';
      if (fight) {
        fs.copyFileSync(path.join(root, 'generated-artifacts/fight-characters.jpg'), path.join(dir, imageName));
      } else if (womanDance) {
        fs.copyFileSync(path.join(root, 'generated-artifacts/microdrama-china-mandarin-test/char_LINWAN.jpg'),
          path.join(dir, imageName));
      } else await sharp(Buffer.from(svg)).png().toFile(path.join(dir, imageName));
      const reference = fs.readFileSync(path.join(root, fight
        ? 'generated-artifacts/fight-reference-10s.mp4' : womanDance
        ? 'exports/kling26_motion_test.mp4'
        : 'generated-artifacts/flowy-motion-control-test/motion-3s.mp4'));
      const referenceFacts = await inspectFloraUpscaleVideo(reference);
      const candidates = (await db.query(`SELECT id FROM picsart_credentials WHERE status='available'
        ORDER BY (access_expires_at > NOW() + INTERVAL '5 minutes') DESC NULLS LAST, updated_at DESC LIMIT 6`)).rows;
      for (const candidate of candidates) {
        try {
          // Only uploads, quote and balance checks may rotate accounts.
          const imageUrl = await picsart.uploadFile(candidate.id, fs.readFileSync(path.join(dir, imageName)),
            imageName, fight || womanDance ? 'image/jpeg' : 'image/png', { gateway: true });
          const videoUrl = await picsart.uploadFile(candidate.id, reference, 'motion-reference.mp4', 'video/mp4', { gateway: true });
          const input = { mode: 'i2v', duration: 10, imageUrls: [imageUrl], videoUrl, referType: 'feature' };
          await preflightKling4OmniCredits(candidate.id, prompt, imageUrl, ratio, input);
          save({ credentialId: candidate.id, duration: 10, ratio, model: 'kling-v4-omni',
            imageCount: 1, videoCount: 1, referenceSeconds: referenceFacts.duration,
            referenceKind: fight ? 'two-adult-fantasy-duel' : womanDance ? 'adult-woman-dance-challenge' : 'robot-dance',
            botSaldoCharged: false });
          console.log('FULL_REFERENCE_PREFLIGHT_PASSED');
          // Submission is outside the catch: no second account after any attempt.
          state.prepared = { imageUrl, videoUrl };
          break;
        } catch (e) {
          console.log('PRE_SUBMIT_ACCOUNT_UNAVAILABLE', e.response?.status ?? (
            /^QA_[A-Z_]+$/.test(e.message) ? e.message : 'PREFLIGHT_OR_UPLOAD'));
          if (e.message === 'QA_QUOTE_EXCEEDS_TEST_BUDGET') throw e;
        }
      }
      if (!state.prepared) throw Error('QA_NO_READY_ACCOUNT');
      const { imageUrl, videoUrl } = state.prepared;
      delete state.prepared;
      const id = await submitPicsartI2v(state.credentialId, 'kling_v4', prompt, imageUrl, {
        ratio, duration: 10, imageUrls: [imageUrl], videoUrl, referType: 'feature',
      });
      if (id !== state.jobId) throw Error('QA_JOB_STATE_MISMATCH');
    } else console.log('RESUME_SAME_JOB', state.jobId);
    let last = -1;
    const source = await pollPicsartI2vResult(state.credentialId, 'kling_v4', state.jobId, {
      onTick(ms) {
        const minute = Math.floor(ms / 60000);
        if (minute !== last) { last = minute; console.log('POLL_MINUTES', minute); }
      },
    });
    save({ status: 'native_completed', usedCredits: source.credits ?? null });
    const bytes = Buffer.from((await http.get(source.url, { responseType: 'arraybuffer', timeout: 180000 })).data);
    fs.writeFileSync(path.join(dir, 'native.mp4'), bytes);
    console.log('NATIVE_COMPLETED', JSON.stringify(await inspectFloraUpscaleVideo(bytes)));
    await finish(source);
  }
} catch (e) {
  const diagnostic = /^(QA_|PICSART_|FLORA_UPSCALE_)[A-Z0-9_]+$/.test(e.message)
    ? e.message : e.response?.status ? `HTTP_${e.response.status}` : 'NETWORK_OR_PROVIDER_FAILURE';
  save({ lastError: diagnostic, stoppedAt: new Date().toISOString() });
  console.log('TEST_STOPPED', diagnostic);
  process.exitCode = 1;
} finally {
  await db.end();
  fs.closeSync(lock);
  fs.unlinkSync(path.join(dir, 'running.lock'));
}
