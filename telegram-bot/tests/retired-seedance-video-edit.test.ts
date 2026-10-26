import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { retiredSeedanceVideoEditGuard } from '../src/retired-seedance-video-edit';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const menu = source.slice(source.indexOf('function mainMenuKeyboard()'), source.indexOf('function seedanceMiniEditRatioKeyboard()'));
const prices = source.slice(source.indexOf('function hargaText('), source.indexOf('// Buat order QRIS'));
assert.doesNotMatch(menu, /Seedance.*Video Edit|mode_seedance_(mini|fast|2)_edit/);
assert.doesNotMatch(prices, /Seedance.*Video Edit|picsart_seedance_2_(mini_edit|fast_edit|video_edit)/);
assert.match(menu, /mode_oneover_seedance25/);
assert.match(menu, /mode_pi2v_seedance_2_mini/);
assert.match(menu, /mode_pi2v_seedance_2_fast/);
assert.match(menu, /mode_pi2v_seedance_2'/);
assert.ok(source.indexOf('bot.use(retiredSeedanceVideoEditGuard(') < source.indexOf('bot.start('));

async function exercise(mode: string, callback?: string, text?: string) {
  let next = 0, reset = 0, ack = 0;
  const replies: string[] = [];
  const guard = retiredSeedanceVideoEditGuard({
    mode: () => mode,
    reset: () => { reset++; },
  });
  await guard({
    from: { id: 1 },
    callbackQuery: callback ? { data: callback } : undefined,
    message: text ? { text } : { video: { file_id: 'fixture' } },
    answerCbQuery: async () => { ack++; },
    reply: async (value: string) => { replies.push(value); },
  } as any, async () => { next++; });
  return { next, reset, ack, replies };
}

async function main() {
  for (const variant of ['mini', 'fast', '2']) {
    const button = await exercise('idle', `mode_seedance_${variant}_edit`);
    assert.equal(button.next, 0);
    assert.equal(button.ack, 1);
    assert.match(button.replies[0], /sudah dihapus/);
    for (const step of ['ratio', 'video', 'image', 'prompt']) {
      const result = await exercise(`seedance_${variant}_edit_wait_${step}`, undefined, 'edit my video');
      assert.equal(result.next, 0, 'Removed drafts cannot reach generation or charging');
      assert.equal(result.reset, 1);
    }
    const navigation = await exercise(`seedance_${variant}_edit_wait_prompt`, undefined, '/menu');
    assert.equal(navigation.next, 1);
    assert.equal(navigation.reset, 1);
  }
  for (const prefix of ['seedance_edit_', 'seedance_fast_edit_', 'seedance_2_edit_']) {
    for (const action of ['ratio_916', 'ratio_169', 'skip_image', 'add_image', 'done_image']) {
      assert.equal((await exercise('idle', prefix + action)).next, 0);
    }
  }
  for (const callback of ['mode_oneover_seedance25', 'seedance25_inputs_done', 'mode_pi2v_seedance_2_mini', 'back_main']) {
    assert.equal((await exercise('idle', callback)).next, 1);
  }
  assert.equal((await exercise('oneover_wait_prompt', undefined, 'generate')).next, 1);
  console.log('Seedance Video Edit removal and stale-button/draft safety tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
