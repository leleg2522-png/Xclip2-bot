import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { Pool } from 'pg';
import { activateOctoberPromo, octoberPromoStatus, octoberPromoPrice, octoberPromoText, OCTOBER_PROMO } from '../src/october-topup-promo';
import { PICSART_I2V_MODELS } from '../src/picsart';
import { HAR_MODELS } from '../src/picsart-har-models';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
function functionCode(name: string): string {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name);
  return ts.transpileModule(node.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}

const active = { active: true, eligible: true };
const prices = {
  heygen: 2500, picsart_minimax_h3: 4000, kling_21_pro: 3500,
  picsart_seedance_2_mini: 3500, picsart_i2v: 3000,
};

async function testBilling(model: string, eligible: boolean, insufficient = false) {
  const charges: number[] = [], refunds: number[] = [];
  let released = 0, downloads = 0;
  const normal = model === 'heygen' ? 2500 : model === 'minimax_h3' ? 4000
    : model === 'pixverse_v6' ? 3000 : 3500;
  const expected = eligible ? 1500 : normal;
  const context = vm.createContext({
    HAR_MODELS, MODEL_PRICES: prices,
    picsart: { PICSART_I2V_MODELS },
    userModelPrice: async (_id: number, actualModel: string, base: number) => {
      assert.equal(actualModel, model);
      assert.equal(base, normal);
      return octoberPromoPrice(actualModel, base, { active: true, eligible });
    },
    getPicsartI2vPrice: (key: string) => key === 'seedance_2_mini' ? 3500 : 3000,
    customerSafeModelLabel: (label: string) => label,
    isSeedance2I2vModel: (key: string) => key === 'seedance_2_mini',
    supportsMultiplePicsartI2vImages: () => false,
    beginCharge: async (_id: number, price: number) => {
      charges.push(price);
      return { ok: !insufficient, reason: 'insufficient' };
    },
    addSaldo: async (_id: number, price: number) => { refunds.push(price); },
    releaseGenerating: () => { released++; },
    chargeFailMsg: () => 'insufficient',
    describeError: () => 'fixture',
    formatRupiah: (amount: number) => `Rp${amount}`,
    downloadBuffer: async () => { downloads++; throw Error('fixture preparation failure'); },
    bot: { telegram: {
      editMessageText: async () => {}, sendMessage: async () => {},
      getFileLink: async () => ({ href: 'https://example.test/image' }),
    } },
    console: { log() {}, warn() {}, error() {} },
  });
  const runner = model === 'heygen' ? 'runHarModel'
    : model === 'minimax_h3' ? 'runMinimaxH3' : 'runPicsartI2v';
  vm.runInContext(functionCode(runner), context);
  const args = model === 'heygen'
    ? [1, 2, 3, 4, 'prompt', { model, ratio: '9:16', imageFileId: 'fixture' }]
    : model === 'minimax_h3'
    ? [1, 2, 3, 4, 'prompt', { startFrameUrl: 'https://example.test/image' }]
    : [1, 2, 3, 4, 'prompt', {
      model, imageUrls: ['https://example.test/image'], ratio: '9:16',
      ...(model === 'kling_v21_pro' ? { priceKey: 'kling_21_pro' } : {}),
    }];
  await context[runner](...args);
  assert.deepEqual(charges, [expected], model);
  assert.deepEqual(refunds, insufficient ? [] : [expected], model);
  assert.equal(downloads, insufficient ? 0 : 1);
  assert.equal(released, insufficient ? 0 : 1);
}

async function testSqlEligibility() {
  // Use transaction-local fixtures, never real accounts/payments. Temporary
  // tables shadow the names on this connection and disappear on rollback.
  assert.ok(process.env.DATABASE_URL, 'Local DATABASE_URL required for promo SQL tests');
  const db = new Pool({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000 });
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE TEMP TABLE bot_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()) ON COMMIT DROP');
    await client.query(`CREATE TEMP TABLE topup_orders (
      db_user_id INTEGER, status TEXT, amount BIGINT,
      created_at TIMESTAMPTZ, paid_at TIMESTAMPTZ
    ) ON COMMIT DROP`);
    const adapter = { query: client.query.bind(client) } as Pick<Pool, 'query'>;
    const now = new Date('2026-10-26T00:00:00+07:00');
    assert.deepEqual(await octoberPromoStatus(adapter, 1, now), { active: false, eligible: false });
    await activateOctoberPromo(adapter);
    const first = await client.query('SELECT applied_at FROM bot_migrations');
    await activateOctoberPromo(adapter);
    assert.deepEqual((await client.query('SELECT applied_at FROM bot_migrations')).rows, first.rows);
    const start = '2026-10-25T12:00:00+07:00';
    await client.query('UPDATE bot_migrations SET applied_at=$1', [start]);
    const add = async (user: number, amount: number, status = 'PAID',
      created = start, paid: string | null = start) =>
      client.query('INSERT INTO topup_orders VALUES ($1,$2,$3,$4,$5)', [user, status, amount, created, paid]);
    await add(1, 200000);
    await add(2, 250000);
    await add(3, 100000); await add(3, 100000); // No accumulation.
    await add(4, 200000, 'PENDING', start, null);
    await add(5, 200000, 'EXPIRED', start, null);
    await add(6, 200000, 'PAID', '2026-10-24T00:00:00+07:00', start);
    await add(7, 200000, 'PAID', start, '2026-11-01T00:00:00+07:00');
    await add(8, 199999);
    await add(9, 200000, 'PAID', start, '2026-10-31T23:59:59+07:00');
    for (const id of [1, 2]) assert.deepEqual(await octoberPromoStatus(adapter, id, now), active);
    for (const id of [3, 4, 5, 6, 7, 8, 10])
      assert.deepEqual(await octoberPromoStatus(adapter, id, now), { active: true, eligible: false });
    assert.equal((await octoberPromoStatus(adapter, 9, new Date('2026-10-31T23:59:59.999+07:00'))).eligible, true);
    assert.deepEqual(await octoberPromoStatus(adapter, 1, new Date(OCTOBER_PROMO.endsAt)), { active: false, eligible: false });
    await client.query("UPDATE topup_orders SET status='PAID', paid_at=$1 WHERE db_user_id=4", [start]);
    assert.equal((await octoberPromoStatus(adapter, 4, now)).eligible, true, 'Payment immediately unlocks promo');
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await db.end();
  }
}

async function main() {
  const selected = ['kling_v21_pro', 'heygen', 'pixverse_v6', 'minimax_h3', 'seedance_2_mini'];
  for (const model of selected) {
    assert.equal(octoberPromoPrice(model, 3500, active), 1500);
    assert.equal(octoberPromoPrice(model, 3500, { active: false, eligible: true }), 3500);
    assert.equal(octoberPromoPrice(model, 3500, { active: true, eligible: false }), 3500);
    await testBilling(model, true);
    await testBilling(model, false);
    await testBilling(model, true, true);
  }
  for (const model of ['kling_21_p2', 'seedance_2_mini_edit', 'seedance_2_fast', 'wan_v3', 'flora_minimax_h3_480', 'banana21_i2i'])
    assert.equal(octoberPromoPrice(model, 4000, active), 4000, model);
  assert.equal(octoberPromoText({ active: false, eligible: false }), '');
  assert.match(octoberPromoText(active), /31 Oktober 2026, 23.59 WIB/);
  assert.match(octoberPromoText(active), /promo aktif di akun/);
  assert.match(octoberPromoText({ active: true, eligible: false }), /harga normal/);
  const priceTableContext = vm.createContext({
    octoberPromoPrice, octoberPromoText,
    formatRupiah: (amount: number) => 'Rp' + amount.toLocaleString('id-ID'),
    KLING4_DURATIONS: [10, 15, 30], CHINA_VIDEO_MODELS: {},
    KLING_P4: { label: 'P4' }, ALRIZ_KLING_P5: { label: 'P5' },
  });
  const priceStatement = ast.statements.find(n => ts.isVariableStatement(n) &&
    n.declarationList.declarations.some(d => d.name.getText(ast) === 'MODEL_PRICES'));
  assert.ok(priceStatement);
  vm.runInContext(ts.transpileModule(priceStatement.getText(ast), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText + functionCode('getPicsartI2vPrice') + functionCode('hargaText'), priceTableContext);
  const promoTable = priceTableContext.hargaText(active);
  for (const label of ['Kling 2.1 Pro', 'Heygen Video', 'PixVerse v6', 'MiniMax H3', 'Seedance 2.0 Mini'])
    assert.ok(promoTable.split('\n').some((line: string) => line.startsWith(`• ${label} `) && line.includes('Rp1.500')), label);
  assert.match(priceTableContext.hargaText({ active: true, eligible: false }), /Kling 2\.1 Pro \(10 detik\) — Rp3\.500/);
  assert.match(priceTableContext.hargaText({ active: false, eligible: false }), /MiniMax H3 \(15 detik · hingga 1K\) — Rp4\.000/);
  await testSqlEligibility();
  console.log('October promo: SQL eligibility, activation, WIB deadline, all five charge/refund paths and exclusions passed.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
