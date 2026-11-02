// Read an existing job only. No upload, options quote, paid submit or saldo update.
import fs from 'node:fs';
import path from 'node:path';
import Module from 'node:module';
import ts from 'typescript';
import { Pool } from 'pg';
import axios from 'axios';
import sharp from 'sharp';

const credId = Number(process.argv[2]), jobId = process.argv[3];
if (!Number.isSafeInteger(credId) || credId < 1 || !/^[a-zA-Z0-9-]{1,160}$/.test(jobId ?? '')) {
  throw Error('Usage: inspect-existing-kling4-job.ts <credential-id> <existing-job-id>');
}
const db = new Pool({ connectionString: process.env.RAILWAY_DATABASE_URL,
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });

function safe(value: unknown): unknown {
  if (typeof value === 'string') return value.slice(0, 1200)
    .replace(/https?:\/\/[^\s"<>]+/gi, '[url]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[jwt]')
    .replace(/((?:token|cookie|authorization|password|api.?key)["'\s:=]+)[^\s,;}]+/gi, '$1[redacted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]');
  if (Array.isArray(value)) return value.slice(0, 10).map(safe);
  if (value && typeof value === 'object') return Object.fromEntries(
    Object.entries(value).filter(([key]) => /^(status|code|error|errors|reason|message|detail|error_code|error_message|description|type)$/i.test(key))
      .map(([key, v]) => [key, safe(v)]),
  );
  return value;
}

async function main() {
  // Keep the exact deployed connection/auth behavior without exporting private
  // request clients from the application or duplicating proxy credentials.
  const filename = path.resolve(__dirname, '../src/picsart.ts');
  const source = fs.readFileSync(filename, 'utf8') + `
export async function inspectExistingJob(credId: number, id: string) {
  const access = await getAccessToken(credId);
  const r = await http.get(API_BASE + '/gw-v2/workflows/kling-image-to-video/' + id + '/result', {
    timeout: 15000, validateStatus: () => true,
    headers: commonHeaders({ authorization: 'Bearer ' + access,
      'x-app-authorization': X_APP_AUTHORIZATION, 'x-sub-package-id': 'subscription_pro_monthly' }),
  });
  const response = r.data?.response ?? r.data;
  return { httpStatus: r.status, body: r.data, hasResult: !!extractPicsartVideoUrl(response) };
}
`;
  const loaded = new (Module as any)(filename);
  loaded.filename = filename;
  loaded.paths = (Module as any)._nodeModulePaths(path.dirname(filename));
  loaded._compile(ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText, filename);
  loaded.exports.initPicsart(db);
  const account = await db.query('SELECT id, status FROM picsart_credentials WHERE id=$1 LIMIT 1', [credId]);
  console.log(JSON.stringify({ credential: account.rows[0] ?? null }));
  const result = await loaded.exports.inspectExistingJob(credId, jobId);
  console.log(JSON.stringify({
    httpStatus: result.httpStatus, hasResult: result.hasResult,
    topLevelKeys: Object.keys(result.body ?? {}),
    responseKeys: Object.keys(result.body?.response ?? {}),
    diagnostic: safe(result.body), responseDiagnostic: safe(result.body?.response),
  }));
  if (process.argv.includes('--probe-upload')) {
    const buffer = await sharp({ create: { width: 512, height: 512, channels: 3, background: '#667799' } }).jpeg().toBuffer();
    const url = await loaded.exports.uploadFile(credId, buffer, 'kling4-diagnostic.jpg', 'image/jpeg', { gateway: true });
    // Public GET, deliberately without any Picsart cookie or authorization.
    const check = await axios.get(url, { responseType: 'arraybuffer', timeout: 15000,
      maxContentLength: 5 * 1024 * 1024, validateStatus: () => true });
    let metadata: unknown = null;
    try {
      const m = await sharp(Buffer.from(check.data)).metadata();
      metadata = { format: m.format, width: m.width, height: m.height };
    } catch { /* Non-image responses are reported without printing bodies. */ }
    console.log(JSON.stringify({
      uploadProbe: true, host: new URL(url).hostname, publicGetStatus: check.status,
      contentType: check.headers['content-type'], bytes: check.data.length, metadata,
    }));
  }
}
main().catch(error => {
  console.error('EXISTING_JOB_INSPECTION_FAILED', safe(String(error?.message ?? 'unknown')));
  process.exitCode = 1;
}).finally(() => db.end());
