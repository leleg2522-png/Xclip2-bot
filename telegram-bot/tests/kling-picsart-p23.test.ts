import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(path.resolve(__dirname, '../src/index.ts'), 'utf8');
const runnerStart = source.indexOf('async function runKlingMotionEdan(');
const wrappersStart = source.indexOf('async function runKlingP2(', runnerStart);
const wrappersEnd = source.indexOf('// ─── Background: Picsart Image-to-Video', wrappersStart);
const runnerEnd = source.indexOf('\n}\n', runnerStart) + 3;
assert.ok(runnerStart >= 0 && runnerEnd > runnerStart && wrappersStart > runnerEnd && wrappersEnd > wrappersStart);
const runnerAndWrappers = source.slice(runnerStart, runnerEnd) + source.slice(wrappersStart, wrappersEnd);
assert.match(runnerAndWrappers, /generateKlingMotionEdan/);
assert.match(runnerAndWrappers, /getAvailableEdanbotCookies/);
assert.match(runnerAndWrappers, /markEdanbotCookieDead/);
assert.doesNotMatch(runnerAndWrappers, /picsart\.generateKlingMotionControl/);
assert.match(source, /KLING_P2_P3_MAX_REF_SECONDS\s*=\s*KLING_MOTION_EDAN\.maxReferenceSeconds/);

function compile(text: string) {
  return ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}

function harness(failure?: 'provider' | 'delivery') {
  const calls = {
    charges: [] as number[],
    refunds: [] as number[],
    releases: 0,
    provider: [] as any[],
    deliveries: [] as any[],
    statuses: [] as string[],
    messages: [] as string[],
    usage: 0,
    successes: 0,
  };
  const image = Buffer.from('character-image');
  const video = Buffer.from('motion-video');
  const context = vm.createContext({
    Buffer,
    MODEL_PRICES: { kling_mc: 3500, kling_p2: 4000, kling_p3: 4000 },
    KLING_MAX_REF_SECONDS: 16,
    KLING_P2_P3_MAX_REF_SECONDS: 30,
    KLING_MOTION_EDAN: { minReferenceSeconds: 3, maxReferenceSeconds: 30 },
    beginCharge: async (_id: number, price: number) => {
      calls.charges.push(price);
      return { ok: true };
    },
    chargeFailMsg: () => 'saldo tidak cukup',
    bot: { telegram: {
      editMessageText: async (_chat: number, _msg: number, _inline: unknown, text: string) => { calls.statuses.push(text); },
      sendMessage: async (_chat: number, text: string) => { calls.messages.push(text); },
      deleteMessage: async () => {},
      getFileLink: async (id: string) => ({ href: `https://telegram.test/${id}` }),
    } },
    downloadBuffer: async (url: string) => url.includes('photo')
      ? { buf: image, ext: 'png', mime: 'image/png' }
      : { buf: video, ext: 'mp4', mime: 'video/mp4' },
    detectVideoType: () => ({ ext: 'mp4', mime: 'video/mp4' }),
    inspectSeedance25Media: async () => 14.3,
    generateKlingMotionEdan: async (...args: any[]) => {
      calls.provider.push(args);
      if (failure === 'provider') throw new Error('Edanbot request failed');
      return { url: 'https://cdn.test/result.mp4', jobId: 'accepted-job' };
    },
    getAvailableEdanbotCookies: async () => [],
    markEdanbotCookieDead: async () => {},
    uploadToEdanbot: async () => ({ type: 'image', url: 'https://edanbot.digital/uploads/a.png', name: 'a.png', size: 10 }),
    edanbotHttp: {},
    pollEdanbotJob: async () => 'https://cdn.test/result.mp4',
    EDANBOT_JOB_TIMEOUT_MS: 1_200_000,
    retryTelegramFileRead: async (read: () => Promise<any>) => read(),
    sendResult: async (_chat: number, url: string, caption: string, isVideo: boolean) => {
      calls.deliveries.push({ url, caption, isVideo });
      return failure !== 'delivery';
    },
    incrementKlingUsage: async () => { calls.usage++; },
    markGenSuccess: () => { calls.successes++; },
    addSaldo: async (_id: number, amount: number) => { calls.refunds.push(amount); },
    releaseGenerating: () => { calls.releases++; },
    notifyGenerationFailure: async () => {},
    describeError: (error: any) => String(error?.message ?? error),
    formatRupiah: (amount: number) => `Rp${amount}`,
    console: { log() {}, error() {} },
  });
  vm.runInContext(compile(runnerAndWrappers), context);
  return { calls, context, image, video };
}

async function checkVariant(variant: 'p2' | 'p3') {
  const h = harness();
  const isP2 = variant === 'p2';
  const price = 4000;
  const label = isP2 ? 'Kling MC V3 PRO P2' : 'Kling MC V3.0 PRO P3';
  const run = isP2 ? h.context.runKlingP2 : h.context.runKlingP3;
  await run(1, 2, 3, 4, 'photo-id', 'video-id', 30, 'Follow this motion.');

  assert.deepEqual(h.calls.charges, [price]);
  assert.equal(h.calls.provider.length, 1);
  assert.equal(h.calls.provider[0][0], 'Follow this motion.');
  assert.deepEqual(h.calls.provider[0][1].buffer, h.image);
  assert.equal(h.calls.provider[0][1].mime, 'image/png');
  assert.deepEqual(h.calls.provider[0][2].buffer, h.video);
  assert.equal(h.calls.provider[0][2].mime, 'video/mp4');
  assert.equal(h.calls.provider[0][3], 14.3);
  assert.equal(h.calls.provider[0][4].cookies, h.context.getAvailableEdanbotCookies);
  assert.equal(h.calls.provider[0][4].markDead, h.context.markEdanbotCookieDead);
  assert.equal(h.calls.deliveries[0].url, 'https://cdn.test/result.mp4');
  assert.equal(h.calls.deliveries[0].caption, `🎭 ${label}\n\n/menu untuk buat lagi`);
  assert.equal(h.calls.deliveries[0].isVideo, true);
  assert.deepEqual(h.calls.refunds, []);
  assert.equal(h.calls.usage, 1);
  assert.equal(h.calls.successes, 1);
  assert.equal(h.calls.releases, 1);
  assert.doesNotMatch(h.calls.statuses.join(' ') + h.calls.messages.join(' '), /Edanbot|edanbot\.digital|provider/i);
}

async function checkThirtyOneSecondsRejectedBeforeCharge() {
  for (const variant of ['p2', 'p3'] as const) {
    const h = harness();
    const run = variant === 'p2' ? h.context.runKlingP2 : h.context.runKlingP3;
    await run(1, 2, 3, 4, 'photo-id', 'video-id', 31, 'too long');
    assert.deepEqual(h.calls.charges, []);
    assert.deepEqual(h.calls.provider, []);
    assert.match(h.calls.statuses.join(' '), /Maksimal 30 detik/);
  }
}

async function checkFailuresRefundTheExistingPackagePrice() {
  for (const failure of ['provider', 'delivery'] as const) {
    const h = harness(failure);
    await h.context.runKlingP3(1, 2, 3, 4, 'photo-id', 'video-id', 30, 'move');
    assert.deepEqual(h.calls.charges, [4000]);
    assert.deepEqual(h.calls.refunds, [4000]);
    assert.equal(h.calls.usage, 0);
    assert.equal(h.calls.successes, 0);
    assert.equal(h.calls.releases, 1);
  }
}

async function main() {
  await checkVariant('p2');
  await checkVariant('p3');
  await checkThirtyOneSecondsRejectedBeforeCharge();
  await checkFailuresRefundTheExistingPackagePrice();
  console.log('Kling MC P2/P3 Edanbot route, 30s cap, package prices, delivery and refunds passed.');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
