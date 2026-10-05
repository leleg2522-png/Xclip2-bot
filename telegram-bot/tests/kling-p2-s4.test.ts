import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

assert.match(source, /kling_p2:\s*4000/);
assert.match(source, /kling_p3:\s*4000/);
assert.match(source, /mode_klingp2/);
assert.match(source, /Kling MC V3 PRO P2/);
const modelMatches = source.match(/model:\s*'kling-motion-26-pro'/g) ?? [];
assert.equal(modelMatches.length, 2, 'P2 and P3 must both use the latest HAR-verified model');
assert.doesNotMatch(source, /kling-motion-26-pro--secondary/);
assert.match(source, /const edanbotHttp = axios\.create\(\{ timeout: 120_000, proxy: false \}\)/);
assert.match(source, /origin: 'https:\/\/edanbot\.digital'/);
assert.match(source, /referer: 'https:\/\/edanbot\.digital\/dashboard'/);
assert.match(source, /const PRICE = variant\.price/);
assert.match(source, /let submitted = false/);
assert.match(source, /if \(submitted\)/);
assert.match(source, /const EDANBOT_JOB_TIMEOUT_MS = 20 \* 60 \* 1000/);
assert.match(source, /pollEdanbotJob\(cookie, jobId, EDANBOT_JOB_TIMEOUT_MS\)/);
assert.match(source, /klingP2VideoFileId:[\s\S]*mode: 'klingp2_wait_prompt'/);
assert.match(source, /klingP3VideoFileId:[\s\S]*mode: 'klingp3_wait_prompt'/);
assert.match(source, /Kirim \*prompt teks\* \(deskripsi gerakan\/adegan\)/);
assert.match(source, /runKlingP2\(ctx\.chat\.id, userId, session\.dbUserId!, statusMsg\.message_id, characterUrlP2, videoFileIdP2, videoDurationP2, prompt\)/);
assert.match(source, /runKlingP3\(ctx\.chat\.id, userId, session\.dbUserId!, statusMsg\.message_id, characterUrlP3, videoFileIdP3, videoDurationP3, prompt\)/);
assert.match(source, /const prompt = raw === '-' \? '' : raw/g);
assert.match(source, /fields: \{\s*prompt,\s*image_url:/);

// Sanitized response shape from the supplied HAR. The provider is returned by
// Edanbot, not a client-side generate parameter; never expose it to customers.
const harCompletedJob = {
  status: 'completed',
  model: 'kling-motion-2.6-pro',
  public_model_key: 'kling-motion-26-pro',
  provider: 'dropshot',
  result_url: 'https://cdn.aistudio.dropshot.io/public/jobs/prod/fixture/output/output_0.mp4',
};
const runnerStart = source.indexOf('async function pollEdanbotJob(');
const runnerEnd = source.indexOf('// ─── Background: Picsart Image-to-Video', runnerStart);
assert.ok(runnerStart > 0 && runnerEnd > runnerStart);
const executable = ts.transpileModule(source.slice(runnerStart, runnerEnd), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function harness(failure?: 'poll-auth' | 'submit-timeout' | 'missing-id' | 'delivery') {
  const events = {
    charges: [] as number[],
    refunds: [] as number[],
    releases: [] as number[],
    submissions: [] as any[],
    deliveries: [] as any[],
    messages: [] as string[],
    polls: [] as string[],
    deadCookies: [] as number[],
  };
  const context = vm.createContext({
    MODEL_PRICES: { kling_p2: 4000, kling_p3: 4000 },
    EDANBOT_JOB_TIMEOUT_MS: 20 * 60 * 1000,
    console: { log() {}, error() {} },
    setTimeout: (callback: () => void) => callback(),
    beginCharge: async (_: number, price: number, limit: number) => {
      assert.equal(limit, 3);
      events.charges.push(price);
      return { ok: true };
    },
    bot: { telegram: {
      getFileLink: async () => new URL('https://example.test/reference.mp4'),
      editMessageText: async (_: any, __: any, ___: any, text: string) => { events.messages.push(text); },
      sendMessage: async (_: any, text: string) => { events.messages.push(text); },
      deleteMessage: async () => {},
    } },
    downloadBuffer: async () => ({ buf: Buffer.from('fixture'), mime: 'image/jpeg', ext: 'jpg' }),
    detectVideoType: () => ({ mime: 'video/mp4', ext: 'mp4' }),
    getAvailableEdanbotCookies: async () => [{ id: 1, cookie: 'fixture-a' }, { id: 2, cookie: 'fixture-b' }],
    uploadToEdanbot: async (_: string, __: Buffer, name: string, mime: string) => ({
      type: mime.startsWith('video') ? 'video' : 'image',
      url: `https://example.test/${name}`, name, size: 10,
    }),
    edanbotHttp: {
      post: async (url: string, body: any) => {
        assert.equal(url, 'https://edanbot.digital/api/generate');
        assert.equal(body.model, harCompletedJob.public_model_key);
        assert.equal(body.provider, undefined, 'provider routing must not be guessed from a poll response');
        events.submissions.push(body);
        if (failure === 'submit-timeout') throw new Error('timeout of 120000ms exceeded');
        return { data: failure === 'missing-id' ? {} : { job_id: 'fixture-job' } };
      },
      get: async (url: string) => {
        events.polls.push(url);
        assert.equal(url, 'https://edanbot.digital/api/jobs/fixture-job');
        if (failure === 'poll-auth') throw new Error('Request failed with status code 401');
        return { data: events.polls.length === 1 ? { status: 'running' } : harCompletedJob };
      },
    },
    sendResult: async (_: number, url: string, caption: string, video: boolean) => {
      assert.equal(video, true);
      events.deliveries.push({ url, caption });
      return failure !== 'delivery';
    },
    incrementKlingUsage: async () => {},
    markGenSuccess: () => {},
    markEdanbotCookieDead: async (id: number) => { events.deadCookies.push(id); },
    addSaldo: async (_: number, price: number) => { events.refunds.push(price); },
    releaseGenerating: (id: number) => { events.releases.push(id); },
    describeError: (err: any) => String(err?.message ?? err),
    formatRupiah: (price: number) => `Rp${price}`,
  });
  vm.runInContext(executable, context);
  return {
    events,
    run: (variant: 'P2' | 'P3') => context[`runKling${variant}`](
      9, 9, 7, 88, 'https://example.test/character.jpg', 'fixture-video', 8, 'fixture prompt'
    ) as Promise<void>,
  };
}

async function main() {
  for (const variant of ['P2', 'P3'] as const) {
    const success = harness();
    await success.run(variant);
    const e = success.events;
    assert.deepEqual(e.charges, [4000]);
    assert.equal(e.submissions.length, 1);
    assert.equal(e.submissions[0].fields.prompt, 'fixture prompt');
    assert.equal(e.submissions[0].fields.reference_video_duration, 8);
    assert.equal(e.submissions[0].fields.character_orientation, 'video');
    assert.equal(e.submissions[0].fields.keep_original_sound, true);
    assert.equal(e.submissions[0].fields.image_url.type, 'image');
    assert.equal(e.submissions[0].fields.video_url.type, 'video');
    assert.equal(e.deliveries[0].url, harCompletedJob.result_url);
    assert.match(e.deliveries[0].caption, new RegExp(variant));
    assert.doesNotMatch(e.messages.join(' ') + e.deliveries[0].caption, /edanbot|dropshot|roboneo|fixture-a|fixture-b/i);
    assert.deepEqual(e.refunds, []);
    assert.deepEqual(e.releases, [7]);
    for (const failure of ['poll-auth', 'submit-timeout', 'missing-id', 'delivery'] as const) {
      const failed = harness(failure);
      await failed.run(variant);
      assert.equal(failed.events.submissions.length, 1, 'accepted or ambiguous paid submit must not be repeated');
      assert.deepEqual(failed.events.refunds, [4000]);
      assert.deepEqual(failed.events.releases, [7]);
      assert.doesNotMatch(failed.events.messages.join(' '), /edanbot|dropshot|roboneo|401|120000/i);
    }
  }
  console.log('Kling P2/P3 HAR model, Dropshot result delivery, prices, prompts and no-resubmit/refund checks passed.');
}

main().catch(error => { console.error(error); process.exitCode = 1; });