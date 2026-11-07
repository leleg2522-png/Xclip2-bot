/** Convert the already-approved Claude story into a clean MUSE-only run plan. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { validateBible, validateScene } from '../src/episode-director';
import { newEpisode } from '../src/episode-types';
import { MICRODRAMA_LLM_DEFAULT } from '../src/microdrama-llm';

const sourceRoot = path.resolve(__dirname, '../../generated-artifacts/microdrama-china-ltx-25');
const outputRoot = path.resolve(__dirname, '../../generated-artifacts/microdrama-china-muse');
const sourceFile = path.join(sourceRoot, 'state.json');
const planFile = path.join(outputRoot, 'claude-plan.json');

async function main() {
  if (!process.argv.includes('--approved')) throw new Error('APPROVAL_REQUIRED');
  const source = JSON.parse(await fs.readFile(sourceFile, 'utf8'));
  if (!source.planComplete || source.directorModel !== MICRODRAMA_LLM_DEFAULT
    || !source.bible || source.shots?.length !== 6) {
    throw new Error('VALIDATED_CLAUDE_PLAN_REQUIRED');
  }
  try {
    await fs.access(planFile);
    throw new Error('MUSE_PLAN_ALREADY_EXISTS');
  } catch (error: any) {
    if (error.code !== 'ENOENT') throw error;
  }

  const episode = newEpisode(1);
  episode.bible = validateBible(source.bible, 1);
  const shots = [0, 1].flatMap(scene => validateScene({
    shots: source.shots.filter((shot: any) => shot.scene === scene)
      .map((shot: any) => ({ ...shot, continuation: shot.number !== 1 })),
  }, episode, scene, true, 'zh'));
  if (shots.length !== 6 || shots.some((shot, i) => (
    shot.number !== i + 1
      || shot.dialogue.length !== 1
      || !/\p{Script=Han}/u.test(shot.dialogue[0].text)
      || (i > 0 && !shot.continuation)
  ))) {
    throw new Error('MUSE_CONTINUITY_PLAN_INVALID');
  }

  await fs.mkdir(outputRoot, { recursive: true });
  const plan = {
    completed: true,
    model: MICRODRAMA_LLM_DEFAULT,
    createdAt: new Date().toISOString(),
    sourceTitle: episode.bible.title,
    results: {
      bible: episode.bible,
      scene1: shots.slice(0, 3),
      scene2: shots.slice(3, 6),
    },
  };
  await fs.writeFile(planFile + '.partial', JSON.stringify(plan, null, 2));
  await fs.rename(planFile + '.partial', planFile);
  console.log(JSON.stringify({ status: 'plan_ready', title: episode.bible.title, shots: shots.length }));
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : 'MUSE_PLAN_FAILED');
  process.exitCode = 1;
});
