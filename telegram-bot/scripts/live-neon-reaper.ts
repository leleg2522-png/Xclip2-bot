import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import sharp from 'sharp';
import { DeapiKeyPool } from '../src/deapi-key-pool';
import { DeapiEpisodeApi, type EpisodeRequest } from '../src/episode-api';

// A user-authorized media demonstration, not a production bot launcher.
const root = path.resolve(__dirname, '../../generated-artifacts/neon-reaper');
const source = path.resolve(__dirname, '../../attached_assets/2d75a816-d6e0-46ef-832a-6718769d7e40_1793449392105.png');
const exec = promisify(execFile);
const style = 'Same adult woman, age 25, same face, short tousled black hair, black futuristic tactical crop top and shorts, black armored gloves and thigh straps, blue energy blade. Preserve the reference costume without making it more revealing. Hand-drawn graphite manga, dense ink cross-hatching, predominantly grayscale with selective electric-blue energy and magenta neon, rainy cyberpunk alley at night. Non-graphic action, no blood, no gore, no dismemberment. No sexualized posing, no nudity.';
const shots = [
  { name: 'The showdown', scene: 'Full-body cinematic shot of the heroine standing firmly in a rainy neon alley facing three black-armored adult soldiers, preparing to draw her blue energy blade.',
    motion: 'Continuous ten-second opening shot. Rain falls and neon reflects in puddles. Camera slowly pushes from full body toward medium shot. The heroine calmly draws her electric-blue blade and settles into a balanced fighting stance. Three armored soldiers cautiously advance in the background. Hair and jacket straps move in the wind. End with her blade ready across her body. Establish anticipation, no combat contact yet.' },
  { name: 'First strike', scene: 'Medium-wide action shot, the heroine facing one advancing armored soldier, energy blade ready for a precise parry.',
    motion: 'Ten seconds of clearly readable combat. The soldier swings a rifle butt; she sidesteps, blocks with her forearm and deflects the weapon with the flat of her blue blade. Blue sparks come only from metal contact. She kicks his armored chest, pushing him backward without injury or blood. Camera tracks laterally, preserve body anatomy and screen direction. End with her balanced and a second guard approaching.' },
  { name: 'Close quarters', scene: 'Wide shot of the heroine in a grounded defensive stance between two armored soldiers in the same rainy alley.',
    motion: 'Ten-second close-quarters exchange, readable choreography. She ducks one punch, delivers a controlled elbow to armored chest, pivots into a low sweep that makes one soldier fall onto the wet ground. She then blocks the other guard with her blue blade. Camera follows smoothly at torso height. No gore, no blades penetrating bodies. End in a low stance, both hands and both legs anatomically coherent.' },
  { name: 'Cybernetic overdrive', scene: 'Full-body action composition with the heroine about to spring into a spinning kick, electric blue energy beginning around her boots.',
    motion: 'Ten seconds. She springs forward into one clear spinning kick, her boot hits an armored guard in the chest and sends him stumbling against a wall. Electric-blue energy traces her motion briefly, not duplicate people. Camera follows the single heroine in a controlled arc. She lands on both feet, stable anatomy. Only one acrobatic move, no teleportation, no blood.' },
  { name: 'Disarm the commander', scene: 'Medium-wide standoff between the heroine and a larger armored squad commander, both on their feet, blue blade reflecting in rain.',
    motion: 'Ten seconds of a decisive non-graphic finish. The commander charges; she parries his armored weapon, steps around him and cuts only the external power cable on his mechanical backpack. Blue electrical sparks erupt from equipment. His armor powers down and he drops to one knee, alive and disarmed. She withdraws her blade and steps back. No stabbing, no gore, no dismemberment.' },
  { name: 'After the storm', scene: 'Heroine standing safely in the same neon alley after combat, disabled weapons on the wet street and defeated armored guards alive in the background.',
    motion: 'Ten-second closing shot. She exhales, lowers and safely sheathes her blue blade. Camera slowly moves from medium shot to a detailed portrait of the same face. Rain beads on her hair and armor, blue energy fades, magenta neon glows behind her. She turns her eyes toward the distant city, composed and alert. Hold the final portrait for the last two seconds. No new fight, no text or logos.' },
];
type Job = { attempted?: boolean; id?: string; keyId?: number; price?: number; file?: string };
type State = { version: 1; shots: Array<{ frame: Job; video: Job }> };
async function save(state: State) {
  await fs.writeFile(path.join(root, 'state.json.partial'), JSON.stringify(state, null, 2));
  await fs.rename(path.join(root, 'state.json.partial'), path.join(root, 'state.json'));
}
async function exists(file: string) { try { await fs.access(file); return true; } catch { return false; } }
async function prepare() {
  const m = await sharp(source).metadata();
  const width = m.width!, height = m.height!;
  // Bounds are fractions of the supplied six-panel storyboard; omit title bands.
  const bounds = [[0.01, .052, .523, .258], [.55, .052, .441, .258],
    [.01, .363, .523, .248], [.55, .363, .441, .248],
    [.01, .665, .523, .263], [.55, .665, .441, .263]];
  for (let i = 0; i < bounds.length; i++) {
    const [x, y, w, h] = bounds[i];
    await sharp(source).extract({ left: Math.round(x * width), top: Math.round(y * height),
      width: Math.floor(w * width), height: Math.floor(h * height) }).jpeg({ quality: 95 })
      .toFile(path.join(root, `reference-${i + 1}.jpg`));
  }
  await fs.writeFile(path.join(root, 'storyboard-draft.json'), JSON.stringify({ duration: 60, width: 768, height: 1344,
    model: 'MiniMaxH3_33B_Turbo_INT8', style, shots }, null, 2));
  console.log('PREPARED six cropped references and six ten-second shots.');
}
async function direct(textOnly = false, plainText = false) {
  if (!process.env.BUATSIMPEL_API_KEY) throw Error('The configured director credential is unavailable.');
  const target = path.join(root, 'storyboard.json');
  if (await exists(target)) {
    const existing = JSON.parse(await fs.readFile(target, 'utf8'));
    if (existing.llmDirected) { console.log('EXISTING LLM storyboard; no additional LLM call.'); return; }
  }
  const marker = path.join(root, plainText ? 'director-plain-attempt.json' : textOnly ? 'director-text-attempt.json' : 'director-attempt.json');
  if (await exists(marker)) throw Error('An earlier director request is unconfirmed; do not retry it automatically.');
  const model = process.env.MICRODRAMA_LLM_MODEL || 'gpt-6-luna';
  const headers = { Authorization: `Bearer ${process.env.BUATSIMPEL_API_KEY}`, 'Content-Type': 'application/json' };
  const catalogue = await fetch('https://buatsimpel.id/v1/models', { headers, signal: AbortSignal.timeout(60000) });
  if (!catalogue.ok) throw Error(`Director catalogue HTTP ${catalogue.status}`);
  const models = await catalogue.json() as any;
  if (!models.data?.some((m: any) => m.id === model)) throw Error('The configured director model is not listed.');
  const reference = await sharp(source).resize({ width: 896, withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
  await fs.writeFile(marker, JSON.stringify({ model, attemptedAt: new Date().toISOString() }));
  console.log(`DIRECTOR ${model}: requesting a six-shot epic action-film plan from the supplied image.`);
  const response = await fetch('https://buatsimpel.id/v1/chat/completions', {
    method: 'POST', headers, signal: AbortSignal.timeout(240000),
    body: JSON.stringify({ model, stream: false, max_tokens: plainText ? 3500 : 7000, temperature: 0.6,
      messages: [
        { role: 'system', content: `You are an expert action-film director, stunt choreographer, storyboard artist and visual continuity supervisor. Return valid JSON only with title, logline, and shots: exactly six objects, each containing name, scene, motion. No markdown, tools, URLs or code. You only write creative direction. Each scene is a single vertical opening frame. Each motion is an executable-in-visual-terms English video prompt for exactly TEN SECONDS, with precise staging, a clear camera move, readable character actions, a final physical state, and native fight sound direction. Compose an epic SIXTY-SECOND action sequence with escalating tension, distinct shots, a memorable but non-graphic finishing move and a satisfying ending. Limit each clip to two or three readable actions, not an impossible montage. Maintain screen direction, enemy positions, weapon hand, wardrobe and identity. No blood, dismemberment or blade penetration of bodies. The heroine is explicitly an adult age 25. Preserve the uploaded graphite manga style, selective blue energy and magenta neon: cinematic action staging does NOT mean changing it to live-action. No sexualized framing. No narration, spoken dialogue, lyrics, text or titles in frames.` },
        { role: 'user', content: plainText
          ? `Create an epic action-film fight for this adult heroine: ${style} Exactly 60 seconds in six ten-second clips. Opening standoff and parry, first strike, close quarters, energy-assisted spinning kick, disarming the armored commander, and a cinematic aftermath. No blood. The uploaded artwork will be used as exact identity references by the image renderer, so focus your plan on precise camera movement, geography and physically readable combat. Return JSON with title, logline, shots:[{name,scene,motion}] only. All prompts must be English. Each motion should include time beats within ten seconds and a clear final state, at most 150 words each. Each scene describes the first frame in at most 90 words.`
          : [
          { type: 'text', text: `The user requests: "buat pertarungan karakter ini 1 menit" and "minta LLM nya buat epic ala film action". ${textOnly ? 'The supplied six-panel reference depicts this character and style: ' + style + ' Its panels show a standoff, first parry, close-quarters combat, blue-energy spinning kick, a finisher against a large armored enemy, and a final portrait.' : 'Study this storyboard as character, costume, setting and combat inspiration.'} Expand the fight from 30 to 60 seconds. Same sole heroine with her blue energy blade against black-armored adult enemies in a rainy neon alley. Each ten-second clip will be generated independently from a character-consistent opening image, so provide enough setting and positioning in every scene. Clip one should be engaging, with tension progressing to one opening parry rather than ten seconds of inactivity. Ensure all shots form one coherent fight. Provide substantial, concrete motion prompts, not generic adjectives.` },
          ...(!textOnly ? [{ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${reference.toString('base64')}` } }] : []),
        ] },
      ] }),
  });
  if (!response.ok) throw Error(`Director request HTTP ${response.status}; no automatic retry.`);
  const envelope = await response.text();
  let body: any;
  try { body = JSON.parse(envelope); }
  catch {
    const safe = envelope.split(process.env.BUATSIMPEL_API_KEY!).join('[REDACTED]')
      .replace(/Bearer\s+[^\s"<>]+/gi, 'Bearer [REDACTED]').replace(/sk-[A-Za-z0-9_-]+/g, '[REDACTED]');
    await fs.writeFile(path.join(root, path.basename(marker, '.json') + '-response.txt'), safe.slice(0, 8000));
    throw Error(`Director returned a non-JSON gateway response; rateLimit=${/rate.?limit|429/i.test(envelope)}, upstreamError=${/upstream|error|failed/i.test(envelope)}. No media submitted.`);
  }
  const raw = body.choices?.[0]?.message?.content;
  if (typeof raw !== 'string' || raw.length > 65000) throw Error('Director response is not valid text.');
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  let plan: any;
  try { plan = JSON.parse(cleaned); }
  catch { throw Error(`Director content is not a JSON plan; rateLimit=${/rate.?limit|429/i.test(cleaned)}, upstreamError=${/upstream|error|failed/i.test(cleaned)}. No media submitted.`); }
  if (typeof plan.title !== 'string' || typeof plan.logline !== 'string' || !Array.isArray(plan.shots) || plan.shots.length !== 6
    || plan.shots.some((s: any) => ['name', 'scene', 'motion'].some(k => typeof s[k] !== 'string' || !s[k].trim() || s[k].length > 6000))) {
    throw Error('Director plan failed its six-shot format checks; no automatic retry.');
  }
  await fs.writeFile(target, JSON.stringify({ ...plan, duration: 60, width: 768, height: 1344,
    model: 'MiniMaxH3_33B_Turbo_INT8', directorModel: model, llmDirected: true, style }, null, 2));
  console.log(`DIRECTED ${plan.title}: ${plan.logline}`);
  plan.shots.forEach((s: any, i: number) => console.log(`SHOT ${i + 1}: ${s.name}`));
}
async function main() {
  await fs.mkdir(root, { recursive: true });
  const lock = await fs.open(path.join(root, 'operation.lock'), 'wx');
  let db: Pool | undefined;
  try {
    const mode = process.argv[2], n = Number(process.argv[3]);
    if (mode === 'prepare') { await prepare(); return; }
    if (['direct', 'direct-text', 'direct-plain'].includes(mode)) { await direct(mode !== 'direct', mode === 'direct-plain'); return; }
    if (!await exists(path.join(root, 'storyboard.json'))) throw Error('Run the LLM director before generating media.');
    const directed = JSON.parse(await fs.readFile(path.join(root, 'storyboard.json'), 'utf8'));
    if (directed.llmDirected !== true) throw Error('A confirmed LLM-directed storyboard is required.');
    const directedShots = directed.shots as typeof shots;
    const state: State = await exists(path.join(root, 'state.json'))
      ? JSON.parse(await fs.readFile(path.join(root, 'state.json'), 'utf8'))
      : { version: 1, shots: directedShots.map(() => ({ frame: {}, video: {} })) };
    if (mode === 'assemble') {
      if (state.shots.some(s => !s.video.file)) throw Error('All six video clips are required before assembly.');
      await fs.writeFile(path.join(root, 'concat.txt'), state.shots.map((_, i) => `file 'clip-${i + 1}.mp4'`).join('\n'));
      await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(root, 'concat.txt'),
        '-t', '60', '-vf', 'crop=756:1344:6:0,setsar=1,fps=24', '-c:v', 'libx264', '-preset', 'fast',
        '-crf', '19', '-threads', '2', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
        path.join(root, 'neon-reaper-60s.mp4')], { timeout: 300_000 });
      console.log('ASSEMBLED neon-reaper-60s.mp4'); return;
    }
    if (!['frame', 'video'].includes(mode) || !Number.isInteger(n) || n < 1 || n > 6) throw Error('Use prepare, frame N, video N, or assemble.');
    if (!process.env.RAILWAY_DATABASE_URL) throw Error('Railway database is not configured.');
    db = new Pool({ connectionString: process.env.RAILWAY_DATABASE_URL, ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
    const api = new DeapiEpisodeApi(new DeapiKeyPool(db));
    const shot = directedShots[n - 1], job = state.shots[n - 1][mode as 'frame' | 'video'];
    const output = path.join(root, `${mode === 'frame' ? 'frame' : 'clip'}-${n}.${mode === 'frame' ? 'jpg' : 'mp4'}`);
    if (job.file && await exists(output)) { console.log(`EXISTING ${mode} ${n}; no paid request.`); return; }
    if (job.attempted && !job.id) throw Error('UNCERTAIN SUBMIT: do not resubmit; inspect the original provider account.');
    const req: EpisodeRequest = mode === 'frame'
      ? { kind: 'image', seed: 28010 + n, images: await Promise.all([n, 1, 6].map(i => fs.readFile(path.join(root, `reference-${i}.jpg`)))),
        prompt: `${style} Reference 1 is scene composition; references 2 and 3 are the same woman's identity and costume. ${shot.scene} Create ONE clean vertical 9:16 opening frame suitable for animation. Extend the scene vertically naturally, do not crop off the heroine's head. Match her recognizable face and outfit. NOT a collage or storyboard: remove panel borders, captions, timing labels, signatures and all text. Do not switch to photorealistic or 3D style.` }
      : { kind: 'video', seed: 58010 + n, images: [await fs.readFile(path.join(root, `frame-${n}.jpg`))],
        prompt: `${style} Animate this supplied first frame, retaining its exact heroine identity and illustrated art style. ${shot.motion} Fluid illustrated cinematic animation, clear motion rather than a still-image zoom. Stable environment and costume. No extra limbs, no face replacement, no split screens, no panels, no captions. Native action sound: rain, footsteps, blade hum and metal impacts. No spoken dialogue, no singing.` };
    if (!job.id) {
      const quote = await api.quote(req);
      job.price = quote.price; job.keyId = quote.keyId; job.attempted = true;
      await save(state); // Never lose the account binding or ambiguous-submit marker.
      console.log(`SUBMIT ${mode} ${n}; quoted USD ${quote.price.toFixed(6)}; pool account ${quote.keyId}`);
      job.id = await api.submit(req, quote.keyId); await save(state);
      console.log(`ACCEPTED ${mode} ${n}; waiting for the same job.`);
    } else console.log(`RESUME ${mode} ${n}; polling its original account, no new submit.`);
    const data = await api.result(job.id, job.keyId!);
    if (mode === 'frame') await sharp(data).resize(768, 1344, { fit: 'cover' }).jpeg({ quality: 95 }).toFile(output);
    else {
      await fs.writeFile(output + '.partial', data); await fs.rename(output + '.partial', output);
      const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output]);
      const probe = JSON.parse(stdout), video = probe.streams.find((s: any) => s.codec_type === 'video');
      if (video?.width !== 768 || video?.height !== 1344 || Number(probe.format.duration) < 9.9) throw Error('Unexpected video dimensions or duration.');
      await exec('ffmpeg', ['-y', '-v', 'error', '-ss', '5', '-i', output, '-frames:v', '1', path.join(root, `sample-${n}.jpg`)]);
      console.log(`VERIFIED ${n}: ${probe.format.duration}s, ${video.width}x${video.height}, audio=${probe.streams.some((s: any) => s.codec_type === 'audio')}`);
    }
    job.file = path.relative(root, output); await save(state);
    console.log(`SAVED ${path.relative(path.resolve(__dirname, '../..'), output)}`);
  } finally {
    if (db) await db.end();
    await lock.close(); await fs.unlink(path.join(root, 'operation.lock'));
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Media operation failed.'); process.exitCode = 1; });
