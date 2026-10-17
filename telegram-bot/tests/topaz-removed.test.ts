import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
assert.doesNotMatch(source, /Topaz 4K|runTopazVideo|topaz_wait_video|MODEL_PRICES\.topaz|video-upscaler-topaz/);
assert.doesNotMatch(source, /Markup\.button\.callback\([^\n]*mode_topaz/);
assert.match(source, /Markup\.button\.callback\([^\n]*mode_bytedance_upscale/);
const start = source.indexOf("  if (data === 'mode_topaz') {");
const end = source.indexOf("  if (data === 'mode_bytedance_upscale') {", start);
assert.ok(start >= 0 && end > start);
const session = { mode: 'idle' };
const messages: string[] = [];
const context = vm.createContext({
  data: 'mode_topaz', userId: 1,
  setSession: (_id: number, update: object) => Object.assign(session, update),
  ctx: {
    answerCbQuery: async () => {},
    editMessageText: async (text: string) => messages.push(text),
  },
});
async function main() {
  const script = ts.transpileModule(`(async () => { ${source.slice(start, end)} })()`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  await vm.runInContext(script, context);
  assert.equal(session.mode, 'idle');
  assert.equal(messages.length, 1);
  assert.match(messages[0], /sudah dihapus/);
  console.log('Topaz removed from public routes; old buttons safely rejected without charging; ByteDance remains available.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
