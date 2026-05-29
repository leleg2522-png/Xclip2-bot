import fs from 'fs';
import axios from 'axios';

const API_KEY = 'sk-aaf85f63df97e36c67ec91909d42ad2e481016967eb69d0a125f785d3f2ed417';
const BASE = 'https://api.aivideoapi.ai/v1';

// Poll remaining task + known completed tasks
const tasks = {
  'nb2_original': '705e8749-3aa6-4270-98a9-609bb7417891',
  'nb2_cropped':  '852f21c0-2a16-4230-8cea-e6059cf7698a',
  'gpt_person_only': '8310ae59-5eaa-4325-8f24-2cd62ded9f4e',
};

async function pollOnce(taskId, label) {
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 6000));
    const r = await axios.get(`${BASE}/tasks/${taskId}`, {
      headers:{Authorization:`Bearer ${API_KEY}`}, timeout:30000
    });
    const {status,output,error} = r.data;
    console.log(`[${label}] ${i+1}: ${status}`);
    if (status==='completed'||status==='succeed'||status==='success') {
      return output?.urls?.[0]??output?.url??output?.image_url??output?.images?.[0]?.url??output?.[0]?.url;
    }
    if (status==='failed'||status==='error') throw new Error(JSON.stringify(error));
  }
  throw new Error('timeout');
}

const results = await Promise.allSettled(
  Object.entries(tasks).map(([label, id]) => pollOnce(id, label).then(url => ({label, url})))
);

console.log('\n=== URLS ===');
for (const r of results) {
  if (r.status==='fulfilled') {
    const {label, url} = r.value;
    console.log(`${label}: ${url}`);
    const resp = await axios.get(url, {responseType:'arraybuffer', timeout:30000});
    const ext = url.includes('.jpg') ? 'jpg' : 'png';
    const path = `../test_results/${label}.${ext}`;
    fs.writeFileSync(path, resp.data);
    console.log(`  saved: ${path} (${(resp.data.byteLength/1024).toFixed(1)}KB)`);
  } else {
    console.log(`ERROR: ${r.reason}`);
  }
}
