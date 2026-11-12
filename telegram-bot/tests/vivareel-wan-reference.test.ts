import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { VivareelWanClient, wanRequest, wanOutputDuration, WAN_REFERENCE_MAX_BYTES, VIVAREEL_WAN_MODEL } from '../src/vivareel-wan';
import { inspectWanReferenceVideo, cropWanBuffer } from '../src/vivareel-wan-media';

const source = readFileSync('src/index.ts', 'utf8');
const ast = ts.createSourceFile('index.ts', source, ts.ScriptTarget.Latest, true);
const compile = (text: string) => ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
function fn(name: string) {
  const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
  assert.ok(node, name); return node.getText(ast);
}
function fragment(start: string, end: string) {
  const a = source.indexOf(start), b = source.indexOf(end, a);
  assert.ok(a >= 0 && b > a); return source.slice(a, b);
}
const json = (data: unknown) => new Response(JSON.stringify({ code: 200, data }));

function harness() {
  let state: any = { mode: 'picsart_i2v_wait_image', dbUserId: 77,
    picsartI2vModel: 'wan_v3', picsartI2vImageUrls: [], picsartI2vDraftId: 'draft', picsartI2vRatio: '9:16' };
  const messages: string[] = [], jobs: any[][] = [], handlers: Record<string, any> = {};
  let gate = Promise.resolve(), seconds = 10.1, invalid = false;
  const context = vm.createContext({
    Buffer, Date, Math, WAN_REFERENCE_MAX_BYTES, wanOutputDuration,
    picsart: { PICSART_I2V_MAX_IMAGES: 5,
      PICSART_I2V_MODELS: { wan_v3: { label: 'Wan 3.0', settingsLabel: '30 detik · 1080p' } } },
    Markup: { inlineKeyboard: (rows: any) => ({ reply_markup: { inline_keyboard: rows } }),
      button: { callback: (text: string, data: string) => ({ text, callback_data: data }) } },
    getSession: () => state, setSession: (_id: number, patch: any) => { state = { ...state, ...patch }; },
    inspectWanReferenceVideo: async () => { if (invalid) throw Error('bad video'); return seconds; },
    retryTelegramFileRead: (fn: any) => fn(), retryTelegramRateLimit: (fn: any) => fn(),
    telegramHttp: { get: async () => { await gate; return { data: Buffer.from('video') }; } },
    requireLogin: async () => true, getCooldownRemainingMs: () => 0,
    isPicsartI2vModelKey: (m: string) => m === 'wan_v3',
    runPicsartI2v: async (...args: any[]) => { jobs.push(args); },
    bot: { on: (name: string, handler: any) => { handlers[name] = handler; } },
    console: { error() {} },
  });
  vm.runInContext(compile([
    'supportsMultiplePicsartI2vImages', 'maxPicsartI2vImages', 'picsartI2vAddPhotoKeyboard',
    'picsartI2vPublicSettings', 'isSeedance2I2vModel',
    'handleWanReferenceVideo', 'handleKling4ReferencePhoto', 'submitPicsartI2vPrompt',
  ].map(fn).join('\n') + `
    async function handleImageInput(ctx, fileUrl, fileId) {
      const userId = ctx.from.id, session = getSession(userId);
      ${fragment("if (session.mode === 'picsart_i2v_wait_image')", "if (session.mode === 'oneover_wait_image')")}
    }
    async function callback(ctx) {
      const userId = ctx.from.id, data = ctx.callbackQuery.data;
      ${fragment("if (data === 'picsart_i2v_photos_done')", "if (data.startsWith('mode_pi2v_'))")}
    }
  `), context);
  // Exercise real video/document/photo dispatch instead of only direct helper calls.
  for (const type of ['video', 'document', 'photo']) {
    const node = ast.statements.find(n => ts.isExpressionStatement(n)
      && ts.isCallExpression(n.expression) && n.expression.expression.getText(ast) === 'bot.on'
      && (n.expression.arguments[0] as ts.StringLiteral)?.text === type);
    assert.ok(node); vm.runInContext(compile(node.getText(ast)), context);
  }
  let seq = 0;
  const ctx = (message: any = {}) => ({
    from: { id: 1 }, chat: { id: 2 }, message: { message_id: ++seq, ...message },
    telegram: { getFileLink: async () => { await gate; return { href: 'https://example.test/reference' }; } },
    reply: async (text: string) => { messages.push(text); return { message_id: seq }; },
    editMessageText: async (text: string) => { messages.push(text); },
    answerCbQuery: async (text: string) => { messages.push(text); },
  });
  return {
    state: () => state, messages, jobs,
    set: (patch: any) => { state = { ...state, ...patch }; },
    seconds: (value: number) => { seconds = value; }, invalid: () => { invalid = true; },
    video: (patch: any = {}) => handlers.video(ctx({video: {file_id:'v1',mime_type:'video/mp4',...patch}})),
    document: (patch: any = {}) => handlers.document(ctx({document: {file_id:'v1',mime_type:'video/quicktime',file_name:'ref.mov',...patch}})),
    photo: () => handlers.photo(ctx({photo:[{file_id:'p1'}]})),
    done: () => context.callback({...ctx(),callbackQuery:{data:'picsart_i2v_photos_done'}}),
    prompt: () => context.submitPicsartI2vPrompt(ctx(), 'Follow Video 1.'),
    block: () => { let release!: () => void; gate = new Promise<void>(r => { release = r; }); return release; },
  };
}

async function main() {
  assert.equal(wanOutputDuration(), 30);
  assert.equal(wanOutputDuration(1), 29);
  assert.equal(wanOutputDuration(10), 20);
  assert.equal(wanOutputDuration(10.1), 19);
  assert.equal(wanOutputDuration(15), 15);
  for (const seconds of [0, 0.9, 15.1, NaN, Infinity]) assert.throws(() => wanOutputDuration(seconds));
  for (const images of [[], ['https://example.test/ref.jpg'], Array(5).fill('https://example.test/ref.jpg')]) {
    const body = wanRequest('Follow Video 1', '9:16', images, {url:'https://example.test/video.mp4',duration:10.1});
    assert.equal(body.capability, 'image_reference');
    assert.equal(body.image_url, undefined);
    assert.equal(body.duration_seconds, 19);
    assert.deepEqual(body.reference_video_urls, ['https://example.test/video.mp4']);
    assert.equal(body.reference_urls?.length ?? 0, images.length);
  }
  assert.throws(() => wanRequest('x','9:16',[],{url:'http://example.test/v',duration:3}));
  const dir = mkdtempSync(join(tmpdir(),'wan-reference-tests-'));
  try {
    const make = (seconds: number) => {
      const file = join(dir, `ref-${seconds}.mp4`);
      execFileSync('ffmpeg',['-v','error','-f','lavfi','-i',`color=c=red:s=854x480:r=2:d=${seconds}`,
        '-c:v','libx264','-threads','2','-preset','ultrafast',file]);
      return readFileSync(file);
    };
    const video = make(10), image = {buffer:Buffer.from('photo'),mime:'image/jpeg'};
    assert.equal(await inspectWanReferenceVideo(video), 10);
    await assert.rejects(inspectWanReferenceVideo(make(16)), /REFERENCE_INVALID/);
    await assert.rejects(inspectWanReferenceVideo(Buffer.from('garbage')));
    await assert.rejects(inspectWanReferenceVideo(Buffer.alloc(WAN_REFERENCE_MAX_BYTES+1)), /SIZE_INVALID/);
    // Short output must pass finishing; a mismatched duration must not.
    const output = make(20);
    await cropWanBuffer(output, '16:9', 20);
    await assert.rejects(cropWanBuffer(output, '16:9'), /SETTINGS_MISMATCH/);
    for (const count of [0,1,5]) {
      const calls: any[] = [];
      const client = new VivareelWanClient('fake', async (url, opts) => {
        const route = String(url); calls.push({route,opts});
        if (route.endsWith('/models')) return json({video_models:[{name:VIVAREEL_WAN_MODEL,is_available:true,
          allowed_resolutions:['480P'],capabilities:['image_reference'],max_reference_images:5,
          max_reference_videos:1,max_duration_seconds:{image_reference:30}}]});
        if (route.endsWith('/files')) return json({url:'https://example.test/upload'});
        if (route.endsWith('/videos/generations')) return json({task_id:'accepted-once'});
        return json({status:'completed',result_url:'https://example.test/result.mp4'});
      }, async () => {});
      const result = await client.generate({prompt:'Video 1',images:Array(count).fill(image),video:{buffer:video}});
      assert.equal(result.durationSeconds,20);
      const submits = calls.filter(c=>c.route.endsWith('/videos/generations'));
      assert.equal(submits.length,1);
      const body = JSON.parse(submits[0].opts.body);
      assert.equal(body.image_url,undefined);
      assert.equal(body.capability,'image_reference');
      assert.equal(body.duration_seconds,20);
      assert.equal(body.reference_urls?.length ?? 0,count);
    }
  } finally { rmSync(dir,{recursive:true,force:true}); }
  for (const method of ['video','document'] as const) {
    const h = harness();
    await h[method]();
    assert.equal(h.state().wanDurationSeconds,19);
    await h.done();
    assert.match(h.messages.at(-1)!, /19 detik.*1080p.*Rp6.000/);
    await Promise.all([h.prompt(),h.prompt()]);
    assert.equal(h.jobs.length,1);
    assert.equal(h.jobs[0][5].videoFileId,'v1');
    assert.equal(h.jobs[0][5].wanDurationSeconds,19);
    assert.equal(h.jobs[0][5].wanReferenceMime,method === 'document' ? 'video/quicktime' : 'video/mp4');
    assert.equal(h.jobs[0][5].imageUrls.length,0);
  }
  const mixed = harness(); await mixed.photo(); await mixed.video(); await mixed.done(); await mixed.prompt();
  assert.equal(mixed.jobs[0][5].imageUrls.length,1);
  const full = harness(); for(let i=0;i<5;i++) await full.photo();
  assert.equal(full.state().mode,'picsart_i2v_wait_image');
  await full.video(); await full.done(); await full.prompt();
  assert.equal(full.jobs[0][5].imageUrls.length,5);
  const photoOnly = harness(); await photoOnly.photo(); await photoOnly.done(); await photoOnly.prompt();
  assert.equal(photoOnly.jobs[0][5].wanDurationSeconds,30);
  assert.equal(photoOnly.jobs[0][5].videoFileId,undefined);
  for (const patch of [{file_size:WAN_REFERENCE_MAX_BYTES+1},{mime_type:'video/webm'}]) {
    const h=harness();await h.video(patch);assert.equal(h.state().picsartI2vVideoFileId,undefined);assert.equal(h.jobs.length,0);
  }
  const bad=harness();bad.invalid();await bad.video();assert.equal(bad.state().picsartI2vVideoFileId,undefined);
  assert.equal(bad.state().wanReferencePending,false);
  const duplicate=harness();await duplicate.video();await duplicate.video({file_id:'v2'});
  assert.equal(duplicate.state().picsartI2vVideoFileId,'v1');assert.match(duplicate.messages.at(-1)!,/Maksimal 1/);
  const pending=harness();const release=pending.block();const work=pending.video();
  await pending.done();assert.equal(pending.state().mode,'picsart_i2v_wait_image');
  await pending.video();assert.match(pending.messages.at(-1)!,/masih diperiksa/);
  pending.set({mode:'picsart_i2v_wait_image',picsartI2vDraftId:'new',wanReferencePending:false});
  release();await work;assert.equal(pending.state().picsartI2vVideoFileId,undefined);
  assert.equal(pending.state().wanReferencePending,false);
  const empty=harness();await empty.done();assert.equal(empty.state().mode,'picsart_i2v_wait_image');
  console.log('Wan video-reference tests passed: actual probes, mixed API modes, dynamic duration/crop, Telegram video/MOV, photo-only, pending/cancel/double-submit guards.');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
