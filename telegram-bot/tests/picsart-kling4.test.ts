import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import * as picsart from '../src/picsart';
import { buildKling4Params, KLING4_CREDITS } from '../src/picsart-kling4';
import { buildKling4OmniParams } from '../src/picsart-kling4-omni';

const backend = fs.readFileSync(path.resolve(__dirname, '../src/picsart.ts'), 'utf8');
const app = fs.readFileSync(path.resolve(__dirname, '../src/index.ts'), 'utf8');
const models = ['kling_v4', 'kling_v4_t2v', 'kling_v4_omni'] as const;
const image = 'https://cdn.example.test/reference.jpg';
const output = 'https://cdn.example.test/kling4-result.mp4';
const compile = (code: string) => ts.transpileModule(code, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function fragment(source: string, start: string, end: string) {
  const a = source.indexOf(start), b = source.indexOf(end, a + start.length);
  assert.ok(a >= 0 && b > a, `Production block exists: ${start}`);
  return source.slice(a, b);
}

function parameterTests() {
  for (const model of models) {
    const t2v = model === 'kling_v4_t2v';
    const omni = model === 'kling_v4_omni';
    assert.equal(picsart.PICSART_I2V_MODELS[model].workflowPath, omni ? 'kling-omni-video' : t2v ? 'kling-text-to-video' : 'kling-image-to-video');
    assert.equal(picsart.PICSART_I2V_MODELS[model].pool, null);
    assert.equal(picsart.PICSART_I2V_MODELS[model].pollAttempts, 360);
    assert.equal(picsart.shouldExportPicsartI2v(model), false);
    for (const ratio of ['9:16', '16:9'] as const) {
      const p = picsart.buildPicsartI2vParams(model, ' A landscape ', t2v ? '' : image, { ratio }) as any;
      assert.equal(p.prompt, 'A landscape');
      assert.equal(p.model_name, omni ? 'kling-v4-omni' : 'kling-v4');
      assert.equal(p.duration, '30');
      assert.equal(p.resolution, '720p');
      assert.equal(p.aspect_ratio, ratio);
      assert.equal(p.image, t2v || omni ? undefined : image);
      if (omni) {
        assert.deepEqual(p.image_list, [{ image_url: image }]);
        for (const field of ['sound', 'mode', 'multi_shot', 'shot_type', 'video_list']) {
          assert.equal(p[field], undefined, `Do not invent Omni request fields: ${field}`);
        }
      } else assert.equal(p.image_list, undefined);
      const metadata = JSON.parse(p.options.drive.attributes.aiSDKPayload);
      assert.equal(metadata.duration, 30);
      assert.equal(metadata.resolution, '720p');
      assert.equal(metadata.aspectRatio, ratio);
      assert.equal(p.options.drive.attributes.model, omni ? 'kling-v4-omni' : 'kling-v4');
      if (omni) {
        assert.deepEqual(metadata.imageUrls, [image]);
        assert.equal(metadata.referType, 'feature');
        assert.equal(metadata.generateAudio, undefined);
        assert.equal(p.options.inputs_transformation.downscale_oversized_images, true);
      }
    }
  }
  assert.throws(() => buildKling4Params({ mode: 'i2v', prompt: 'a', ratio: '9:16' }), /IMAGE_REQUIRED/);
  assert.throws(() => buildKling4Params({ mode: 't2v', prompt: 'a', ratio: '9:16', imageUrl: image }), /UNEXPECTED_IMAGE/);
  assert.throws(() => buildKling4Params({ mode: 't2v', prompt: '', ratio: '9:16' }), /INVALID_INPUT/);
  assert.throws(() => buildKling4Params({ mode: 't2v', prompt: 'a', ratio: '4:3' as any }), /INVALID_INPUT/);
  for (const imageUrl of ['', 'http://example.test/photo.jpg', 'https://user:pass@example.test/photo.jpg']) {
    assert.throws(() => buildKling4OmniParams({ prompt: 'a', ratio: '9:16', imageUrl }), /IMAGE_REQUIRED/);
  }
  assert.throws(() => buildKling4OmniParams({ prompt: '', ratio: '9:16', imageUrl: image }), /INVALID_INPUT/);
  assert.throws(() => buildKling4OmniParams({ prompt: 'a', ratio: '4:3' as any, imageUrl: image }), /INVALID_INPUT/);
  assert.equal(picsart.buildPicsartI2vParams('kling_omni', 'a', image).model_name, 'kling-v3-omni', 'Existing Omni v3 is unchanged');
}

async function backendTest(model: typeof models[number], outcome = 'success') {
  const t2v = model === 'kling_v4_t2v';
  const omni = model === 'kling_v4_omni';
  const workflow = omni ? 'kling-omni-video' : `kling-${t2v ? 'text' : 'image'}-to-video`;
  const events = { accounts: 0, uploads: 0, quotes: 0, posts: 0, gets: 0, dead: 0 };
  const context = vm.createContext({
    exports: {}, Buffer, PICSART_I2V_MODELS: picsart.PICSART_I2V_MODELS,
    PICSART_I2V_MAX_IMAGES: 5, KLING4_CREDITS,
    buildPicsartI2vParams: picsart.buildPicsartI2vParams,
    buildKling4OmniParams,
    extractPicsartVideoUrl: picsart.extractPicsartVideoUrl,
    isPicsartPostSubmitAuthFailure: picsart.isPicsartPostSubmitAuthFailure,
    API_BASE: 'https://api.picsart.com', X_APP_AUTHORIZATION: 'fixture-app-token',
    ERR_INSUFFICIENT_CREDITS: 'PICSART_INSUFFICIENT_CREDITS',
    setTimeout: (fn: () => void) => fn(), console: { log() {} },
    commonHeaders: (headers: any) => headers,
    ok2xx: (status: number) => status >= 200 && status < 300,
    getAccessToken: async () => 'fixture-access-token',
    getCredits: async (id: number) => ({ credits: outcome === 'unknown-credits' ? NaN : outcome === 'no-credits' || (outcome === 'low-first' && id === 7) ? 10 : 200 }),
    runWithAccount: async (_id: number, pool: unknown, fn: any) => {
      assert.equal(pool, null);
      for (const id of [7, 8]) {
        events.accounts++;
        try { return await fn(id); } catch (error) {
          if (String(error).includes('PICSART_INSUFFICIENT_CREDITS')
            || String(error).includes('PICSART_AUTH_DEAD')) continue;
          throw error;
        }
      }
      throw Error('PICSART_NO_CREDENTIAL');
    },
    uploadFile: async (_id: number, _bytes: Buffer, _name: string, _mime: string, config: any) => {
      assert.equal(t2v, false); assert.equal(config.gateway, true);
      events.uploads++; return image;
    },
    q: async () => { events.dead++; }, notifyOwner() {},
    isTransientPicsartNetworkError: (error: any) => error.code === 'ECONNRESET',
    PollDiag: class {
      note(r: any) { if (r.status === 401) throw Error('PICSART_AUTH_DEAD'); return r.status === 200; }
      timeoutError() { return Error('PICSART_TIMEOUT'); }
    },
    http: {
      post: async (url: string, body: any, config: any) => {
        if (url.endsWith('/options')) {
          events.quotes++;
          assert.equal(omni, true);
          assert.equal(url, 'https://api.picsart.com/gw-v2/workflows/kling-omni-video/options');
          assert.equal(config.headers.authorization, 'Bearer fixture-access-token');
          assert.equal(body.params.model_name, 'kling-v4-omni');
          assert.equal(body.params.duration, '30');
          assert.equal(body.params.resolution, '720p');
          assert.equal(body.params.image_list[0].image_url, image);
          assert.equal(body.params.options, undefined);
          if (outcome === 'quote-timeout') throw Error('ETIMEDOUT');
          return {
            status: outcome === 'quote-http' ? 422 : 201,
            data: { response: { credits: outcome === 'quote-invalid' ? undefined : 120 } },
          };
        }
        events.posts++;
        assert.equal(url, `https://api.picsart.com/gw-v2/workflows/${workflow}/submit`);
        assert.equal(config.headers.authorization, 'Bearer fixture-access-token');
        assert.equal(body.params.model_name, omni ? 'kling-v4-omni' : 'kling-v4');
        assert.equal(body.params.image, t2v || omni ? undefined : image);
        if (omni) assert.equal(body.params.image_list[0].image_url, image);
        assert.equal(body.params.duration, '30');
        if (outcome === 'submit-timeout') throw Error('ETIMEDOUT');
        if (outcome === 'submit-error') return { status: 500, data: { message: 'PICSART_INSUFFICIENT_CREDITS' } };
        return { status: 201, data: { response: { id: outcome === 'no-id' ? undefined : 'job-kling4' } } };
      },
      get: async (url: string) => {
        events.gets++;
        assert.equal(url, `https://api.picsart.com/gw-v2/workflows/${workflow}/job-kling4/result`);
        if (outcome === 'poll-auth') return { status: 401, data: {} };
        if (outcome === 'poll-credits') throw Error('PICSART_INSUFFICIENT_CREDITS');
        if (outcome === 'result-failed') return { status: 200, data: { response: { status: 'FAILED' } } };
        if (outcome === 'result-http') return { status: 422, data: { status: 'error', message: 'Invalid request' } };
        if (outcome === 'transient' && events.gets === 1) throw Object.assign(Error('reset'), { code: 'ECONNRESET' });
        return { status: 200, data: { status: 'success', response: {
          status: events.gets === 1 ? 'IN_PROGRESS' : 'COMPLETED',
          result: events.gets === 1 ? null : { url: output, duration: '30.041', mimeType: 'video/mp4' },
          usage: { credits: 90 },
        } } };
      },
    },
  });
  const blocks = [
    fragment(backend, 'async function submitPicsartI2v(', 'export function getPicsartI2vExportSize('),
    fragment(backend, 'async function pollPicsartI2vResult(', 'async function submitSeedanceVideoEdit('),
    fragment(backend, 'export async function generatePicsartI2v(', '// ─── Seedream 2.7'),
  ];
  vm.runInContext(compile(blocks.join('\n')), context);
  const promise = context.exports.generatePicsartI2v({
    userId: 2, model, prompt: 'A landscape', ratio: '16:9',
    images: t2v ? [] : [{ buffer: Buffer.from('photo'), name: 'reference.jpg', mime: 'image/jpeg' }],
  });
  if (['success', 'low-first', 'transient'].includes(outcome)) {
    assert.equal((await promise).url, output);
  } else await assert.rejects(promise);
  const preflightFailure = ['no-credits', 'unknown-credits', 'quote-http', 'quote-invalid', 'quote-timeout'].includes(outcome);
  assert.equal(events.posts, preflightFailure ? 0 : 1, 'Never replay a paid/ambiguous submit');
  assert.equal(events.accounts, ['low-first', 'no-credits'].includes(outcome) ? 2 : 1);
  assert.equal(events.uploads, omni
    ? (['low-first', 'no-credits'].includes(outcome) ? 2 : 1)
    : t2v || ['no-credits', 'unknown-credits'].includes(outcome) ? 0 : 1);
  assert.equal(events.quotes, omni ? events.accounts : 0);
  assert.equal(events.dead, outcome === 'poll-auth' ? 1 : 0);
}

async function wizardTest(model: typeof models[number], ratio: '9:16' | '16:9') {
  const t2v = model === 'kling_v4_t2v';
  const price = model === 'kling_v4_omni' ? 8500 : 8000;
  const state: any = { mode: 'idle', dbUserId: 2, picsartI2vImageUrl: image, picsartI2vImageUrls: [image] };
  const messages: string[] = [], calls: any[][] = [];
  const ctx = vm.createContext({
    picsart, session: state, userId: 1, fileUrl: image, MODEL_PRICES: { picsart_kling4: 8000, picsart_kling4_omni: 8500 },
    ctx: { chat: { id: 5 }, message: { text: 'A landscape' },
      reply: async (text: string) => { messages.push(text); return { message_id: 6 }; },
      editMessageText: async (text: string) => { messages.push(text); },
      answerCbQuery: async () => {} },
    getSession: () => state, setSession: (_id: number, patch: any) => Object.assign(state, patch),
    requireLogin: async () => true, isPicsartI2vModelKey: (key: string) => key in picsart.PICSART_I2V_MODELS,
    supportsMultiplePicsartI2vImages: () => false,
    picsartI2vRatioKeyboard: () => ({}), picsartI2vPublicSettings: (_model: string, settings: string) => settings,
    formatRupiah: (n: number) => `Rp${n}`, getCooldownRemainingMs: () => 0,
    runPicsartI2v: async (...args: any[]) => { calls.push(args); }, console: { error() {} },
  });
  vm.runInContext(compile(fragment(app, 'function getPicsartI2vPrice(', '\n//')), ctx);
  const run = async (code: string) => vm.runInContext(compile(`(async () => { ${code} })()`), ctx);
  ctx.data = `mode_pi2v_${model}`;
  await run(fragment(app, "if (data.startsWith('mode_pi2v_')) {", "if (data === 'mode_kling')"));
  assert.equal(state.mode, 'picsart_i2v_wait_ratio');
  assert.equal(state.picsartI2vImageUrl, undefined);
  assert.equal(state.picsartI2vImageUrls, undefined);
  ctx.data = ratio === '16:9' ? 'picsart_ratio_169' : 'picsart_ratio_916';
  const ratioBranch = fragment(app, "if (data.startsWith('picsart_ratio_')) {", "if (data === 'picsart_i2v_add_photo')");
  await run(ratioBranch);
  assert.equal(state.mode, t2v ? 'picsart_i2v_wait_prompt' : 'picsart_i2v_wait_image');
  assert.ok(messages.at(-1)!.includes(`Rp${price}`));
  if (!t2v) {
    await run(fragment(app, "if (session.mode === 'picsart_i2v_wait_image')", "if (session.mode === 'oneover_wait_image')"));
    assert.equal(state.mode, 'picsart_i2v_wait_prompt');
  } else assert.match(messages.at(-1)!, /Tidak perlu foto/);
  const promptBranch = fragment(app, "if (session.mode === 'picsart_i2v_wait_prompt')", '// ── OneOver Seedance 2.5 image-to-video prompt');
  await run(promptBranch);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][5].model, model);
  assert.equal(calls[0][5].ratio, ratio);
  assert.deepEqual(Array.from(calls[0][5].imageUrls), t2v ? [] : [image]);
  assert.equal(state.mode, 'idle');
  await run(promptBranch); await run(ratioBranch);
  assert.equal(calls.length, 1, 'Stale prompt/ratio events cannot submit another job');
}

async function billingTest(model: typeof models[number], outcome: string) {
  const price = model === 'kling_v4_omni' ? 8500 : 8000;
  const events = { charges: [] as number[], refunds: [] as number[], deliveries: 0, released: 0, success: 0 };
  const ctx = vm.createContext({
    picsart: { ...picsart, generatePicsartI2v: async (input: any) => {
      assert.equal(input.model, model);
      assert.equal(input.images.length, model === 'kling_v4_t2v' ? 0 : 1);
      if (outcome === 'provider') throw Error('PICSART_KLING4_POST_SUBMIT_FAILED');
      return { url: output, credits: 90 };
    } },
    MODEL_PRICES: { picsart_kling4: 8000, picsart_kling4_omni: 8500 },
    customerSafeModelLabel: (name: string) => name, isSeedance2I2vModel: () => false,
    supportsMultiplePicsartI2vImages: () => false,
    downloadBuffer: async () => ({ buf: Buffer.from('photo'), ext: 'jpg', mime: 'image/jpeg' }),
    beginCharge: async (_id: number, amount: number) => {
      events.charges.push(amount); return { ok: outcome !== 'insufficient', reason: 'insufficient' };
    },
    chargeFailMsg: () => 'Saldo kurang', describeError: (e: any) => e.message, formatRupiah: String,
    addSaldo: async (_id: number, amount: number) => { events.refunds.push(amount); },
    releaseGenerating: () => { events.released++; }, markGenSuccess: () => { events.success++; },
    incrementKlingUsage: async () => 1,
    bot: { telegram: { editMessageText: async () => {}, deleteMessage: async () => {}, sendMessage: async () => {} } },
    upscaleGeneratedVideo: async () => { throw Error('Kling 4 must never use finishing'); },
    sendResult: async (_chat: number, url: string, caption: string) => {
      events.deliveries++; assert.equal(url, output); assert.match(caption, /720p native/);
      assert.doesNotMatch(caption, /1080|Renderful|Picsart/i); return outcome !== 'delivery';
    },
    console: { log() {}, error() {}, warn() {} },
  });
  vm.runInContext(compile(fragment(app, 'function getPicsartI2vPrice(', '\n//')), ctx);
  vm.runInContext(compile(fragment(app, 'async function runPicsartI2v(', '// ─── Background: Native Picsart Seedance 2.5')), ctx);
  await ctx.runPicsartI2v(1, 2, 3, 4, 'A landscape', { model, imageUrls: model === 'kling_v4_t2v' ? [] : [image], ratio: '16:9' });
  assert.deepEqual(events.charges, [price]);
  assert.deepEqual(events.refunds, ['success', 'insufficient'].includes(outcome) ? [] : [price]);
  assert.equal(events.released, outcome === 'insufficient' ? 0 : 1);
  assert.equal(events.success, outcome === 'success' ? 1 : 0);
  assert.equal(events.deliveries, ['success', 'delivery'].includes(outcome) ? 1 : 0);
}

async function main() {
  parameterTests();
  for (const model of models) {
    for (const outcome of ['success', 'low-first', 'no-credits', 'unknown-credits', 'transient', 'submit-timeout', 'submit-error', 'no-id', 'poll-auth', 'poll-credits', 'result-failed', 'result-http']) {
      await backendTest(model, outcome);
    }
    if (model === 'kling_v4_omni') {
      for (const outcome of ['quote-http', 'quote-invalid', 'quote-timeout']) await backendTest(model, outcome);
    }
    for (const ratio of ['9:16', '16:9'] as const) await wizardTest(model, ratio);
    for (const outcome of ['success', 'provider', 'delivery', 'insufficient']) await billingTest(model, outcome);
    assert.ok(app.includes(`'mode_pi2v_${model}'`), 'Both modes have a menu button');
  }
  assert.match(app, /picsart_kling4:\s*8000/);
  assert.match(app, /picsart_kling4_omni:\s*8500/);
  assert.ok(app.includes('• Kling 4 Omni (30 detik · 720p)'));
  console.log('Kling 4 I2V/T2V and Omni: HAR payloads, gateway upload/submit/poll, quote-based Omni credit preflight, no paid replay, both ratio wizards, Rp8000/Rp8500 billing/refunds and native delivery passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
