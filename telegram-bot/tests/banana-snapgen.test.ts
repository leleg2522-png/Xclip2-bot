import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { generateBananaSnapgen, type SnapgenBananaApi, type SnapgenBananaModel } from '../src/banana-snapgen';

const models: SnapgenBananaModel[] = ['nano-banana-pro', 'nano-banana-2', 'nano-banana-2-lite'];
const image = { buffer: Buffer.from('reference'), name: 'reference.png', mime: 'image/png' };
function harness(failure?: string) {
  const events = { submits: 0, polls: 0 };
  const api: SnapgenBananaApi = {
    available: failure !== 'no-key',
    status: async () => {},
    submit: async body => {
      events.submits++;
      assert.equal(body.model, 'nano-banana-2');
      assert.equal(body.aspectRatio, '9:16');
      assert.equal(body.prompt, 'draw');
      if (failure === 'timeout' || failure === 'auth') throw Error(failure);
      return { uuid: failure === 'no-id' ? '' : 'job', ...(failure === 'immediate' ? { url: 'https://result.test/4k' } : {}) };
    },
    poll: async uuid => {
      events.polls++;
      assert.equal(uuid, 'job');
      if (failure === 'poll-auth' || failure === 'poll-timeout') throw Error(failure);
      return { url: failure === 'no-output' ? '' : 'https://result.test/4k' };
    },
  };
  return { events, api };
}

async function main() {
  for (const model of models) for (const mode of ['t2i', 'i2i'] as const) {
    for (const failure of [undefined, 'immediate', 'timeout', 'auth', 'no-id', 'poll-auth', 'poll-timeout', 'no-output', 'no-key']) {
      const h = harness(failure);
      const run = () => generateBananaSnapgen({
        model, mode, prompt: ' draw ', ratio: '9:16', images: mode === 'i2i' ? [image, image] : [],
      }, h.api);
      if (!failure || failure === 'immediate') assert.equal(await run(), 'https://result.test/4k');
      else await assert.rejects(run());
      assert.equal(h.events.submits, failure === 'no-key' ? 0 : 1, 'No replay for rejected, ambiguous or accepted submissions');
      assert.equal(h.events.polls, !failure || ['poll-auth', 'poll-timeout', 'no-output'].includes(failure) ? 1 : 0);
    }
  }
  for (const [mode, refs] of [['i2i', []], ['i2i', [image, image, image]], ['t2i', [image]]] as const) {
    const h = harness();
    await assert.rejects(generateBananaSnapgen({
      model: 'nano-banana-2', mode, prompt: 'draw', ratio: '9:16', images: [...refs],
    }, h.api), /INVALID_REFERENCES/);
    assert.equal(h.events.submits, 0);
  }

  // Exercise the actual multipart adapter and URL parsing offline.
  const source = fs.readFileSync(path.resolve(__dirname, '../src/index.ts'), 'utf8');
  const start = source.indexOf('async function snapgenSubmitImage(');
  const end = source.indexOf('// ─── Background: Nano Banana image', start);
  for (const immediate of [false, true]) {
    let submits = 0;
    let polls = 0;
    class FakeFormData {
      fields: Array<{ name: string; value: any; opts: any }> = [];
      append(name: string, value: any, opts?: any) { this.fields.push({ name, value, opts }); }
      getHeaders() { return { 'content-type': 'multipart/form-data; boundary=fixture' }; }
    }
    const context = vm.createContext({
      FormData: FakeFormData, SNAPGEN_API_KEY: 'fixture-not-a-secret',
      SNAPGEN_BASE: 'https://api.snapgen.ai/uapi/v1', sleep: async () => {},
      snapgenHttp: {
        post: async (url: string, form: FakeFormData, config: any) => {
          submits++;
          assert.equal(url, 'https://api.snapgen.ai/uapi/v1/generate_image');
          assert.equal(config.headers['x-api-key'], 'fixture-not-a-secret');
          for (const [name, value] of [['model', 'nano-banana-2'], ['resolution', '4K'], ['output', 'jpeg'], ['aspect_ratio', '9:16']]) {
            assert.equal(form.fields.find(field => field.name === name)?.value, value);
          }
          const files = form.fields.filter(field => field.name === 'files');
          assert.equal(files.length, 2);
          assert.equal(files[0].value, image.buffer);
          assert.equal(files[0].opts.contentType, 'image/png');
          assert.equal(form.fields.some(field => typeof field.value === 'string' && field.value.includes('telegram.org')), false);
          return { status: 200, data: { uuid: 'job', status: immediate ? 2 : 1,
            ...(immediate ? { generate_result: 'https://result.test/4k' } : {}) } };
        },
        get: async (url: string, config: any) => {
          polls++;
          assert.equal(url, 'https://api.snapgen.ai/uapi/v1/history/job');
          assert.equal(config.headers['x-api-key'], 'fixture-not-a-secret');
          return { status: 200, data: { status: 2, generated_image: [{ image_url: 'https://result.test/4k' }] } };
        },
      },
    });
    const compiled = ts.transpileModule(source.slice(start, end), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    vm.runInContext(compiled, context);
    const result = await generateBananaSnapgen({
      model: 'nano-banana-pro', mode: 'i2i', prompt: 'draw', ratio: '9:16', images: [image, image],
    }, { available: true, status: async () => {}, submit: context.snapgenSubmitImage, poll: context.snapgenPollImage });
    assert.equal(result, 'https://result.test/4k');
    assert.equal(submits, 1);
    assert.equal(polls, immediate ? 0 : 1);
  }
  console.log('SnapGen Banana Pro/2/Lite: shared backend, references, multipart 4K, immediate/polled results and no paid replay passed (offline).');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
