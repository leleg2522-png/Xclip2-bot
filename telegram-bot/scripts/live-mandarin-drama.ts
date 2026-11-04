/**
 * Approved Mandarin episode smoke test. Stage one only: one director request.
 * No media submit, user saldo writes, default-model changes or automatic retries.
 * Test-local language adaptation leaves the production bot's defaults untouched.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { EpisodeDirector } from '../src/episode-director';
import { newEpisode } from '../src/episode-types';

const root = path.resolve(__dirname, '../../generated-artifacts/microdrama-china-mandarin-test');
const model = process.env.MICRODRAMA_LLM_MODEL || 'gpt-6-luna';
const idea = `Create a one-minute contemporary Chinese family microdrama set in China.
Exactly two adult women: a biological daughter and an adopted daughter, both age 25 or older.
One location: the living room of their wealthy family's home in Shanghai.
Conflict over their place in the family, an emotional reveal, and a cliffhanger.
The user requested: seorang dracin anak kandung dan anak angkat berlatar di china dan juga pake bahasa cina.
Use natural Mandarin Chinese (simplified Chinese characters) for title, synopsis, character names and all eventual dialogue.
Visual descriptions remain in English. No Indonesian speech, no minors, no extra actors.`;

async function exists(file: string) {
  try { await fs.access(file); return true; } catch { return false; }
}
async function save(data: unknown) {
  const file = path.join(root, 'director-state.json');
  await fs.writeFile(file + '.partial', JSON.stringify(data, null, 2));
  await fs.rename(file + '.partial', file);
}
async function main() {
  if (!process.argv.includes('--approved')) throw new Error('APPROVAL_REQUIRED');
  if (!process.env.BUATSIMPEL_API_KEY) throw new Error('LLM_KEY_MISSING');
  await fs.mkdir(root, { recursive: true });
  const planning = process.argv.includes('--plan');
  const existing = await exists(path.join(root, 'director-state.json'));
  if (!planning && existing) {
    console.log('EXISTING_DIRECTOR_ATTEMPT: not sending another request.');
    return;
  }
  if (planning && !existing) throw new Error('VALIDATED_BIBLE_REQUIRED');
  const state: any = planning
    ? JSON.parse(await fs.readFile(path.join(root, 'director-state.json'), 'utf8')) : {
    stage: 'director', model, locale: 'zh-CN', durationSeconds: 60,
    idea, mediaBudgetUsd: 1.85, mediaSubmissions: 0,
    attempted: true, status: 'running', startedAt: new Date().toISOString(),
  };
  if (planning && (!state.bible || state.model !== model)) throw new Error('VALIDATED_BIBLE_REQUIRED');
  await save(state);
  let submits = 0;
  const request: typeof fetch = async (url, init) => {
    const options = { ...init };
    if (String(url).endsWith('/chat/completions')) {
      if (++submits > (planning ? 2 : 1)) throw new Error('NO_AUTOMATIC_LLM_REPLAY');
      const body = JSON.parse(String(options.body));
      if (body.model !== model) throw new Error('UNAPPROVED_MODEL');
      body.messages = body.messages.map((message: any) => ({
        ...message,
        content: typeof message.content === 'string'
          ? message.content.replace(/Indonesian/g, 'Mandarin Chinese') : message.content,
      }));
      options.body = JSON.stringify(body);
      console.log(`DIRECTOR_SUBMIT model=${model} language=Mandarin media_submissions=0`);
    }
    const response = await fetch(url, options);
    if (String(url).endsWith('/chat/completions')) {
      state.httpStatus = response.status;
      state.contentType = response.headers.get('content-type');
      const body = await response.clone().json().catch(() => null) as any;
      if (body?.usage) state.usage = Object.fromEntries(
        ['prompt_tokens', 'completion_tokens', 'total_tokens']
          .filter(k => Number.isFinite(body.usage[k]))
          .map(k => [k, body.usage[k]]),
      );
      state.usageHistory ??= [];
      state.usageHistory.push({ stage: state.activeOperation || 'bible', httpStatus: response.status, usage: state.usage });
      state.finishReason = body?.choices?.[0]?.finish_reason;
      await save(state);
      console.log(`DIRECTOR_HTTP ${response.status}`);
    }
    return response;
  };
  try {
    const director = new EpisodeDirector(process.env.BUATSIMPEL_API_KEY, request);
    if (planning) {
      const episode = newEpisode(1);
      episode.bible = state.bible;
      state.shots ??= [];
      state.sceneAttempts ??= {};
      for (let scene = 0; scene < 2; scene++) {
        episode.shots = state.shots.map((shot: any) => ({ shot, takes: [] }));
        if (state.shots.filter((shot: any) => shot.scene === scene).length === 3) continue;
        if (state.sceneAttempts[scene]) throw new Error('PRIOR_SCENE_ATTEMPT_NOT_REPLAYED');
        state.sceneAttempts[scene] = true;
        state.activeOperation = `scene_${scene + 1}`;
        state.status = 'planning';
        await save(state);
        const shots = await director.scene(episode, scene, model);
        if (shots.some(shot => shot.dialogue.some(d => !/\p{Script=Han}/u.test(d.text)))) {
          throw new Error('MANDARIN_DIALOGUE_REQUIRED');
        }
        state.shots.push(...shots);
        await save(state);
        console.log(`SCENE_VALIDATED ${scene + 1} shots=${shots.length}`);
      }
      if (state.shots.length !== 6) throw new Error('SIX_SHOTS_REQUIRED');
      state.status = 'script_validated';
      state.completedAt = new Date().toISOString();
      await save(state);
      console.log(JSON.stringify({ status: state.status, shots: state.shots.map((s: any) => ({ number: s.number, dialogue: s.dialogue })), mediaSubmissions: 0 }));
      return;
    }
    const bible = await director.bible(idea, 1, model);
    if (bible.cast.length !== 2 || bible.locations.length !== 1
      || !/\p{Script=Han}/u.test(bible.title)
      || !/\p{Script=Han}/u.test(bible.synopsis)) throw new Error('MANDARIN_STORY_REQUIREMENTS_FAILED');
    state.bible = bible;
    state.status = 'bible_validated';
    state.completedAt = new Date().toISOString();
    await save(state);
    console.log(JSON.stringify({ status: state.status, title: bible.title, cast: bible.cast.map(c => c.name), beats: bible.beats.length, usage: state.usage, mediaSubmissions: 0 }));
  } catch (error) {
    state.status = 'failed_before_media';
    state.error = error instanceof Error ? error.name === 'SyntaxError'
      ? 'DIRECTOR_INVALID_JSON' : error.message : 'DIRECTOR_FAILED';
    state.completedAt = new Date().toISOString();
    await save(state);
    console.log(JSON.stringify({ status: state.status, error: state.error, httpStatus: state.httpStatus, usage: state.usage, mediaSubmissions: 0 }));
    process.exitCode = 1;
  }
}
main().catch(() => { console.error('TEST_SETUP_FAILED'); process.exitCode = 1; });
