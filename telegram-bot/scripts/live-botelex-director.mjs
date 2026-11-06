// Explicit migration verification only. No media submits or customer saldo.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
if (!process.argv.includes('--approved')) throw Error('APPROVAL_REQUIRED');
const require = createRequire(import.meta.url);
const { EpisodeDirector, validateBible, validateScene } = require('../dist/episode-director.js');
const { newEpisode } = require('../dist/episode-types.js');
const { MICRODRAMA_LLM_DEFAULT, microdramaLlmKey } = require('../dist/microdrama-llm.js');
const root = path.resolve(import.meta.dirname, '../..');
const scriptTest = process.argv.includes('--script-test');
const koreanDrama = process.argv.includes('--korean-drama');
const museNegative = process.argv.includes('--muse-negative');
const dir = path.join(root, koreanDrama
  ? 'generated-artifacts/botelex-korean-drama-plan'
  : museNegative
  ? 'generated-artifacts/botelex-muse-negative-plan'
  : scriptTest
  ? 'generated-artifacts/botelex-director-script-test'
  : 'generated-artifacts/botelex-director-verification');
await fs.mkdir(dir, { recursive: true });
const lockPath = path.join(dir, 'running.lock');
const lock = await fs.open(lockPath, 'wx');
const statePath = path.join(dir, 'state.json');
let state;
let stage = 'initial';
try { state = JSON.parse(await fs.readFile(statePath, 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; state = { attempts: {}, results: {}, model: MICRODRAMA_LLM_DEFAULT }; }
async function save() {
  await fs.writeFile(statePath + '.tmp', JSON.stringify(state, null, 2));
  await fs.rename(statePath + '.tmp', statePath);
}
async function once(name, run, restore) {
  if (Object.hasOwn(state.results, name)) return state.results[name];
  if (state.attempts[name] && process.argv.includes('--revalidate-saved') && restore) {
    const raw = await fs.readFile(path.join(dir, `${name}-assistant.txt`), 'utf8');
    const value = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    const result = restore(value);
    state.results[name] = result;
    state.revalidatedFromSaved ??= [];
    state.revalidatedFromSaved.push(name);
    delete state.error;
    await save();
    console.log('LLM_SAVED_RESPONSE_VALIDATED_NO_NEW_REQUEST', name);
    return result;
  }
  if (state.attempts[name]) throw Error('LLM_PREVIOUS_ATTEMPT_NO_AUTOMATIC_REPLAY');
  state.attempts[name] = true; await save();
  stage = name;
  console.log('LLM_TEST_STARTED', name);
  const result = await run();
  state.results[name] = result; await save();
  console.log('LLM_TEST_PASSED', name);
  return result;
}
try {
  const key = microdramaLlmKey();
  if (!key) throw Error('LLM_KEY_MISSING');
  const request = async (url, init) => {
    const response = await fetch(url, init);
    if (!String(url).endsWith('/chat/completions')) return response;
    const diagnostic = {
      httpStatus: response.status, contentType: response.headers.get('content-type'),
    };
    state.transport ??= {};
    state.transport[stage] = diagnostic; await save();
    // Only retain the assistant's fictional story output and machine metadata.
    // Never store request headers, credentials, reasoning or upstream messages.
    const copy = response.clone();
    let raw = '';
    const decoder = new TextDecoder();
    try {
      for await (const bytes of copy.body) {
        raw += decoder.decode(bytes, { stream: true });
        if (raw.length > 4 * 1024 * 1024) throw Error('LLM_DIAGNOSTIC_BODY_TOO_LARGE');
      }
      raw += decoder.decode();
      diagnostic.bytes = Buffer.byteLength(raw);
      let content = '';
      diagnostic.finishReasons = [];
      const inspect = value => {
        const c = value?.choices?.[0];
        if (typeof c?.delta?.content === 'string') content += c.delta.content;
        if (typeof c?.message?.content === 'string') content += c.message.content;
        if (c?.finish_reason) diagnostic.finishReasons.push(c.finish_reason);
      };
      if (/(?:^|\n)data:/.test(raw)) {
        for (const line of raw.split(/\r?\n/).filter(v => v.startsWith('data:'))) {
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try { inspect(JSON.parse(data)); }
          catch { diagnostic.malformedEvents = (diagnostic.malformedEvents || 0) + 1; }
        }
      } else {
        try { inspect(JSON.parse(raw)); } catch { diagnostic.bodyNotJson = true; }
      }
      diagnostic.assistantChars = content.length;
      if (content) await fs.writeFile(path.join(dir, `${stage}-assistant.txt`), content);
    } catch (e) {
      diagnostic.readErrorName = /^[A-Za-z_]+$/.test(e.name) ? e.name : 'UnknownError';
    }
    await save();
    return response;
  };
  const d = new EpisodeDirector(key, request, museNegative || koreanDrama, koreanDrama ? 'ko' : 'id');
  const episode = newEpisode(1);
  episode.bible = await once('bible', () => d.bible(
    koreanDrama
      ? '한국 서울을 배경으로 한 1분 분량의 따뜻한 로맨스 한국 드라마를 쓴다. 성인 한국인 두 명만 출연한다. cast[0]는 ID DOYUN, 이름 강도윤, 33세 잘생긴 남성 CEO이며 승인된 첫 번째 남성 캐릭터 레퍼런스를 따라간다. cast[1]은 ID SEOYEON, 이름 윤서연, 29세 생활이 어려운 여성 배달원이며 승인된 두 번째 여성 캐릭터 레퍼런스를 따라간다. 조용한 회사 로비 한 곳에만 머문다. 과거 비 오는 밤에 서로 도왔던 두 사람이 그 기억을 알아보는 감정적 이야기. 한국 드라마다운 설렘과 놀라움은 담되 과장된 재벌 클리셰, 모욕, 신체 접촉은 피한다. 공개된 캐릭터 레퍼런스 이미지 속 두 사람의 실제 얼굴과 헤어, 의상은 변경하지 않는다. 카메라와 화면 좌우 위치를 유지해 여섯 쇼트를 이전 장면의 마지막 프레임과 연결한다. 화면에는 남녀 주인공 외 인물이나 군중이 절대 나오지 않는다. 단순한 시선·표정 연기만 쓰며 복잡한 손동작과 소품 건네기는 피한다. spoken dialogue는 자연스러운 한국어 한글로만 쓴다. 매 대사에 정확하고 간결한 인도네시아어 subtitleId를 포함한다. 줄거리와 카메라·이미지·영상 프롬프트는 영어로 작성한다. 마지막은 따뜻한 감정의 고백 직전에서 끝낸다. 각 샷에는 해당 구도, 배우, 손, 소품, 동작, 말하는 사람에 맞춘 별개의 구체적 negativePrompt를 쓴다.'
      : museNegative
      ? 'Buat microdrama romantis Indonesia tepat satu menit: Arga CEO tampan dewasa dan Nara wanita dewasa sederhana yang mengantar makanan, ternyata pernah saling menolong dan baru saling mengenali. HANYA dua tokoh dewasa itu dari awal sampai akhir; lobi kantor kecil yang kosong, tanpa orang lewat, pegawai, manajer atau satpam. Semua tokoh berdiri tenang. Satu kalimat singkat dari satu pembicara per shot. Aksi sederhana: tatapan, senyum, anggukan. Satu kantong makanan tetap di tangan Nara sepanjang episode; tidak dijatuhkan atau dipindahkan. Tanpa peragaan kenangan, flashback, menyentuh wajah/tangan, gelang tambahan, merogoh kantong atau pergantian baju. Jadikan dialog pendek sebagai pengungkapan masa lalu. Semua shot akan disambung memakai frame terakhir shot sebelumnya. Akhiri dengan pengungkapan romantis, bukan aksi fisik.'
      : 'Microdrama romantis Indonesia satu menit: Arga, CEO tampan dewasa, bertemu Nara, wanita dewasa yang hidup sederhana dan mengantar makanan. Mereka menyadari pernah saling menolong. Hanya dua pemeran, satu lobi kantor, gerakan sederhana, dialog singkat, tanpa kekerasan. Akhiri dengan pengungkapan emosional.',
    1, state.model), value => validateBible(value, 1));
  if (koreanDrama && (episode.bible.cast.length !== 2
      || episode.bible.cast[0].id !== 'DOYUN'
      || episode.bible.cast[1].id !== 'SEOYEON')) {
    throw Error('KDRAMA_CHARACTER_REFERENCE_ORDER_MISMATCH');
  }
  for (let i=0; i<2; i++) {
    const shots = await once(`scene${i+1}`, () => d.scene(episode, i, state.model),
    value => validateScene(value, episode, i, museNegative || koreanDrama, koreanDrama));
    episode.shots.push(...shots.map(shot => ({ shot })));
  }
  let quality;
  if (!scriptTest && !museNegative && !koreanDrama) {
    const imageDir = path.join(root,'generated-artifacts/muse-ceo-microdrama-strict');
    const images = await Promise.all(['scene-1-check.jpg','sample-6.jpg'].map(n=>fs.readFile(path.join(imageDir,n))));
    quality = await once('vision', () => d.review(state.model,
      'First image is the approved reference, second is a later candidate frame. Check whether the same two leads, wardrobe and supporting cast persist. Flag any new/unapproved adult. Evaluate only visible evidence, not dialogue or audio.', images));
  }
  state.completed = true; await save();
  console.log('DIRECTOR_VERIFIED',JSON.stringify({
    model:state.model,beats:episode.bible.beats.length,shots:episode.shots.length,
    visionResponded:!!quality,visionPass:quality?.pass,visionIssues:quality?.issues.length,
    mediaSubmissions:0,botSaldoCharged:false,
  }));
} catch(e) {
  const code = /^(LLM_[A-Z0-9_]+|DIRECTOR_FORMAT)$/.test(e.message)
    ? e.message : 'LLM_NETWORK_OR_FORMAT_FAILURE';
  state.error = code;
  state.errorName = /^[A-Za-z_]+$/.test(e.name) ? e.name : 'UnknownError';
  await save(); console.error('DIRECTOR_VERIFICATION_STOPPED',code); process.exitCode=1;
} finally {
  await lock.close(); await fs.unlink(lockPath);
}
