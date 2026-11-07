/** Rewrites the approved Mandarin shot prompts while preserving the story and dialogue. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateBible, validateScene } from '../src/episode-director';
import { FILM_DIRECTOR_ROLE } from '../src/film-director-role';
import { MICRODRAMA_LLM_DEFAULT, MicrodramaLlm, microdramaLlmKey } from '../src/microdrama-llm';
import { newEpisode } from '../src/episode-types';

const generatedRoot = path.resolve(__dirname, '../../generated-artifacts');
const sourceRoot = path.join(generatedRoot, 'microdrama-china-muse');
const outputRoot = path.join(generatedRoot, 'microdrama-china-muse-rerender');
const sourceFile = path.join(sourceRoot, 'claude-plan.json');
const planFile = path.join(outputRoot, 'claude-plan.json');
const stateFile = path.join(outputRoot, 'prompt-refresh-state.json');
const lockFile = path.join(outputRoot, 'prompt-refresh.lock');

async function exists(file: string) {
  try { await fs.access(file); return true; } catch { return false; }
}

async function atomic(file: string, value: unknown) {
  await fs.writeFile(file + '.partial', JSON.stringify(value, null, 2));
  await fs.rename(file + '.partial', file);
}

function parseJson(text: string) {
  try { return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch { throw new Error('REFRESHED_PROMPT_JSON_INVALID'); }
}

function sameDialogue(a: any[], b: any[]) {
  return JSON.stringify(a.map(({ speaker, text }) => ({ speaker, text })))
    === JSON.stringify(b.map(({ speaker, text }) => ({ speaker, text })));
}

async function main() {
  if (!process.argv.includes('--approved')) throw new Error('APPROVAL_REQUIRED');
  const key = microdramaLlmKey();
  if (!key) throw new Error('BOTELEX_KEY_MISSING');
  await fs.mkdir(outputRoot, { recursive: true });
  if (await exists(planFile)) throw new Error('REFRESHED_PLAN_ALREADY_EXISTS');
  const lock = await fs.open(lockFile, 'wx');
  try {
    const source = JSON.parse(await fs.readFile(sourceFile, 'utf8'));
    if (!source.completed || source.model !== MICRODRAMA_LLM_DEFAULT
      || source.sourceTitle !== source.results?.bible?.title
      || source.results?.scene1?.length !== 3 || source.results?.scene2?.length !== 3) {
      throw new Error('APPROVED_CLAUDE_PLAN_REQUIRED');
    }

    const episode = newEpisode(1);
    episode.bible = validateBible(source.results.bible, 1);
    let state: any = await exists(stateFile)
      ? JSON.parse(await fs.readFile(stateFile, 'utf8'))
      : { attempted: {}, rawResponses: {}, results: {} };
    const llm = new MicrodramaLlm(key);

    for (let sceneIndex = 0; sceneIndex < 2; sceneIndex++) {
      const sceneName = `scene${sceneIndex + 1}`;
      if (state.results[sceneName]) continue;
      const originalShots = source.results[sceneName];
      let raw = state.rawResponses[sceneName];
      if (!raw) {
        if (state.attempted[sceneName]) {
          throw new Error(`REFRESH_${sceneIndex + 1}_PRIOR_LLM_REQUEST_NOT_REPLAYED`);
        }
        state.attempted[sceneName] = true;
        await atomic(stateFile, state);
        raw = await llm.complete(MICRODRAMA_LLM_DEFAULT, [
          {
            role: 'system',
            content: `${FILM_DIRECTOR_ROLE}

CURRENT TASK: Refine the supplied approved Chinese short-drama shot prompts for MUSE. Preserve the exact story, bible, beat, cast, location, prop facts, shot order, speaker IDs, spoken dialogue text, and continuation flags. Do not invent story beats, props, characters, or lines.
Return only {"shots":[{"camera":"","action":"","startState":"","endState":"","imagePrompt":"","videoPrompt":"","negativePrompt":"","continuation":false,"dialogue":[{"speaker":"CHAR_ID","text":"Exact existing Simplified Chinese line"}]}]}.
Write all visual fields in concise, precise English; keep spoken dialogue in the exact supplied Simplified Chinese. Write production-ready, filmable shot directions with camera<=500 characters. Keep imagePrompt to one clear first-frame composition; make videoPrompt describe one achievable action and camera move with stable start/end continuity.
For each negativePrompt, write 5-12 distinct, shot-specific risk exclusions separated by semicolons. Aim for 450-850 characters and stay under 1000. Prioritize visible identity/face/wardrobe drift, anatomy and hands when visible, prop count/placement/teleportation, extra actors or text, camera/flicker/ghosting, and speaker/lip-sync risks for dialogue. Include only relevant risks, do not repeat a generic blacklist, and never negate the intended action or dialogue.
Dialogue and continuation must match the supplied shot exactly. Return valid JSON only.`,
          },
          {
            role: 'user',
            content: JSON.stringify({
              bible: episode.bible,
              beat: episode.bible!.beats[sceneIndex],
              approvedShots: originalShots,
            }),
          },
        ], 6000, 0.35);
        state.rawResponses[sceneName] = raw;
        await atomic(stateFile, state);
      }

      const parsed = parseJson(raw);
      if (!Array.isArray(parsed?.shots) || parsed.shots.length !== 3
        || parsed.shots.some((shot: any, i: number) =>
          !sameDialogue(shot?.dialogue || [], originalShots[i].dialogue)
          || shot?.continuation !== originalShots[i].continuation)) {
        throw new Error(`REFRESH_${sceneIndex + 1}_STORY_OR_CONTINUITY_CHANGED`);
      }
      const shots = validateScene(parsed, episode, sceneIndex, true, 'zh');
      for (const shot of shots) {
        const riskCount = shot.negativePrompt.split(';').filter((risk: string) => risk.trim()).length;
        if (shot.negativePrompt.length < 300 || riskCount < 5 || riskCount > 12) {
          throw new Error(`REFRESH_${sceneIndex + 1}_NEGATIVE_PROMPT_QUALITY_INVALID`);
        }
      }
      state.results[sceneName] = shots;
      await atomic(stateFile, state);
    }

    const refinedShots = [...state.results.scene1, ...state.results.scene2];
    if (refinedShots.length !== 6) throw new Error('REFRESHED_PLAN_INCOMPLETE');
    const plan = {
      completed: true,
      model: MICRODRAMA_LLM_DEFAULT,
      createdAt: new Date().toISOString(),
      sourceTitle: episode.bible!.title,
      results: {
        bible: episode.bible,
        scene1: state.results.scene1,
        scene2: state.results.scene2,
      },
    };
    await atomic(planFile, plan);
    state.completed = true;
    await atomic(stateFile, state);
    console.log(JSON.stringify({
      status: 'refined_plan_ready', title: plan.sourceTitle, shots: refinedShots.length,
      negativePromptLengths: refinedShots.map((shot: any) => shot.negativePrompt.length),
      output: path.relative(generatedRoot, planFile),
    }));
  } finally {
    await lock.close();
    await fs.unlink(lockFile);
  }
}

main().catch(error => {
  console.error(error instanceof Error && /^[A-Z0-9_:-]{1,120}$/.test(error.message)
    ? error.message : 'MANDARIN_PROMPT_REFRESH_FAILED');
  process.exitCode = 1;
});
