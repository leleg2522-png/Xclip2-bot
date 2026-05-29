import fs from 'fs';
import axios from 'axios';
import sharp from 'sharp';

const API_KEY = 'sk-aaf85f63df97e36c67ec91909d42ad2e481016967eb69d0a125f785d3f2ed417';
const BASE = 'https://api.aivideoapi.ai/v1';

const buf1 = fs.readFileSync('../attached_assets/IMG-20260529-WA0011_1780053975505.jpg');
const buf2 = fs.readFileSync('../attached_assets/Screenshot_20251125-063540_1780054054452.jpg');

// Crop garment image to focus on just the jacket (remove head/face area from garment photo)
const garmentCropped = await sharp(buf2)
  .metadata().then(m => {
    const cropY = Math.floor(m.height * 0.08); // skip top 8% (head area)
    return sharp(buf2)
      .extract({ left: 0, top: cropY, width: m.width, height: m.height - cropY })
      .jpeg({ quality: 90 }).toBuffer();
  });
fs.writeFileSync('../test_results/garment_cropped.jpg', garmentCropped);
console.log(`garment cropped: ${(garmentCropped.length/1024).toFixed(1)}KB`);

const b64person  = `data:image/jpeg;base64,${buf1.toString('base64')}`;
const b64garment = `data:image/jpeg;base64,${buf2.toString('base64')}`;
const b64garmentCropped = `data:image/jpeg;base64,${garmentCropped.toString('base64')}`;

async function poll(taskId, label) {
  for (let i = 0; i < 45; i++) {
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

async function testNB(prompt, b64g, label) {
  const res = await axios.post(`${BASE}/images/generations`, {
    model:'nano-banana-2',
    input:{ prompt, person_image_url:b64person, garment_image_url:b64g }
  }, {headers:{Authorization:`Bearer ${API_KEY}`,'Content-Type':'application/json'}, maxBodyLength:Infinity, timeout:60000});
  const taskId = res.data?.data?.taskId ?? res.data?.taskId;
  console.log(`[${label}] taskId: ${taskId}`);
  return poll(taskId, label);
}

async function testGptPersonOnly(label) {
  // Send ONLY the person image (no composite) with a detailed garment description in prompt
  const b64 = `data:image/jpeg;base64,${buf1.toString('base64')}`;
  const prompt = `Change this person's outfit to a black fitted zip-up athletic jacket with long sleeves and a front center zipper. Keep the person's face, hair, skin tone, pose, and background exactly the same. Only change the clothing.`;
  const res = await axios.post(`${BASE}/images/generations`, {
    model:'gpt-image-2',
    input:{ prompt, image_url:b64, size:'1024x1792' }
  }, {headers:{Authorization:`Bearer ${API_KEY}`,'Content-Type':'application/json'}, maxBodyLength:Infinity, timeout:60000});
  const taskId = res.data?.data?.taskId ?? res.data?.taskId;
  console.log(`[${label}] taskId: ${taskId}`);
  return poll(taskId, label);
}

async function testGptVerticalComposite(label) {
  // Vertical stack: person on top (2/3), garment below (1/3)
  const W = 800, personH = 900, garmentH = 450;
  const personResized = await sharp(buf1).resize(W, personH, {fit:'cover',position:'top'}).jpeg({quality:85}).toBuffer();
  const garmentResized = await sharp(buf2).resize(W, garmentH, {fit:'cover',position:'center'}).jpeg({quality:85}).toBuffer();
  const composite = await sharp({create:{width:W,height:personH+garmentH,channels:3,background:'#f0f0f0'}})
    .composite([
      {input:personResized,left:0,top:0},
      {input:garmentResized,left:0,top:personH},
    ])
    .jpeg({quality:85}).toBuffer();
  fs.writeFileSync('../test_results/composite_vertical.jpg', composite);
  const b64 = `data:image/jpeg;base64,${composite.toString('base64')}`;
  console.log(`[${label}] vertical composite: ${(composite.length/1024).toFixed(1)}KB`);
  const prompt = `The top portion shows a person. The bottom portion shows the target outfit (black zip-up athletic jacket). Dress the person from the top portion in the outfit shown in the bottom portion. Preserve the person's face, hair, and pose exactly.`;
  const res = await axios.post(`${BASE}/images/generations`, {
    model:'gpt-image-2',
    input:{ prompt, image_url:b64, size:'1024x1792' }
  }, {headers:{Authorization:`Bearer ${API_KEY}`,'Content-Type':'application/json'}, maxBodyLength:Infinity, timeout:60000});
  const taskId = res.data?.data?.taskId ?? res.data?.taskId;
  console.log(`[${label}] taskId: ${taskId}`);
  return poll(taskId, label);
}

// Run all 3 tests in parallel
const [r1, r2, r3] = await Promise.allSettled([
  testNB('The person is wearing the garment shown. Keep the person\'s face, skin tone, and hair exactly the same. Only change the outfit.', b64garment, 'nb2-original-garment'),
  testNB('Apply this outfit to the person. Preserve the person\'s identity, face, and hair.', b64garmentCropped, 'nb2-cropped-garment'),
  testGptPersonOnly('gpt-person-only'),
  // testGptVerticalComposite('gpt-vertical'),  // skip to save tokens
]);

console.log('\n=== RESULTS ===');
const labels = ['nb2-original-garment', 'nb2-cropped-garment', 'gpt-person-only'];
[r1, r2, r3].forEach((r, i) => {
  console.log(`${labels[i]}: ${r.status==='fulfilled' ? r.value : 'ERROR: '+r.reason}`);
});
