import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {
  CHINA_VIDEO_MODELS, ChinaVideoClient, chinaVideoRequest, isChinaVideoModel,
  validateChinaVideoFacts,
  ChinaVideoHttpError, isChinaKeyRejection,
} from '../src/chinaapi-video';
import { ChinaApiKeyPool } from '../src/chinaapi-key-pool';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const keys = Object.keys(CHINA_VIDEO_MODELS) as Array<keyof typeof CHINA_VIDEO_MODELS>;
const image = 'https://media.example.test/dl/reference';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

async function main() {
  assert.equal(keys.length, 4);
  assert.equal(isChinaVideoModel('constructor'), false);
  assert.equal(isChinaVideoModel('unknown'), false);
  for (const key of keys) {
    const config = CHINA_VIDEO_MODELS[key];
    assert.equal(config.price, 2000);
    assert.equal(config.duration, key === 'wan3' ? 30 : 15);
    assert.equal(config.resolution, key.startsWith('kling') ? '720p' : '480p');
    for (const ratio of ['9:16', '16:9'] as const) {
      const body: any = chinaVideoRequest(key, image, ' subject walks ', ratio);
      assert.equal(body.model, config.model);
      assert.equal(body.prompt, 'subject walks');
      if (key === 'kling_omni') {
        assert.equal(body.metadata.duration, '15');
        assert.equal(body.metadata.mode, 'std');
        assert.equal(body.metadata.aspect_ratio, ratio);
        assert.deepEqual(body.metadata.image_list, [{ image_url: image, type: 'first_frame' }]);
        assert.equal(body.metadata.resolution, undefined);
      } else if (key === 'kling_v3') {
        assert.equal(body.image, image);
        assert.equal(body.mode, 'std');
        assert.equal(body.duration, 15);
        assert.equal(body.metadata.aspect_ratio, ratio);
        assert.equal(body.input_reference, undefined);
      } else {
        assert.equal(body.input_reference, image);
        assert.equal(body.duration, config.duration);
        if (key === 'wan3') {
          assert.equal(body.size, ratio === '9:16' ? '480*832' : '832*480');
          assert.equal(body.metadata, undefined);
        } else {
          assert.deepEqual(body.metadata, { resolution: '480p' });
        }
      }
      const edge = Number.parseInt(config.resolution);
      const wide = Math.round(edge * 16 / 9 / 2) * 2;
      const probe = { streams: [{
        codec_type: 'video', duration: String(config.duration),
        width: ratio === '9:16' ? edge : wide, height: ratio === '9:16' ? wide : edge,
      }], format: { duration: config.duration + 0.02 } };
      assert.equal(validateChinaVideoFacts(key, ratio, probe).duration, config.duration);
      for (const mismatch of [
        { ...probe, streams: [] },
        { ...probe, streams: [{ ...probe.streams[0], duration: 5 }] },
        { ...probe, streams: [{ ...probe.streams[0], width: 1080, height: 1920 }] },
        { ...probe, streams: [{ ...probe.streams[0], width: edge, height: edge }] },
      ]) assert.throws(() => validateChinaVideoFacts(key, ratio, mismatch), /OUTPUT_MISMATCH/);
    }
    assert.throws(() => chinaVideoRequest(key, 'http://localhost/secret', 'walk', '16:9'));
  }

  const calls: Array<{ path: string; method: string; body?: any }> = [];
  let polls = 0;
  const transport: typeof fetch = async (url, options) => {
    const pathname = new URL(String(url)).pathname;
    assert.equal((options?.headers as any).Authorization, 'Bearer test-key');
    calls.push({ path: pathname, method: options?.method ?? 'GET', body: options?.body ? JSON.parse(String(options.body)) : undefined });
    if (pathname === '/v1/models') return json({ data: keys.map(key => ({ id: CHINA_VIDEO_MODELS[key].model })) });
    if (options?.method === 'POST') return json({ id: 'one-job', status: 'queued' });
    if (pathname.endsWith('/content')) return new Response(Buffer.from('video-bytes'));
    return json(++polls === 1 ? { status: 'in_progress', progress: 30 } : { status: 'completed' });
  };
  const client = new ChinaVideoClient('test-key', transport, async () => {});
  await client.ensureModel('wan3');
  const id = await client.submit(chinaVideoRequest('wan3', image, 'walk', '16:9'));
  const progress: number[] = [];
  await client.poll(id, async value => { progress.push(value); });
  assert.deepEqual(progress, [30]);
  assert.equal((await client.download(id)).toString(), 'video-bytes');
  assert.equal(calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(calls.at(-1)?.path, '/v1/videos/one-job/content');

  for (const failure of ['network', 'missing-id', 'http', 'failed'] as const) {
    let submissions = 0;
    const failing = new ChinaVideoClient('test-key', async (_url, options) => {
      if (options?.method === 'POST') {
        submissions++;
        if (failure === 'network') throw Error('timeout');
        if (failure === 'missing-id') return json({ status: 'queued' });
        if (failure === 'http') return json({}, 400);
        return json({ id: 'accepted' });
      }
      return json({ status: 'failed', error: { message: 'private upstream reason' } });
    }, async () => {});
    const request = chinaVideoRequest('kling_v3', image, 'walk', '9:16');
    if (failure === 'failed') {
      const accepted = await failing.submit(request);
      await assert.rejects(failing.poll(accepted, async () => {}), /GENERATION_FAILED/);
    } else await assert.rejects(failing.submit(request));
    assert.equal(submissions, 1, 'No retry of ambiguous or accepted paid jobs');
  }
  const absent = new ChinaVideoClient('test-key', async () => json({ data: [] }));
  await assert.rejects(absent.ensureModel('wan3'), /MODEL_UNAVAILABLE/);
  const authLost = new ChinaVideoClient('test-key', async () => json({}, 401), async () => {});
  await assert.rejects(authLost.poll('accepted', async () => {}), /HTTP_401/);
  const timedOut = new ChinaVideoClient('test-key', async () => json({ status: 'queued' }), async () => {});
  await assert.rejects(timedOut.poll('accepted', async () => {}, 2), /POLL_TIMEOUT/);
  for (const [code, safe] of [['insufficient_user_quota', true], ['', false]] as const) {
    const rejected = new ChinaVideoClient('test-key', async () => json({ error: { code } }, 402));
    await assert.rejects(rejected.submit(chinaVideoRequest('wan3', image, 'walk', '16:9')), error => {
      assert.ok(isChinaKeyRejection(error));
      assert.equal(error.safeToRotate, safe);
      return true;
    });
  }
  const ambiguousWithId = new ChinaVideoClient('test-key', async () => json({ id: 'accepted', error: { code: 'insufficient_quota' } }, 402));
  await assert.rejects(ambiguousWithId.submit(chinaVideoRequest('wan3', image, 'walk', '16:9')), error => {
    assert.ok(isChinaKeyRejection(error));
    assert.equal(error.safeToRotate, false);
    return true;
  });
  const sqlCalls: Array<{ sql: string; params?: any[] }> = [];
  const databasePool = new ChinaApiKeyPool({
    async query(sql, params) {
      sqlCalls.push({ sql, params });
      assert.doesNotMatch(sql, /dummy-secret-key/);
      if (sql.includes('RETURNING p.id')) return { rows: [{ id: 2, api_key: 'dummy-secret-key' }], rowCount: 1 };
      if (sql.includes(' AS available') && sql.includes('SELECT EXISTS')) return { rows: [{ available: true }], rowCount: 1 };
      if (sql.includes(' AS busy') && sql.includes('COUNT(*)')) return { rows: [{ available: 1, busy: 1, dead: 1, used: 1 }], rowCount: 1 };
      if (sql.includes(' AS status')) return { rows: [{ id: 2, status: 'available', busy: false }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    },
  });
  await databasePool.ensureSchema();
  assert.equal(await databasePool.addKeys(['dummy-secret-key', 'dummy-secret-key']), 1);
  assert.deepEqual(sqlCalls.at(-1)?.params, [['dummy-secret-key']]);
  assert.equal(await databasePool.hasAvailable(), true);
  const selected = await databasePool.acquire([1]);
  assert.ok(selected);
  assert.equal(selected.apiKey, 'dummy-secret-key');
  assert.match(sqlCalls.at(-1)!.sql, /FOR UPDATE SKIP LOCKED/);
  await databasePool.consume(selected);
  assert.match(sqlCalls.at(-1)!.sql, /consumed_at IS NULL AND lease_until > NOW/);
  await databasePool.release(selected, 'never store arbitrary upstream text');
  assert.equal(sqlCalls.at(-1)?.params?.[2], 'authentication_or_quota_rejected');
  assert.match(sqlCalls.at(-1)!.sql, /WHERE id = \$1 AND lease_token = \$2/);
  assert.deepEqual(await databasePool.stats(), { available: 1, busy: 1, dead: 1, used: 1 });
  assert.equal((await databasePool.list())[0].id, 2);
  await databasePool.disable(2);
  await databasePool.restore(2);
  assert.match(sqlCalls.at(-1)!.sql, /lease_until <= NOW/);
  assert.match(sqlCalls.at(-1)!.sql, /consumed_at IS NULL/);
  const alreadyUsed = new ChinaApiKeyPool({ query: async () => ({ rows: [], rowCount: 0 }) });
  await assert.rejects(alreadyUsed.consume(selected), /ALREADY_USED_OR_NOT_OWNED/);
  const dbError = new ChinaApiKeyPool({ query: async () => { throw Error('dummy-secret-key'); } });
  await assert.rejects(dbError.stats(), /CHINA_POOL_DATABASE_ERROR/);

  // Execute the real billing/delivery runner with inert transport and DB doubles.
  const start = source.indexOf('async function runChinaVideo(');
  const end = source.indexOf('// ─── Background: Flora image generation', start);
  assert.ok(start > 0 && end > start);
  const executable = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  function harness(stage = 'success') {
    const events = { charges: [] as number[], refunds: [] as number[], submits: 0, releases: 0, successes: 0, messages: [] as string[], consumes: [] as number[], keyReleases: [] as Array<{ id: number; dead: boolean }> };
    const chain: any = {};
    for (const method of ['rotate', 'resize', 'flatten', 'jpeg']) chain[method] = () => chain;
    chain.toBuffer = async () => Buffer.from('cropped-photo');
    class FakeClient {
      constructor(private key: string) {}
      async ensureModel() {
        if (stage === 'catalog') throw Error('unavailable');
        if (stage === 'rotate' && this.key === 'pool-1') throw new ChinaVideoHttpError(401, true, true);
      }
      async submit() {
        events.submits++;
        if (stage === 'submit') throw Error('ambiguous');
        if (stage === 'quota-rotate' && this.key === 'pool-1') throw new ChinaVideoHttpError(402, true, true);
        return 'accepted';
      }
      async poll() {
        if (stage === 'poll') throw Error('failed');
        if (stage === 'accepted-auth-loss') throw new ChinaVideoHttpError(401, true, true);
      }
      async download() { if (stage === 'download') throw Error('failed'); return Buffer.from('video'); }
    }
    const context = vm.createContext({
      CHINA_VIDEO_MODELS, ChinaVideoClient: FakeClient, chinaVideoRequest, isChinaKeyRejection,
      chinaKeyPool: {
        hasAvailable: async () => stage !== 'unconfigured',
        acquire: async (skip: number[]) => {
          const id = [1, 2].find(id => !skip.includes(id));
          return id ? { id, apiKey: `pool-${id}`, token: 'lease' } : null;
        },
        consume: async (lease: any) => {
          events.consumes.push(lease.id);
          if (stage === 'consume-db-ambiguous') throw Error('CHINA_POOL_DATABASE_ERROR');
        },
        release: async (lease: any, reason: any) => { events.keyReleases.push({ id: lease.id, dead: !!reason }); },
      },
      inspectChinaVideo: async () => { if (stage === 'dimensions') throw Error('mismatch'); return { width: 854, height: 480 }; },
      process: { env: { CHINAAPI_API_KEY: stage === 'unconfigured' ? '' : 'unit-test' } },
      publicBaseUrl: () => stage === 'no-public-url' ? 'http://localhost' : 'https://media.example.test',
      beginCharge: async (_user: number, price: number) => {
        if (stage === 'insufficient') return { ok: false, reason: 'insufficient' };
        events.charges.push(price); return { ok: true };
      },
      chargeFailMsg: () => 'Saldo tidak cukup',
      downloadBuffer: async () => { if (stage === 'photo') throw Error('invalid'); return { buf: Buffer.from('photo') }; },
      sharp: () => chain,
      publishMedia: async () => image,
      sendResult: async (_chat: number, _url: string, caption: string) => {
        events.messages.push(caption); if (stage === 'delivery-throw') throw Error('transport'); return stage !== 'delivery';
      },
      addSaldo: async (_user: number, price: number) => { events.refunds.push(price); if (stage === 'refund') throw Error('db response ambiguous'); },
      markGenSuccess: () => { events.successes++; },
      releaseGenerating: () => { events.releases++; },
      formatRupiah: () => 'Rp2.000',
      mediaStore: new Map(), fsp: { unlink: async () => {} },
      URL, console: { log() {}, error() {} },
      bot: { telegram: {
        editMessageText: async (_chat: number, _id: number, _inline: unknown, text: string) => { events.messages.push(text); },
        sendMessage: async (_chat: number, text: string) => { events.messages.push(text); },
        deleteMessage: async () => {},
      } },
    });
    if (stage === 'refund') FakeClient.prototype.poll = async () => { throw Error('failed'); };
    vm.runInContext(executable, context);
    return { events, run: (key: string) => context.runChinaVideo(1, 2, 3, 4, key, 'https://api.telegram.org/file/botPRIVATE/photo', 'walk', '16:9') };
  }
  for (const key of keys) {
    const success = harness();
    await success.run(key);
    assert.deepEqual(success.events.charges, [2000]);
    assert.deepEqual(success.events.refunds, []);
    assert.equal(success.events.submits, 1);
    assert.deepEqual(success.events.consumes, [1]);
    assert.equal(success.events.successes, 1);
    assert.equal(success.events.releases, 1);
    assert.deepEqual(success.events.keyReleases, [{ id: 1, dead: false }]);
    assert.doesNotMatch(success.events.messages.join(' '), /ChinaAPI|PRIVATE|upscale/i);
  }
  for (const stage of ['catalog', 'photo', 'submit', 'poll', 'download', 'dimensions', 'delivery', 'delivery-throw', 'refund']) {
    const failed = harness(stage);
    await failed.run('wan3');
    assert.deepEqual(failed.events.charges, [2000]);
    assert.deepEqual(failed.events.refunds, [2000]);
    assert.equal(failed.events.releases, 1);
    assert.equal(failed.events.successes, 0);
    assert.ok(failed.events.submits <= 1);
    if (stage === 'refund') {
      assert.match(failed.events.messages.join(' '), /belum dapat dikonfirmasi/);
      assert.doesNotMatch(failed.events.messages.join(' '), /Saldo Rp2.000 dikembalikan/);
    }
  }
  for (const stage of ['unconfigured', 'no-public-url', 'insufficient']) {
    const rejected = harness(stage);
    await rejected.run('wan3');
    assert.deepEqual(rejected.events.charges, []);
    assert.deepEqual(rejected.events.refunds, []);
    assert.equal(rejected.events.submits, 0);
  }
  for (const stage of ['rotate', 'quota-rotate']) {
    const failover = harness(stage);
    await failover.run('wan3');
    assert.deepEqual(failover.events.charges, [2000]);
    assert.deepEqual(failover.events.refunds, []);
    assert.equal(failover.events.submits, stage === 'rotate' ? 1 : 2);
    assert.deepEqual(failover.events.keyReleases, [{ id: 1, dead: true }, { id: 2, dead: false }]);
  }
  const lostAuth = harness('accepted-auth-loss');
  await lostAuth.run('wan3');
  assert.equal(lostAuth.events.submits, 1);
  assert.deepEqual(lostAuth.events.refunds, [2000]);
  assert.deepEqual(lostAuth.events.keyReleases, [{ id: 1, dead: true }]);
  const consumeFailure = harness('consume-db-ambiguous');
  await consumeFailure.run('wan3');
  assert.equal(consumeFailure.events.submits, 0, 'No paid call after ambiguous consumption write');
  assert.deepEqual(consumeFailure.events.refunds, [2000]);
  assert.deepEqual(consumeFailure.events.consumes, [1]);
  // Exercise the actual setup, image and prompt branches, not just their labels.
  function section(first: string, next: string) {
    const begin = source.indexOf(first);
    const finish = source.indexOf(next, begin + first.length);
    assert.ok(begin > 0 && finish > begin, first);
    return source.slice(begin, finish);
  }
  let draft: any = { mode: 'idle', dbUserId: 3 };
  const replies: string[] = [];
  const launched: any[][] = [];
  const ctx = {
    chat: { id: 1 }, message: { text: 'walk slowly' },
    editMessageText: async (text: string) => { replies.push(text); },
    reply: async (text: string) => { replies.push(text); return { message_id: 4 }; },
  };
  const wizardContext = vm.createContext({
    CHINA_VIDEO_MODELS, isChinaVideoModel,
    chinaKeyPool: { hasAvailable: async () => true },
    process: { env: { CHINAAPI_API_KEY: 'unit-test' } },
    getSession: () => draft,
    setSession: (_id: number, data: any) => { draft = { ...draft, ...data }; },
    formatRupiah: () => 'Rp2.000',
    Markup: { inlineKeyboard: (rows: any) => ({ rows }), button: { callback: (text: string, value: string) => ({ text, value }) } },
    requireLogin: async () => true,
    getCooldownRemainingMs: () => 0, formatCooldown: () => '',
    runChinaVideo: async (...args: any[]) => { launched.push(args); },
    console,
  });
  const wizard = section("  if (data.startsWith('mode_china_')) {", "  if (data === 'mode_flora_seedance_2_480') {");
  const photo = section("  if (session.mode === 'china_video_wait_image') {", "  if (session.mode === 'flora_seedance_2_480_wait_image') {");
  const prompt = section("  if (session.mode === 'china_video_wait_prompt') {", "  if (\n    session.mode === 'flora_minimax_h3_480_wait_prompt'");
  const wrappers =
    `async function wizard(ctx, data, userId) { ${wizard} }\n` +
    `async function photo(ctx, fileUrl, userId) { const session = getSession(userId); ${photo} }\n` +
    `async function prompt(ctx, userId) { const session = getSession(userId); ${prompt} }\n`;
  vm.runInContext(ts.transpileModule(wrappers, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText, wizardContext);
  for (const key of keys) {
    draft = { mode: 'idle', dbUserId: 3 };
    await wizardContext.wizard(ctx, `mode_china_${key}`, 2);
    assert.equal(draft.chinaVideoModel, key);
    assert.equal(draft.mode, 'china_video_wait_ratio');
    assert.match(replies.at(-1)!, /Rp2.000/);
    await wizardContext.wizard(ctx, 'china_ratio_916', 2);
    assert.equal(draft.mode, 'china_video_wait_image');
    assert.equal(draft.chinaVideoRatio, '9:16');
    await wizardContext.photo(ctx, image, 2);
    assert.equal(draft.mode, 'china_video_wait_prompt');
    const before = launched.length;
    await Promise.all([wizardContext.prompt(ctx, 2), wizardContext.prompt(ctx, 2)]);
    assert.equal(launched.length, before + 1, 'Duplicate prompt must launch once');
    assert.equal(launched.at(-1)![4], key);
    assert.equal(launched.at(-1)![5], image);
    assert.equal(launched.at(-1)![7], '9:16');
    assert.equal(draft.mode, 'idle');
    assert.equal(draft.chinaVideoImageUrl, undefined);
  }
  draft = { mode: 'idle', dbUserId: 3 };
  await wizardContext.wizard(ctx, 'china_ratio_169', 2);
  assert.equal(draft.mode, 'idle', 'Stale ratio buttons must not recreate a draft');
  assert.match(replies.at(-1)!, /tidak aktif/);
  wizardContext.chinaKeyPool.hasAvailable = async () => false;
  await wizardContext.wizard(ctx, 'mode_china_wan3', 2);
  assert.equal(draft.mode, 'idle');
  assert.match(replies.at(-1)!, /Saldo tidak dipotong/);
  assert.match(source, /mode_china_\$\{key\}/);
  assert.match(source, /Object\.values\(CHINA_VIDEO_MODELS\)\.map/);
  for (const mode of ['ratio', 'image', 'prompt']) assert.match(source, new RegExp(`'china_video_wait_${mode}'`));
  assert.match(source, /return 'china_video'/);
  console.log('ChinaAPI model contracts, one-submit policy, native media checks, billing and refunds passed (offline).');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
