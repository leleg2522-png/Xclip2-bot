import fs from 'fs';
import axios from 'axios';

const API_KEY = 'sk-aaf85f63df97e36c67ec91909d42ad2e481016967eb69d0a125f785d3f2ed417';
const BASE = 'https://api.aivideoapi.ai/v1';

const buf1 = fs.readFileSync('../attached_assets/IMG-20260529-WA0011_1780053975505.jpg');
const buf2 = fs.readFileSync('../attached_assets/Screenshot_20251125-063540_1780054054452.jpg');
const b64person  = `data:image/jpeg;base64,${buf1.toString('base64')}`;
const b64garment = `data:image/jpeg;base64,${buf2.toString('base64')}`;
console.log(`person: ${(buf1.length/1024).toFixed(1)}KB, garment: ${(buf2.length/1024).toFixed(1)}KB`);

const body = {
  model: 'nano-banana-2',
  input: {
    prompt: 'The person is wearing the garment shown.',
    person_image_url: b64person,
    garment_image_url: b64garment,
  }
};

const res = await axios.post(`${BASE}/images/generations`, body, {
  headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
  maxBodyLength: Infinity, timeout: 60000
});
console.log('response:', JSON.stringify(res.data).slice(0, 400));

const taskId = res.data?.data?.taskId ?? res.data?.data?.id ?? res.data?.taskId ?? res.data?.id;
console.log('taskId:', taskId);

for (let i = 0; i < 40; i++) {
  await new Promise(r => setTimeout(r, 8000));
  const r = await axios.get(`${BASE}/tasks/${taskId}`, {
    headers: { Authorization: `Bearer ${API_KEY}` }, timeout: 30000
  });
  const { status, output, error } = r.data;
  console.log(`attempt ${i+1}: status=${status}`, output ? JSON.stringify(output).slice(0,200) : '');
  if (status === 'completed' || status === 'succeed' || status === 'success') {
    const url = output?.urls?.[0] ?? output?.url ?? output?.image_url
             ?? output?.images?.[0]?.url ?? output?.images?.[0] ?? output?.[0]?.url;
    console.log('RESULT URL:', url ?? JSON.stringify(output));
    break;
  }
  if (status === 'failed' || status === 'error') { console.error('FAILED:', error); break; }
}
