import assert from 'node:assert/strict';
import {
  buildPosbotSeedance25Request,
  generatePosbotSeedance25,
  validatePosbotSeedance25Prompt,
} from '../src/posbot-seedance25';
import { createPosbotSeedance25Bot } from '../src/posbot-seedance25-bot';

async function main() {
const img1 = 'https://bot.example/dl/image-one.jpg';
const img2 = 'https://bot.example/dl/image-two.jpg';
const video = 'https://bot.example/dl/reference-video.mp4';

const singleI2v = buildPosbotSeedance25Request({
  mode: 'i2v', prompt: 'A cinematic walk', ratio: '9:16', imageUrls: [img1],
});
assert.deepEqual(singleI2v, {
  model: 's2_seedance_25_30s', prompt: 'A cinematic walk', mode: 'i2v',
  image_url: img1, aspect_ratio: '9:16', notify_telegram: false,
});
const multiI2v = buildPosbotSeedance25Request({
  mode: 'i2v', prompt: 'A cinematic walk', ratio: '16:9', imageUrls: [img1, img2],
});
assert.deepEqual(multiI2v.image_urls, [img1, img2]);
assert.equal(multiI2v.image_url, undefined);

const r2v = buildPosbotSeedance25Request({
  mode: 'r2v', prompt: 'A cinematic walk', ratio: '1:1', imageUrls: [img1], videoUrl: video,
});
assert.equal(r2v.model, 'seedance_25_30s_r2v');
assert.equal(r2v.video_url, video);
assert.deepEqual(r2v.image_urls, [img1]);
assert.throws(() => buildPosbotSeedance25Request({
  mode: 'r2v', prompt: 'A cinematic walk', ratio: '1:1', imageUrls: [],
}), /video/);
assert.throws(() => buildPosbotSeedance25Request({
  mode: 'i2v', prompt: 'A cinematic walk', ratio: '1:1', imageUrls: [img1, img2, img1],
}), /1–2/);
assert.throws(() => buildPosbotSeedance25Request({
  mode: 'i2v', prompt: 'A cinematic walk', ratio: '1:1', imageUrls: ['http://insecure.example/image.jpg'],
}), /URL/);
assert.equal(validatePosbotSeedance25Prompt('  a cinematic walk  '), 'a cinematic walk');
assert.throws(() => validatePosbotSeedance25Prompt('ab'), /minimal 3/);
assert.throws(() => validatePosbotSeedance25Prompt('a'.repeat(8001)), /maksimal/);

const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
const result = await generatePosbotSeedance25({
  mode: 'r2v', prompt: 'A cinematic walk', ratio: '9:16', imageUrls: [], videoUrl: video,
}, {
  apiKey: 'test-key',
  sleep: async () => {},
  maxPollAttempts: 2,
  fetchImpl: async (input, init) => {
    const url = String(input);
    fetchCalls.push({ url, init });
    if (url.endsWith('/generate')) {
      return Response.json({ success: true, job_code: 'JOB-20261113-123456-ABC123' });
    }
    return Response.json({
      success: true, status: 'completed', progress: 100,
      result_url: 'https://cdn.posbot.web.id/outputs/job.mp4',
    });
  },
});
assert.equal(result.jobCode, 'JOB-20261113-123456-ABC123');
assert.equal(fetchCalls.length, 2);
assert.equal(fetchCalls[0].init?.method, 'POST');
assert.equal((fetchCalls[0].init?.headers as Record<string, string>).Authorization, 'Bearer test-key');
assert.equal((JSON.parse(String(fetchCalls[0].init?.body)) as any).notify_telegram, false);
assert.equal(fetchCalls[1].url.endsWith('/status/JOB-20261113-123456-ABC123'), true);

let submitCalls = 0;
await assert.rejects(
  generatePosbotSeedance25({
    mode: 'i2v', prompt: 'A cinematic walk', ratio: '9:16', imageUrls: [img1],
  }, {
    apiKey: 'test-key',
    fetchImpl: async () => { submitCalls++; throw Error('connection closed'); },
  }),
  /POSBOT_SUBMIT_UNCERTAIN/,
);
assert.equal(submitCalls, 1, 'ambiguous paid submits must not be replayed');

let missingVideoMessage = '';
const state = new Map<number, any>([[7, { mode: 'idle', dbUserId: 17 }]]);
const jobs: any[] = [];
const bot = createPosbotSeedance25Bot({
  getSession: id => state.get(id) ?? { mode: 'idle' },
  setSession: (id, patch) => state.set(id, { ...state.get(id), ...patch }),
  available: () => true,
  price: () => 8000,
  download: async () => Buffer.from('valid'),
  inspect: async (_bytes, kind) => kind === 'video'
    ? { duration: 8, width: 640, height: 480 } : { width: 800, height: 800 },
  run: async job => { jobs.push(job); },
  failed: () => {},
});
function fakeCtx(message: any = {}) {
  return {
    from: { id: 7 }, chat: { id: 8 },
    message: { message_id: 11, ...message },
    reply: async (text: string) => { missingVideoMessage = text; return { message_id: 21 }; },
    editMessageText: async (_text: string, keyboard: any) => keyboard,
  };
}
const startKeyboard = await bot.callback(fakeCtx(), 'mode_posbot_s25_i2v') as any;
const ratioButton = startKeyboard.reply_markup.inline_keyboard[0][0].callback_data;
await bot.callback(fakeCtx(), ratioButton);
await bot.message(fakeCtx({ photo: [{ file_id: 'photo1', file_size: 100 }] }));
const doneButton = `pb25_done:${state.get(7).posbotSeedance25Draft.id}`;
await bot.callback(fakeCtx(), doneButton);
await bot.message(fakeCtx({ text: 'A cinematic walk' }));
assert.equal(jobs.length, 1);
assert.equal(jobs[0].mode, 'i2v');
assert.equal(jobs[0].dbUserId, 17);
assert.equal(jobs[0].refs.length, 1);
assert.equal(state.get(7).mode, 'idle');

state.set(7, { mode: 'idle', dbUserId: 17 });
const r2vKeyboard = await bot.callback(fakeCtx(), 'mode_posbot_s25_r2v') as any;
const r2vRatio = r2vKeyboard.reply_markup.inline_keyboard[0][0].callback_data;
await bot.callback(fakeCtx(), r2vRatio);
const r2vDone = `pb25_done:${state.get(7).posbotSeedance25Draft.id}`;
await bot.callback(fakeCtx(), r2vDone);
assert.match(missingVideoMessage, /video referensi/i);
assert.equal(state.get(7).mode, 'posbot_s25_wait_media');
await bot.message(fakeCtx({ video: { file_id: 'video1', file_size: 200 } }));
assert.equal(state.get(7).posbotSeedance25Draft.refs[0].kind, 'video');
console.log('PosBot Seedance 2.5 I2V/R2V contracts, single-submit safety, and Telegram wizard passed.');
}

void main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
