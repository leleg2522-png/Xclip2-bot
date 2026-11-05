import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { retiredFloraImagesGuard } from '../src/retired-flora-images';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
assert(source.indexOf('bot.use(retiredFloraImagesGuard(') < source.indexOf('bot.start('));
const menu = source.slice(source.indexOf('function mainMenuKeyboard()'), source.indexOf('const SD_RATIO_MAP'));
assert.doesNotMatch(menu, /menu_flora_image|floraimg_/);
for (const callback of ['mode_seedream', 'mode_gptimg', 'mode_gpt25_sunburst', 'mode_gpt25_flare',
  'mode_nbpro', 'mode_nb2', 'menu_banana21', 'mode_nb2lite', 'menu_audio', 'menu_lipsync']) {
  assert(menu.includes(`'${callback}'`), `${callback} preserved`);
}
const prices = source.slice(source.indexOf('function hargaText('), source.indexOf('// Buat order QRIS'));
assert.doesNotMatch(prices, /AI Image Generation \(semua model\)/);

async function exercise(mode: string, callback?: string, text?: string) {
  let next = 0, reset = 0, ack = 0;
  const replies: string[] = [];
  await retiredFloraImagesGuard({ mode: () => mode, reset: () => { reset++; } })({
    from: { id: 1 }, callbackQuery: callback ? { data: callback } : undefined,
    message: text ? { text } : { photo: [] },
    answerCbQuery: async () => { ack++; },
    reply: async (message: string) => { replies.push(message); },
  } as any, async () => { next++; });
  return { next, reset, ack, replies };
}

async function main() {
  for (const callback of ['menu_flora_image', 'floraimg_page_0', 'floraimg_page_4',
    'floraimg_select_0_0', 'floraimg_select_4_7']) {
    for (const mode of ['idle', 'floraimg_wait_prompt']) {
      const result = await exercise(mode, callback);
      assert.equal(result.next, 0, 'Old catalog buttons cannot reach API calls or billing');
      assert.equal(result.ack, 1);
      assert.match(result.replies[0], /sudah dihapus/);
    }
  }
  for (const text of [undefined, 'draw a cat']) {
    const result = await exercise('floraimg_wait_prompt', undefined, text);
    assert.equal(result.reset, 1);
    assert.equal(result.next, 0, 'Old prompts/media cannot start paid image generation');
  }
  for (const callback of ['back_main', 'mode_nb2', 'menu_audio']) {
    const result = await exercise('floraimg_wait_prompt', callback);
    assert.equal(result.reset, 1);
    assert.equal(result.next, 1);
  }
  assert.equal((await exercise('floraimg_wait_prompt', undefined, '/menu')).next, 1);
  for (const mode of ['idle', 'img_wait_prompt', 'flora_minimax_h3_480_wait_prompt', 'audio_wait_prompt']) {
    const result = await exercise(mode, undefined, 'generate');
    assert.equal(result.next, 1);
    assert.equal(result.reset, 0);
  }
  console.log('Flora image retirement: menu, prices, old buttons/drafts and other image/video/audio routes passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
