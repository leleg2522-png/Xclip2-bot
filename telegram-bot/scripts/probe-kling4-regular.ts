// Read-only provider quotes. Never submits a generation or charges bot saldo.
import { Pool } from 'pg';
import { initPicsart, quoteKling4Regular } from '../src/picsart';
const db = new Pool({ connectionString: process.env.RAILWAY_DATABASE_URL,
  ssl: { rejectUnauthorized: false }, connectionTimeoutMillis: 15000 });
initPicsart(db);
async function main() {
  const result = await db.query("SELECT id FROM picsart_credentials WHERE status = 'available' ORDER BY id DESC LIMIT 1");
  if (!result.rows.length) throw Error('NO_AVAILABLE_ACCOUNT');
  const image = 'https://images.pexels.com/photos/6856000/pexels-photo-6856000.jpeg';
  for (const mode of ['i2v', 'frames'] as const) {
    for (const duration of [10, 15, 30] as const) {
      const credits = await quoteKling4Regular(result.rows[0].id, {
        mode, duration, prompt: 'A gentle camera movement.',
        imageUrls: mode === 'i2v' ? [image] : [image, image],
        ratio: '9:16',
      });
      console.log(JSON.stringify({ model: 'kling-v4', mode, duration, credits }));
    }
  }
  console.log('QUOTES_ONLY_NO_PAID_GENERATION');
}
main().catch(error => {
  console.error('QUOTE_CHECK_FAILED', /^[A-Z_]+$/.test(error.message) ? error.message : 'PROVIDER_UNAVAILABLE');
  process.exitCode = 1;
}).finally(() => db.end());
