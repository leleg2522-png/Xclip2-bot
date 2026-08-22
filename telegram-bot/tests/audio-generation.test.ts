import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

const expectedModels = [
  'ElevenLabs Multilingual v2',
  'ElevenLabs Scribe v2',
  'Gemini 3.1 Flash TTS',
  'ElevenLabs Music v1',
  'ElevenLabs Sound Effects',
];

assert.match(source, /audio:\s*3000/);
assert.match(source, /menu_audio/);
assert.match(source, /floraListAudioModels/);
assert.match(source, /params:\s*\{\s*type:\s*'audio'\s*\}/);
assert.match(source, /audio_wait_prompt/);
assert.match(source, /audio_wait_voice/);
assert.match(source, /audio_wait_file/);
assert.match(source, /runFloraAudio/);
assert.match(source, /floraPollRunResult/);
assert.match(source, /extractFloraVoiceOptions/);
assert.match(source, /audioVoiceKeyboard/);
assert.match(source, /audio_voice_/);
assert.match(source, /\{\s*voice:\s*voiceId\s*\}/);
assert.match(source, /audio_url/);
assert.match(source, /sendAudio/);
assert.match(source, /sendTranscriptionResult/);
assert.match(source, /if \(acceptedRunId\)/);

for (const model of expectedModels) {
  assert.ok(source.includes(`name: '${model}'`), `missing audio model: ${model}`);
}

console.log(`Audio generation catalog tests passed (${expectedModels.length} models at Rp3.000).`);