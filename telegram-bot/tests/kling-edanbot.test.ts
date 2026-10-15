import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(path.resolve(__dirname, '../src/index.ts'), 'utf8');
const MODEL = 'kling-motion-26-pro--secondary';
const prices = { kling_p2: 4000, kling_p3: 4000 };

function compile(text: string) {
  return ts.transpileModule(text, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
}

async function wrapperTests() {
  const from = source.indexOf('async function runKlingP2(');
  const to = source.indexOf('// ─── Background: Picsart Image-to-Video', from);
  assert.ok(from >= 0 && to > from);
  const calls: any[][] = [];
  const ctx = vm.createContext({
    EDANBOT_KLING_MC_MODEL: MODEL,
    MODEL_PRICES: prices,
    runKlingEdanbot: async (...args: any[]) => { calls.push(args); },
  });
  vm.runInContext(compile(source.slice(from, to)), ctx);

  await ctx.runKlingP2(1, 2, 3, 4, 'photo-url', 'video-id', 12, 'move P2');
  await ctx.runKlingP3(5, 6, 7, 8, 'photo-url-2', 'video-id-2', 14, 'move P3');
  assert.equal(JSON.stringify(calls), JSON.stringify([
    [1, 2, 3, 4, 'photo-url', 'video-id', 12, 'move P2',
      { label: 'Kling MC V3 PRO P2', model: MODEL, price: prices.kling_p2 }],
    [5, 6, 7, 8, 'photo-url-2', 'video-id-2', 14, 'move P3',
      { label: 'Kling MC V3.0 PRO P3', model: MODEL, price: prices.kling_p3 }],
  ]));
}

class TestFormData {
  parts: any[] = [];
  append(...args: any[]) { this.parts.push(args); }
  getHeaders() { return { 'content-type': 'multipart/form-data; boundary=test' }; }
}

async function runnerTest(variant: 'p2' | 'p3', failure?: 'submit-timeout' | 'poll-auth' | 'delivery') {
  const price = prices[variant === 'p2' ? 'kling_p2' : 'kling_p3'];
  const label = variant === 'p2' ? 'Kling MC V3 PRO P2' : 'Kling MC V3.0 PRO P3';
  const events = {
    charges: [] as number[], refunds: [] as number[], dead: [] as number[],
    uploads: [] as any[], submissions: [] as any[], polls: [] as string[],
    deliveries: [] as any[], usage: 0, successes: 0,
    statuses: [] as string[], messages: [] as string[], fileLinks: [] as string[],
  };
  const imageBytes = Buffer.from('fixture-image');
  const videoBytes = Buffer.from('fixture-video');
  const uploadRequests: any[] = [];
  const generateRequests: any[] = [];
  const ctx = vm.createContext({
    Buffer,
    FormData: TestFormData,
    EDANBOT_JOB_TIMEOUT_MS: 20 * 60 * 1000,
    MODEL_PRICES: prices,
    beginCharge: async (_id: number, amount: number) => {
      events.charges.push(amount);
      return { ok: true };
    },
    chargeFailMsg: () => 'insufficient saldo',
    bot: { telegram: {
      editMessageText: async (_chat: number, _msg: number, _inline: unknown, text: string) => { events.statuses.push(text); },
      sendMessage: async (_chat: number, text: string) => { events.messages.push(text); },
      deleteMessage: async () => {},
      getFileLink: async (id: string) => {
        events.fileLinks.push(id);
        return { href: `https://telegram.test/${id}.mp4` };
      },
    } },
    downloadBuffer: async (url: string) => url.includes('photo')
      ? { buf: imageBytes, ext: 'png', mime: 'image/png' }
      : { buf: videoBytes, ext: 'mp4', mime: 'video/mp4' },
    detectVideoType: () => ({ ext: 'mp4', mime: 'video/mp4' }),
    getAvailableEdanbotCookies: async () => [
      { id: 11, cookie: 'session=fixture-one' },
      { id: 12, cookie: 'session=fixture-two' },
    ],
    markEdanbotCookieDead: async (id: number) => { events.dead.push(id); },
    edanbotHttp: {
      post: async (url: string, body: any, config: any) => {
        assert.equal(config.headers.cookie, 'session=fixture-one');
        if (url.endsWith('/api/uploads')) {
          events.uploads.push(body);
          uploadRequests.push({ url, body, contentType: config.headers['content-type'] });
          const n = events.uploads.length;
          return { data: {
            url: `https://edanbot.digital/uploads/asset-${n}`,
            asset: { type: n === 1 ? 'image' : 'video', url: `https://edanbot.digital/uploads/asset-${n}`, name: n === 1 ? 'character.png' : 'driver.mp4', size: n === 1 ? imageBytes.length : videoBytes.length },
          } };
        }
        generateRequests.push({ url, body });
        events.submissions.push(body);
        if (failure === 'submit-timeout') throw new Error('ETIMEDOUT');
        return { data: { job_id: 'accepted-job' } };
      },
    },
    pollEdanbotJob: async (_cookie: string, jobId: string, maxMs: number) => {
      assert.equal(maxMs, 20 * 60 * 1000);
      events.polls.push(jobId);
      if (failure === 'poll-auth') throw new Error('401 Unauthorized');
      return 'https://edanbot.digital/results/native.mp4';
    },
    sendResult: async (_chat: number, url: string, caption: string, isVideo: boolean) => {
      events.deliveries.push({ url, caption, isVideo });
      return failure !== 'delivery';
    },
    incrementKlingUsage: async () => { events.usage++; },
    markGenSuccess: () => { events.successes++; },
    addSaldo: async (_id: number, amount: number) => { events.refunds.push(amount); },
    releaseGenerating: () => {},
    describeError: (error: any) => String(error?.message ?? error),
    formatRupiah: (amount: number) => `Rp${amount}`,
    console: { error() {}, log() {} },
  });

  const uploadStart = source.indexOf('async function uploadToEdanbot(');
  const pollStart = source.indexOf('async function pollEdanbotJob(', uploadStart);
  const runnerStart = source.indexOf('async function runKlingEdanbot(', pollStart);
  const runnerEnd = source.indexOf('async function runKlingP2(', runnerStart);
  assert.ok(uploadStart >= 0 && pollStart > uploadStart && runnerStart > pollStart && runnerEnd > runnerStart);
  const functions = source.slice(uploadStart, pollStart) + source.slice(runnerStart, runnerEnd);
  assert.doesNotMatch(functions, /upscaleGeneratedVideo|1K\/1080p|1080p/);
  assert.doesNotMatch(functions, /console\.log\([^)]*(?:result_url|characterUrl|videoUrl|prompt)/);
  vm.runInContext(compile(functions), ctx);

  await ctx.runKlingEdanbot(
    1, 2, 3, 4, 'photo-id', 'video-id', 14.466667, 'Follow this motion.',
    { label, model: MODEL, price },
  );

  assert.deepEqual(events.charges, [price]);
  assert.deepEqual(events.fileLinks, ['photo-id', 'video-id']);
  assert.deepEqual(events.refunds, failure ? [price] : []);
  assert.equal(events.submissions.length, 1);
  assert.equal(generateRequests.length, 1, 'An ambiguous submit is never retried');
  assert.equal(uploadRequests.length, 2);
  assert.equal(uploadRequests[0].contentType, 'multipart/form-data; boundary=test');
  assert.equal(uploadRequests[0].body.parts[0][0], 'file');
  assert.deepEqual(uploadRequests[0].body.parts[0][1], imageBytes);
  assert.equal(uploadRequests[0].body.parts[0][2].filename, 'character.png');
  assert.equal(uploadRequests[1].body.parts[0][2].filename, 'driver.mp4');
  assert.equal(events.submissions[0].model, MODEL);
  assert.deepEqual(Object.keys(events.submissions[0].fields).sort(), [
    'character_orientation', 'image_url', 'keep_original_sound', 'prompt', 'reference_video_duration', 'video_url',
  ]);
  assert.equal(events.submissions[0].fields.reference_video_duration, 14.466667);
  assert.equal(events.submissions[0].fields.character_orientation, 'video');
  assert.equal(events.submissions[0].fields.keep_original_sound, true);
  assert.equal(events.submissions[0].fields.prompt, 'Follow this motion.');
  assert.equal(events.polls.length, failure === 'submit-timeout' ? 0 : 1);
  assert.equal(events.deliveries.length, ['submit-timeout', 'poll-auth'].includes(failure ?? '') ? 0 : 1);
  assert.equal(events.successes, failure ? 0 : 1);
  assert.equal(events.usage, failure ? 0 : 1);
  if (failure === 'poll-auth') assert.deepEqual(events.dead, [11]);
  else assert.deepEqual(events.dead, []);
  if (!failure) {
    assert.equal(events.deliveries[0].url, 'https://edanbot.digital/results/native.mp4');
    assert.equal(events.deliveries[0].caption, `🎭 ${label}\n\n/menu untuk buat lagi`);
    assert.equal(events.deliveries[0].isVideo, true);
    assert.equal(events.deliveries[0].caption.includes('1080p'), false);
  }
  assert.doesNotMatch(events.statuses.join(' ') + events.messages.join(' '), /Edanbot|edanbot\.digital|provider|dropshot/i);
  return events;
}

async function main() {
  assert.match(source, /EDANBOT_KLING_MC_MODEL\s*=\s*'kling-motion-26-pro--secondary'/);
  assert.match(source, /kling_p2:\s*4000/);
  assert.match(source, /kling_p3:\s*4000/);
  await wrapperTests();
  await runnerTest('p2');
  await runnerTest('p3');
  await runnerTest('p2', 'submit-timeout');
  await runnerTest('p3', 'poll-auth');
  await runnerTest('p3', 'delivery');
  console.log('Edanbot Kling MC P2/P3: HAR payload, independent prices, native delivery, single-submit safety and refunds passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
