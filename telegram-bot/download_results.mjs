import fs from 'fs';
import axios from 'axios';

const results = {
  'gpt_square_1024x1024.png': 'https://apimarket.5bceaa8e058f4dec6be9e800778a9955.r2.cloudflarestorage.com/images/2026/05/29/f98e0192-ca17-4555-99f0-0805c4185009.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=e2230bb6671a59c60b15411488026185%2F20260529%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260529T113957Z&X-Amz-Expires=86400&X-Amz-Signature=38591d35e998fd4e3a6816c326fa48f59a08bedcd43f0497b0f8eaf4da116fbd&X-Amz-SignedHeaders=host&x-amz-checksum-mode=ENABLED&x-id=GetObject',
  'gpt_portrait_1024x1792.png': 'https://apimarket.5bceaa8e058f4dec6be9e800778a9955.r2.cloudflarestorage.com/images/2026/05/29/2f0e7e33-e11c-4649-bf62-ed6d9ef5e1aa.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=e2230bb6671a59c60b15411488026185%2F20260529%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260529T113949Z&X-Amz-Expires=86400&X-Amz-Signature=6df9e6b12c795fc0eb8eace540506b11bbb7dacc170d8261a48d083759c4bb87&X-Amz-SignedHeaders=host&x-amz-checksum-mode=ENABLED&x-id=GetObject',
  'gpt_landscape_1792x1024.png': 'https://apimarket.5bceaa8e058f4dec6be9e800778a9955.r2.cloudflarestorage.com/images/2026/05/29/f7eb5b1b-ee77-44db-a337-8ec667bae20d.png?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=e2230bb6671a59c60b15411488026185%2F20260529%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260529T114003Z&X-Amz-Expires=86400&X-Amz-Signature=9253f56ac8d330915af4c41f1913dabf73b0e7c5bfb72b02bae06303ab3ad35b&X-Amz-SignedHeaders=host&x-amz-checksum-mode=ENABLED&x-id=GetObject',
  'nano_banana_2_tryon.jpg': 'https://apimarket.5bceaa8e058f4dec6be9e800778a9955.r2.cloudflarestorage.com/images/2026/05/29/04031832-e264-4777-9814-68fd83453a96.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=e2230bb6671a59c60b15411488026185%2F20260529%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20260529T113859Z&X-Amz-Expires=86400&X-Amz-Signature=1655cabacd511a03124d1fd8608a04511376ddafae621436c0da2046707aa810&X-Amz-SignedHeaders=host&x-amz-checksum-mode=ENABLED&x-id=GetObject',
};

for (const [filename, url] of Object.entries(results)) {
  const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
  fs.writeFileSync(`../test_results/${filename}`, res.data);
  console.log(`saved: ${filename} (${(res.data.byteLength/1024).toFixed(1)}KB)`);
}
console.log('done');
