import fs from 'fs';
import axios from 'axios';
import sharp from 'sharp';
import path from 'path';

const API_KEY = 'sk-aaf85f63df97e36c67ec91909d42ad2e481016967eb69d0a125f785d3f2ed417';
const BASE = 'https://api.aivideoapi.ai/v1';

const img1Path = path.resolve('../attached_assets/IMG-20260529-WA0011_1780053975505.jpg');
const img2Path = path.resolve('../attached_assets/Screenshot_20251125-063540_1780054054452.jpg');

const buf1 = fs.readFileSync(img1Path);
const buf2 = fs.readFileSync(img2Path);
const b64person = `data:image/jpeg;base64,${buf1.toString('base64')}`;
const b64garment = `data:image/jpeg;base64,${buf2.toString('base64')}`;
console.log(`person: ${(buf1.length/1024).toFixed(1)}KB, garment: ${(buf2.length/1024).toFixed(1)}KB`);

async function pollTask(taskId, label) {
  console.log(`[${label}] polling task: ${taskId}`);
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 8000));
    const r = await axios.get(`${BASE}/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${API_KEY}` }, timeout: 30000
    });
    const { status, output, error } = r.data;
    console.log(`[${label}] attempt ${i+1}: status=${status}`);
    if (status === 'completed' || status === 'succeed' || status === 'success') {
      const url = output?.urls?.[0] ?? output?.url ?? output?.image_url
               ?? output?.images?.[0]?.url ?? output?.images?.[0]
               ?? output?.[0]?.url;
      return url ?? JSON.stringify(output);
    }
    if (status === 'failed' || status === 'error') throw new Error(typeof error === 'string' ? error : JSON.stringify(error));
  }
  throw new Error('timeout');
}

async function testNanoBanana() {
  console.log('\n=== TEST: nano-banana-2 ===');
  const body = { model: 'nano-banana-2', input: { person_image_url: b64person, garment_image_url: b64garment } };
  try {
    const res = await axios.post(`${BASE}/images/generations`, body, {
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      maxBodyLength: Infinity, timeout: 60000
    });
    console.log('response:', JSON.stringify(res.data).slice(0, 400));
    const taskId = res.data?.data?.taskId ?? res.data?.data?.id ?? res.data?.taskId ?? res.data?.id;
    if (taskId) {
      const url = await pollTask(taskId, 'nano-banana-2');
      console.log('RESULT URL:', url);
    } else {
      const url = res.data?.data?.url ?? res.data?.url ?? res.data?.output?.url;
      console.log('SYNC RESULT:', url ?? JSON.stringify(res.data));
    }
  } catch(e) {
    const msg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    console.error('ERROR:', msg);
  }
}

async function testGptImage2() {
  console.log('\n=== TEST: gpt-image-2 ===');
  // Build composite
  const W=512, H=640;
  const [left, right] = await Promise.all([
    sharp(buf1).resize(W,H,{fit:'cover',position:'top'}).jpeg({quality:85}).toBuffer(),
    sharp(buf2).resize(W,H,{fit:'cover',position:'top'}).jpeg({quality:85}).toBuffer(),
  ]);
  const composite = await sharp({create:{width:W*2,height:H,channels:3,background:'#ffffff'}})
    .composite([{input:left,left:0,top:0},{input:right,left:W,top:0}])
    .jpeg({quality:85}).toBuffer();
  const compositeB64 = `data:image/jpeg;base64,${composite.toString('base64')}`;
  console.log(`composite: ${(composite.length/1024).toFixed(1)}KB`);

  const body = { model: 'gpt-image-2', input: { prompt: 'Dress the person on the left in the outfit shown on the right. Keep the person\'s face and pose exactly the same.', image_url: compositeB64, size: '1024x1024' } };
  try {
    const res = await axios.post(`${BASE}/images/generations`, body, {
      headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      maxBodyLength: Infinity, timeout: 60000
    });
    console.log('response:', JSON.stringify(res.data).slice(0, 400));
    const taskId = res.data?.data?.taskId ?? res.data?.data?.id ?? res.data?.taskId ?? res.data?.id;
    if (taskId) {
      const url = await pollTask(taskId, 'gpt-image-2');
      console.log('RESULT URL:', url);
    } else {
      const url = res.data?.data?.url ?? res.data?.url ?? res.data?.output?.url;
      console.log('SYNC RESULT:', url ?? JSON.stringify(res.data));
    }
  } catch(e) {
    const msg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
    console.error('ERROR:', msg);
  }
}

// Run both in parallel
await Promise.all([testNanoBanana(), testGptImage2()]);
console.log('\n=== ALL DONE ===');
