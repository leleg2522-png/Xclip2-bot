import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { PICSART_I2V_MODELS } from '../src/picsart';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');
const helpers = source.slice(source.indexOf('function isSeedance2I2vModel('), source.indexOf('function picsartI2vRatioKeyboard('));
const runner = source.slice(source.indexOf('async function runPicsartI2v('), source.indexOf('// ─── Background: Native Picsart Seedance 2.5'));
assert.ok(helpers && runner);
const executable = ts.transpileModule(helpers + runner, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function harness(options: { upscale?: boolean; failDelivery?: boolean; failUpscaledDelivery?: boolean; generationFails?: boolean } = {}) {
  const events = {
    order: [] as string[], charges: [] as number[], refunds: [] as number[],
    releases: [] as number[], successes: [] as number[],
    deliveries: [] as Array<{ chatId: number; url: string; caption: string }>,
    inputs: [] as any[], messages: [] as string[],
  };
  const context = vm.createContext({
    picsart: {
      PICSART_I2V_MODELS, PICSART_I2V_MAX_IMAGES: 5,
      generatePicsartI2v: async (input: any) => {
        events.order.push('generate');
        events.inputs.push(input);
        input.onStatus('poll');
        if (options.generationFails) throw new Error('PICSART_TIMEOUT');
        return { url: `https://example.test/${input.userId}.mp4` };
      },
    },
    console: { log() {}, warn() {}, error() {} },
    MODEL_PRICES: {},
    customerSafeModelLabel: (label: string) => label,
    getPicsartI2vPrice: (model: string) => model === 'seedance_2_mini' ? 3500 : 4000,
    beginCharge: async (_: number, price: number) => { events.charges.push(price); return { ok: true }; },
    chargeFailMsg: () => 'Saldo tidak cukup',
    downloadBuffer: async () => ({ buf: Buffer.from('fixture'), mime: 'image/jpeg' }),
    upscaleGeneratedVideo: async (url: string) => {
      events.order.push('upscale');
      return options.upscale === false ? { url, upscaled: false } : { url: url.replace('.mp4', '-1080.mp4'), upscaled: true };
    },
    sendResult: async (chatId: number, url: string, caption: string) => {
      events.order.push('deliver');
      events.deliveries.push({ chatId, url, caption });
      if (options.failUpscaledDelivery && url.includes('-1080')) throw new Error('SEND_FAILED');
      return !options.failDelivery;
    },
    incrementKlingUsage: async () => 1,
    markGenSuccess: (id: number) => events.successes.push(id),
    addSaldo: async (_: number, amount: number) => { events.refunds.push(amount); },
    releaseGenerating: (id: number) => events.releases.push(id),
    describeError: (error: Error) => error.message,
    formatRupiah: (amount: number) => `Rp${amount}`,
    bot: { telegram: {
      editMessageText: async (_: number, __: number, ___: unknown, text: string) => { events.messages.push(text); },
      sendMessage: async (_: number, text: string) => { events.messages.push(text); },
      deleteMessage: async () => {},
    } },
  });
  vm.runInContext(executable, context);
  return {
    events, context,
    run: (model: string, id = 1) => context.runPicsartI2v(id, id, id, 10, 'fixture', {
      model, ratio: '16:9', imageUrls: ['https://example.test/a.jpg', 'https://example.test/b.jpg'],
    }),
  };
}

async function main() {
  for (const model of ['seedance_2', 'seedance_2_fast', 'seedance_2_mini'] as const) {
    const success = harness();
    await success.run(model);
    assert.deepEqual(success.events.order, ['generate', 'upscale', 'deliver']);
    assert.deepEqual(success.events.charges, [model === 'seedance_2_mini' ? 3500 : 4000]);
    assert.deepEqual(success.events.refunds, []);
    assert.deepEqual(success.events.releases, [1]);
    assert.equal(success.events.inputs[0].images.length, 2);
    assert.equal(success.events.inputs[0].ratio, '16:9');
    assert.match(success.events.deliveries[0].url, /-1080\.mp4$/);
    assert.match(success.events.deliveries[0].caption, /16:9 · 15 detik · 1080p · audio/);
    assert.doesNotMatch(success.events.messages.join(' ') + success.events.deliveries[0].caption, /upscal|Renderful|ByteDance|native|asli|480p/i);
    assert.match(success.context.picsartI2vPublicSettings(model, PICSART_I2V_MODELS[model].settingsLabel), /1080p/);
    assert.match(source, new RegExp(PICSART_I2V_MODELS[model].label.replaceAll('.', '\\.')));

    for (const options of [{ upscale: false }, { failUpscaledDelivery: true }]) {
      const fallback = harness(options);
      await fallback.run(model);
      const delivery = fallback.events.deliveries.at(-1)!;
      assert.equal(delivery.url, 'https://example.test/1.mp4');
      assert.match(delivery.caption, /480p/);
      assert.doesNotMatch(delivery.caption, /1080p|upscal|native|asli|Renderful/i);
      assert.deepEqual(fallback.events.refunds, []);
      assert.equal(fallback.events.inputs.length, 1);
      assert.equal(fallback.events.order.filter(event => event === 'upscale').length, 1);
    }
    const failed = harness({ failDelivery: true });
    await failed.run(model);
    assert.equal(failed.events.deliveries.length, 2);
    assert.deepEqual(failed.events.refunds, failed.events.charges);
    assert.deepEqual(failed.events.releases, [1]);
    assert.deepEqual(failed.events.successes, []);

    const generationFailed = harness({ generationFails: true });
    await generationFailed.run(model);
    assert.deepEqual(generationFailed.events.order, ['generate']);
    assert.deepEqual(generationFailed.events.refunds, generationFailed.events.charges);
  }
  const unrelated = harness();
  await unrelated.run('grok_imagine');
  assert.deepEqual(unrelated.events.order, ['generate', 'deliver']);
  const parallel = harness();
  await Promise.all([parallel.run('seedance_2_mini', 11), parallel.run('seedance_2_fast', 22)]);
  assert.equal(parallel.events.deliveries.find(row => row.chatId === 11)?.url, 'https://example.test/11-1080.mp4');
  assert.equal(parallel.events.deliveries.find(row => row.chatId === 22)?.url, 'https://example.test/22-1080.mp4');
  console.log('Seedance 2/Mini/Fast automatic 1080p delivery, fallback, prices, refunds and isolation passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });