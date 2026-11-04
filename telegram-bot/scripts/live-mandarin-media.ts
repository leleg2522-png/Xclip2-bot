/**
 * Controlled owner test, not a bot launcher. Uses the existing Railway DeAPI
 * credential pool and production adapters. Persist before every paid submit.
 * No user saldo writes, provider fallback after submit, or automatic retakes.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { Pool } from 'pg';
import sharp from 'sharp';
import { DeapiKeyPool } from '../src/deapi-key-pool';
import { DeapiEpisodeApi, type EpisodeRequest } from '../src/episode-api';
import { EpisodeMedia, parseTranscript } from '../src/episode-media';
import { lockedPrompt } from '../src/episode-director';
import { newEpisode } from '../src/episode-types';

const root = path.resolve(__dirname, '../../generated-artifacts/microdrama-china-mandarin-test');
type Job = { attempted?: boolean; id?: string; keyId?: number; quotedUsd?: number; file?: string; status?: string; error?: string };
type State = { capUsd: number; reservedUsd: number; jobs: Record<string, Job>; approvedShots: number[] };
async function exists(file: string) {
  try { await fs.access(file); return true; } catch { return false; }
}
async function atomic(file: string, data: unknown) {
  await fs.writeFile(file + '.partial', JSON.stringify(data, null, 2));
  await fs.rename(file + '.partial', file);
}
async function main() {
  if (!process.argv.includes('--approved')) throw new Error('APPROVAL_REQUIRED');
  const mode = process.argv[2], number = Number(process.argv[3]);
  if (!['refs', 'shot', 'transcript'].includes(mode)) throw new Error('MODE_REQUIRED');
  const plan = JSON.parse(await fs.readFile(path.join(root, 'director-state.json'), 'utf8'));
  if (plan.status !== 'script_validated' || plan.shots?.length !== 6) throw new Error('VALIDATED_DIRECTOR_SCRIPT_REQUIRED');
  if (!process.env.RAILWAY_DATABASE_URL) throw new Error('PROVIDER_POOL_DATABASE_MISSING');
  const lock = await fs.open(path.join(root, 'media-operation.lock'), 'wx');
  const db = new Pool({ connectionString: process.env.RAILWAY_DATABASE_URL, max: 2, connectionTimeoutMillis: 15_000 });
  const stateFile = path.join(root, 'media-state.json');
  const state: State = await exists(stateFile) ? JSON.parse(await fs.readFile(stateFile, 'utf8'))
    : { capUsd: 1.85, reservedUsd: 0, jobs: {}, approvedShots: [] };
  const save = () => atomic(stateFile, state);
  let active: Job | undefined;
  try {
    if (state.capUsd !== 1.85) throw new Error('UNAPPROVED_BUDGET');
    const pool = new DeapiKeyPool(db);
    // Only the test request is adapted; do not change production transcription defaults.
    const request: typeof fetch = async (url, init) => {
      if (String(url).includes('/audio/transcriptions') && init?.body instanceof FormData) {
        init.body.set('lang', 'zh');
      }
      const response = await fetch(url, init);
      if (!response.ok && String(url).includes('api.deapi.ai')) {
        console.log(JSON.stringify({ http: response.status, retryAfter: response.headers.get('retry-after'),
          dailyRemaining: response.headers.get('x-ratelimit-remaining-day'), mediaReplay: false }));
      }
      return response;
    };
    const api = new DeapiEpisodeApi(pool, request);
    const media = new EpisodeMedia();
    await media.check();
    const episode = newEpisode(1);
    episode.bible = plan.bible;
    episode.shots = plan.shots.map((shot: any) => ({ shot, takes: [] }));
    const nativePrompt = (n: number, video: boolean) => lockedPrompt(episode, plan.shots[n - 1], video)
      .replace(/Indonesian drama/g, 'Chinese family drama set in modern Shanghai, China')
      .replace(/Indonesian audio/g, 'Mandarin Chinese audio (Putonghua, not Indonesian or English)');
    async function paid(name: string, req: EpisodeRequest, file: string) {
      const job = state.jobs[name] ??= {};
      active = job;
      const target = path.join(root, file);
      if (job.file && await exists(target)) {
        console.log(`EXISTING ${name}: no new submit`);
        return fs.readFile(target);
      }
      if (job.attempted && !job.id) throw new Error('PRIOR_SUBMIT_NOT_REPLAYED');
      if (!job.id) {
        const quote = await api.quote(req);
        if (state.reservedUsd + quote.price > state.capUsd + 0.000001) throw new Error('MEDIA_BUDGET_EXCEEDED');
        job.attempted = true;
        job.status = 'submitting';
        job.keyId = quote.keyId;
        job.quotedUsd = quote.price;
        state.reservedUsd += quote.price;
        await save();
        console.log(`SUBMIT ${name} quoted_usd=${quote.price} reserved_usd=${state.reservedUsd.toFixed(6)}/${state.capUsd}`);
        job.id = await api.submit(req, quote.keyId);
        job.status = 'accepted';
        await save();
        console.log(`ACCEPTED ${name} ${job.id}`);
      }
      const bytes = await api.result(job.id, job.keyId!);
      await fs.writeFile(target + '.partial', bytes);
      await fs.rename(target + '.partial', target);
      job.file = file;
      job.status = 'downloaded';
      await save();
      console.log(`SAVED ${name} ${file} bytes=${bytes.length}`);
      return bytes;
    }
    const refs = async () => Promise.all([
      ...plan.bible.cast.map((c: any) => `char_${c.id}.jpg`),
      ...plan.bible.locations.map((l: any) => `loc_${l.id}.jpg`),
    ].map(file => fs.readFile(path.join(root, file))));
    if (mode === 'refs') {
      for (const cast of plan.bible.cast) {
        const file = `char_${cast.id}.jpg`;
        const bytes = await paid(`char_${cast.id}`, {
          kind: 'image', seed: cast === plan.bible.cast[0] ? 8101 : 8102,
          prompt: `Photorealistic contemporary Chinese family drama. ONE adult Chinese woman, age ${cast.age}.
Character: ${cast.name}. ${cast.look}. ${plan.bible.style}.
Clean single-person character reference portrait, natural front three-quarter view, head through hips visible,
neutral expression, realistic skin and anatomy, uncluttered neutral background, clear exact wardrobe.
No other people, no collage, no logos or writing.`,
        }, file);
        await sharp(bytes).jpeg({ quality: 95 }).toFile(path.join(root, file + '.converted'));
        await fs.rename(path.join(root, file + '.converted'), path.join(root, file));
      }
      for (const location of plan.bible.locations) {
        const file = `loc_${location.id}.jpg`;
        const bytes = await paid(`loc_${location.id}`, {
          kind: 'image', seed: 8103,
          prompt: `Photorealistic empty interior location for a Chinese family drama in Shanghai, China.
${location.description}. ${plan.bible.style}.
One coherent vertical establishing view, consistent furniture layout and lighting.
No people, no collage, no writing, no logos.`,
        }, file);
        await sharp(bytes).jpeg({ quality: 95 }).toFile(path.join(root, file + '.converted'));
        await fs.rename(path.join(root, file + '.converted'), path.join(root, file));
      }
      const images = await refs();
      const tiles = await Promise.all(images.map(b => sharp(b).resize(384, 672, { fit: 'cover' }).jpeg().toBuffer()));
      await sharp({ create: { width: 384 * tiles.length, height: 672, channels: 3, background: 'white' } })
        .composite(tiles.map((input, i) => ({ input, left: i * 384, top: 0 }))).jpeg({ quality: 90 })
        .toFile(path.join(root, 'reference-sheet.jpg'));
      console.log(`REFERENCES_READY reserved_usd=${state.reservedUsd.toFixed(6)}`);
    } else {
      if (!Number.isInteger(number) || number < 1 || number > 6) throw new Error('SHOT_NUMBER');
      if (number > 1 && !state.approvedShots.includes(number - 1)) throw new Error('PREVIOUS_CLIP_APPROVAL_REQUIRED');
      const file = path.join(root, `shot-${number}.mp4`);
      if (mode === 'transcript') {
        await media.probe(file);
        const bytes = await paid(`transcript_${number}`, {
          kind: 'transcript', prompt: '', source: await media.audio(file), seed: 71,
        }, `transcript-${number}.json`);
        const segments = parseTranscript(bytes);
        const expectedText = plan.shots[number - 1].dialogue.map((d: any) => d.text).join('');
        const normalize = (s: string) => s.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
        const expected = [...normalize(expectedText)];
        const recognized = [...normalize(segments.map(s => s.text).join(''))];
        let distance = Array.from({ length: recognized.length + 1 }, (_, i) => i);
        for (let i = 0; i < expected.length; i++) {
          const next = [i + 1];
          for (let j = 0; j < recognized.length; j++) {
            next.push(Math.min(next[j] + 1, distance[j + 1] + 1, distance[j] + (expected[i] === recognized[j] ? 0 : 1)));
          }
          distance = next;
        }
        await atomic(path.join(root, `dialogue-check-${number}.json`), {
          expected: plan.shots[number - 1].dialogue, recognized: segments,
          containsHanCharacters: segments.some(s => /\p{Script=Han}/u.test(s.text)),
          normalizedCharacterErrorRate: distance.at(-1)! / Math.max(1, expected.length),
          note: 'Transcription does not prove exact speaker assignment, voice identity or lip synchronization.',
        });
        console.log(JSON.stringify({ shot: number, recognized: segments, reservedUsd: state.reservedUsd }));
      } else {
        let frame: Buffer;
        if (plan.shots[number - 1].continuation) {
          frame = await media.frame(path.join(root, `shot-${number - 1}.mp4`), 9.8);
          await fs.writeFile(path.join(root, `frame-${number}.jpg`), frame);
        } else {
          const bytes = await paid(`frame_${number}`, {
            kind: 'image', prompt: nativePrompt(number, false), images: await refs(), seed: 8200 + number,
          }, `frame-${number}.jpg`);
          frame = await sharp(bytes).jpeg({ quality: 95 }).toBuffer();
          await fs.writeFile(path.join(root, `frame-${number}.jpg`), frame);
        }
        await paid(`video_${number}`, {
          kind: 'video', prompt: nativePrompt(number, true), images: [frame], seed: 8300 + number,
        }, `shot-${number}.mp4`);
        await media.probe(file);
        const tiles = await Promise.all([0.5, 4.5, 8.5].map(async seconds =>
          sharp(await media.frame(file, seconds)).resize(384, 672).jpeg().toBuffer()));
        await sharp({ create: { width: 1152, height: 672, channels: 3, background: 'white' } })
          .composite(tiles.map((input, i) => ({ input, left: i * 384, top: 0 }))).jpeg()
          .toFile(path.join(root, `shot-${number}-samples.jpg`));
        console.log(`CLIP_REVIEW_REQUIRED shot=${number}: do not generate the next clip before user approval.`);
      }
    }
  } catch (error) {
    if (active) {
      active.error = error instanceof Error ? error.message : 'MEDIA_FAILED';
      active.status = active.id ? 'paused_with_job_id' : 'stopped_before_job_id';
      await save();
    }
    throw error;
  } finally {
    await db.end();
    await lock.close();
    await fs.unlink(path.join(root, 'media-operation.lock'));
  }
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : 'MEDIA_TEST_FAILED');
  process.exitCode = 1;
});
