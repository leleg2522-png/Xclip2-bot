/**
 * Owner-authorized one-minute Mandarin microdrama using Claude + DeAPI LTX 2.5.
 * Each stage persists before paid submits; never replay an ambiguous job.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import sharp from 'sharp';
import { DeapiEpisodeApi, type EpisodeRequest } from '../src/episode-api';
import { DeapiKeyPool } from '../src/deapi-key-pool';
import { DeapiRateLimitError } from '../src/deapi-rate-limit';
import { EpisodeDirector, lockedPrompt } from '../src/episode-director';
import { parseTranscript } from '../src/episode-media';
import { MICRODRAMA_LLM_DEFAULT, microdramaLlmKey } from '../src/microdrama-llm';
import { newEpisode } from '../src/episode-types';

const exec = promisify(execFile);
const root = path.resolve(__dirname, '../../generated-artifacts/microdrama-china-ltx-25');
const budgetUsd = 1.85;
const model = 'Ltx2_5_22B_Dist_INT8';
const videoSettings = { model, width: 768, height: 1344, frames: 241, fps: 24 };
const idea = `Write a completely NEW original Chinese short-form family/romance drama, not a continuation or rewrite of any earlier story.
Set it in contemporary Shanghai, China. Exactly two adult Chinese lead characters, one principal location, one minute total.
Use a fresh high-hook premise with escalating conflict, a sharp emotional reversal/reveal, and a cliffhanger in the final shot.
Do not use the earlier biological/adopted-daughters, inheritance will, sealed letter, half-photo, or switched-baby premise.
Keep the plot filmable with simple actions and a few stable props. Natural spoken Mandarin using Simplified Chinese; no other language, no subtitles, no minors, no extra visible actors.
All six ten-second shots must maintain each lead's face, hair, exact wardrobe, screen position and voice. Visual descriptions and shot directions in English; all spoken dialogue in Simplified Chinese.`;

type Job = { attempted?: boolean; id?: string; keyId?: number; quoteUsd?: number; priceUsd?: number; file?: string; status?: string; error?: string; alternateFor?: string };
type State = {
  model: string; directorModel: string; budgetUsd: number; reservedUsd: number;
  planAttempted?: boolean; sceneAttempts?: Record<string, boolean>;
  planStage?: string; completedAt?: string; finishAuthorized?: boolean; renderComplete?: boolean;
  sceneRetryAttempted?: boolean; sceneRetryStatus?: string;
  alternateRefAttemptUsed?: boolean;
  bible?: any; shots?: any[]; planComplete?: boolean;
  jobs: Record<string, Job>; quotedTotalUsd?: number; completed?: boolean; finalFile?: string; lastError?: string;
};
async function exists(file: string) {
  try { await fs.access(file); return true; } catch { return false; }
}
async function atomic(file: string, value: unknown) {
  await fs.writeFile(file + '.partial', JSON.stringify(value, null, 2));
  await fs.rename(file + '.partial', file);
}
async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as T;
}
async function probe(file: string) {
  const { stdout } = await exec('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  return JSON.parse(stdout);
}
async function frame(file: string, seconds: number) {
  const { stdout } = await exec('ffmpeg', ['-v', 'error', '-threads', '2', '-ss', String(seconds), '-i', file,
    '-frames:v', '1', '-f', 'image2pipe', '-vcodec', 'mjpeg', 'pipe:1'],
  { encoding: 'buffer', timeout: 60_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout as Buffer;
}
function episodeFrom(state: State) {
  if (!state.planComplete || !state.bible || state.shots?.length !== 6) throw new Error('VALIDATED_PLAN_REQUIRED');
  const episode = newEpisode(1);
  episode.bible = state.bible;
  episode.shots = state.shots.map(shot => ({ shot, takes: [] }));
  return episode;
}
function normalizeHan(text: string) {
  return [...text.normalize('NFKC').replace(/[^\p{Script=Han}]/gu, '')];
}
function charError(expected: string, actual: string) {
  const a = normalizeHan(expected), b = normalizeHan(actual);
  if (!a.length) return 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 0; i < a.length; i++) {
    const next = [i + 1];
    for (let j = 0; j < b.length; j++) {
      next.push(Math.min(next[j] + 1, prev[j + 1] + 1, prev[j] + (a[i] === b[j] ? 0 : 1)));
    }
    prev = next;
  }
  return prev.at(-1)! / a.length;
}
function imageRequest(prompt: string, seed: number, images?: Buffer[]): EpisodeRequest {
  return { kind: 'image', prompt, ...(images?.length ? { images } : {}), seed };
}
function dialogueRequest(bytes?: Buffer): EpisodeRequest {
  return { kind: 'transcript', prompt: '', ...(bytes ? { source: bytes } : {}), seed: 71 };
}
function time(seconds: number) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}
function captureAssistant(stage: string): typeof fetch {
  return async (url, init) => {
    const response = await fetch(url, init);
    if (!String(url).endsWith('/chat/completions')) return response;
    try {
      const copy = response.clone();
      const raw = await copy.text();
      if (raw.length > 4 * 1024 * 1024) throw new Error('LLM_CAPTURE_TOO_LARGE');
      let content = '';
      const finishReasons: string[] = [];
      if ((response.headers.get('content-type') || '').includes('text/event-stream')) {
        for (const line of raw.split(/\r?\n/).filter(row => row.startsWith('data:'))) {
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            const event = JSON.parse(data), choice = event?.choices?.[0];
            if (typeof choice?.delta?.content === 'string') content += choice.delta.content;
            if (typeof choice?.message?.content === 'string') content += choice.message.content;
            if (choice?.finish_reason) finishReasons.push(choice.finish_reason);
          } catch { /* Keep transport details separate from the assistant's fictional output. */ }
        }
      } else {
        try {
          const body = JSON.parse(raw), choice = body?.choices?.[0];
          if (typeof choice?.message?.content === 'string') content = choice.message.content;
          if (choice?.finish_reason) finishReasons.push(choice.finish_reason);
        } catch { /* The LLM client will report the response format error. */ }
      }
      if (content) await fs.writeFile(path.join(root, `${stage}-assistant.txt`), content);
      await atomic(path.join(root, `${stage}-transport.json`), {
        httpStatus: response.status, contentType: response.headers.get('content-type'),
        assistantChars: content.length, finishReasons,
      });
    } catch { /* Capture failure must not trigger another provider request. */ }
    return response;
  };
}

async function main() {
  const action = process.argv[2];
  if (!process.argv.includes('--approved')) throw new Error('APPROVAL_REQUIRED');
  if (!['plan', 'retry-missing-scene', 'retry403-reference', 'quote-refs', 'refs', 'quote', 'render', 'finish'].includes(action)) {
    throw new Error('STAGE_REQUIRED');
  }
  await fs.mkdir(root, { recursive: true });
  const lockPath = path.join(root, 'operation.lock');
  const lock = await fs.open(lockPath, 'wx');
  const dbUrl = process.env.RAILWAY_DATABASE_URL;
  if (!dbUrl) { await lock.close(); await fs.unlink(lockPath); throw new Error('PROVIDER_POOL_DATABASE_MISSING'); }
  const db = new Pool({ connectionString: dbUrl, max: 2, connectionTimeoutMillis: 15_000 });
  const statePath = path.join(root, 'state.json');
  let state: State = await exists(statePath) ? await readJson<State>(statePath) : {
    model, directorModel: MICRODRAMA_LLM_DEFAULT, budgetUsd, reservedUsd: 0, jobs: {},
  };
  const save = () => atomic(statePath, state);
  const pool = new DeapiKeyPool(db);
  const api = new DeapiEpisodeApi(pool, fetch, videoSettings, 'zh');
  const episode = () => episodeFrom(state);
  const imageFile = (name: string) => path.join(root, `${name}.jpg`);
  const refsFor = async (shot: any) => Promise.all([
    ...shot.cast.map((id: string) => fs.readFile(imageFile(`char_${id}`))),
    fs.readFile(imageFile(`loc_${shot.location}`)),
  ]);
  const promptFor = (shot: any, video: boolean) => lockedPrompt(episode(), shot, video, '', 'zh');

  async function quoteJob(name: string, request: EpisodeRequest) {
    const job = state.jobs[name] ??= {};
    if (job.quoteUsd !== undefined) return;
    const q = await api.quote(request);
    job.quoteUsd = q.price; job.keyId = q.keyId; job.status = 'quoted';
    await save();
    console.log(`QUOTED ${name} usd=${q.price.toFixed(6)}`);
  }

  async function paid(name: string, request: EpisodeRequest, fileName: string) {
    const job = state.jobs[name] ??= {};
    const target = path.join(root, fileName);
    if (job.file && await exists(target)) return fs.readFile(target);
    if (job.attempted && !job.id) throw new Error('PRIOR_SUBMIT_NO_REPLAY');
    if (!job.quoteUsd || job.quoteUsd <= 0) throw new Error(`JOB_NOT_QUOTED_${name}`);
    if (!job.id) {
      const skipped: number[] = [];
      while (!job.id) {
        const q = await api.quote(request, skipped);
        if (q.price > job.quoteUsd + 0.000001) throw new Error('PRICE_EXCEEDS_APPROVED_QUOTE');
        if (state.reservedUsd + q.price > state.budgetUsd + 0.000001) throw new Error('MEDIA_BUDGET_EXCEEDED');
        job.attempted = true; job.status = 'submitting'; job.keyId = q.keyId; job.priceUsd = q.price;
        state.reservedUsd += q.price;
        await save();
        try {
          job.id = await api.submit(request, q.keyId);
          job.status = 'accepted'; await save();
        } catch (error) {
          if (!(error instanceof DeapiRateLimitError) || error.phase !== 'SUBMIT') throw error;
          // Explicit 429 only: provider rejected before acceptance, so release the reservation.
          state.reservedUsd = Math.max(0, state.reservedUsd - q.price);
          job.attempted = false; job.keyId = undefined; job.priceUsd = undefined; job.status = 'quoted';
          await save();
          skipped.push(q.keyId);
          if (skipped.length >= 100) throw new Error('DEAPI_POOL_NO_USABLE_KEY');
        }
      }
    }
    const bytes = await api.result(job.id!, job.keyId!);
    await fs.writeFile(target + '.partial', bytes);
    await fs.rename(target + '.partial', target);
    job.file = fileName; job.status = 'downloaded'; await save();
    console.log(`DOWNLOADED ${name} bytes=${bytes.length}`);
    return bytes;
  }

  async function references() {
    return Promise.all([
      ...state.bible!.cast.map((c: any) => fs.readFile(imageFile(`char_${c.id}`))),
      ...state.bible!.locations.map((l: any) => fs.readFile(imageFile(`loc_${l.id}`))),
    ]);
  }

  try {
    if (state.model !== model || state.directorModel !== MICRODRAMA_LLM_DEFAULT || state.budgetUsd !== budgetUsd) {
      throw new Error('PROJECT_SETTINGS_MISMATCH');
    }
    if (action === 'plan') {
      if (state.planComplete) { console.log('PLAN_ALREADY_COMPLETE'); return; }
      const key = microdramaLlmKey();
      if (!key) throw new Error('LLM_KEY_MISSING');
      const director = new EpisodeDirector(key, fetch, false, 'zh');
      state.sceneAttempts ??= {};
      const work = newEpisode(1);
      if (!state.bible) {
        if (state.planAttempted) throw new Error('PRIOR_BIBLE_REQUEST_NOT_REPLAYED');
        state.planAttempted = true; state.planStage = 'bible'; await save();
        state.bible = await director.bible(idea, 1, state.directorModel);
        await save();
        console.log(`BIBLE_READY ${state.bible.title}`);
      }
      work.bible = state.bible;
      state.shots ??= [];
      for (let scene = 0; scene < 2; scene++) {
        if (state.shots.filter((s: any) => s.scene === scene).length === 3) continue;
        if (state.sceneAttempts[String(scene)]) throw new Error('PRIOR_SCENE_REQUEST_NOT_REPLAYED');
        state.sceneAttempts[String(scene)] = true; state.planStage = `scene_${scene + 1}`; await save();
        work.shots = state.shots.map((shot: any) => ({ shot, takes: [] }));
        const next = await director.scene(work, scene, state.directorModel);
        if (next.some(s => s.dialogue.some(d => !/\p{Script=Han}/u.test(d.text)))) {
          throw new Error('MANDARIN_DIALOGUE_REQUIRED');
        }
        state.shots.push(...next); await save();
        console.log(`SCENE_READY ${scene + 1}/2`);
      }
      if (state.shots.length !== 6 || state.bible.cast.length !== 2) throw new Error('ONE_MINUTE_PLAN_INVALID');
      state.planComplete = true; state.planStage = 'validated'; state.completedAt = new Date().toISOString();
      await save();
      console.log(JSON.stringify({ status: 'plan_ready', title: state.bible.title,
        cast: state.bible.cast.map((c: any) => c.name), shots: state.shots.length, language: 'zh-CN' }));
      return;
    }
    if (action === 'retry-missing-scene') {
      if (state.planComplete || !state.bible || state.shots?.length !== 3
        || state.shots.some((s: any) => s.scene !== 0)) throw new Error('PARTIAL_PLAN_NOT_RETRYABLE');
      if (state.sceneRetryAttempted) throw new Error('SCENE_RETRY_ALREADY_USED');
      const key = microdramaLlmKey();
      if (!key) throw new Error('LLM_KEY_MISSING');
      state.sceneRetryAttempted = true; state.sceneRetryStatus = 'requesting';
      state.planStage = 'scene_2_retry'; delete state.lastError; await save();
      const director = new EpisodeDirector(key, captureAssistant('scene2-retry'), false, 'zh');
      const work = newEpisode(1);
      work.bible = state.bible;
      work.shots = state.shots.map((shot: any) => ({ shot, takes: [] }));
      const next = await director.scene(work, 1, state.directorModel);
      if (next.some(s => s.dialogue.some(d => !/\p{Script=Han}/u.test(d.text)))) {
        throw new Error('MANDARIN_DIALOGUE_REQUIRED');
      }
      state.shots.push(...next); state.planComplete = true;
      state.planStage = 'validated'; state.sceneRetryStatus = 'completed';
      state.completedAt = new Date().toISOString(); await save();
      console.log(JSON.stringify({ status: 'plan_ready', title: state.bible.title,
        shots: state.shots.length, addedShots: next.length, language: 'zh-CN' }));
      return;
    }
    if (action === 'retry403-reference') {
      if (!state.planComplete || !state.bible || !state.quotedTotalUsd
        || state.quotedTotalUsd > state.budgetUsd + 0.000001) throw new Error('APPROVED_PLAN_AND_QUOTE_REQUIRED');
      const failed = Object.entries(state.jobs).filter(([name, job]) =>
        name.startsWith('char_') && job.attempted && !job.id && !job.file && job.keyId
        && job.quoteUsd && job.status === 'submitting');
      if (failed.length !== 1) throw new Error('EXACTLY_ONE_REJECTED_REFERENCE_REQUIRED');
      const [name, original] = failed[0];
      const existing = state.jobs[`${name}_alternate`];
      const fileName = `${name}.jpg`, target = imageFile(name);
      if (state.alternateRefAttemptUsed) {
        if (!existing?.id || existing.file || existing.status !== 'accepted') {
          throw new Error('ALTERNATE_REFERENCE_ATTEMPT_ALREADY_USED');
        }
        const bytes = await api.result(existing.id, existing.keyId!);
        await fs.writeFile(target + '.partial', bytes);
        await fs.rename(target + '.partial', target);
        await sharp(bytes).jpeg({ quality: 94 }).toFile(target + '.normalized.jpg');
        await fs.rename(target + '.normalized.jpg', target);
        existing.file = fileName; existing.status = 'downloaded';
        original.file = fileName; original.status = 'downloaded_after_alternate';
        delete state.lastError; await save();
        console.log(`ALTERNATE_REFERENCE_DOWNLOADED ${name}`);
        return;
      }
      if (state.lastError !== 'EPISODE_SUBMIT_403') throw new Error('REJECTED_REFERENCE_403_REQUIRED');
      if (existing) throw new Error('ALTERNATE_REFERENCE_STATE_INVALID');
      const cast = state.bible.cast.find((person: any) => `char_${person.id}` === name);
      if (!cast) throw new Error('FAILED_REFERENCE_CAST_NOT_FOUND');
      const request = imageRequest(
        `Photorealistic casting reference for a contemporary Chinese short drama. One adult Chinese actor, age ${cast.age}. Character ${cast.name}: ${cast.look}. ${state.bible.style}. Head-to-hips portrait, exact wardrobe clearly visible, natural face, plain neutral background, no text and no extra people.`,
        8101 + state.bible.cast.indexOf(cast));
      const quote = await api.quote(request, [original.keyId!]);
      if (quote.keyId === original.keyId) throw new Error('ALTERNATE_KEY_NOT_DIFFERENT');
      if (quote.price > original.quoteUsd! + 0.000001) throw new Error('ALTERNATE_PRICE_EXCEEDS_APPROVED_QUOTE');
      if (state.quotedTotalUsd + quote.price > state.budgetUsd + 0.000001
        || state.reservedUsd + quote.price > state.budgetUsd + 0.000001) {
        throw new Error('MEDIA_BUDGET_EXCEEDED');
      }
      state.alternateRefAttemptUsed = true;
      state.quotedTotalUsd += quote.price;
      state.jobs[`${name}_alternate`] = {
        alternateFor: name, quoteUsd: quote.price, keyId: quote.keyId,
        attempted: true, status: 'submitting', priceUsd: quote.price,
      };
      state.reservedUsd += quote.price;
      await save();
      const alternate = state.jobs[`${name}_alternate`];
      try {
        alternate.id = await api.submit(request, quote.keyId);
        alternate.status = 'accepted'; await save();
      } catch (error) {
        const code = error instanceof Error && /^[A-Z0-9_:-]{1,100}$/.test(error.message)
          ? error.message : 'ALTERNATE_SUBMIT_UNCERTAIN';
        if (error instanceof DeapiRateLimitError && error.phase === 'SUBMIT') {
          state.reservedUsd = Math.max(0, state.reservedUsd - quote.price);
          alternate.status = 'rejected_429'; alternate.error = code;
        } else {
          alternate.status = error instanceof Error && error.message === 'EPISODE_SUBMIT_403'
            ? 'rejected' : 'uncertain';
          alternate.error = code;
        }
        state.lastError = code; await save();
        throw error;
      }
      const bytes = await api.result(alternate.id!, alternate.keyId!);
      await fs.writeFile(target + '.partial', bytes);
      await fs.rename(target + '.partial', target);
      await sharp(bytes).jpeg({ quality: 94 }).toFile(target + '.normalized.jpg');
      await fs.rename(target + '.normalized.jpg', target);
      alternate.file = fileName; alternate.status = 'downloaded';
      original.file = fileName; original.status = 'downloaded_after_alternate';
      delete state.lastError; await save();
      console.log(`ALTERNATE_REFERENCE_DOWNLOADED ${name}`);
      return;
    }
    episode();
    if (action === 'quote-refs') {
      for (const cast of state.bible!.cast) {
        await quoteJob(`char_${cast.id}`, imageRequest(
          `Photorealistic casting reference for a contemporary Chinese short drama. One adult Chinese actor, age ${cast.age}. Character ${cast.name}: ${cast.look}. ${state.bible!.style}. Head-to-hips portrait, exact wardrobe clearly visible, natural face, plain neutral background, no text and no extra people.`,
          8101 + state.bible!.cast.indexOf(cast)));
      }
      for (const location of state.bible!.locations) {
        await quoteJob(`loc_${location.id}`, imageRequest(
          `Photorealistic empty film set for a Chinese drama in Shanghai. ${location.description}. ${state.bible!.style}. Vertical 9:16, no people, no writing, no collage.`,
          8200));
      }
      // Obtain the entire episode estimate before creating even the first paid reference.
      // Placeholder references have the same selected dimensions and operation type as the final frames.
      const placeholder = await sharp({ create: { width: 768, height: 1344, channels: 3, background: '#777777' } }).jpeg().toBuffer();
      const placeholderRefs = [placeholder, placeholder, placeholder];
      for (const shot of state.shots!) {
        if (!shot.continuation) {
          await quoteJob(`frame_${shot.number}`,
            imageRequest(promptFor(shot, false), 8200 + shot.number, placeholderRefs));
        }
        await quoteJob(`video_${shot.number}`,
          { kind: 'video', prompt: promptFor(shot, true), images: [placeholder], seed: 8300 + shot.number });
        await quoteJob(`transcript_${shot.number}`, dialogueRequest());
      }
      const estimate = Object.values(state.jobs).reduce((sum, job) => sum + Number(job.quoteUsd || 0), 0);
      state.quotedTotalUsd = estimate; await save();
      console.log(`FULL_EPISODE_QUOTE usd=${estimate.toFixed(6)} cap_usd=${state.budgetUsd}`);
      if (estimate > state.budgetUsd + 0.000001) throw new Error('MEDIA_BUDGET_EXCEEDED');
      return;
    }
    if (action === 'refs') {
      if (!state.quotedTotalUsd || state.quotedTotalUsd > state.budgetUsd + 0.000001) {
        throw new Error('FULL_EPISODE_QUOTE_REQUIRED');
      }
      if (state.bible!.cast.some((c: any) => !state.jobs[`char_${c.id}`]?.quoteUsd)
        || state.bible!.locations.some((l: any) => !state.jobs[`loc_${l.id}`]?.quoteUsd)) {
        throw new Error('REFERENCE_QUOTES_REQUIRED');
      }
      for (const cast of state.bible!.cast) {
        const bytes = await paid(`char_${cast.id}`, imageRequest(
          `Photorealistic casting reference for a contemporary Chinese short drama. One adult Chinese actor, age ${cast.age}. Character ${cast.name}: ${cast.look}. ${state.bible!.style}. Head-to-hips portrait, exact wardrobe clearly visible, natural face, plain neutral background, no text and no extra people.`,
          8101 + state.bible!.cast.indexOf(cast)), `char_${cast.id}.jpg`);
        await sharp(bytes).jpeg({ quality: 94 }).toFile(imageFile(`char_${cast.id}`) + '.normalized.jpg');
        await fs.rename(imageFile(`char_${cast.id}`) + '.normalized.jpg', imageFile(`char_${cast.id}`));
      }
      for (const location of state.bible!.locations) {
        const bytes = await paid(`loc_${location.id}`, imageRequest(
          `Photorealistic empty film set for a Chinese drama in Shanghai. ${location.description}. ${state.bible!.style}. Vertical 9:16, no people, no writing, no collage.`,
          8200), `loc_${location.id}.jpg`);
        await sharp(bytes).jpeg({ quality: 94 }).toFile(imageFile(`loc_${location.id}`) + '.normalized.jpg');
        await fs.rename(imageFile(`loc_${location.id}`) + '.normalized.jpg', imageFile(`loc_${location.id}`));
      }
      console.log('REFERENCES_READY');
      return;
    }
    if (action === 'quote') {
      const refs = await references();
      const placeholder = await sharp({ create: { width: 768, height: 1344, channels: 3, background: '#777777' } }).jpeg().toBuffer();
      for (const shot of state.shots!) {
        if (!shot.continuation) {
          await quoteJob(`frame_${shot.number}`, imageRequest(promptFor(shot, false), 8200 + shot.number, await refsFor(shot)));
        }
        await quoteJob(`video_${shot.number}`, { kind: 'video', prompt: promptFor(shot, true), images: [placeholder], seed: 8300 + shot.number });
        await quoteJob(`transcript_${shot.number}`, dialogueRequest());
      }
      const pending = Object.entries(state.jobs)
        .filter(([name, j]) => !name.startsWith('char_') && !name.startsWith('loc_') && !j.file)
        .reduce((sum, [, j]) => sum + Number(j.quoteUsd || 0), 0);
      const total = state.reservedUsd + pending;
      state.quotedTotalUsd = total; await save();
      console.log(`MEDIA_TOTAL_QUOTE usd=${total.toFixed(6)} cap_usd=${state.budgetUsd}`);
      if (total > state.budgetUsd + 0.000001) throw new Error('MEDIA_BUDGET_EXCEEDED');
      return;
    }
    if (action === 'render') {
      if (!state.quotedTotalUsd || state.quotedTotalUsd > state.budgetUsd + 0.000001) throw new Error('APPROVED_MEDIA_QUOTE_REQUIRED');
      state.finishAuthorized = true; await save();
      for (const shot of state.shots!) {
        const file = path.join(root, `shot-${shot.number}.mp4`);
        if (state.jobs[`video_${shot.number}`]?.file && await exists(file)) continue;
        let frame: Buffer;
        if (shot.continuation) {
          const previous = path.join(root, `shot-${shot.number - 1}.mp4`);
          if (!await exists(previous)) throw new Error('PREVIOUS_SHOT_REQUIRED');
          const { stdout } = await exec('ffmpeg', ['-v', 'error', '-threads', '2', '-sseof', '-1', '-i', previous,
            '-an', '-fps_mode', 'passthrough', '-update', '1', '-threads', '2', '-y',
            path.join(root, `frame-${shot.number}.jpg`)], { timeout: 90_000 });
          void stdout;
          frame = await fs.readFile(path.join(root, `frame-${shot.number}.jpg`));
        } else {
          frame = await paid(`frame_${shot.number}`,
            imageRequest(promptFor(shot, false), 8200 + shot.number, await refsFor(shot)),
            `frame-${shot.number}.jpg`);
        }
        await paid(`video_${shot.number}`, {
          kind: 'video', prompt: promptFor(shot, true), images: [frame], seed: 8300 + shot.number,
        }, `shot-${shot.number}.mp4`);
        const videoProbe = await probe(file);
        if (!videoProbe.streams?.some((s: any) => s.codec_type === 'audio')) {
          state.jobs[`video_${shot.number}`].status = 'downloaded_without_audio'; await save();
          throw new Error(`LTX_AUDIO_MISSING_SHOT_${shot.number}`);
        }
        const audio = await exec('ffmpeg', ['-v', 'error', '-threads', '2', '-i', file, '-t', '10',
          '-vn', '-ar', '16000', '-ac', '1', '-f', 'wav', 'pipe:1'],
        { encoding: 'buffer', timeout: 60_000, maxBuffer: 2 * 1024 * 1024 });
        const transcript = await paid(`transcript_${shot.number}`,
          dialogueRequest(audio.stdout as Buffer), `transcript-${shot.number}.json`);
        const segments = parseTranscript(transcript);
        const expected = shot.dialogue.map((d: any) => d.text).join('');
        const actual = segments.map(s => s.text).join('');
        const errorRate = charError(expected, actual);
        await atomic(path.join(root, `dialogue-check-${shot.number}.json`), {
          expected: shot.dialogue, recognized: segments, normalizedCharacterErrorRate: errorRate,
          note: 'Transcription checks Mandarin content, not speaker assignment or lip synchronization.',
        });
        console.log(`SHOT_READY ${shot.number}/6 mandarin_char_error=${errorRate.toFixed(3)}`);
      }
      state.renderComplete = true; await save();
      return;
    }
    if (action === 'finish') {
      if (!state.renderComplete) throw new Error('ALL_SIX_SHOTS_REQUIRED');
      const work = path.join(root, 'assembly');
      await fs.mkdir(work, { recursive: true });
      for (let n = 1; n <= 6; n++) {
        const source = path.join(root, `shot-${n}.mp4`), p = await probe(source);
        const v = p.streams.find((s: any) => s.codec_type === 'video');
        if (!v || !p.streams.some((s: any) => s.codec_type === 'audio')) throw new Error(`SHOT_MEDIA_INVALID_${n}`);
        const duration = Number(p.format.duration);
        if (duration < 9 || duration > 12) throw new Error(`SHOT_DURATION_INVALID_${n}`);
        const speed = Math.max(1, duration / 10);
        await exec('ffmpeg', ['-y', '-v', 'error', '-threads', '2', '-filter_threads', '2', '-i', source,
          '-vf', `setpts=(PTS-STARTPTS)/${speed},scale=768:1344:force_original_aspect_ratio=increase,crop=768:1344,setsar=1,fps=24,tpad=stop_mode=clone:stop_duration=1,trim=duration=10`,
          '-af', `aresample=48000,atempo=${speed},apad,atrim=duration=10`,
          '-t', '10', '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'libx264', '-preset', 'fast', '-crf', '20',
          '-pix_fmt', 'yuv420p', '-threads', '2', '-c:a', 'aac', '-b:a', '128k',
          path.join(work, `edit-${n}.mp4`)], { timeout: 300_000 });
      }
      const concat = path.join(work, 'concat.txt');
      await fs.writeFile(concat, Array.from({ length: 6 }, (_, i) => `file 'edit-${i + 1}.mp4'`).join('\n'));
      const partial = path.join(root, 'episode-mandarin-ltx25.partial.mp4');
      const final = path.join(root, 'episode-mandarin-ltx25.mp4');
      await exec('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', concat,
        '-map', '0:v:0', '-map', '0:a:0', '-c:v', 'copy', '-c:a', 'copy',
        '-metadata', `title=${state.bible!.title}`, '-movflags', '+faststart', partial], { timeout: 300_000 });
      const p = await probe(partial), v = p.streams.find((s: any) => s.codec_type === 'video');
      if (Math.abs(Number(p.format.duration) - 60) > 0.2 || v?.width !== 768 || v?.height !== 1344
        || !p.streams.some((s: any) => s.codec_type === 'audio')
        || p.streams.some((s: any) => s.codec_type === 'subtitle')) throw new Error('FINAL_VERIFICATION_FAILED');
      await exec('ffmpeg', ['-v', 'error', '-threads', '2', '-i', partial, '-map', '0:v:0', '-map', '0:a:0',
        '-f', 'null', '-'], { timeout: 300_000 });
      const sampleTimes = [0.5, 5, 9.5];
      const tiles = await Promise.all(sampleTimes.flatMap(seconds =>
        Array.from({ length: 6 }, (_, i) => frame(path.join(root, `shot-${i + 1}.mp4`), seconds)
          .then(bytes => sharp(bytes).resize(256, 448, { fit: 'cover' }).jpeg({ quality: 82 }).toBuffer()))));
      await sharp({ create: { width: 1536, height: 1344, channels: 3, background: '#111111' } })
        .composite(tiles.map((input, i) => ({ input, left: (i % 6) * 256, top: Math.floor(i / 6) * 448 })))
        .jpeg({ quality: 88 }).toFile(path.join(root, 'contact-sheet.jpg'));
      await fs.rename(partial, final);
      state.completed = true; state.finalFile = path.basename(final); await save();
      await atomic(path.join(root, 'episode-report.json'), {
        title: state.bible!.title, directorModel: state.directorModel, videoModel: model,
        durationSeconds: Number(p.format.duration), width: v.width, height: v.height,
        audio: true, subtitleTrack: false, srtCreated: false, reservedUsd: state.reservedUsd,
        capUsd: state.budgetUsd, dialogueChecks: Array.from({ length: 6 }, (_, i) => i + 1)
          .map(n => ({ shot: n, ...JSON.parse(require('node:fs').readFileSync(path.join(root, `dialogue-check-${n}.json`), 'utf8')) })),
        note: 'ASR checks dialogue text only; face, voice identity, speaker assignment, and lip sync are not guaranteed.',
      });
      console.log(`EPISODE_READY ${final} duration=${p.format.duration} reserved_usd=${state.reservedUsd.toFixed(6)}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : 'MEDIA_FAILED';
    state.lastError = /^[A-Z0-9_:-]{1,100}$/.test(message) ? message : 'NETWORK_OR_PROCESS_FAILURE';
    await save();
    throw error;
  } finally {
    await db.end();
    await lock.close();
    await fs.unlink(lockPath);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'MICRODRAMA_FAILED');
  process.exitCode = 1;
});
