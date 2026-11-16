import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import { generateGenjutsuWithSeedance25 } from '../src/picsart-genjutsu';
import { GENJUTSU_PROMPT } from '../src/genjutsu';

const ast = ts.createSourceFile('picsart.ts', readFileSync(new URL('../src/picsart.ts', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true);
const functions = ['submitSeedance', 'generateSeedance25Genjutsu'].map(name => {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert(node, name);
  return node.getText(ast).replace('export async function', 'async function');
}).join('\n');
const code = ts.transpileModule(functions, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function harness(options: { quote?: number; balance?: number; pollFails?: boolean; submitStatus?: number;
  missingId?: boolean; quoteStatus?: number } = {}) {
  const calls = { posts: [] as any[], uploads: [] as any[], events: [] as string[], polls: 0, prepared: [] as any[] };
  const context = vm.createContext({
    Buffer, console, generateGenjutsuWithSeedance25,
    API_BASE: 'https://provider.test', X_APP_AUTHORIZATION: 'fixture',
    SEEDANCE_MODEL: 'seedance_2_5', SEEDANCE_MAX_REF_IMAGES: 30, SEEDANCE_MAX_REF_VIDEOS: 10, SEEDANCE_MAX_REF_AUDIOS: 10,
    ok2xx: (status: number) => status >= 200 && status < 300,
    runWithAccount: async (_user: number, _pool: unknown, work: (id: number) => Promise<any>) => work(7),
    prepareGenjutsuVideo: async (video: any) => {
      calls.prepared.push(video);
      return video.duration < 4 ? { ...video, buffer: Buffer.from('padded-video'), duration: 4.1 } : video;
    },
    getAccessToken: async () => 'fixture',
    commonHeaders: (value: any) => value,
    getCredits: async () => ({ credits: options.balance ?? 500 }),
    uploadFile: async (_id: number, bytes: Buffer, name: string) => {
      calls.uploads.push({ name, bytes: bytes.toString() });
      return `https://media.test/${name}`;
    },
    http: { post: async (url: string, body: any) => {
      calls.posts.push({ url, body });
      if (url.endsWith('/options')) return {
        status: options.quoteStatus ?? 201, data: { response: { credits: options.quote ?? 72, estimated: false } },
      };
      return { status: options.submitStatus ?? 201, data: { response: options.missingId ? {} : { id: 'accepted-job' } } };
    } },
    pollSeedanceResult: async () => {
      calls.events.push('poll'); calls.polls++;
      if (options.pollFails) throw Error('PICSART_AUTH_DEAD');
      return { url: 'https://media.test/result.mp4', credits: 72 };
    },
    pollSeedance25FlashResult: () => { throw Error('Must not poll Flash'); },
  });
  vm.runInContext(code, context);
  const input = {
    userId: 1, prompt: GENJUTSU_PROMPT, taskType: 'edit', generateAudio: false, maxReferenceSeconds: 15,
    images: [{ buffer: Buffer.from('replacement'), name: 'character.jpg', mime: 'image/jpeg' }],
    videos: [{ buffer: Buffer.from('original'), name: 'source.mp4', mime: 'video/mp4', duration: 10 }],
    audios: [],
    onSubmitted: async () => { calls.events.push('saved'); },
  };
  return { calls, run: (patch: any = {}) => context.generateSeedance25Genjutsu({ ...input, ...patch }) };
}

async function main() {
  const h = harness();
  const result = await h.run();
  assert.equal(result.url, 'https://media.test/result.mp4');
  assert.deepEqual(h.calls.events, ['saved', 'poll']);
  assert.equal(h.calls.posts.length, 2);
  for (const call of h.calls.posts) {
    assert.match(call.url, /\/gw-v2\/workflows\/seedance\/(?:options|submit)$/);
    const p = call.body.params;
    assert.equal(p.model, 'seedance_2_5');
    assert.equal(p.duration, -1);
    assert.equal(p.ratio, 'adaptive');
    assert.equal(p.omni_reference_task_type, 'edit');
    assert.equal(p.generate_audio, false);
    assert.equal(p.content.find((item: any) => item.type === 'text').text, GENJUTSU_PROMPT);
    assert.equal(p.content.find((item: any) => item.type === 'image_url').role, 'reference_image');
    assert.equal(p.content.find((item: any) => item.type === 'video_url').role, 'reference_video');
    assert.equal(p.negative_prompt, undefined);
  }
  const metadata = JSON.parse(h.calls.posts[1].body.params.options.drive.attributes.aiSDKPayload);
  assert.equal(metadata.duration, -1);
  assert.equal(metadata.aspectRatio, 'adaptive');
  assert.equal(metadata.prompt, undefined, 'Do not duplicate prompt into Drive metadata');

  for (const patch of [
    { images: [] }, { audios: [{ buffer: Buffer.from('x'), duration: 2 }] },
    { images: Array.from({ length: 11 }, () => ({ buffer: Buffer.from('x') })) },
    { videos: Array.from({ length: 2 }, () => ({ buffer: Buffer.from('x'), duration: 10 })) },
    { generateAudio: true }, { taskType: 'reference' }, { maxReferenceSeconds: 20 },
    { videos: [{ buffer: Buffer.from('x'), duration: 2.99 }] },
    { videos: [{ buffer: Buffer.from('x'), duration: 15.01 }] },
  ]) {
    const invalid = harness();
    await assert.rejects(() => invalid.run(patch), /GENJUTSU_INVALID/);
    assert.equal(invalid.calls.posts.length, 0);
  }
  for (const count of [2, 10]) {
    const multi = harness();
    const images = Array.from({ length: count }, (_, i) => ({
      buffer: Buffer.from(`ref-${i}`), name: `ref-${i}.jpg`, mime: 'image/jpeg',
    }));
    await multi.run({ images });
    assert.equal(multi.calls.uploads.length, count + 1);
    assert.deepEqual(multi.calls.uploads.slice(0, count).map(item => item.bytes), images.map(item => item.buffer.toString()));
    for (const call of multi.calls.posts) {
      const refs = call.body.params.content.filter((item: any) => item.type === 'image_url');
      assert.equal(refs.length, count, 'All references reach both quote and submit');
      assert.deepEqual(Array.from(refs, (item: any) => item.image_url.url),
        images.map(image => `https://media.test/${image.name}`));
      assert.equal(call.body.params.content.filter((item: any) => item.type === 'video_url').length, 1);
    }
  }
  for (const max of [15, 30]) {
    for (const duration of [3, max]) {
      const valid = harness();
      await valid.run({ maxReferenceSeconds: max, videos: [{ buffer: Buffer.from('original'), duration }] });
      assert.equal(valid.calls.prepared[0].duration, duration);
      if (duration === 3) assert.equal(valid.calls.uploads[1].bytes, 'padded-video');
    }
  }
  for (const options of [{ balance: 5 }, { balance: NaN }, { quote: NaN }, { quoteStatus: 400 }]) {
    const blocked = harness(options);
    await assert.rejects(() => blocked.run(), /INVALID_CREDIT_QUOTE|INSUFFICIENT_CREDITS/);
    assert.equal(blocked.calls.posts.length, 1, 'No submit when preflight fails');
  }
  const capped = harness();
  await assert.rejects(() => capped.run({ maxProviderCredits: 50 }), /QUOTE_EXCEEDS/);
  assert.equal(capped.calls.posts.length, 1);
  const failed = harness({ pollFails: true });
  await assert.rejects(() => failed.run(), /^Error: PICSART_SEEDANCE25_POST_SUBMIT_FAILED/);
  assert.equal(failed.calls.posts.length, 2, 'Never resubmit an accepted job');
  for (const options of [{ submitStatus: 500 }, { missingId: true }]) {
    const ambiguous = harness(options);
    await assert.rejects(() => ambiguous.run(), /POST_SUBMIT_FAILED/);
    assert.equal(ambiguous.calls.posts.length, 2);
    assert.equal(ambiguous.calls.polls, 0);
  }
  console.log('Genjutsu provider passed: standard Seedance edit, automatic duration/ratio, both packages, quote checks, no Flash or paid-job replay.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
