import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {
  createKlikqrisClient, createTopupOrderId, isMyPgOrder, parseQrisExpiry,
  isPaidStatus, isExpiredStatus,
} from '../src/klikqris';

const id = createTopupOrderId(12345, 1000);
assert.equal(id, 'XCLIP-MYPG-12345-1000');
assert.equal(isMyPgOrder(id), true);
assert.equal(isMyPgOrder('XCLIP-12345-999'), false);
assert.equal(parseQrisExpiry('2026-10-27 13:00:13')?.toISOString(), '2026-10-27T06:00:13.000Z');
assert.equal(parseQrisExpiry('2026-10-27T06:00:13Z')?.toISOString(), '2026-10-27T06:00:13.000Z');
assert.equal(parseQrisExpiry('invalid'), null);
assert.equal(parseQrisExpiry(), null);
for (const status of ['SUCCESS', 'PAID', 'settled']) assert.ok(isPaidStatus(status));
assert.equal(isPaidStatus('PENDING'), false);
assert.equal(isExpiredStatus('EXPIRED'), true);

const calls: Array<{ method: string; url: string; body?: any; config: any }> = [];
let payload: any;
let failPost = false;
const http = {
  post: async (url: string, body: any, config: any) => {
    calls.push({ method: 'POST', url, body, config });
    if (failPost) throw new Error('timeout');
    return { data: payload };
  },
  get: async (url: string, config: any) => {
    calls.push({ method: 'GET', url, config });
    return { data: payload };
  },
};
const client = createKlikqrisClient({ apiKey: 'test-only', merchantId: 'merchant/id', http: http as any });
const invoice = {
  order_id: id, amount: '50000.00', total_amount: '50021.00', status: 'PENDING',
  direct_url: 'https://klikqris.com/payqris/merchant/invoice',
  qris_url: 'https://klikqris.com/storage/qr.png', expired_at: '2026-10-27 13:00:13',
};

async function gatewayTests() {
  assert.ok(client.configured());
  assert.equal(createKlikqrisClient({}).configured(), false);
  payload = { status: true, data: invoice };
  const created = await client.createQris(id, 50000, 'topup');
  assert.equal(created.amount, 50000);
  assert.equal(created.totalAmount, 50021);
  assert.equal(created.directUrl, invoice.direct_url);
  assert.equal(calls[0].url, 'https://klikqris.com/api/qrisv2/create');
  assert.deepEqual(calls[0].body, { order_id: id, id_merchant: 'merchant/id', amount: 50000, keterangan: 'topup' });
  assert.equal(calls[0].config.headers['id_merchant'], 'merchant/id');
  assert.equal(calls[0].config.headers['x-api-key'], 'test-only');

  for (const status of ['PENDING', 'SUCCESS', 'PAID', 'EXPIRED']) {
    // Documented MY PG status does not contain amount.
    payload = { status: true, data: { order_id: id, total_amount: 50021, status } };
    const result = await client.checkQrisStatus(id);
    assert.equal(result.status, status);
    assert.equal(result.amount, undefined);
    assert.equal(calls.at(-1)?.url, `https://klikqris.com/api/qrisv2/status/merchant%2Fid/${id}`);
  }
  const oldId = 'XCLIP-12345-999';
  payload = { status: true, data: { ...invoice, order_id: oldId, status: 'SUCCESS' } };
  await client.checkQrisStatus(oldId);
  assert.equal(calls.at(-1)?.url, `https://klikqris.com/api/qris/status/${oldId}`);
  await assert.rejects(client.createQris(oldId, 50000, 'topup'), /REQUIRES_MYPG/);

  for (const bad of [
    { status: false, data: invoice },
    { status: true, data: { ...invoice, order_id: 'wrong' } },
    { status: true, data: { ...invoice, amount: 90000 } },
    { status: true, data: { ...invoice, total_amount: null } },
    { status: true, data: { ...invoice, total_amount: 49999 } },
    { status: true, data: { ...invoice, qris_url: null, direct_url: null } },
    { status: true, data: { ...invoice, status: '' } },
  ]) {
    payload = bad;
    await assert.rejects(client.createQris(id, 50000, 'topup'));
  }
  payload = { status: true, data: { ...invoice, order_id: 'wrong', status: 'PAID' } };
  await assert.rejects(client.checkQrisStatus(id), /INVALID_RESPONSE/);
  const count = calls.length;
  failPost = true;
  await assert.rejects(client.createQris(id, 50000, 'topup'), /timeout/);
  assert.equal(calls.length, count + 1, 'Never retry or create on the old gateway after an ambiguous POST');
  failPost = false;
}

// Exercise the real settlement/reconciliation code without starting the Telegram
// bot or connecting to a live database. No actual invoices, payments, or credits.
const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const settlement = source.slice(source.indexOf('async function markTopupPaidAndCredit('), source.indexOf('async function markTopupExpired('));
const reconcile = source.slice(source.indexOf('async function reconcileTopupOrder('), source.indexOf('// Poller: setiap'));
async function settlementTests() {
  let orderState = 'PENDING', saldo = 1300, credits = 0;
  let response: any = { orderId: id, totalAmount: 50021, status: 'SUCCESS' };
  const query = async (sql: string, params?: any[]) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
    if (sql.includes('UPDATE topup_orders SET status')) {
      if (orderState === 'PAID') return { rows: [], rowCount: 0 };
      orderState = 'PAID';
      return { rows: [{ db_user_id: 7, telegram_id: '12345', amount: 50000 }], rowCount: 1 };
    }
    if (sql.includes('UPDATE users SET saldo')) {
      assert.equal(params?.[1], 50000);
      credits++;
      saldo += 50000;
      return { rows: [{ saldo }] };
    }
    if (sql.includes('SELECT referred_by')) return { rows: [{ referred_by: null }] };
    if (sql.includes('SELECT amount, total_amount')) return { rows: [{ amount: 50000, total_amount: 50021 }] };
    throw Error(`Unexpected query ${sql}`);
  };
  const context = vm.createContext({
    db: { query, connect: async () => ({ query, release() {} }) },
    klikqris: { checkQrisStatus: async () => response, isPaidStatus, isExpiredStatus },
    console: { warn() {} },
  });
  const compiled = ts.transpileModule(`${settlement}\n${reconcile}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  vm.runInContext(compiled, context);
  const run = () => vm.runInContext(`reconcileTopupOrder('${id}')`, context);
  response = { ...response, totalAmount: 99999 };
  assert.equal(await run(), 'pending');
  assert.equal(credits, 0);
  response = { ...response, totalAmount: 50021, amount: 99999 };
  assert.equal(await run(), 'pending');
  assert.equal(credits, 0);
  response = { orderId: id, totalAmount: 50021, status: 'SUCCESS' };
  assert.equal(await run(), 'paid');
  assert.equal(await run(), 'paid');
  assert.equal(credits, 1, 'Duplicate status checks must credit only once');
  assert.equal(saldo, 51300, 'Credit the requested nominal, not the payable unique-code total');
  orderState = 'EXPIRED';
  assert.equal(await run(), 'paid', 'A late confirmed payment must still recover');
  assert.equal(credits, 2);
  assert.match(settlement, /status <> 'PAID'/);
}

async function main() {
  await gatewayTests();
  await settlementTests();
  console.log('KlikQRIS My PG routing, validation, settlement, late-payment and duplicate-credit tests passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
