import assert from 'node:assert/strict';
import vm from 'node:vm';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { generationErrorMessage, classifyGenerationError, generationFailure } from '../src/generation-errors';
import { withGenerationErrors } from './generation-error-harness';

async function main() {
  const cases: Array<[unknown, string]> = [
    [Error('PICSART_GEN_FAILED: ContentPolicyViolation'), 'sensitive'],
    [Error('FLORA_RUN_FAILED: PROMPT_MODERATED'), 'sensitive'],
    [Error('SNAPGEN_CONTENT_MODERATION'), 'sensitive'],
    [Error('VIVAREEL_HTTP_403'), 'unavailable'],
    [{response:{status:403,data:{error:{message:'image_sensitive_content'}}}},'sensitive'],
    [generationFailure('PICSART_KLING4_POST_SUBMIT_FAILED', {message:'NSFW image detected'}),'sensitive'],
    [{response:{data:{errors:[{code:'sensitive_content'}]}}},'sensitive'],
    [Error('copyright restriction'),'copyright'],
    [Error('REFERENCE_VIDEO_TOO_LARGE'),'size'],
    [Error('SEEDANCE25_MEDIA_SIZE_LIMIT'),'size'],
    [Error('WAN_REFERENCE_DURATION_INVALID'),'duration'],
    [Error('INVALID_CHARACTER_IMAGE'),'image'],
    [Error('SNAPGEN_INVALID_REFERENCE_IMAGE'),'image'],
    [Error('WAN_REFERENCE_INVALID'),'video'],
    [Error('AUDIO_INVALID'),'audio'],
    [Error('INVALID_RATIO'),'input'],
    [Error('FLORA_MODEL_UNSUPPORTED_PARAMETERS'),'input'],
    [Error('PICSART_NO_CREDENTIAL'),'unavailable'],
    [Error('DEAPI_POOL_NO_USABLE_KEY'),'unavailable'],
    [Error('PICSART_INSUFFICIENT_CREDITS'),'unavailable'],
    [Error('SNAPGEN_HIGH_TRAFFIC'),'busy'],
    [{response:{status:429}},'busy'],
    [Error('VIVAREEL_SUBMIT_AMBIGUOUS'),'uncertain'],
    [Error('FLORA_RUN_TIMEOUT'),'timeout'],
    [Object.assign(Error('socket disconnected'),{code:'ECONNRESET'}),'network'],
    [Error('WAN_1080_FINISH_FAILED'),'finishing'],
    [Error('DELIVERY_FAILED'),'delivery'],
    [Error('PICSART_UPLOAD_FAILED'),'upload'],
    [Error('EDANBOT_JOB_FAILED: ERXX99'),'unknown'],
    [{message:'Unknown processing error',config:{prompt:'nsfw',headers:{Authorization:'secretmarker'}}},'unknown'],
    [{message:'Unknown processing error',input:{prompt:'sensitive'}},'unknown'],
    [{message:'No sensitive content detected'},'unknown'],
    [Error('PICSART_GEN_FAILED job=a413b403c422d429e503'),'unknown'],
    [null,'unknown'],
  ];
  for (const [error,kind] of cases) assert.equal(classifyGenerationError(error),kind,String((error as any)?.message));
  const circular: any = {}; circular.cause = circular;
  assert.equal(classifyGenerationError(circular),'unknown');
  const hostile = {get message() {throw Error('bad getter');}};
  assert.equal(classifyGenerationError(hostile),'unknown');
  assert.match(generationErrorMessage(Error('image_sensitive_content')),/Foto referensi.*konten sensitif/);
  assert.match(generationErrorMessage(Error('video_sensitive_content')),/Video referensi.*konten sensitif/);
  assert.match(generationErrorMessage(Error('prompt_moderated')),/Prompt.*konten sensitif/);
  assert.match(generationErrorMessage(Error('output_sensitive_content')),/Hasil.*konten sensitif/);
  assert.match(generationErrorMessage(Error('unknown'),{stage:'finishing'}),/kualitas/);
  assert.match(generationErrorMessage(Error('timeout'),{stage:'delivery'}),/dikirim/);

  for (const supplier of ['Picsart','Flora AI','Renderful','Vivareel','Snapgen','DeAPI','Alriz',
    'ChinaAPI','Botelex','Aiveed','OneOver','Freebeat','Edanbot','UnknownFutureSupplier']) {
    for (const failure of ['NSFW image detected','timeout','unknown issue']) {
      const error = Error(`${supplier}: ${failure}; cookie=secretmarker Authorization=Bearer secretmarker https://internal.example/job?key=secretmarker`);
      const messages: string[] = [];
      const context = withGenerationErrors(vm.createContext({
        bot: {telegram:{
          editMessageText: async (_chat: number,_id: number,_x: any,text: string) => {messages.push(text);throw Error('edit unavailable');},
          sendMessage: async (_chat: number,text: string) => {messages.push(text);},
        }},
      }));
      await context.notifyGenerationFailure(1,2,error);
      assert.equal(messages.length,2);
      assert.equal(messages[0],messages[1]);
      assert.match(messages[0],/\/menu/);
      assert.doesNotMatch(messages[0],new RegExp(supplier.replace(/ /g,'\\s*'),'i'));
      assert.doesNotMatch(messages[0],/secretmarker|internal\.example|https?:|cookie|Bearer|Authorization|job=/i);
    }
  }
  // Every generation runner is either integrated directly or explicitly delegates
  // to a runner that is. New runners cannot silently keep a generic/raw failure.
  const source=readFileSync('src/index.ts','utf8');
  const ast=ts.createSourceFile('index.ts',source,ts.ScriptTarget.Latest,true);
  const delegates: Record<string,string> = {
    runKlingP4:'runKlingV3Standard',runKlingP2:'runKlingEdanbot',runKlingP3:'runKlingEdanbot',
    runSeedance25P2:'runPicsartSeedance25',runSeedanceMiniVideoEdit:'runSeedanceVideoEdit',
    runSeedanceFastVideoEdit:'runSeedanceVideoEdit',runSeedance2VideoEdit:'runSeedanceVideoEdit',
    runKling21Pro:'runPicsartI2v',
  };
  let runners=0;
  for(const node of ast.statements) {
    if(!ts.isFunctionDeclaration(node)||!node.name?.text.startsWith('run'))continue;
    const name=node.name.text,text=node.getText(ast);runners++;
    assert.ok(/notifyGenerationFailure|generationErrorMessage/.test(text)
      || (delegates[name]&&text.includes(delegates[name])),`${name} must translate its public failures`);
  }
  assert.ok(runners>=30);
  assert.match(source,/failed: async error =>[\s\S]{0,500}notifyGenerationFailure\(chatId, statusId, error\)/);
  console.log(`Generation error tests passed: ${cases.length} classifications, precise moderation hints, cyclic/hostile errors, ${runners} runners, all supplier names withheld, identical fallback messages.`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
