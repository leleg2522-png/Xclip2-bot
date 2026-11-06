// Six owner-requested MUSE scenes. Persist accepted jobs; never replay a submit.
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { qualityRules, strictScenes, strictCaptions } from './muse-microdrama-quality.mjs';
const exec = promisify(execFile);
const dryRun = process.argv.includes('--dry-run');
if (!dryRun && !process.argv.includes('--approved')) throw Error('APPROVAL_REQUIRED');
const gentleContinuation = process.argv.includes('--approved-gentle-continuation');
const strictQuality = process.argv.includes('--strict-quality');
const koreanDrama = process.argv.includes('--korean-drama');
const claudeDriven = process.argv.includes('--claude-plan') || koreanDrama;
if (claudeDriven && strictQuality) throw Error('CHOOSE_ONE_EXPERIMENT');
const chainEndFrames = claudeDriven || strictQuality || process.argv.includes('--chain-end-frames');
if (chainEndFrames && gentleContinuation) throw Error('CHOOSE_ONE_EXPERIMENT');
const originalDir = path.resolve(import.meta.dirname, '../../generated-artifacts/muse-ceo-microdrama');
const dir = koreanDrama ? path.resolve(import.meta.dirname, '../../generated-artifacts/muse-korean-drama')
  : claudeDriven ? originalDir + '-claude-negatives'
  : strictQuality ? originalDir + '-strict'
  : chainEndFrames ? originalDir + '-chained' : originalDir;
const base = 'https://api.snapgen.ai/uapi/v1';
const key = process.env.SNAPGEN_API_KEY;
if (!dryRun && !key) throw Error('SNAPGEN_KEY_MISSING');
const headers = { 'x-api-key': key, Accept: 'application/json' };
const pause = ms => new Promise(r => setTimeout(r, ms));
const characterRefs = koreanDrama ? [
  path.resolve(import.meta.dirname, '../../generated-artifacts/k-drama-character-references/arga-ceo.jpg'),
  path.resolve(import.meta.dirname, '../../generated-artifacts/k-drama-character-references/nara-delivery-worker.jpg'),
] : [];
const characters = `Photorealistic Indonesian romantic microdrama, vertical 9:16, cinematic live action, adult actors only. Maintain exactly the same two leads throughout: ARGA, handsome Indonesian male CEO aged 30, neat short black side-part hair, clean shaven, navy tailored suit, white shirt, no tie, silver watch; NARA, Indonesian woman aged 24 with a modest low-income background, warm brown eyes, long black hair in a low ponytail, faded light-blue long-sleeve blouse, dark trousers, old brown canvas shoulder bag. Respectful portrayal, not caricature. Modern Jakarta luxury office lobby. Natural human movements and emotional acting, consistent faces and clothing. No written text, captions, watermarks or logos. Clear audible Indonesian speech with correct speaker turns, natural room ambience and subtle dramatic instrumental music. No English speech.`;
const scenes = [
  `Opening: Nara enters the marble office lobby carrying a paper food-delivery bag, visibly nervous but dignified. Arga is clearly visible beside her near the elevator, watching her kindly. Establish both lead faces in a medium two-shot before close-up of Nara. Nara quietly says in Indonesian: "Permisi, saya antar pesanan." Arga turns toward her as a rude female office manager approaches. Ten seconds of coherent storytelling.`,
  `Continue in the same lobby. A haughty female office manager in a black office dress blocks Nara carrying her food bag, looking at Nara's worn clothes. Arga stands behind them within sight. The manager dismissively says: "Kurir lewat belakang. Jangan kotori lobi!" Nara lowers her eyes, then answers softly: "Saya cuma mencari nafkah, Bu." Show hurt and dignity, no slapstick.`,
  `All three adults are standing calmly in the same office lobby. The office manager points politely toward the service reception. Nara holds her paper food bag securely and looks uncertain. Arga steps beside Nara and says with calm authority: "Sebentar. Dia tamu saya." The manager nods and walks away. Nara looks up at Arga in grateful surprise. Gentle dramatic reaction shots, no physical confrontation, no falling objects.`,
  `Arga and Nara remain standing beside each other in the same office lobby. Nara offers him the paper delivery bag. He notices a small old red braided bracelet on her wrist. Cut from the bracelet to his surprised face and her curious expression, maintaining the same costumes. Arga softly asks: "Gelang itu... dari mana?" Nara answers: "Dari anak yang dulu saya tolong." Warm romantic tension and restrained emotion.`,
  `Arga and Nara stand together in the lobby, close medium two-shot. Arga takes an identical old red braided bracelet from his inner suit pocket and holds it beside hers. No flashback, remain in the present. Arga says emotionally: "Anak itu aku, Nara. Sepuluh tahun aku mencarimu." Nara looks at his face, stunned, tears welling. Gentle camera push-in.`,
  `Final cliffhanger, same two adults in the office lobby. Arga gently offers his open hand, never grabbing her. Nara looks from the matching red bracelets to his face. Arga says: "Izinkan aku membalas kebaikanmu." Nara replies: "Tapi... kenapa harus aku?" He smiles warmly and says: "Karena aku tak pernah lupa." Finish on their emotional eye contact, romantic dramatic ending, no text.`,
];
const captions = [
  [[0.5,4.2,'Nara: Permisi, saya antar pesanan.']],
  [[0.4,4.8,'Kurir lewat belakang. Jangan kotori lobi!'],[5.1,9.5,'Nara: Saya cuma mencari nafkah, Bu.']],
  [[4.0,8.8,'Arga: Sebentar. Dia tamu saya.']],
  [[1.4,5.0,'Arga: Gelang itu... dari mana?'],[5.2,9.6,'Nara: Dari anak yang dulu saya tolong.']],
  [[1.2,5.3,'Arga: Anak itu aku, Nara.'],[5.4,9.6,'Sepuluh tahun aku mencarimu.']],
  [[0.3,3.5,'Arga: Izinkan aku membalas kebaikanmu.'],[3.7,6.6,'Nara: Tapi... kenapa harus aku?'],[6.8,9.8,'Arga: Karena aku tak pernah lupa.']],
];
let claudeEpisode, claudeShots, directorPrompt;
if (claudeDriven) {
  const require = createRequire(import.meta.url);
  const { lockedPrompt, validateBible, validateScene } = require('../dist/episode-director.js');
  const { newEpisode } = require('../dist/episode-types.js');
  if (koreanDrama) {
    for (const file of characterRefs) {
      const size = (await fs.stat(file)).size;
      if (!size || size > 10 * 1024 * 1024) throw Error('KOREAN_CHARACTER_REFERENCE_INVALID_SIZE');
    }
  }
  const planFile = koreanDrama
    ? '../../generated-artifacts/botelex-korean-drama-plan/state.json'
    : '../../generated-artifacts/botelex-muse-negative-plan/state.json';
  const plan = JSON.parse(await fs.readFile(path.resolve(import.meta.dirname, planFile), 'utf8'));
  if (!plan.completed || plan.model !== 'claude-fable-5.1') throw Error('CLAUDE_PLAN_NOT_READY');
  claudeEpisode = newEpisode(1);
  claudeEpisode.bible = validateBible(plan.results.bible, 1);
  if (koreanDrama && (claudeEpisode.bible.cast.length !== 2
      || claudeEpisode.bible.cast[0].id !== 'DOYUN'
      || claudeEpisode.bible.cast[1].id !== 'SEOYEON')) {
    throw Error('KDRAMA_CHARACTER_REFERENCE_ORDER_MISMATCH');
  }
  claudeShots = [0,1].flatMap(i => validateScene(
    { shots: plan.results[`scene${i+1}`] }, claudeEpisode, i, true, koreanDrama));
  if (claudeShots.length !== 6 || claudeShots.some(s => !s.negativePrompt
      || (koreanDrama && s.dialogue.some(d => !d.subtitleId)))) throw Error('CLAUDE_PROMPT_NEGATIVE_OR_SUBTITLE_MISSING');
  directorPrompt = lockedPrompt;
}
function buildPrompt(i) {
  const continuity = chainEndFrames && i > 0
    ? '\nCONTINUITY: The attached image is the exact final frame of the preceding scene. Begin at this exact image composition: same camera angle, positions, poses, faces, clothing, props, lighting and background. Continue movement naturally from that instant. Do not restart the encounter or reset the actors. After the opening moment, develop the next story beat below. No establishing shot, no fade, no opening transition.\n'
    : '\n';
  if (claudeDriven) {
    const shot = claudeShots[i];
    const fixedCharacters = koreanDrama
      ? `\nFIXED CAST REFERENCES: Attached image 1 is the approved Korean male CEO, ${claudeEpisode.bible.cast[0].id} (${claudeEpisode.bible.cast[0].name}); preserve this exact face, hair and wardrobe. Image 2 is the approved Korean woman, ${claudeEpisode.bible.cast[1].id} (${claudeEpisode.bible.cast[1].name}); preserve her exact face, hair and wardrobe.${i > 0 ? ' Image 3 is the exact final decoded frame of the previous clip; continue from it without replacing either identity in images 1 and 2.' : ' Use both approved lead identities in the opening shot.'}\n`
      : '';
    return directorPrompt(claudeEpisode, shot, true, '', koreanDrama ? 'ko' : 'id') + continuity
      + fixedCharacters
      + (i === 0 ? `\nOpening-frame composition from the director: ${shot.imagePrompt}` : '')
      + '\nUse only natural quiet room ambience. The named adult characters are the only people in view.';
  }
  const cast = strictQuality
    ? characters.replace('and subtle dramatic instrumental music', 'only, without music')
    : characters;
  return cast + continuity + 'SCENE: ' + (strictQuality ? strictScenes[i] : scenes[i])
    + (strictQuality ? '\n' + qualityRules : '');
}
if (dryRun) {
  // Inspect all prompts without filesystem writes, credentials or network calls.
  console.log(JSON.stringify({
    strictQuality, chainEndFrames, paidSubmissions: 0,
    newScenes: koreanDrama ? 6 : strictQuality ? 6 : chainEndFrames ? 5 : 6,
    prompts: Array.from({length:6},(_,i) => buildPrompt(i)),
  }, null, 2));
  process.exit(0);
}
await fs.mkdir(dir, { recursive: true });
const lockPath = path.join(dir, 'running.lock');
const lock = await fs.open(lockPath, 'wx');
const statePath = path.join(dir, 'state.json');
let state;
try { state = JSON.parse(await fs.readFile(statePath, 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; state = { scenes: [], botSaldoCharged: false }; }
// Serialize writes even when two scene polls complete at once.
let saving = Promise.resolve();
function save() {
  const snapshot = JSON.stringify(state, null, 2);
  saving = saving.then(async () => {
    await fs.writeFile(statePath + '.tmp', snapshot);
    await fs.rename(statePath + '.tmp', statePath);
  });
  return saving;
}
async function probe(file) {
  return JSON.parse((await exec('ffprobe', ['-v','error','-show_streams','-show_format','-of','json',file])).stdout);
}
function safeCode(r) {
  const value = r?.detail?.error_code ?? r?.error_code;
  return typeof value === 'string' && /^[A-Z0-9_]{1,80}$/.test(value) ? value : 'UNKNOWN';
}
async function scene(i) {
  const s = state.scenes[i] ??= {
    prompt: buildPrompt(i),
    ...(claudeDriven ? {
      directorModel: 'claude-fable-5.1',
      negativePrompt: claudeShots[i].negativePrompt,
      ...(koreanDrama ? { approvedCharacterReferences: characterRefs.map(f => path.basename(f)) } : {}),
    } : {}),
  };
  const file = path.join(dir, `scene-${i+1}.mp4`);
  if (s.downloaded) return file;
  if (s.failed) throw Error(`SCENE_${i+1}_PREVIOUSLY_FAILED_${s.errorCode}`);
  if (!s.uuid) {
    if (s.attempted) throw Error(`SCENE_${i+1}_AMBIGUOUS_SUBMIT_NO_REPLAY`);
    const body = new FormData();
    body.set('prompt', s.prompt); body.set('model','muse-ai-video');
    body.set('duration','10'); body.set('orientation','portrait');
    for (const reference of characterRefs) {
      body.append('files', new Blob([await fs.readFile(reference)], { type:'image/jpeg' }), path.basename(reference));
    }
    if (i > 0) {
      let reference = 'cast-reference.jpg';
      if (chainEndFrames) {
        if (!state.scenes[i-1]?.downloaded) throw Error('PREVIOUS_SCENE_NOT_READY');
        reference = `scene-${i}-last-frame.png`;
        // Decode to EOF and keep overwriting one image, leaving the actual last
        // decoded frame rather than a timestamp approximation.
        await exec('ffmpeg', ['-v','error','-threads','2','-sseof','-1',
          '-i',path.join(dir,`scene-${i}.mp4`),'-an','-fps_mode','passthrough',
          '-update','1','-threads','2','-y',path.join(dir,reference)]);
        s.referenceScene = i;
        s.referenceFile = reference;
      }
      const mime = chainEndFrames ? 'image/png' : 'image/jpeg';
      body.append('files', new Blob([await fs.readFile(path.join(dir,reference))],
        { type:mime }), reference);
    }
    s.attempted = true;
    await save();
    const response = await fetch(base + '/video-gen/muse', {
      method:'POST', headers, body, signal:AbortSignal.timeout(120000),
    });
    const r = await response.json().catch(() => null);
    if (r?.uuid) { s.uuid = r.uuid; s.estimatedCredit = r.estimated_credit; await save(); }
    if (!response.ok) {
      s.errorCode = safeCode(r); s.failed = true; await save();
      throw Error(`SCENE_${i+1}_SUBMIT_HTTP_${response.status}_${s.errorCode}`);
    }
    if (!s.uuid || r.model_name !== 'muse-ai-video') throw Error('MUSE_SUBMIT_METADATA_INVALID');
    console.log(`SCENE_${i+1}_ACCEPTED estimated_credit=${s.estimatedCredit}`);
  }
  for (let n=0; n<150; n++) {
    await pause(10000);
    let response;
    try { response = await fetch(base+'/history/'+encodeURIComponent(s.uuid), { headers, signal:AbortSignal.timeout(45000) }); }
    catch { console.log(`SCENE_${i+1}_POLL_NETWORK_PAUSED`); continue; }
    if (response.status === 429 || response.status >= 500) {
      await pause(Math.min(120,Math.max(10,Number(response.headers.get('retry-after'))||30))*1000);
      continue;
    }
    if (!response.ok) throw Error(`MUSE_POLL_HTTP_${response.status}`);
    const r = await response.json();
    if (r.model_name !== 'muse-ai-video') throw Error('MUSE_HISTORY_MODEL_MISMATCH');
    const video = r.generated_video?.[0];
    if (s.providerStatus !== r.status) {
      s.providerStatus = r.status; await save();
      console.log(`SCENE_${i+1}_STATUS ${r.status}`);
    }
    if (Number(r.status) === 3 || Number(video?.status) === 3) {
      s.failed = true; s.errorCode = safeCode(r); s.usedCredit = r.used_credit; await save();
      throw Error(`SCENE_${i+1}_FAILED_${s.errorCode}`);
    }
    if (Number(r.status) !== 2 && Number(video?.status) !== 2) continue;
    const url = r.generated_video?.find(v => v.video_url)?.video_url;
    if (typeof url !== 'string' || !url.startsWith('https://')) throw Error('MUSE_NO_OUTPUT_URL');
    const media = await fetch(url, { signal:AbortSignal.timeout(180000) });
    if (!media.ok || !media.body) throw Error('MUSE_DOWNLOAD_FAILED');
    const parts = []; let size=0;
    for await (const chunk of media.body) {
      size += chunk.length;
      if (size > 150*1024*1024) throw Error('MUSE_OUTPUT_TOO_LARGE');
      parts.push(chunk);
    }
    await fs.writeFile(file, Buffer.concat(parts));
    const p = await probe(file);
    const v = p.streams.find(v => v.codec_type === 'video');
    if (!v || Math.abs(Number(p.format.duration)-10)>1) throw Error('MUSE_DURATION_INVALID');
    s.downloaded = true; s.usedCredit = r.used_credit;
    s.media = { duration:Number(p.format.duration), width:v.width, height:v.height,
      audio:p.streams.some(v => v.codec_type === 'audio') };
    await save(); console.log(`SCENE_${i+1}_DOWNLOADED ${JSON.stringify(s.media)}`);
    return file;
  }
  throw Error(`SCENE_${i+1}_POLL_PAUSED_RESUME_SAME_JOB`);
}
function time(s) {
  return `${String(Math.floor(s/3600)).padStart(2,'0')}:${String(Math.floor(s/60)%60).padStart(2,'0')}:${(s%60).toFixed(3).padStart(6,'0').replace('.',',')}`;
}
try {
  if (claudeDriven && !state.claudeDriven) {
    if (state.scenes.some(s => s?.attempted || s?.downloaded)) throw Error('CLAUDE_STATE_ALREADY_USED');
    state.claudeDriven = true; state.chainEndFrames = true;
    state.title = claudeEpisode.bible.title;
    state.directorModel = 'claude-fable-5.1';
    if (koreanDrama) state.characterReferenceFiles = characterRefs.map(file => path.basename(file));
    await save();
  }
  if (strictQuality && !state.strictQuality) {
    if (state.scenes.some(s => s?.attempted || s?.downloaded)) throw Error('STRICT_STATE_ALREADY_USED');
    state.strictQuality = true;
    state.chainEndFrames = true;
    await save();
  }
  if (chainEndFrames && !strictQuality && !claudeDriven && !state.chainEndFrames) {
    if (state.scenes.some(s => s?.attempted)) throw Error('CHAIN_STATE_ALREADY_HAS_SUBMISSIONS');
    const source = JSON.parse(await fs.readFile(path.join(originalDir,'state.json'),'utf8'));
    if (!source.scenes[0]?.downloaded) throw Error('ORIGINAL_FIRST_SCENE_MISSING');
    await fs.copyFile(path.join(originalDir,'scene-1.mp4'),path.join(dir,'scene-1.mp4'));
    state.scenes[0] = {
      downloaded: true, reusedFromOriginal: true, usedCredit: 0,
      media: source.scenes[0].media,
    };
    state.chainEndFrames = true;
    await save();
    console.log('CHAINED_EXPERIMENT_FIRST_SCENE_REUSED');
  }
  if (gentleContinuation && !state.gentleContinuationAuthorized) {
    const previous = state.scenes[2];
    if (!previous?.failed || previous.errorCode !== 'CONTENT_MODERATION_ERROR') {
      throw Error('GENTLE_CONTINUATION_REQUIRES_KNOWN_FAILED_SCENE');
    }
    if (state.scenes.slice(3).some(s => s?.attempted)) {
      throw Error('GENTLE_CONTINUATION_LATER_SCENES_ALREADY_SUBMITTED');
    }
    // Keep the rejected UUID and billing evidence; this is a separately
    // authorized replacement scene, not a replay of the failed paid job.
    state.supersededScenes ??= [];
    state.supersededScenes.push({ scene: 3, ...previous });
    state.scenes[2] = { prompt: characters + '\nSCENE: ' + scenes[2] };
    state.gentleContinuationAuthorized = true;
    delete state.lastError;
    await save();
    console.log('SEPARATELY_AUTHORIZED_GENTLE_CONTINUATION');
  }
  if (state.completed) { console.log('ALREADY_COMPLETED'); }
  else {
    const accountResponse = await fetch(base+'/account', { headers, signal:AbortSignal.timeout(30000) });
    if (!accountResponse.ok) throw Error(`MUSE_ACCOUNT_HTTP_${accountResponse.status}`);
    const a = await accountResponse.json();
    if (!a.is_active || a.plan_id !== 'PP0001') throw Error('MUSE_PREMIUM_REQUIRED');
    const remaining = 6 - state.scenes.filter(s => s?.downloaded).length;
    if (Number(a.user_credit?.available_credit) < remaining) throw Error('MUSE_INSUFFICIENT_CREDIT');
    console.log('MUSE_ACCOUNT_READY');
    await scene(0);
    await exec('ffmpeg',['-v','error','-threads','2','-ss','2','-i',path.join(dir,'scene-1.mp4'),
      '-frames:v','1','-threads','2','-y',path.join(dir,'cast-reference.jpg')]);
    // Keep reference-based scene jobs sequential to stop spending on first failure.
    for (let i=1; i<6; i++) await scene(i);
    let srt = '', index = 0;
    const activeCaptions = koreanDrama
      ? claudeShots.map(s => s.dialogue.map((d,i,all) => [
        1+i*6/all.length, 1+(i+1)*6/all.length, d.subtitleId,
      ]))
      : claudeDriven ? claudeShots.map(s => s.dialogue.map((d,i,all) => [
        1+i*6/all.length, 1+(i+1)*6/all.length, `${d.speaker}: ${d.text}`,
      ])) : strictQuality ? strictCaptions : captions;
    activeCaptions.forEach((rows,i) => rows.forEach(([start,end,text]) => {
      srt += `${++index}\n${time(i*10+start)} --> ${time(i*10+end)}\n${text}\n\n`;
    }));
    await fs.writeFile(path.join(dir,'dialog-id.srt'),srt);
    for (let i=0; i<6; i++) {
      const input = ['-i',path.join(dir,`scene-${i+1}.mp4`)];
      if (!state.scenes[i].media.audio) input.push('-f','lavfi','-i','anullsrc=r=48000:cl=stereo');
      await exec('ffmpeg',['-v','error','-threads','2',...input,
        '-map','0:v:0','-map',state.scenes[i].media.audio?'0:a:0':'1:a:0',
        '-vf','scale=720:1280:force_original_aspect_ratio=increase,crop=720:1280,setsar=1,fps=24,tpad=stop_mode=clone:stop_duration=1',
        '-af','aresample=48000,apad','-t','10','-c:v','libx264','-threads','2',
        '-preset','fast','-crf','19','-pix_fmt','yuv420p','-c:a','aac','-ar','48000','-ac','2',
        '-y',path.join(dir,`part-${i+1}.mp4`)],{timeout:180000});
    }
    await fs.writeFile(path.join(dir,'concat.txt'),scenes.map((_,i)=>`file 'part-${i+1}.mp4'`).join('\n'));
    const stitchedFile = path.join(dir, koreanDrama ? 'seoul-drama-stitched.mp4' : 'ceo-itu-mengenalku-60s.mp4');
    await exec('ffmpeg',['-v','error','-f','concat','-safe','0','-i',path.join(dir,'concat.txt'),
      '-c','copy','-movflags','+faststart','-y',stitchedFile],{timeout:180000});
    let finalFile = stitchedFile;
    if (koreanDrama) {
      const subtitleFile = path.join(dir,'dialog-id.srt');
      finalFile = path.join(dir,'drama-korea-seoul-60s.mp4');
      const subtitleFilter = `subtitles=${subtitleFile}:force_style='FontName=DejaVu Sans,FontSize=26,Outline=2,Shadow=1,Alignment=2,MarginV=48'`;
      await exec('ffmpeg',['-v','error','-threads','2','-i',stitchedFile,'-vf',subtitleFilter,
        '-c:v','libx264','-threads','2','-preset','fast','-crf','19','-pix_fmt','yuv420p',
        '-c:a','copy','-movflags','+faststart','-y',finalFile],{timeout:300000});
    }
    state.finalMedia = (await probe(finalFile)).format;
    state.finalMediaPath = path.basename(finalFile);
    state.completed = true; state.usedCredit = state.scenes.reduce((sum,s)=>sum+Number(s.usedCredit||0),0);
    await save(); console.log('MICRODRAMA_COMPLETED',JSON.stringify({duration:state.finalMedia.duration,usedCredit:state.usedCredit}));
  }
} catch(e) {
  const diagnostic = /^[A-Z0-9_]+$/.test(e.message) ? e.message : 'NETWORK_OR_PROCESS_FAILURE';
  state.lastError = diagnostic; await save(); console.error(diagnostic); process.exitCode=1;
} finally {
  await saving; await lock.close(); await fs.unlink(lockPath);
}
