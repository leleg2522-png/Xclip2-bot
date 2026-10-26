import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

// Execute the actual account orchestration with fake DB/provider boundaries.
// No credentials, network requests, or live balance changes are used.
const source = readFileSync(new URL('../src/picsart.ts', import.meta.url), 'utf8');
const start = source.indexOf('export function isPicsartSubmitTokenRejection');
const end = source.indexOf('// Admin: register a refresh token', start);
assert.ok(start > 0 && end > start);
const javascript = ts.transpileModule(
  source.slice(start, end).replace('export function', 'function'),
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }
).outputText;

async function scenario(failures: string[], available = [11, 22]) {
  const used: number[] = [];
  const quarantined: number[] = [];
  const notices: string[] = [];
  const context = vm.createContext({
    Error, console: { error() {} }, MAX_ACCOUNT_ATTEMPTS: 50,
    ERR_INSUFFICIENT_CREDITS: 'PICSART_INSUFFICIENT_CREDITS',
    isCreditError: () => false,
    handleCreditError: async () => { throw Error('unexpected credit handling'); },
    isPicsartPostSubmitAuthFailure: () => false,
    q: async (sql: string, params?: number[]) => {
      if (sql.includes('COUNT(*)')) return { rows: [{ n: available.length }] };
      assert.match(sql, /SET status = 'dead'/);
      quarantined.push(params![0]);
      return { rows: [] };
    },
    acquireAccount: async (_user: number, _pool: unknown, tried: number[]) =>
      available.find(id => !tried.includes(id)) ?? null,
    notifyOwner: (message: string) => notices.push(message),
  });
  vm.runInContext(javascript, context);
  let result: unknown;
  let error: unknown;
  try {
    result = await context.runWithAccount(2935, null, async (id: number) => {
      used.push(id);
      const failure = failures[used.length - 1];
      if (failure) throw new Error(failure);
      return 'accepted-job-result';
    });
  } catch (e) { error = e; }
  return { result, error, used, quarantined, notices };
}

async function main() {
  for (const message of [
    'PICSART_SUBMIT_FAILED status 401: {"reason":"token_error"}',
    'PICSART_SUBMIT_FAILED: 401 {"reason":"token_error"}',
  ]) {
    const result = await scenario([message]);
    assert.equal(result.result, 'accepted-job-result');
    assert.deepEqual(result.used, [11, 22]);
    assert.deepEqual(result.quarantined, [11]);
    assert.equal(result.notices.length, 1);
  }
  for (const message of [
    'PICSART_SUBMIT_FAILED status 403: forbidden',
    'PICSART_SUBMIT_FAILED status 422: invalid input',
    'PICSART_SUBMIT_FAILED status 500: server error',
    'PICSART_SUBMIT_FAILED status 200: missing id',
    'submit timeout',
    'PICSART_POST_SUBMIT_AUTH_LOST job=accepted',
    'PICSART_KLING4_POST_SUBMIT_FAILED: PICSART_SUBMIT_FAILED status 401: token_error',
  ]) {
    const result = await scenario([message]);
    assert.ok(result.error);
    assert.deepEqual(result.used, [11]);
    assert.deepEqual(result.quarantined, []);
  }
  const exhausted = await scenario([
    'PICSART_SUBMIT_FAILED status 401: token_error',
    'PICSART_SUBMIT_FAILED status 401: token_error',
  ]);
  assert.ok(exhausted.error);
  assert.deepEqual(exhausted.used, [11, 22]);
  assert.deepEqual(exhausted.quarantined, [11, 22]);
  console.log('Picsart submit auth failover tests passed');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
