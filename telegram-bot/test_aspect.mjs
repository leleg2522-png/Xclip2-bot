import fs from 'fs';
import axios from 'axios';
import sharp from 'sharp';

const API_KEY = 'sk-aaf85f63df97e36c67ec91909d42ad2e481016967eb69d0a125f785d3f2ed417';
const BASE = 'https://api.aivideoapi.ai/v1';

const buf1 = fs.readFileSync('../attached_assets/IMG-20260529-WA0011_1780053975505.jpg');
const buf2 = fs.readFileSync('../attached_assets/Screenshot_20251125-063540_1780054054452.jpg');

async function buildComposite(w, h) {
  const [left, right] = await Promise.all([
    sharp(buf1).resize(w, h, {fit:'cover',position:'top'}).jpeg({quality:85}).toBuffer(),
    sharp(buf2).resize(w, h, {fit:'cover',position:'top'}).jpeg({quality:85}).toBuffer(),
  ]);
  return sharp({create:{width:w*2,height:h,channels:3,background:'#ffffff'}})
    .composite([{input:left,left:0,top:0},{input:right,left:w,top:0}])
    .jpeg({quality:85}).toBuffer();
}

async function poll(taskId, label) {
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 8000));
    const r = await axios.get(`${BASE}/tasks/${taskId}`, {
      headers:{Authorization:`Bearer ${API_KEY}`}, timeout:30000
    });
    const {status,output,error} = r.data;
    console.log(`[${label}] attempt ${i+1}: ${status}`);
    if (status==='completed'||status==='succeed'||status==='success') {
      return output?.urls?.[0]??output?.url??output?.image_url??output?.images?.[0]?.url??output?.[0]?.url;
    }
    if (status==='failed'||status==='error') throw new Error(JSON.stringify(error));
  }
  throw new Error('timeout');
}

async function testGpt(size, label) {
  // portrait: 512x768 per panel
  const panelW = size.includes('1792x') ? 512 : 512;
  const panelH = size === '1024x1792' ? 768 : size === '1792x1024' ? 341 : 640;
  const comp = await buildComposite(panelW, panelH);
  console.log(`[gpt-${label}] composite: ${(comp.length/1024).toFixed(1)}KB, size=${size}`);
  const b64 = `data:image/jpeg;base64,${comp.toString('base64')}`;
  const res = await axios.post(`${BASE}/images/generations`, {
    model:'gpt-image-2',
    input:{prompt:"Dress the person on the left in the outfit shown on the right. Keep the person's face and pose exactly the same.", image_url:b64, size}
  }, {headers:{Authorization:`Bearer ${API_KEY}`,'Content-Type':'application/json'}, maxBodyLength:Infinity, timeout:60000});
  console.log(`[gpt-${label}] taskId:`, res.data?.data?.taskId ?? JSON.stringify(res.data).slice(0,200));
  const taskId = res.data?.data?.taskId ?? res.data?.taskId;
  return poll(taskId, `gpt-${label}`);
}

async function testNanoBanana(label='nb2') {
  const b64person  = `data:image/jpeg;base64,${buf1.toString('base64')}`;
  const b64garment = `data:image/jpeg;base64,${buf2.toString('base64')}`;
  const res = await axios.post(`${BASE}/images/generations`, {
    model:'nano-banana-2',
    input:{prompt:'The person is wearing the garment shown.', person_image_url:b64person, garment_image_url:b64garment}
  }, {headers:{Authorization:`Bearer ${API_KEY}`,'Content-Type':'application/json'}, maxBodyLength:Infinity, timeout:60000});
  console.log(`[${label}] taskId:`, res.data?.data?.taskId ?? JSON.stringify(res.data).slice(0,200));
  const taskId = res.data?.data?.taskId ?? res.data?.taskId;
  return poll(taskId, label);
}

// Run all tests in parallel
const [urlSquare, urlPortrait, urlLandscape, urlNB] = await Promise.allSettled([
  testGpt('1024x1024', 'square'),
  testGpt('1024x1792', 'portrait'),
  testGpt('1792x1024', 'landscape'),
  testNanoBanana('nb2'),
]);

console.log('\n=== RESULTS ===');
console.log('gpt-square:',   urlSquare.status==='fulfilled'   ? urlSquare.value   : 'ERROR: '+urlSquare.reason);
console.log('gpt-portrait:', urlPortrait.status==='fulfilled' ? urlPortrait.value : 'ERROR: '+urlPortrait.reason);
console.log('gpt-landscape:',urlLandscape.status==='fulfilled'? urlLandscape.value: 'ERROR: '+urlLandscape.reason);
console.log('nano-banana-2:',urlNB.status==='fulfilled'       ? urlNB.value       : 'ERROR: '+urlNB.reason);
