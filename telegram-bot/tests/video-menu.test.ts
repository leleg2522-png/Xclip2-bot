import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { Markup } from 'telegraf';
import { CHINA_VIDEO_MODELS } from '../src/chinaapi-video';
import { buildVideoMenuScreen, VIDEO_FAMILIES, videoFamilyForCallback } from '../src/video-menu';
import { isRetiredVideoCallback } from '../src/retired-video-models';
import { BUDGET_VIDEO_MODELS, isBudgetVideoModel } from '../src/budget-video-api';

// Evaluate only pure menu functions, never import the running bot or connect to its DB.
const source = fs.readFileSync(path.resolve(__dirname, '../src/index.ts'), 'utf8');
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.ES2022, true);
const functionNames = ['videoModelRows', 'mainMenuKeyboard',
  'generationDraftKindForStart', 'generationDraftKindForContinuation', 'isGenerationEntryCallback'];
const functions = ast.statements.filter(s => ts.isFunctionDeclaration(s)
  && functionNames.includes(s.name?.text || '')).map(s => s.getText(ast)).join('\n');
assert.equal(functions.match(/function /g)?.length, functionNames.length);
const context = vm.createContext({
  Markup, CHINA_VIDEO_MODELS, buildVideoMenuScreen, isRetiredVideoCallback, BUDGET_VIDEO_MODELS, isBudgetVideoModel,
  MODEL_PRICES: { seedance25_p2: 6000 },
  KLING_V3_PRO: { label: 'Kling v3 Pro' },
  formatRupiah: (value: number) => `Rp${value}`,
  getPicsartI2vPrice: () => 5000,
});
vm.runInContext(ts.transpileModule(functions, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText, context);
const modelRows = JSON.parse(JSON.stringify(vm.runInContext('videoModelRows()', context)));
const main = JSON.parse(JSON.stringify(vm.runInContext('mainMenuKeyboard().reply_markup.inline_keyboard', context)));
const expected = [
  'mode_bvideo_vela', 'mode_bvideo_muse', 'mode_bvideo_deapi_ltx', 'mode_bvideo_deapi_h3',
  'menu_kling_list', 'mode_har_heygen',
  'mode_pi2v_seedance_2_mini', 'mode_pi2v_seedance_2_fast', 'mode_pi2v_seedance_2',
  'mode_oneover_seedance25', 'mode_seedance25_p2', 'mode_pi2v_grok_imagine',
  'mode_pi2v_creatify_boreal', 'mode_pi2v_ltx_pro', 'mode_pi2v_ltx_fast', 'mode_pi2v_pixverse_v6',
  'mode_pi2v_kling_v3_turbo', 'mode_pi2v_kling_v26_pro', 'mode_pi2v_kling_v3',
  'mode_pi2v_kling_v4', 'mode_pi2v_kling_v4_t2v', 'mode_pi2v_kling_v4_regular',
  'mode_pi2v_kling_v4_frames', 'mode_pi2v_kling_omni',
  'mode_china_minimax_h3',
  'mode_pi2v_wan_v3', 'mode_flora_minimax_h3_480',
  'mode_flora_wan_v3_480', 'mode_flora_seedance_2_480', 'mode_kling21', 'mode_kling21p2',
  'mode_gomni11_flora', 'mode_rw', 'mode_sora', 'mode_veofast', 'mode_veolite', 'mode_veo31',
  'mode_minimax_h3', 'mode_gomni', 'mode_gomni12',
];
assert.deepEqual(modelRows.flat().map((b: any) => b.callback_data).sort(), [...expected].sort());
assert.equal(main.flat().filter((b: any) => b.callback_data === 'menu_video').length, 1);
assert(!main.flat().some((b: any) => expected.includes(b.callback_data)), 'No flat video list in main menu');
for (const callback of ['menu_topup', 'menu_saldo', 'menu_harga', 'menu_referral',
  'mode_bytedance_upscale', 'menu_lipsync', 'menu_audio', 'mode_chat', 'mode_nb2']) {
  assert(main.flat().some((b: any) => b.callback_data === callback), `${callback} remains available`);
}
assert(!main.flat().some((b: any) => b.callback_data === 'menu_flora_image'), 'Flora images removed');

const root = buildVideoMenuScreen('menu_video', modelRows)!;
assert.equal(root.rows.flat().length, VIDEO_FAMILIES.length + 1);
assert(root.rows.every(row => row.length <= 2), 'Compact two-column family menu');
assert.equal(root.rows.at(-1)![0].callback_data, 'back_main');
const reached: string[] = [];
const counts: Record<string, number> = {};
for (const family of VIDEO_FAMILIES) {
  const callback = `menu_video_family_${family.id}`;
  assert(root.rows.flat().some(b => b.callback_data === callback));
  const screen = buildVideoMenuScreen(callback, modelRows)!;
  assert(screen.text.includes(family.label));
  const models = screen.rows.flat().filter(b => expected.includes(b.callback_data));
  counts[family.id] = models.length;
  assert(models.length > 0, 'No empty families');
  for (const model of models) {
    assert.equal(videoFamilyForCallback(model.callback_data), family.id);
    const original = modelRows.flat().find((b: any) => b.callback_data === model.callback_data);
    assert.equal(model.text, original.text.replace(/\s+[•·]\s+/g, ' · '), 'Names, prices, durations and quality preserved');
    reached.push(model.callback_data);
  }
  assert.equal(screen.rows.at(-2)![0].callback_data, 'menu_video');
  assert.equal(screen.rows.at(-1)![0].callback_data, 'back_main');
  for (const b of screen.rows.flat()) assert(Buffer.byteLength(b.callback_data) <= 64);
  // Browsing never reserves or restarts a generation draft.
  assert.equal(vm.runInContext(`generationDraftKindForStart(${JSON.stringify(callback)})`, context), undefined);
  assert.equal(vm.runInContext(`generationDraftKindForContinuation(${JSON.stringify(callback)})`, context), undefined);
  assert.equal(vm.runInContext(`isGenerationEntryCallback(${JSON.stringify(callback)})`, context), false);
}
assert.deepEqual(reached.sort(), [...expected].sort(), 'All 40 entries reachable exactly once');
assert.deepEqual(counts, { kling: 11, seedance: 6, veo: 3, wan: 2, minimax: 4,
  gemini: 3, ltx: 3, grok: 1, pixverse: 1, runway: 1, sora: 1, heygen: 1, creatify: 1, vela: 1, muse: 1 });
assert(!root.rows.flat().some(b => b.callback_data === 'menu_video_family_happyhorse'));
assert.equal(buildVideoMenuScreen('menu_video_family_happyhorse', modelRows), undefined);
assert.equal(buildVideoMenuScreen('menu_video_family_invalid', modelRows), undefined);
assert.equal(buildVideoMenuScreen('menu_video_family_toString', modelRows), undefined);
assert.equal(buildVideoMenuScreen('mode_rw', modelRows), undefined);
assert.throws(() => buildVideoMenuScreen('menu_video', [[{ text: 'Unknown', callback_data: 'unknown_model' }]]), /UNMAPPED/);
assert.throws(() => buildVideoMenuScreen('menu_video', [modelRows[0], modelRows[0]]), /DUPLICATE/);

// Exercise the exact callback branch with a fake Telegram context, without paid calls.
let navigationBranch: ts.Statement | undefined;
function visit(node: ts.Node) {
  if (ts.isIfStatement(node) && node.expression.getText(ast) === "data === 'menu_video' || data.startsWith('menu_video_family_')") {
    navigationBranch = node.thenStatement;
  }
  ts.forEachChild(node, visit);
}
visit(ast);
assert(navigationBranch, 'New navigation callback is wired into the bot');
vm.runInContext(`async function navigate(ctx, data) ${navigationBranch!.getText(ast)}`, context);
async function mainTest() {
  for (const data of ['menu_video', ...VIDEO_FAMILIES.map(f => `menu_video_family_${f.id}`), 'menu_video_family_invalid']) {
    let edits = 0; let replies = 0;
    const ctx = {
      editMessageText: async (text: string, markup: any) => {
        edits++; assert(text.length > 0); assert(markup.reply_markup.inline_keyboard.length > 0);
      },
      reply: async () => { replies++; },
    };
    context.testCtx = ctx; context.testData = data;
    await vm.runInContext('navigate(testCtx, testData)', context);
    assert.equal(edits, data.endsWith('_invalid') ? 0 : 1);
    assert.equal(replies, data.endsWith('_invalid') ? 1 : 0);
  }
  const mcStart = source.indexOf("if (data === 'menu_kling_list')");
  const mcBranch = source.slice(mcStart, source.indexOf('\n  }\n', mcStart));
  for (const back of ['menu_video_family_kling', 'menu_video', 'back_main']) assert(mcBranch.includes(`'${back}'`));
  console.log('Video menu passed: 15 families, all 40 entries including four Rp500 packages, navigation and draft guards; no paid API calls.');
}
mainTest().catch(error => { console.error(error); process.exitCode = 1; });
