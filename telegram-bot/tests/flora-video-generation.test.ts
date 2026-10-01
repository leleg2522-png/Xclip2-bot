import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {
  FLORA_480_VIDEO_MODELS,
  resolveFlora480VideoModel,
  buildFlora480VideoParams,
  type Flora480VideoModelKey,
} from '../src/flora-video-models';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const start = source.indexOf('function isExplicitFlora480KeyRejection');
const end = source.indexOf('// ─── Background: Flora image generation', start);
assert.ok(start > 0 && end > start);
const runnerSource = source.slice(start, end);
assert.doesNotMatch(runnerSource, /upscaleGeneratedVideo|result\.url/);
assert.match(source, /flora_minimax_h3_480:\s*3500/);
assert.match(source, /flora_wan_v3_480:\s*5000/);
for (const route of ['flora_minimax_h3_480', 'flora_wan_v3_480']) {
  for (const mode of ['wait_ratio', 'wait_image', 'wait_prompt']) {
    assert.match(source, new RegExp(`'${route}_${mode}'`));
  }
  assert.match(source, new RegExp(`mode_${route}: '${route}'`));
}
assert.match(source, /data\.startsWith\('flora480_minimax_'\).*return 'flora_minimax_h3_480'/);
assert.match(source, /data\.startsWith\('flora480_wan_'\).*return 'flora_wan_v3_480'/);
assert.match(source, /runFlora480Video\(ctx\.chat\.id, userId, dbUserId, statusMsg\.message_id, modelKey, imageUrl, prompt, ratio\)/);

const executable = ts.transpileModule(runnerSource, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function catalog() {
  return {
    models: (['minimax_h3_480', 'wan_v3_480'] as const).map(key => ({
      model_id: `live-${key}`,
      name: key === 'minimax_h3_480' ? 'MiniMax H3 Max' : 'WAN 3.0',
      type: 'video',
      capabilities: ['audio-image-to-video'],
      params: [
        { name: 'image_urls', type: 'string[]' },
        { name: 'duration', options: [{ value: String(FLORA_480_VIDEO_MODELS[key].durationSeconds) }] },
        { name: 'resolution', options: [{ value: FLORA_480_VIDEO_MODELS[key].resolution }] },
        { name: 'aspect_ratio', options: [{ value: '9:16' }, { value: '16:9' }] },
      ],
    })),
  };
}

type Options = {
  keys?: string[];
  chargeOk?: boolean;
  catalog?: (key: string, attempt: number) => unknown;
  submit?: (key: string, prompt: string) => string;
  poll?: (runId: string) => string;
  deliver?: boolean;
  refundFails?: boolean;
};

function harness(options: Options = {}) {
  const events = {
    charges: [] as number[],
    refunds: [] as number[],
    releases: [] as number[],
    dead: [] as string[],
    submissions: [] as Array<{ key: string; model: string; params: any; prompt: string }>,
    deliveries: [] as Array<{ chatId: number; url: string; caption: string }>,
    messages: [] as string[],
    successes: [] as number[],
    polls: [] as string[],
    catalogCalls: 0,
  };
  const keys = options.keys ?? ['key-a', 'key-b'];
  const context = vm.createContext({
    FLORA_480_VIDEO_MODELS,
    buildFlora480VideoParams,
    resolveFlora480VideoModel,
    MODEL_PRICES: { flora_minimax_h3_480: 3500, flora_wan_v3_480: 5000 },
    FLORA_BASE: 'https://provider.example.test',
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (callback: () => void) => callback(),
    describeError: (error: any) => String(error.message ?? ''),
    isFloraRetryablePreSubmitError: (desc: string) => desc.includes('Server Error'),
    beginCharge: async (_: number, price: number, limit: number) => {
      assert.equal(limit, 3);
      events.charges.push(price);
      return { ok: options.chargeOk !== false, reason: 'saldo' };
    },
    chargeFailMsg: () => 'Saldo tidak cukup',
    downloadBuffer: async () => ({ buf: Buffer.from('fixture'), ext: 'jpg', mime: 'image/jpeg' }),
    getNextFloraKey: async (skipped: Set<string>) => keys.find(key => !skipped.has(key)) ?? null,
    markFloraKeyDead: async (key: string) => { events.dead.push(key); },
    floraHttp: {
      get: async (_: string, config: any) => {
        const key = config.headers.Authorization.replace('Bearer ', '');
        events.catalogCalls++;
        return { data: options.catalog ? options.catalog(key, events.catalogCalls) : catalog() };
      },
    },
    floraGetWorkspace: async () => ({ workspaceId: 'workspace', projectId: 'project' }),
    floraUploadImage: async () => 'https://provider.example.test/image.jpg',
    floraGenerate: async (key: string, _: any, model: string, params: any, prompt: string, type: string) => {
      assert.equal(type, 'video');
      events.submissions.push({ key, model, params, prompt });
      return options.submit ? options.submit(key, prompt) : `run-${prompt}`;
    },
    floraPollRun: async (_: string, runId: string, maxMs: number) => {
      assert.equal(maxMs, 20 * 60 * 1000);
      events.polls.push(runId);
      return options.poll ? options.poll(runId) : `https://provider.example.test/${runId}.mp4`;
    },
    sendResult: async (chatId: number, url: string, caption: string, video: boolean) => {
      assert.equal(video, true);
      events.deliveries.push({ chatId, url, caption });
      return options.deliver !== false;
    },
    markGenSuccess: (userId: number) => { events.successes.push(userId); },
    addSaldo: async (_: number, price: number) => {
      events.refunds.push(price);
      if (options.refundFails) throw new Error('Database connection lost');
    },
    releaseGenerating: (userId: number) => { events.releases.push(userId); },
    formatRupiah: (value: number) => `Rp${value}`,
    bot: {
      telegram: {
        editMessageText: async (_: number, __: number, ___: unknown, text: string) => { events.messages.push(text); },
        sendMessage: async (_: number, text: string) => { events.messages.push(text); },
        deleteMessage: async () => {},
      },
    },
  });
  vm.runInContext(executable, context);
  const run = (key: Flora480VideoModelKey, chatId = 1, prompt = 'fixture') =>
    context.runFlora480Video(chatId, chatId, chatId, chatId * 10, key,
      'https://example.test/reference.jpg', prompt, '16:9') as Promise<void>;
  return { events, run };
}

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { response: { status } });
}

async function main() {
  for (const key of ['minimax_h3_480', 'wan_v3_480'] as const) {
    const { events, run } = harness();
    await run(key);
    assert.deepEqual(events.charges, [key === 'minimax_h3_480' ? 3500 : 5000]);
    assert.equal(events.submissions.length, 1);
    assert.equal(events.submissions[0].model, `live-${key}`);
    assert.equal(events.submissions[0].params.duration, String(FLORA_480_VIDEO_MODELS[key].durationSeconds));
    assert.equal(events.submissions[0].params.resolution, FLORA_480_VIDEO_MODELS[key].resolution);
    assert.equal(events.submissions[0].params.aspect_ratio, '16:9');
    assert.deepEqual(events.refunds, []);
    assert.deepEqual(events.releases, [1]);
    assert.match(events.deliveries[0].caption, /480p native/);
    assert.doesNotMatch(events.messages.join(' ') + events.deliveries[0].caption, /Flora|gateway|key-|1K|1080/i);
  }

  const rotated = harness({ catalog: key => {
    if (key === 'key-a') throw httpError(403, 'Forbidden');
    return catalog();
  } });
  await rotated.run('minimax_h3_480');
  assert.deepEqual(rotated.events.dead, ['key-a']);
  assert.equal(rotated.events.submissions[0].key, 'key-b');
  assert.deepEqual(rotated.events.refunds, []);

  const absent = harness({ catalog: key => key === 'key-a' ? { models: [] } : catalog() });
  await absent.run('wan_v3_480');
  assert.deepEqual(absent.events.dead, []);
  assert.equal(absent.events.submissions[0].key, 'key-b');
  assert.equal(absent.events.submissions.length, 1);

  const quota = harness({ submit: key => {
    if (key === 'key-a') throw httpError(402, 'Payment required');
    return 'accepted';
  } });
  await quota.run('minimax_h3_480');
  assert.deepEqual(quota.events.dead, ['key-a']);
  assert.equal(quota.events.submissions.length, 2);
  assert.deepEqual(quota.events.polls, ['accepted']);
  assert.deepEqual(quota.events.refunds, []);

  for (const message of ['network timeout', 'Server Error', 'FLORA_SUBMIT_FAILED: no run_id']) {
    const ambiguous = harness({ submit: () => { throw new Error(message); } });
    await ambiguous.run('wan_v3_480');
    assert.equal(ambiguous.events.submissions.length, 1, 'ambiguous submit must never repeat');
    assert.deepEqual(ambiguous.events.dead, []);
    assert.deepEqual(ambiguous.events.refunds, [5000]);
    assert.deepEqual(ambiguous.events.releases, [1]);
  }
  for (const error of [
    httpError(500, 'Gateway failure: quota exceeded'),
    httpError(503, 'Forbidden billing_not_enough_credits'),
    Object.assign(new Error('Gateway failure: quota exceeded'), { isAxiosError: true }),
    new Error('Ambiguous submission mentions insufficient credits'),
  ]) {
    const ambiguous = harness({ submit: () => { throw error; } });
    await ambiguous.run('wan_v3_480');
    assert.equal(ambiguous.events.submissions.length, 1, 'incidental quota/auth wording must not cause resubmission');
    assert.deepEqual(ambiguous.events.dead, []);
    assert.deepEqual(ambiguous.events.refunds, [5000]);
    assert.deepEqual(ambiguous.events.releases, [1]);
  }

  for (const error of [
    new Error('FLORA_RUN_FAILED [BILLING_NOT_ENOUGH_CREDITS]'),
    httpError(401, 'Unauthorized'),
    new Error('FLORA_RUN_TIMEOUT'),
    new Error('PROMPT_MODERATED provider details'),
  ]) {
    const failed = harness({ poll: () => { throw error; } });
    await failed.run('minimax_h3_480');
    assert.equal(failed.events.submissions.length, 1, 'accepted job must never be resubmitted');
    assert.deepEqual(failed.events.refunds, [3500]);
    assert.deepEqual(failed.events.releases, [1]);
    assert.equal(failed.events.dead.length, /BILLING|Unauthorized/.test(error.message) ? 1 : 0);
    assert.doesNotMatch(failed.events.messages.join(' '), /FLORA_|BILLING|provider details|PROMPT_MODERATED/);
  }

  const deliveryFailed = harness({ deliver: false });
  await deliveryFailed.run('wan_v3_480');
  assert.equal(deliveryFailed.events.submissions.length, 1);
  assert.deepEqual(deliveryFailed.events.refunds, [5000]);
  assert.deepEqual(deliveryFailed.events.successes, []);

  const pendingRefund = harness({ deliver: false, refundFails: true });
  await pendingRefund.run('wan_v3_480');
  assert.deepEqual(pendingRefund.events.refunds, [5000], 'ambiguous credit must not be blindly repeated');
  assert.deepEqual(pendingRefund.events.releases, [1]);
  assert.match(pendingRefund.events.messages.join(' '), /belum dapat dikonfirmasi/);
  assert.match(pendingRefund.events.messages.join(' '), /video-1-10/);
  assert.doesNotMatch(pendingRefund.events.messages.join(' '), /Saldo Rp5000 dikembalikan/);

  const empty = harness({ keys: [] });
  await empty.run('minimax_h3_480');
  assert.equal(empty.events.submissions.length, 0);
  assert.deepEqual(empty.events.refunds, [3500]);
  assert.deepEqual(empty.events.releases, [1]);

  const noSaldo = harness({ chargeOk: false });
  await noSaldo.run('wan_v3_480');
  assert.equal(noSaldo.events.submissions.length, 0);
  assert.deepEqual(noSaldo.events.refunds, []);
  assert.deepEqual(noSaldo.events.releases, []);

  const preparation = harness({ catalog: (_, attempt) => {
    if (attempt === 1) throw new Error('Server Error');
    return catalog();
  } });
  await preparation.run('wan_v3_480');
  assert.equal(preparation.events.submissions.length, 1);
  assert.equal(preparation.events.catalogCalls, 2);
  assert.deepEqual(preparation.events.dead, []);

  const parallel = harness();
  await Promise.all([
    parallel.run('minimax_h3_480', 11, 'minimax'),
    parallel.run('wan_v3_480', 22, 'wan'),
  ]);
  assert.equal(parallel.events.submissions.length, 2);
  assert.equal(parallel.events.deliveries.find(d => d.chatId === 11)?.url, 'https://provider.example.test/run-minimax.mp4');
  assert.equal(parallel.events.deliveries.find(d => d.chatId === 22)?.url, 'https://provider.example.test/run-wan.mp4');
  assert.deepEqual(parallel.events.refunds, []);
  assert.deepEqual(parallel.events.releases.sort(), [11, 22]);
  console.log('Flora 480p video flow, key rotation, refunds, no-resubmit and parallel-isolation simulations passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });