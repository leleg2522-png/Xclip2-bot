// Read-only price check plus reference uploads. Paid submission is blocked.
import fs from 'node:fs/promises';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { Pool } from 'pg';
import { GENJUTSU_PROMPT } from '../src/genjutsu';
import { inspectSeedance25Media } from '../src/seedance25-media';

const workspace = path.resolve(__dirname, '../..');
const root = path.join(workspace, 'generated-artifacts/seedance25-p2-character-swap-once');
const sourcePath = path.join(workspace, 'generated-artifacts/genjutsu-indian-film-live-once/source-solo.mp4');
const imagePath = path.join(workspace, 'attached_assets/generated_images/young-ceo-woman-reference.jpg');
const db = new Pool({ connectionString: process.env.RAILWAY_DATABASE_URL,
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });

async function main() {
  const [source, image, moduleSource] = await Promise.all([
    fs.readFile(sourcePath), fs.readFile(imagePath),
    fs.readFile(path.join(workspace, 'telegram-bot/src/picsart.ts'), 'utf8'),
  ]);
  const sourceSeconds = await inspectSeedance25Media(source, 'video');
  const context = vm.createContext({
    exports: {}, require: createRequire(path.join(workspace, 'telegram-bot/src/picsart.ts')),
    process, Buffer, URL, setTimeout, clearTimeout, setInterval, clearInterval,
    console: { log() {}, warn() {}, error() {} },
  });
  const code = ts.transpileModule(moduleSource, { compilerOptions: {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText;
  vm.runInContext(code + '\nexports.qa = { http, commonHeaders, API_BASE, X_APP_AUTHORIZATION };', context);
  const provider = (context as any).exports;
  provider.initPicsart({ query: (sql: string, values?: any[]) => {
    if (!/^\s*SELECT\b/i.test(sql)
      && !/^\s*UPDATE picsart_credentials\s+SET access_token\b/i.test(sql)) {
      throw Error('PREFLIGHT_DATABASE_WRITE_BLOCKED');
    }
    return db.query(sql, values);
  } });
  const { http, commonHeaders, API_BASE, X_APP_AUTHORIZATION } = provider.qa;
  http.interceptors.request.use((config: any) => {
    if (/\/submit(?:[/?]|$)/i.test(config.url ?? '')) throw Error('PAID_SUBMIT_BLOCKED_IN_PREFLIGHT');
    return config;
  });

  const candidates = await db.query(
    "SELECT id FROM picsart_credentials WHERE status = 'available' ORDER BY tier_credits DESC NULLS LAST, id DESC LIMIT 20"
  );
  let accountId: number | undefined;
  const minimumBalance = 130 + Math.ceil(130 * sourceSeconds / 30);
  for (const row of candidates.rows) {
    try {
      const balance = await provider.getCredits(row.id);
      if (balance.credits >= minimumBalance) { accountId = row.id; break; }
    } catch { /* No account-token or transport details in test output. */ }
  }
  if (!accountId) throw Error('NO_READY_P2_ACCOUNT_FOR_REFERENCE_TEST');
  const videoUrl = await provider.uploadFile(accountId, source, 'source-indian-film.mp4', 'video/mp4', { gateway: true });
  const imageUrl = await provider.uploadFile(accountId, image, 'replacement-character.jpg', 'image/jpeg', { gateway: true });
  const params = {
    model: provider.SEEDANCE_MODEL,
    content: [
      { type: 'video_url', video_url: { url: videoUrl }, role: 'reference_video' },
      { type: 'image_url', image_url: { url: imageUrl }, role: 'reference_image' },
      { type: 'text', text: GENJUTSU_PROMPT },
    ],
    ratio: '16:9', duration: 30, resolution: '480p', generate_audio: false,
    omni_reference_task_type: 'reference', output_format: 'mp4',
  };
  const result = await http.post(`${API_BASE}/gw-v2/workflows/seedance/options`, { params }, {
    headers: commonHeaders({
      'content-type': 'application/json',
      authorization: `Bearer ${await provider.getAccessToken(accountId)}`,
      'x-app-authorization': X_APP_AUTHORIZATION,
      'x-sub-package-id': 'subscription_pro_monthly',
    }), validateStatus: () => true,
  });
  const quote = result.data?.response;
  // Legacy Seedance /options returns a price estimate without chargeCredits;
  // unlike Flash's model-v1 contract, that field is optional here.
  if (result.status < 200 || result.status >= 300 || !Number.isFinite(quote?.credits)
    || quote.credits <= 0 || (quote.chargeCredits !== undefined && quote.chargeCredits !== false)) {
    console.log('P2_FREE_QUOTE_UNAVAILABLE', JSON.stringify({
      status: result.status,
      reason: String(result.data?.reason ?? result.data?.status ?? 'INVALID_QUOTE').slice(0, 120),
      responseKeys: Object.keys(quote ?? {}),
      creditValue: quote?.credits, creditType: typeof quote?.credits,
      chargeCredits: quote?.chargeCredits,
    }));
    throw Error('NO_VERIFIED_FREE_QUOTE_DO_NOT_SUBMIT');
  }
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(path.join(root, 'preflight.json'), JSON.stringify({
    quotedAt: new Date().toISOString(), accountId, sourcePath, imagePath, sourceSeconds,
    imageUrls: [imageUrl], videoUrls: [videoUrl], prompt: GENJUTSU_PROMPT,
    duration: 30, ratio: '16:9', resolution: '480p', generateAudio: false,
    quoteCredits: quote.credits, freeQuoteEndpoint: true, estimated: quote.estimated,
    botSaldoCharged: false, paidJobSubmitted: false,
  }, null, 2));
  console.log('P2_FREE_QUOTE', JSON.stringify({
    credits: quote.credits, freeQuoteEndpoint: true, estimated: quote.estimated, sourceSeconds,
    outputSeconds: 30, mode: 'reference', generatedAudio: false, paidJobSubmitted: false,
  }));
}

main().catch(error => {
  console.error('P2_PREFLIGHT_STOPPED', String(error?.message ?? 'UNKNOWN')
    .replace(/https?:\/\/\S+/g, '[url]').replace(/Bearer\s+\S+/gi, '[redacted]').slice(0, 250));
  process.exitCode = 1;
}).finally(() => db.end());
