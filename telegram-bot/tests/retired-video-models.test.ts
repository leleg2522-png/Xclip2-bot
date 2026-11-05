import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { CHINA_VIDEO_MODELS } from '../src/chinaapi-video';
import { BUDGET_VIDEO_MODELS } from '../src/budget-video-api';
import { isRetiredVideoCallback, retiredVideoModelsGuard } from '../src/retired-video-models';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
assert(source.indexOf('bot.use(retiredVideoModelsGuard(') < source.indexOf('bot.start('));
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.ES2022, true);
const priceFn = ast.statements.find(s => ts.isFunctionDeclaration(s) && s.name?.text === 'hargaText')!;
const prices = vm.createContext({
  CHINA_VIDEO_MODELS, isRetiredVideoCallback, BUDGET_VIDEO_MODELS,
  MODEL_PRICES: new Proxy({}, { get: () => 1000 }),
  formatRupiah: (n: number) => `Rp${n}`, octoberPromoText: () => '',
  octoberPromoPrice: (_status: unknown, _model: string, price: number) => price,
  KLING_V3_PRO: { label: 'Kling v3 Pro' },
  KLING_P4: { label: 'Kling P4' },
  ALRIZ_KLING_P5: { label: 'Kling P5' },
  KLING4_DURATIONS: [10, 15, 30], getPicsartI2vPrice: () => 1000,
});
vm.runInContext(ts.transpileModule(priceFn.getText(ast), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, prices);
const tariff = vm.runInContext('hargaText()', prices);
assert.doesNotMatch(tariff, /Wan v2|Wan 3\.0 \(30 detik · 480p\)|Seedance 2\.0 \(15 detik · 480p\)|HappyHorse/i);
assert.match(tariff, /Wan 3\.0 \(30 detik · 720p\)/);
assert.match(tariff, /Seedance 2 Uncensored/);
assert.match(tariff, /MiniMax H3 \(15 detik · 2K\)/);

async function exercise(session: any, callback?: string, text?: string) {
  let next = 0, reset = 0, ack = 0;
  const replies: string[] = [];
  await retiredVideoModelsGuard({ session: () => session, reset: () => { reset++; } })({
    from: { id: 1 }, callbackQuery: callback ? { data: callback } : undefined,
    message: text ? { text } : { photo: [] },
    answerCbQuery: async () => { ack++; },
    reply: async (message: string) => { replies.push(message); },
  } as any, async () => { next++; });
  return { next, reset, ack, replies };
}

async function main() {
  for (const callback of ['mode_pi2v_wan_v2', 'mode_china_wan3', 'mode_china_seedance2',
    'mode_china_happyhorse11', 'menu_video_family_happyhorse']) {
    const result = await exercise({ mode: 'idle' }, callback);
    assert.equal(result.next, 0);
    assert.equal(result.ack, 1);
    assert.match(result.replies[0], /sudah dihapus/);
  }
  for (const step of ['ratio', 'duration', 'image', 'prompt']) {
    for (const session of [
      { mode: `picsart_i2v_wait_${step}`, picsartI2vModel: 'wan_v2' },
      { mode: `china_video_wait_${step}`, chinaVideoModel: 'wan3' },
      { mode: `china_video_wait_${step}`, chinaVideoModel: 'seedance2' },
      { mode: `china_video_wait_${step}`, chinaVideoModel: 'happyhorse11' },
    ]) {
      for (const text of [undefined, 'generate video']) {
        const result = await exercise(session, undefined, text);
        assert.equal(result.next, 0, 'No removed draft reaches generation or charging');
        assert.equal(result.reset, 1);
      }
      for (const callback of ['china_ratio_916', 'pi2v_ratio_916', 'back_main']) {
        const result = await exercise(session, callback);
        assert.equal(result.reset, 1);
        assert.equal(result.next, 1, 'Continuation sees cleared session, navigation remains usable');
      }
      assert.equal((await exercise(session, undefined, '/menu')).next, 1);
    }
  }
  for (const session of [
    { mode: 'picsart_i2v_wait_prompt', picsartI2vModel: 'wan_v3' },
    { mode: 'china_video_wait_prompt', chinaVideoModel: 'minimax_h3' },
    { mode: 'flora_wan_v3_480_wait_prompt' },
    { mode: 'flora_seedance_2_480_wait_prompt' },
    { mode: 'idle', picsartI2vModel: 'wan_v2' },
  ]) {
    const result = await exercise(session, undefined, 'generate');
    assert.equal(result.next, 1);
    assert.equal(result.reset, 0);
  }
  console.log('Removed video variants: tariff, old buttons, media/prompt drafts and unaffected variants passed; no paid calls.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
