import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import sharp from 'sharp';
import { generateBananaRenderful, type BananaApi, type BananaModel } from '../src/banana-renderful';

const source = fs.readFileSync(path.resolve(__dirname, '../src/index.ts'), 'utf8');
const models: BananaModel[] = ['nano-banana-pro', 'nano-banana-2', 'nano-banana-2-lite'];
const prices = { nb_pro: 11, nb_2: 22, nb_2lite: 33 }; // Distinct fixtures detect price cross-wiring.
const keys = ['nb_pro', 'nb_2', 'nb_2lite'] as const;
const images = [{ buffer: Buffer.from('fixture'), name: 'photo.png', mime: 'image/png' }];
function compile(text: string) {
  return ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
}
function apiHarness(failure?: string) {
  const events = { submits: [] as any[], polls: 0, hosts: 0, dead: [] as string[] };
  const api: BananaApi = {
    getKey: async skip => failure === 'no-key' ? null : ['one', 'two'].find(key => !skip.has(key)) ?? null,
    markDead: async key => { events.dead.push(key); },
    rejectedKey: error => (error as any)?.response?.status === 402,
    host: async () => { events.hosts++; return 'https://our-domain.test/dl/image.png'; },
    submit: async (key, body) => {
      events.submits.push({ key, body });
      if (failure === 'pre-billing' && key === 'one') throw Object.assign(Error('insufficient'), { response: { status: 402 } });
      if (failure === 'timeout') throw Error('ETIMEDOUT');
      return failure === 'no-id' ? '' : 'job';
    },
    poll: async () => {
      events.polls++;
      if (failure === 'poll-auth') throw Object.assign(Error('unauthorized'), { response: { status: 402 } });
      if (failure === 'provider') throw Error('provider failed');
      return 'https://provider.test/4k.png';
    },
    status: async () => {},
  };
  return { events, api };
}
async function contractTests() {
  for (const model of models) for (const mode of ['t2i', 'i2i'] as const) {
    const h = apiHarness();
    await generateBananaRenderful({ model, mode, prompt: 'draw or edit', ratio: '9:16', images: mode === 'i2i' ? [...images, ...images] : [] }, h.api);
    assert.equal(h.events.submits.length, 1);
    const body = h.events.submits[0].body;
    assert.equal(body.model, `${model === 'nano-banana-pro' ? model : 'nano-banana-2'}${mode === 'i2i' ? '-i2i' : ''}`);
    assert.equal(body.type, mode === 't2i' ? 'text-to-image' : 'image-to-image');
    assert.equal(body.resolution, '4k');
    assert.equal(body.num_outputs, 1);
    assert.equal(h.events.hosts, mode === 'i2i' ? 2 : 0);
    assert.equal(body.images?.length ?? 0, mode === 'i2i' ? 2 : 0);
  }
  for (const failure of ['no-key', 'timeout', 'no-id', 'poll-auth', 'provider']) {
    const h = apiHarness(failure);
    await assert.rejects(generateBananaRenderful({ model: models[0], mode: 't2i', prompt: 'draw', ratio: '1:1', images: [] }, h.api));
    assert.equal(h.events.submits.length, failure === 'no-key' ? 0 : 1, 'Never replay ambiguous or accepted paid jobs');
    assert.deepEqual(h.events.dead, failure === 'poll-auth' ? ['one'] : []);
  }
  const rotate = apiHarness('pre-billing');
  await generateBananaRenderful({ model: models[1], mode: 'i2i', prompt: 'edit', ratio: '1:1', images }, rotate.api);
  assert.deepEqual(rotate.events.dead, ['one']);
  assert.equal(rotate.events.hosts, 1, 'Reuse safely hosted references after an explicit rejected submit');
  assert.equal(rotate.events.submits[1].key, 'two');
  const invalid = apiHarness();
  await assert.rejects(generateBananaRenderful({ model: models[0], mode: 'i2i', prompt: 'edit', ratio: '1:1', images: [] }, invalid.api));
  assert.equal(invalid.events.submits.length, 0);
}
async function billingTests() {
  const from = source.indexOf('async function runImage(');
  const to = source.indexOf('// Kirim gambar hasil', from);
  const runSource = source.slice(from, to);
  assert.doesNotMatch(runSource, /snapgenSubmitImage|snapgenPollImage|picsart\./);
  assert.match(runSource, /bytedanceUpscalerHttp\.post/);
  const harFrom = source.indexOf('async function runHarModel(');
  assert.match(source.slice(harFrom, source.indexOf('// ─── Background: Kling Motion V3 Standard', harFrom)), /picsart\.generateHarModel/);
  assert.match(source, /banana21:\s*600/);
  for (let i = 0; i < models.length; i++) for (const mode of ['t2i', 'i2i'] as const) {
    for (const outcome of ['success', 'provider', 'delivery', 'insufficient', 'no-key', 'download', 'low-resolution']) {
      const events = { charges: [] as number[], refunds: [] as number[], submits: 0, hosts: 0, deliveries: 0, releases: 0, success: 0, messages: [] as string[] };
      const context = vm.createContext({
        Buffer, process: { env: {} },
        IMG_MODELS: { model: { model: models[i], label: 'Banana public' } }, MODEL_PRICES: prices,
        beginCharge: async (_id: number, amount: number) => { events.charges.push(amount); return { ok: outcome !== 'insufficient', reason: 'insufficient' }; },
        chargeFailMsg: () => 'Saldo kurang',
        bot: { telegram: {
          editMessageText: async (_chat: number, _id: number, _inline: any, text: string) => { events.messages.push(text); },
          sendMessage: async (_chat: number, text: string) => { events.messages.push(text); },
          deleteMessage: async () => {},
        } },
        downloadBuffer: async () => {
          if (outcome === 'download') throw Error('download failed');
          return { buf: Buffer.from('reference'), mime: 'image/png', ext: 'png' };
        },
        sharp: () => ({ metadata: async () => ({ format: 'png' }) }),
        generateBananaRenderful,
        getNextRenderfulPoolKey: async () => outcome === 'no-key' ? null : 'fixture-key',
        markRenderfulPoolKeyDead: async () => {},
        isKeyExhaustedError: () => false, describeError: (error: any) => error.message,
        publishMedia: async () => { events.hosts++; return 'https://our-domain.test/dl/reference.png'; },
        RENDERFUL_BASE: 'https://api.renderful.ai/api/v1',
        bytedanceUpscalerHttp: { post: async (url: string, body: any, options: any) => {
          events.submits++;
          assert.equal(url, 'https://api.renderful.ai/api/v1/generations');
          assert.equal(options.headers.Authorization, 'Bearer fixture-key');
          assert.equal(body.resolution, '4k');
          assert.equal(body.type, mode === 'i2i' ? 'image-to-image' : 'text-to-image');
          if (outcome === 'provider') throw Error('Renderful internal provider failed');
          return { data: { id: 'job' } };
        } },
        pollForResult: async (id: string, user: number, key: string) => {
          assert.deepEqual([id, user, key], ['job', 2, 'fixture-key']);
          return 'https://provider.test/output.png';
        },
        sendImageResult: async (_chat: number, _url: string, caption: string, require4k: boolean) => {
          events.deliveries++; assert.equal(require4k, true); assert.match(caption, /4K/);
          return !['delivery', 'low-resolution'].includes(outcome);
        },
        addSaldo: async (_id: number, amount: number) => { events.refunds.push(amount); },
        incrementKlingUsage: async () => 1, markGenSuccess: () => { events.success++; },
        releaseGenerating: () => { events.releases++; }, formatRupiah: (n: number) => String(n),
        console: { log() {}, error() {} },
      });
      vm.runInContext(compile(runSource), context);
      await context.runImage(1, 2, 3, 4, 'draw', { model: models[i], priceKey: keys[i], inputMode: mode, ratio: '1:1', imageUrls: mode === 'i2i' ? ['https://api.telegram.org/file/botPRIVATE/photo'] : [] });
      const failed = outcome !== 'success' && outcome !== 'insufficient' && !(mode === 't2i' && outcome === 'download');
      assert.deepEqual(events.charges, [prices[keys[i]]]);
      assert.deepEqual(events.refunds, failed ? [prices[keys[i]]] : []);
      assert.equal(events.releases, outcome === 'insufficient' ? 0 : 1);
      assert.doesNotMatch(events.messages.join(' '), /Renderful|SnapGen|Picsart|PRIVATE/i);
      if (['success', 'delivery', 'low-resolution'].includes(outcome)) assert.equal(events.deliveries, 1);
    }
  }
}
async function deliveryTests() {
  const from = source.indexOf('async function sendImageResult(');
  const to = source.indexOf('// ─── Background: Gemini Omni', from);
  for (const width of [1024, 4096]) for (const fallback of [false, true]) {
    const buf = await sharp({ create: { width, height: width, channels: 3, background: 'white' } }).png().toBuffer();
    let photos = 0, documents = 0, hosted = 0;
    const context = vm.createContext({
      Buffer, sharp, console: { log() {}, error() {} }, describeError: String,
      telegramHttp: { get: async () => ({ data: buf }) },
      bot: { telegram: {
        sendPhoto: async () => { photos++; },
        sendDocument: async (_chat: number, media: any) => { documents++; assert.deepEqual(media.source, buf); if (fallback) throw Error('upload failed'); },
        sendMessage: async () => {},
      } },
      publishMedia: async (bytes: Buffer) => { hosted++; assert.deepEqual(bytes, buf); return 'https://our-domain.test/dl/output.png'; },
    });
    vm.runInContext(compile(source.slice(from, to)), context);
    assert.equal(await context.sendImageResult(1, 'https://provider.test/image.png', '4K image', true), width >= 3840);
    assert.equal(photos, 0, 'Never compress a 4K result through sendPhoto');
    assert.equal(documents, width >= 3840 ? 1 : 0);
    assert.equal(hosted, width >= 3840 && fallback ? 1 : 0);
  }
}
async function main() {
  await contractTests();
  await billingTests();
  await deliveryTests();
  console.log('Banana Pro/2/Lite Renderful: T2I/I2I, 4K, full-resolution delivery, independent prices/refunds, no replay and unchanged Banana 2.1 passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
