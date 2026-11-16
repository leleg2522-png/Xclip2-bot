import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import * as picsart from '../src/picsart';
import { inspectSeedance25Media } from '../src/seedance25-media';

async function main() {
  const [videoPath, imagePath] = process.argv.slice(2);
  if (!videoPath || !imagePath) {
    throw new Error('Usage: quote-seedance25-flash-edit.ts <video> <character-image>');
  }
  const databaseUrl = process.env.RAILWAY_DATABASE_URL;
  if (!databaseUrl) throw new Error('RAILWAY_DATABASE_URL is required');

  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });
  picsart.initPicsart(pool);
  try {
    const [videoBuffer, imageBuffer] = await Promise.all([
      readFile(videoPath),
      readFile(imagePath),
    ]);
    const videoDuration = await inspectSeedance25Media(videoBuffer, 'video');
    const quote = await picsart.generateSeedance25Flash({
      userId: 0,
      prompt: 'Replace the young man in the navy-blue suit with the woman shown in the image reference. Keep the older woman and the younger woman unchanged. Preserve the source actions, expressions, camera movement, framing, background, lighting, pacing, and original audio. Keep the replacement character recognizable and consistent in every frame; do not add characters or change the story.',
      images: [{ buffer: imageBuffer, name: 'character-reference.jpg', mime: 'image/jpeg' }],
      videos: [{ buffer: videoBuffer, name: 'source-video.mp4', mime: 'video/mp4', duration: videoDuration }],
      taskType: 'edit',
      generateAudio: true,
      quoteOnly: true,
    });
    console.log(JSON.stringify({
      taskType: quote.taskType,
      inputVideoSeconds: Math.round(videoDuration * 1000) / 1000,
      outputDurationSetting: quote.duration,
      aspectRatioSetting: quote.aspectRatio,
      providerCredits: quote.credits,
      providerPrice: quote.price,
      providerUnit: quote.unit,
      usageAmount: quote.usageAmount,
      selectedAccountHasEnoughCredits: quote.hasEnoughProviderCredits,
      submittedPaidJob: false,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error: any) => {
  const message = String(error?.message ?? 'Unknown quote error')
    .replace(/rt:[^\s]+/g, 'rt:[redacted]')
    .slice(0, 240);
  console.error(message);
  process.exitCode = 1;
});
