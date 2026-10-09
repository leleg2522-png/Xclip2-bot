// Explicitly paid smoke test. Uses pool keys read-only, never charges bot saldo,
// never replays a submit, and saves only non-secret results.
import axios from 'axios';
import { Pool } from 'pg';
import sharp from 'sharp';
import fs from 'node:fs/promises';
import path from 'node:path';
import { generateBananaRenderful } from '../src/banana-renderful';

const paid = process.argv.includes('--paid');
if (!paid) throw Error('Run with --paid only after user authorization.');
const base = 'https://api.renderful.ai/api/v1';
const sourceUrl = 'https://d2w6xqzevsijyc.cloudfront.net/JTgSMQs2GsPA0V4wbyeJ05dQO0q1/images/1769502428976_0.png';
const outDir = path.resolve(__dirname, '../../.agents/outputs/banana-i2i-test');
const http = axios.create({ proxy: false, timeout: 180_000 });
const pool = new Pool({ connectionString: process.env.RAILWAY_DATABASE_URL, ssl: { rejectUnauthorized: false } });
const prompt = 'Edit the provided portrait photo. Preserve exactly the same woman, facial identity, windblown hair, pose, close-up framing and photorealistic style. Change only the gray background to a solid vivid teal studio backdrop. Keep the subject recognizable and the fine hair strands intact. No text or watermark. Output in 4K.';
let submitted = false;
async function main() {
  await fs.mkdir(outDir, { recursive: true });
  const previous = await fs.readFile(path.join(outDir, 'result.json'), 'utf8')
    .then(text => JSON.parse(text)).catch(() => null);
  if (previous?.jobId && !['completed', 'failed'].includes(previous.status)) {
    throw Error('PRIOR_ACCEPTED_JOB_EXISTS_DO_NOT_RESUBMIT');
  }
  const reference = await fs.readFile(path.join(outDir, 'reference.jpg'));
  const rows = await pool.query("SELECT api_key FROM renderful_key_pool WHERE status <> 'dead' ORDER BY id DESC LIMIT 50");
  console.log(`POOL_CANDIDATES ${rows.rows.length}`);
  let key: string | undefined;
  let quoteCost: string | undefined;
  for (const row of rows.rows) {
    try {
      const quote = await http.post(`${base}/agents/quote`, {
        type: 'image-to-image', model: 'nano-banana-2-i2i', resolution: '4k', num_outputs: 1,
      }, { headers: { Authorization: `Bearer ${row.api_key}` } });
      if (quote.data.can_afford) {
        key = row.api_key;
        quoteCost = quote.data.cost_usd;
        console.log(`QUOTE_USD ${quoteCost}`);
        break;
      }
      console.log('PREFLIGHT_UNFUNDED');
    } catch (error: any) {
      console.log(`PREFLIGHT_HTTP ${error.response?.status ?? 'network-error'}`);
      // Some endpoints distinguish agent keys from developer keys. Confirm
      // developer access independently without generating or revealing keys.
      try {
        const balance = await http.get(`${base}/account/balance`, {
          headers: { Authorization: `Bearer ${row.api_key}` },
        });
        if (Number(balance.data.balance_available) >= 0.20) {
          key = row.api_key;
          console.log('DEVELOPER_PREFLIGHT_READY');
          break;
        }
        console.log('DEVELOPER_PREFLIGHT_UNFUNDED');
      } catch (accountError: any) {
        console.log(`DEVELOPER_PREFLIGHT_HTTP ${accountError.response?.status ?? 'network-error'}`);
      }
    }
  }
  if (!key) throw Error('NO_READY_RENDERFUL_KEY');
  const headers = { Authorization: `Bearer ${key}` };
  const result: any = { model: 'nano-banana-2-i2i', resolutionRequested: '4k', prompt, quoteCost, botSaldoCharged: false };
  const save = () => fs.writeFile(path.join(outDir, 'result.json'), JSON.stringify(result, null, 2));
  const url = await generateBananaRenderful({
    model: 'nano-banana-2', mode: 'i2i', prompt, ratio: '16:9',
    images: [{ buffer: reference, name: 'reference.jpg', mime: 'image/jpeg' }],
  }, {
    getKey: async () => key!,
    markDead: async () => {},
    rejectedKey: () => false,
    // Use the same publicly fetchable sample bytes as the saved reference.
    // Telegram URLs and bot tokens are never sent to the provider.
    host: async () => sourceUrl,
    status: async stage => { console.log(`STAGE ${stage}`); },
    submit: async (_key, body) => {
      if (submitted) throw Error('REFUSE_SECOND_SUBMIT');
      submitted = true; // Includes ambiguous failures: do not retry.
      result.request = body;
      await save();
      const response = await http.post(`${base}/generations`, body, { headers });
      result.jobId = response.data.id;
      result.cost = response.data.cost;
      await save();
      console.log(`ACCEPTED_JOB ${result.jobId} COST_USD ${result.cost}`);
      return result.jobId;
    },
    poll: async (_key, id) => {
      for (let i = 0; i < 90; i++) {
        await new Promise(resolve => setTimeout(resolve, 5000));
        const response = await http.get(`${base}/generations/${encodeURIComponent(id)}`, { headers });
        const data = response.data;
        result.status = data.status;
        await save();
        if (i % 6 === 0 || ['completed', 'failed'].includes(data.status)) console.log(`POLL ${i + 1} ${data.status}`);
        if (data.status === 'failed') {
          result.failure = 'Provider returned failed status';
          await save();
          throw Error('PROVIDER_JOB_FAILED');
        }
        if (data.status === 'completed') {
          const output = data.output ?? data.outputs?.[0];
          if (typeof output !== 'string' || !/^https:\/\//.test(output)) throw Error('INVALID_RESULT_URL');
          return output;
        }
      }
      throw Error('POLL_TIMEOUT');
    },
  });
  const response = await http.get(url, { responseType: 'arraybuffer' });
  const bytes = Buffer.from(response.data);
  const meta = await sharp(bytes).metadata();
  const ext = meta.format === 'jpeg' ? 'jpg' : meta.format ?? 'png';
  result.width = meta.width;
  result.height = meta.height;
  result.bytes = bytes.length;
  result.file = `output.${ext}`;
  result.is4k = Math.max(meta.width ?? 0, meta.height ?? 0) >= 3840;
  await fs.writeFile(path.join(outDir, result.file), bytes);
  await save();
  console.log(`RESULT ${meta.width}x${meta.height} ${bytes.length} bytes FILE ${result.file} IS_4K ${result.is4k}`);
  if (!result.is4k) throw Error('OUTPUT_NOT_4K');
  console.log('TEST_COMPLETE');
}
main().catch(async (error: any) => {
  // Never print Axios configs, headers, DB strings or API credential values.
  console.error(`TEST_FAILED ${error.response?.status ? `HTTP_${error.response.status}` : error.code ?? error.message}`);
  process.exitCode = 1;
}).finally(() => pool.end());
