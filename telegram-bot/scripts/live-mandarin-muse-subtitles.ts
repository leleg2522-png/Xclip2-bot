/**
 * Transcribe the accepted MUSE clips in Mandarin, translate the heard speech,
 * then add accurate timed Indonesian subtitles. Never replay paid ASR submits.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Pool } from 'pg';
import { DeapiKeyPool } from '../src/deapi-key-pool';
import { DeapiEpisodeApi, type EpisodeRequest } from '../src/episode-api';
import { EpisodeMedia, parseTranscript } from '../src/episode-media';
import { MicrodramaLlm, microdramaLlmKey } from '../src/microdrama-llm';

const root = path.resolve(__dirname, '../../generated-artifacts/microdrama-china-muse');
const capUsd = 1.85;
const exec = promisify(execFile);
type Segment = { start: number; end: number; text: string };
type TranscriptJob = {
  attempted?: boolean; id?: string; keyId?: number; quoteUsd?: number;
  priceUsd?: number; status?: string; segments?: Segment[]; error?: string;
};
type SubtitleState = {
  capUsd: number; reservedUsd: number; quotesComplete?: boolean;
  jobs: Record<string, TranscriptJob>; translationAttempted?: boolean;
  blockedSubmitKeyIds?: number[];
  translated?: Array<{ id: string; text: string }>; completed?: boolean;
};

async function exists(file: string) {
  try { await fs.access(file); return true; } catch { return false; }
}
async function atomic(file: string, value: unknown) {
  await fs.writeFile(file + '.partial', JSON.stringify(value, null, 2));
  await fs.rename(file + '.partial', file);
}
function stamp(seconds: number) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}
function hanCount(text: string) {
  return [...text.normalize('NFKC').matchAll(/\p{Script=Han}/gu)].length;
}
function normalizeHan(text: string) {
  return [...text.normalize('NFKC').replace(/[^\p{Script=Han}]/gu, '')];
}
function characterError(expectedText: string, actualText: string) {
  const a = normalizeHan(expectedText), b = normalizeHan(actualText);
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
function wrapSubtitle(text: string, limit = 40) {
  const words = text.split(/\s+/).filter(Boolean), lines: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (next.length > limit && line) { lines.push(line); line = word; }
    else line = next;
  }
  if (line) lines.push(line);
  return lines.join('\n');
}
function subtitleRequest(bytes: Buffer): EpisodeRequest {
  return { kind: 'transcript', prompt: '', source: bytes, seed: 71 };
}

async function main() {
  if (!process.argv.includes('--approved')) throw new Error('APPROVAL_REQUIRED');
  const statePath = path.join(root, 'state.json');
  const planPath = path.join(root, 'claude-plan.json');
  const subtitleStatePath = path.join(root, 'subtitle-state.json');
  if (!process.env.RAILWAY_DATABASE_URL) throw new Error('PROVIDER_POOL_DATABASE_MISSING');
  const lock = await fs.open(path.join(root, 'subtitle-operation.lock'), 'wx');
  const db = new Pool({ connectionString: process.env.RAILWAY_DATABASE_URL, max: 2, connectionTimeoutMillis: 15_000 });
  try {
    const state = JSON.parse(await fs.readFile(statePath, 'utf8'));
    const plan = JSON.parse(await fs.readFile(planPath, 'utf8'));
    if (!state.completed || state.title !== plan.results.bible.title
      || state.scenes?.length !== 6 || state.scenes.some((scene: any) =>
        !scene?.downloaded || !scene.media?.audio)) {
      throw new Error('COMPLETE_MUSE_AUDIO_REQUIRED');
    }
    const plainVideo = path.join(root, state.finalMediaPath);
    if (!(await exists(plainVideo))) throw new Error('MUSE_STITCHED_VIDEO_MISSING');
    let subtitles: SubtitleState = await exists(subtitleStatePath)
      ? JSON.parse(await fs.readFile(subtitleStatePath, 'utf8'))
      : { capUsd, reservedUsd: 0, jobs: {} };
    if (subtitles.capUsd !== capUsd) throw new Error('SUBTITLE_BUDGET_MISMATCH');
    if (subtitles.completed) { console.log('SUBTITLES_ALREADY_COMPLETE'); return; }

    const sourceRequest = async (shot: number) => {
      const media = new EpisodeMedia();
      await media.check();
      const audio = await media.audio(path.join(root, `scene-${shot}.mp4`));
      return subtitleRequest(audio);
    };
    const pool = new DeapiKeyPool(db);
    const request: typeof fetch = async (url, init) => {
      if (String(url).includes('/audio/transcriptions') && init?.body instanceof FormData) {
        init.body.set('lang', 'zh');
      }
      return fetch(url, init);
    };
    const api = new DeapiEpisodeApi(pool, request, undefined, 'zh');
    const requests = new Map<number, EpisodeRequest>();

    for (let shot = 1; shot <= 6; shot++) {
      const req = await sourceRequest(shot);
      requests.set(shot, req);
      const job = subtitles.jobs[`scene_${shot}`] ??= {};
      if (job.quoteUsd !== undefined) continue;
      const quote = await api.quote(req, subtitles.blockedSubmitKeyIds ?? []);
      job.quoteUsd = quote.price; job.keyId = quote.keyId; job.status = 'quoted';
      await atomic(subtitleStatePath, subtitles);
    }
    const quoteTotal = Object.values(subtitles.jobs).reduce((sum, job) => sum + Number(job.quoteUsd || 0), 0);
    if (quoteTotal > capUsd + 0.000001) throw new Error('TRANSCRIPTION_BUDGET_EXCEEDED');
    subtitles.quotesComplete = true;
    await atomic(subtitleStatePath, subtitles);
    console.log(`TRANSCRIPTION_QUOTES_USD ${quoteTotal.toFixed(6)}`);

    for (let shot = 1; shot <= 6; shot++) {
      const job = subtitles.jobs[`scene_${shot}`];
      if (job.status === 'transcribed' && job.segments?.length) continue;
      if (job.attempted && !job.id && job.status !== 'rejected_403') {
        throw new Error(`TRANSCRIPT_${shot}_PRIOR_SUBMIT_NOT_REPLAYED`);
      }
      const req = requests.get(shot)!;
      if (!job.id) {
        const skipIds = [...(subtitles.blockedSubmitKeyIds ?? [])];
        let accepted = false;
        // A definite HTTP 403 has no request ID and is a pre-acceptance rejection.
        // Retry only this known rejection with a different pooled account.
        for (let attempt = 0; attempt < 3; attempt++) {
          const quote = await api.quote(req, skipIds);
          if (quote.price > job.quoteUsd! + 0.000001) throw new Error('TRANSCRIPTION_PRICE_CHANGED');
          if (subtitles.reservedUsd + quote.price > capUsd + 0.000001) {
            throw new Error('TRANSCRIPTION_BUDGET_EXCEEDED');
          }
          job.attempted = true; job.keyId = quote.keyId; job.priceUsd = quote.price; job.status = 'submitting';
          job.error = undefined;
          subtitles.reservedUsd += quote.price;
          await atomic(subtitleStatePath, subtitles);
          try {
            job.id = await api.submit(req, quote.keyId);
          } catch (error) {
            if (!(error instanceof Error) || error.message !== 'EPISODE_SUBMIT_403') throw error;
            subtitles.reservedUsd = Math.max(0, subtitles.reservedUsd - quote.price);
            job.attempted = false; job.status = 'rejected_403'; job.error = 'EPISODE_SUBMIT_403';
            (job as any).rejectedKeyIds ??= [];
            if (!(job as any).rejectedKeyIds.includes(quote.keyId)) (job as any).rejectedKeyIds.push(quote.keyId);
            subtitles.blockedSubmitKeyIds ??= [];
            if (!subtitles.blockedSubmitKeyIds.includes(quote.keyId)) {
              subtitles.blockedSubmitKeyIds.push(quote.keyId);
            }
            await atomic(subtitleStatePath, subtitles);
            skipIds.push(quote.keyId);
            continue;
          }
          job.status = 'accepted'; job.error = undefined;
          await atomic(subtitleStatePath, subtitles);
          accepted = true;
          break;
        }
        if (!accepted) throw new Error('DEAPI_TRANSCRIPT_NO_ELIGIBLE_KEY');
      }
      const bytes = await api.result(job.id!, job.keyId!);
      const segments = parseTranscript(bytes);
      const recognized = segments.map(segment => segment.text).join('');
      if (!segments.length || hanCount(recognized) < 3) {
        job.status = 'mandarin_unverified'; job.error = 'NO_MANDARIN_TRANSCRIPT';
        await atomic(subtitleStatePath, subtitles);
        throw new Error(`SCENE_${shot}_MANDARIN_TRANSCRIPT_UNVERIFIED`);
      }
      const expected = plan.results[`scene${shot <= 3 ? 1 : 2}`][(shot - 1) % 3]
        .dialogue.map((line: any) => line.text).join('');
      job.segments = segments;
      job.status = 'transcribed';
      job.error = undefined;
      (job as any).characterErrorRate = characterError(expected, recognized);
      await atomic(subtitleStatePath, subtitles);
      console.log(`TRANSCRIBED scene=${shot} mandarin_chars=${hanCount(recognized)} script_cer=${(job as any).characterErrorRate.toFixed(3)}`);
    }

    const allSegments: Array<{ id: string; shot: number; speaker: string; start: number; end: number; source: string }> = [];
    for (let shot = 1; shot <= 6; shot++) {
      const shotPlan = plan.results[`scene${shot <= 3 ? 1 : 2}`][(shot - 1) % 3];
      const segments = subtitles.jobs[`scene_${shot}`].segments!;
      segments.forEach((segment, index) => allSegments.push({
        id: `s${shot}_${index + 1}`, shot, speaker: shotPlan.dialogue[0].speaker,
        start: segment.start, end: segment.end, source: segment.text,
      }));
    }

    if (!subtitles.translated) {
      if (subtitles.translationAttempted) throw new Error('PRIOR_SUBTITLE_TRANSLATION_NOT_REPLAYED');
      const model = plan.model;
      const key = microdramaLlmKey();
      if (!key || model !== 'claude-fable-5.1') throw new Error('CLAUDE_SUBTITLE_TRANSLATOR_REQUIRED');
      subtitles.translationAttempted = true;
      (subtitles as any).translationModel = model;
      (subtitles as any).segmentsForTranslation = allSegments;
      await atomic(subtitleStatePath, subtitles);
      const llm = new MicrodramaLlm(key);
      const output = await llm.complete(model, [
        { role: 'system', content: `Translate the supplied Simplified Chinese speech-recognition segments into accurate, concise, natural Indonesian subtitles for a contemporary Chinese short drama. Translate only what is heard; do not add speaker labels, explanations, or new information. Preserve the source segment ID and source text exactly. Return only valid JSON: {"translations":[{"id":"s1_1","source":"原文","text":"Terjemahan Indonesia"}]}. Produce one translation for every input segment, in the same order. Subtitle text must be Indonesian Latin script, not Han characters; preserve Chinese names in readable pinyin when appropriate.` },
        { role: 'user', content: JSON.stringify({ title: plan.results.bible.title,
          synopsis: plan.results.bible.synopsis, segments: allSegments }) },
      ], 3500, 0.1);
      let parsed: any;
      try { parsed = JSON.parse(output.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
      catch { throw new Error('CLAUDE_SUBTITLE_JSON_INVALID'); }
      if (!Array.isArray(parsed?.translations) || parsed.translations.length !== allSegments.length) {
        throw new Error('CLAUDE_SUBTITLE_COUNT_INVALID');
      }
      const expectedIds = new Set(allSegments.map(segment => segment.id));
      subtitles.translated = parsed.translations.map((entry: any) => {
        const original = allSegments.find(segment => segment.id === entry?.id);
        if (!original || !expectedIds.delete(entry.id) || entry.source !== original.source
          || typeof entry.text !== 'string' || !entry.text.trim() || entry.text.length > 180
          || /[\r\n]|-->|\p{Script=Han}/u.test(entry.text)) {
          throw new Error('CLAUDE_SUBTITLE_TRANSLATION_INVALID');
        }
        return { id: entry.id, text: entry.text.trim() };
      });
      if (expectedIds.size) throw new Error('CLAUDE_SUBTITLE_COUNT_INVALID');
      await atomic(subtitleStatePath, subtitles);
    }

    const translationMap = new Map(subtitles.translated.map(entry => [entry.id, entry.text]));
    let index = 0, srt = '';
    for (const segment of allSegments) {
      const text = translationMap.get(segment.id);
      if (!text) throw new Error('SUBTITLE_TRANSLATION_MISSING');
      const start = Math.min(9.999, Math.max(0, segment.start));
      const end = Math.min(10, Math.max(start + 0.08, segment.end));
      srt += `${++index}\n${stamp((segment.shot - 1) * 10 + start)} --> ${stamp((segment.shot - 1) * 10 + end)}\n${wrapSubtitle(text)}\n\n`;
    }
    const srtFile = path.join(root, 'dialog-id.srt');
    await fs.writeFile(srtFile + '.partial', srt);
    await fs.rename(srtFile + '.partial', srtFile);

    const final = path.join(root, 'microdrama-china-muse-60s.mp4');
    const subtitleFilter = `subtitles=${srtFile}:force_style='FontName=DejaVu Sans,FontSize=28,Outline=2,Shadow=1,Alignment=2,MarginV=48'`;
    await exec('ffmpeg', [
      '-y', '-v', 'error', '-threads', '2', '-i', plainVideo, '-i', srtFile,
      '-vf', subtitleFilter, '-map', '0:v:0', '-map', '0:a:0', '-map', '1:0',
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '19', '-pix_fmt', 'yuv420p',
      '-threads', '2', '-c:a', 'copy', '-c:s', 'mov_text', '-metadata:s:s:0', 'language=ind',
      '-movflags', '+faststart', final,
    ], { timeout: 300_000 });
    const { stdout } = await exec('ffprobe', [
      '-v', 'error', '-show_streams', '-show_format', '-of', 'json', final,
    ]);
    const probe = JSON.parse(stdout);
    const video = probe.streams.find((stream: any) => stream.codec_type === 'video');
    if (Math.abs(Number(probe.format.duration) - 60) > 0.5 || video?.width !== 720 || video?.height !== 1280
      || !probe.streams.some((stream: any) => stream.codec_type === 'audio')
      || !probe.streams.some((stream: any) => stream.codec_type === 'subtitle')) {
      throw new Error('SUBTITLED_VIDEO_VERIFICATION_FAILED');
    }
    subtitles.completed = true;
    (subtitles as any).finalFile = path.basename(final);
    (subtitles as any).transcriptionQuoteUsd = quoteTotal;
    await atomic(subtitleStatePath, subtitles);
    state.subtitlesCompleted = true;
    state.subtitleFile = path.basename(srtFile);
    state.finalMediaPath = path.basename(final);
    await atomic(statePath, state);
    await atomic(path.join(root, 'episode-report.json'), {
      title: plan.results.bible.title, directorModel: plan.model, videoModel: 'muse-ai-video',
      durationSeconds: Number(probe.format.duration), width: video.width, height: video.height,
      subtitleLanguage: 'id', hardcodedSubtitles: true, softSubtitleTrack: true,
      museCreditsUsed: state.usedCredit, transcriptionReservedUsd: subtitles.reservedUsd,
      transcriptionQuoteUsd: quoteTotal, capUsd,
      transcriptChecks: Object.entries(subtitles.jobs).map(([scene, job]) => ({
        scene, characterErrorRate: (job as any).characterErrorRate,
        recognizedMandarin: job.segments?.map(segment => segment.text).join(''),
      })),
      note: 'Subtitle text is translated from Mandarin ASR segments; ASR, speaker assignment, and lip synchronization can still be imperfect.',
    });
    console.log(JSON.stringify({ status: 'subtitles_ready', file: path.basename(final),
      duration: Number(probe.format.duration), transcriptionQuoteUsd: quoteTotal,
      transcriptionReservedUsd: subtitles.reservedUsd, museCreditsUsed: state.usedCredit }));
  } finally {
    await db.end();
    await lock.close();
    await fs.unlink(path.join(root, 'subtitle-operation.lock'));
  }
}

main().catch(error => {
  console.error(error instanceof Error && /^[A-Z0-9_:-]{1,120}$/.test(error.message)
    ? error.message : 'MUSE_SUBTITLE_PROCESS_FAILED');
  process.exitCode = 1;
});
