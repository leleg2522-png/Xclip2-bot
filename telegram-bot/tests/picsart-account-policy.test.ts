import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { PICSART_I2V_MODELS, picsartI2vAccountPolicy } from '../src/picsart';

const source = fs.readFileSync(path.resolve(__dirname, '../src/picsart.ts'), 'utf8');
const from = source.indexOf('async function runWithAccount<T>(');
const to = source.indexOf('// Admin: register', from);
assert.ok(from >= 0 && to > from);
const compiled = ts.transpileModule(source.slice(from, to), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

async function main() {
  for (const model of Object.keys(PICSART_I2V_MODELS) as Array<keyof typeof PICSART_I2V_MODELS>) {
    const policy = picsartI2vAccountPolicy(model);
    assert.deepEqual(policy, { pool: null });
  }
  for (const model of ['kling_v4', 'kling_v4_t2v'] as const) {
    for (const duration of [5, 10, 15, 20, 25, 30] as const) {
      const policy = picsartI2vAccountPolicy(model, duration);
      assert.equal(policy.pool, null);
    }
  }

  // Exercise actual account wrapper: no historic caller may restrict selection
  // to just low-credit or premium accounts.
  for (const requestedPool of [null, 'p500', 'p100']) {
      for (const exhausted of [false, true]) {
        let acquired = 0;
        let submitted = 0;
        const ctx = vm.createContext({
          MAX_ACCOUNT_ATTEMPTS: 3,
          q: async () => ({ rows: [{ n: 3 }] }),
          acquireAccount: async (_user: number, pool: unknown, _exclude: number[], strict: boolean) => {
            acquired++;
            assert.equal(pool, null);
            assert.equal(strict, false);
            return exhausted ? null : 7;
          },
          console: { error() {} },
        });
        vm.runInContext(compiled, ctx);
        const run = () => ctx.runWithAccount(1, requestedPool, async () => { submitted++; return 'ok'; });
        if (exhausted) await assert.rejects(run());
        else assert.equal(await run(), 'ok');
        assert.equal(acquired, 1);
        assert.equal(submitted, exhausted ? 0 : 1);
      }
  }
  // Neither the legacy Seedance path nor Kling 4 keeps a special restriction.
  const legacySeedance = source.slice(source.indexOf('export async function generateSeedance('), source.indexOf('type PicsartI2vModelConfig'));
  assert.doesNotMatch(legacySeedance, /preservePool|strictPool: true/);
  assert.match(source, /picsartI2vAccountPolicy\(input\.model, input\.duration\)/);
  assert.doesNotMatch(source, /preservePool/);
  console.log('All Picsart models and Kling 4 durations can use every credit tier; no model-specific pool restriction; exhausted pool stops without submit (offline).');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
