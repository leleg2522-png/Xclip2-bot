import assert from 'node:assert/strict';
import { BUDGET_VIDEO_MODELS, BudgetVideoApi, type BudgetVideoInput, type BudgetVideoModel } from '../src/budget-video-api';
import { createBudgetVideoBot, executeBudgetVideoOrder } from '../src/budget-video-bot';
import { readFileSync } from 'node:fs';

const image = { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]), mime: 'image/jpeg' };
const input = (model: BudgetVideoModel): BudgetVideoInput => ({ model, ratio: '9:16', prompt: 'A fox walks slowly', images: [image] });
const wait = async () => {};

function keyPool() {
  const limits: any[] = [], disabled: number[] = [];
  return {
    limits, disabled,
    async next(skip: number[] = [], scopes: string[] = []) {
      const id = [1, 2].find(id => !skip.includes(id) && !limits.some(c => c.id === id && scopes.includes(c.scope) && c.until > Date.now()));
      return id ? { id, apiKey: `fixture-key-${id}` } : null;
    },
    async get(id: number) { return { id, apiKey: `fixture-key-${id}` }; },
    async disable(id: number) { disabled.push(id); return true; },
    async markLimited(id: number, scope: string, until: number) { limits.push({ id, scope, until }); },
  };
}

async function contracts() {
  for (const c of Object.values(BUDGET_VIDEO_MODELS)) assert.equal(c.price, 500);
  for (const model of ['vela', 'muse'] as const) {
    let submits = 0, polls = 0;
    const api = new BudgetVideoApi(keyPool(), 'snapgen-fixture', async (url, options) => {
      assert.equal(new Headers(options?.headers).get('x-api-key'), 'snapgen-fixture');
      if (options?.method === 'POST') {
        submits++;
        assert.equal(String(url), `https://api.snapgen.ai/uapi/v1/video-gen/${model}`);
        const body = options.body as FormData;
        assert.equal(body.get('model'), `${model}-ai-video`);
        assert.equal(body.get('duration'), model === 'vela' ? '5' : '10');
        assert.equal(body.get('orientation'), 'portrait');
        assert.equal(body.get('resolution'), model === 'vela' ? '720p' : null, 'Never invent MUSE resolution');
        assert.equal(body.getAll('files').length, model === 'vela' ? 2 : 1);
        assert.equal((body.getAll('files')[0] as File).name, 'frame-1.jpg');
        if (model === 'vela') assert.equal((body.getAll('files')[1] as File).name, 'frame-2.png');
        return Response.json({ uuid: 'accepted-job', model_name: `${model}-ai-video`, status: 1 });
      }
      polls++;
      return Response.json({ model_name: `${model}-ai-video`, status: 2, generated_video: [{ status: 2, video_url: 'https://cdn.test/result.mp4' }] });
    }, wait);
    const request = input(model);
    if (model === 'vela') request.images.push({ bytes: Buffer.from('end'), mime: 'image/png' });
    assert.equal(await api.generate(request), 'https://cdn.test/result.mp4');
    assert.equal(submits, 1); assert.equal(polls, 1);
  }
  for (const model of ['deapi_ltx', 'deapi_h3'] as const) {
    for (const hasImage of [false, true]) {
      const pool = keyPool(), submits: string[] = [], polls: string[] = [];
      let quotes = 0;
      const api = new BudgetVideoApi(pool, undefined, async (url, options) => {
        const auth = new Headers(options?.headers).get('authorization')!;
        const endpoint = hasImage ? 'animations' : 'generations';
        if (options?.method === 'POST') {
          assert(String(url).includes(`/videos/${endpoint}`));
          const body = options.body instanceof FormData ? Object.fromEntries(options.body.entries()) : JSON.parse(String(options.body));
          assert.equal(body.model, model === 'deapi_ltx' ? 'Ltx2_5_22B_Dist_INT8' : 'MiniMaxH3_33B_Turbo_INT8');
          assert.equal(Number(body.width), 768); assert.equal(Number(body.height), 1344);
          assert.equal(Number(body.frames), model === 'deapi_ltx' ? 241 : 240);
          assert.equal(Number(body.fps), 24);
          if (hasImage) {
            assert(body.first_frame_image instanceof Blob);
            assert.equal(body.first_frame_image.type, 'image/jpeg', 'DeAPI gets the actual image MIME');
          }
          if (String(url).endsWith('/price')) {
            quotes++; return Response.json({ data: { price: 0.1, is_estimated: false } });
          }
          submits.push(auth);
          if (auth.endsWith('-1')) return Response.json({ message: 'Too Many Attempts.' },
            { status: 429, headers: { 'retry-after': '120' } });
          return Response.json({ data: { request_id: 'job-key-2' } });
        }
        polls.push(auth);
        assert(String(url).endsWith('/jobs/job-key-2'));
        return Response.json({ data: { status: 'done', result_url: 'https://cdn.test/video.mp4' } });
      }, wait);
      const request = input(model);
      if (!hasImage) request.images = [];
      assert.equal(await api.generate(request), 'https://cdn.test/video.mp4');
      assert.deepEqual(submits, ['Bearer fixture-key-1', 'Bearer fixture-key-2']);
      assert.deepEqual(polls, ['Bearer fixture-key-2']); assert.equal(quotes, 2);
      assert.equal(pool.limits.length, 1); assert(pool.limits[0].scope.endsWith(model === 'deapi_ltx' ? ':Ltx2_5_22B_Dist_INT8' : ':MiniMaxH3_33B_Turbo_INT8'));
      assert.deepEqual(pool.disabled, []);
    }
  }
  for (const failure of ['timeout', 'bad-id', 'post-accept', 'traffic', 'invalid-image', 'moderation', 'nested-moderation', 'submit-moderation']) {
    let submits = 0;
    const api = new BudgetVideoApi(keyPool(), 'fixture', async (_url, options) => {
      if (options?.method === 'POST') {
        submits++;
        if (failure === 'timeout') throw Error('socket timeout');
        if (failure === 'bad-id') return Response.json({});
        if (failure === 'invalid-image') return Response.json({ detail: {
          error_code: 'UNSUPPORTED_IMAGE_FORMAT', error_message: 'private provider details must not enter logs',
        } }, { status: 400 });
        if (failure === 'submit-moderation') return Response.json({
          uuid: 'accepted', model_name: 'vela-ai-video', status: 3, error_code: 'CONTENT_MODERATION_ERROR',
        });
        return Response.json({ uuid: 'accepted', model_name: 'vela-ai-video' });
      }
      if (failure === 'post-accept') return new Response('', { status: 401 });
      if (failure === 'moderation') return Response.json({
        status: 3, model_name: 'vela-ai-video', error_code: 'CONTENT_MODERATION_ERROR', used_credit: 0,
      });
      if (failure === 'nested-moderation') return Response.json({
        status: 1, model_name: 'vela-ai-video',
        generated_video: [{ status: 3, error_code: 'CONTENT_MODERATION_ERROR' }],
      });
      return Response.json({ status: 3, model_name: 'vela-ai-video', error_code: 'HIGH_TRAFFIC_ERROR' });
    }, wait);
    await assert.rejects(api.generate(input('vela')),
      failure.includes('moderation') ? /SNAPGEN_CONTENT_MODERATION$/
        : failure === 'invalid-image' ? /SNAPGEN_SUBMIT_HTTP_400_UNSUPPORTED_IMAGE_FORMAT$/ : undefined);
    assert.equal(submits, 1, 'Failures never replay a paid SnapGen submit');
  }
  for (const [mime, extension] of [['image/jpeg','jpg'], ['image/png','png'], ['image/webp','webp']]) {
    let submits = 0;
    const api = new BudgetVideoApi(keyPool(), 'fixture', async (_url, options) => {
      submits++;
      const body = options!.body as FormData;
      const file = body.get('files') as File;
      assert.equal(file.name, `frame-1.${extension}`);
      assert.equal(file.type, mime);
      return Response.json({ detail: { error_code: 'INVALID_FILE_CONTENT' } }, { status: 400 });
    }, wait);
    await assert.rejects(api.generate({ ...input('muse'), images: [{ ...image, mime }] }),
      /SNAPGEN_SUBMIT_HTTP_400_INVALID_FILE_CONTENT$/);
    assert.equal(submits, 1);
  }
  await assert.rejects(new BudgetVideoApi(keyPool(), 'fixture').generate({ ...input('vela'), images: [] }), /IMAGE_INVALID/);
}

async function billing() {
  for (const model of Object.keys(BUDGET_VIDEO_MODELS) as BudgetVideoModel[]) {
    for (const outcome of ['success', 'generate-failed', 'delivery-failed', 'delivery-threw', 'insufficient', 'refund-failed']) {
      let balance = 1000, charges = 0, refunds = 0, releases = 0, generated = 0, delivered = 0, refundNotices = 0;
      const run = () => executeBudgetVideoOrder(input(model), {
        async charge() {
          charges++;
          if (outcome === 'insufficient') return { ok: false, reason: 'insufficient' };
          balance -= 500; return { ok: true };
        },
        async rejected() {},
        async generate() { generated++; if (outcome === 'generate-failed') throw Error('failed'); return 'https://cdn.test/video.mp4'; },
        async deliver() {
          delivered++;
          if (outcome === 'delivery-threw') throw Error('delivery failed');
          return outcome === 'success';
        },
        async refund() { refunds++; if (outcome === 'refund-failed') throw Error('DB unavailable'); balance += 500; },
        async refunded() { refundNotices++; }, async failed() {}, release() { releases++; },
      });
      if (outcome === 'refund-failed') await assert.rejects(run(), /DB unavailable/); else await run();
      assert.equal(charges, 1);
      assert.equal(balance, outcome === 'success' || outcome === 'refund-failed' ? 500 : 1000);
      assert.equal(refunds, outcome === 'success' || outcome === 'insufficient' ? 0 : 1);
      assert.equal(releases, outcome === 'insufficient' ? 0 : 1);
      if (outcome === 'insufficient') assert.equal(generated + delivered, 0);
      if (outcome === 'refund-failed') assert.equal(refundNotices, 0, 'Never claim a failed refund succeeded');
    }
  }
}

async function suspendedAccounts() {
  for (const scenario of ['suspended', 'generic-forbidden', 'has-job', 'has-running-status', 'poll-forbidden']) {
    const pool = keyPool(), submits: string[] = [], polls: string[] = [];
    const api = new BudgetVideoApi(pool, undefined, async (url, options) => {
      const auth = new Headers(options?.headers).get('authorization')!;
      if (String(url).endsWith('/price')) return Response.json({ data: { price: 0.1, is_estimated: false } });
      if (options?.method === 'POST') {
        submits.push(auth);
        if (auth.endsWith('-1') && scenario !== 'poll-forbidden') {
          const body: any = { message: scenario === 'generic-forbidden'
            ? 'Forbidden' : 'Client account is suspended. If you believe this is a mistake, contact us.' };
          if (scenario === 'has-job') body.data = { request_id: 'accepted-do-not-replay' };
          if (scenario === 'has-running-status') body.data = { status: 'processing' };
          return Response.json(body, { status: 403 });
        }
        return Response.json({ data: { request_id: 'bound-job' } });
      }
      polls.push(auth);
      if (scenario === 'poll-forbidden') return Response.json({ message: 'Client account is suspended.' }, { status: 403 });
      return Response.json({ data: { status: 'done', result_url: 'https://cdn.test/result.mp4' } });
    }, wait);
    if (scenario === 'suspended') {
      assert.equal(await api.generate(input('deapi_h3')), 'https://cdn.test/result.mp4');
      assert.deepEqual(submits, ['Bearer fixture-key-1', 'Bearer fixture-key-2']);
      assert.deepEqual(polls, ['Bearer fixture-key-2']);
      assert.equal(pool.limits[0].scope, 'account');
      assert.equal(pool.limits[0].id, 1);
      // A new renderer instance skips the persisted account hold, even for another model.
      await api.generate(input('deapi_ltx'));
      assert.equal(submits.length, 3);
      assert.equal(submits[2], 'Bearer fixture-key-2');
    } else {
      await assert.rejects(api.generate(input('deapi_h3')), /DEAPI_(SUBMIT|POLL)_HTTP_403/);
      assert.equal(submits.length, 1, 'Unknown/ambiguous 403 and accepted polling failures never replay');
      assert.equal(pool.limits.length, 0, 'Only a proven suspended-account refusal creates a hold');
    }
    assert.deepEqual(pool.disabled, [], 'A suspension must never delete or permanently disable the key');
  }
}

async function wizard() {
  for (const model of Object.keys(BUDGET_VIDEO_MODELS) as BudgetVideoModel[]) {
    for (const withImage of [false, true]) {
    let session: any = { mode: 'idle', dbUserId: 7 }, runs = 0;
    const replies: string[] = [], requests: BudgetVideoInput[] = [];
    const ctx: any = { from: { id: 1 }, chat: { id: 1 }, message: {},
      async reply(text: string) { replies.push(text); return { message_id: 1 }; },
      async editMessageText(text: string) { replies.push(text); },
    };
    const bot = createBudgetVideoBot({
      session: () => session, set: (_id, patch) => { session = { ...session, ...patch }; },
      async download() { return image; },
      async run(_ctx, dbId, request) { assert.equal(dbId, 7); runs++; requests.push(request); },
      error(error) { throw error; },
    });
    await bot.callback(ctx, `mode_bvideo_${model}`);
    assert(replies[0].includes('Rp500'));
    const id = session.budgetVideo.id;
    await bot.callback(ctx, 'bvideo_skip:stale');
    assert.equal(session.mode, 'budget_video_ratio');
    await bot.callback(ctx, `bvideo_ratio_916:${id}`);
    if (model === 'vela') {
      await bot.callback(ctx, `bvideo_skip:${id}`);
      assert.equal(session.mode, 'budget_video_image', 'Vela cannot skip its start frame');
      ctx.message = { photo: [{ file_id: 'start', file_size: 100 }] }; await bot.message(ctx);
      assert.equal(session.mode, 'budget_video_end');
      if (withImage) {
        ctx.message = { photo: [{ file_id: 'end', file_size: 100 }] }; await bot.message(ctx);
      } else await bot.callback(ctx, `bvideo_skip:${id}`);
    } else if (withImage) {
      ctx.message = { photo: [{ file_id: 'start', file_size: 100 }] }; await bot.message(ctx);
    } else {
      await bot.callback(ctx, `bvideo_skip:${id}`);
    }
    assert.equal(session.mode, 'budget_video_prompt');
    ctx.message = { text: 'Make a cinematic scene' };
    await Promise.all([bot.message(ctx), bot.message(ctx)]);
    assert.equal(runs, 1, 'Concurrent prompts submit only one order');
    assert.equal(session.mode, 'idle'); assert.equal(requests[0].model, model);
    assert.equal(requests[0].images.length, model === 'vela' ? (withImage ? 2 : 1) : (withImage ? 1 : 0));
    }
  }
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
  assert(source.includes("return budgetVideoBot.callback(ctx, data)"));
  assert(source.includes("return budgetVideoBot.message(ctx)"));
  assert(source.includes("startsWith('budget_video_')"));
  assert(source.includes("beginCharge(dbUserId, config.price)"));
  assert(source.includes("addSaldo(dbUserId, config.price)"));
  assert(source.includes("getFileLink(fileId)"), 'Telegram reference URLs stay internal');
}

async function main() {
  await contracts(); await suspendedAccounts(); await billing(); await wizard();
  console.log('PASS four Rp500 video packages: real request contracts, menu wizard, stale buttons, duplicate prompts, persistent cooldown scopes, accepted-job safety and full failed-delivery refunds. No paid API calls.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
