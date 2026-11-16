import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { Pool } from 'pg';
import * as picsart from '../src/picsart';
import { inspectSeedance25Media } from '../src/seedance25-media';

async function main() {
  const args = process.argv.slice(2);
  const [videoPath, imagePath] = args.filter(arg => !arg.startsWith('--'));
  const submit = args.includes('--submit');
  const maxCreditsArg = args.find(arg => arg.startsWith('--max-provider-credits='));
  const maxProviderCredits = maxCreditsArg ? Number(maxCreditsArg.split('=')[1]) : undefined;
  if (!videoPath || !imagePath) {
    throw new Error('Usage: quote-seedance25-flash-edit.ts <video> <character-image>');
  }
  if (submit && (!Number.isFinite(maxProviderCredits) || (maxProviderCredits ?? 0) <= 0)) {
    throw new Error('Paid submission requires --max-provider-credits=<approved-credit-limit>');
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
    let lastPollLog = 0;
    const sharedInput = {
      userId: 0,
      prompt: 'Replace the main person in the source video with the woman shown in the image reference. Preserve the source movement and choreography, timing, camera framing and movement, background, lighting, other people, and original audio. Keep the reference woman recognizable and consistent throughout; do not add people or change the scene.',
      images: [{ buffer: imageBuffer, name: 'character-reference.jpg', mime: 'image/jpeg' }],
      videos: [{ buffer: videoBuffer, name: 'source-video.mp4', mime: 'video/mp4', duration: videoDuration }],
      taskType: 'edit',
      generateAudio: true,
      persistAccount: false,
      onStatus: stage => console.log(`STAGE=${stage}`),
      onPoll: elapsedSec => {
        if (elapsedSec - lastPollLog >= 30) {
          lastPollLog = elapsedSec;
          console.log(`POLL_ELAPSED_SECONDS=${elapsedSec}`);
        }
      },
    } as const;
    const result = submit
      ? await picsart.generateSeedance25Flash({
        ...sharedInput,
        quoteOnly: false,
        maxProviderCredits,
      })
      : await picsart.generateSeedance25Flash({
        ...sharedInput,
        quoteOnly: true,
      });
    if ('quoteOnly' in result && result.quoteOnly) {
      console.log(JSON.stringify({
        taskType: result.taskType,
        inputVideoSeconds: Math.round(videoDuration * 1000) / 1000,
        outputDurationSetting: result.duration,
        aspectRatioSetting: result.aspectRatio,
        providerCredits: result.credits,
        providerPrice: result.price,
        providerUnit: result.unit,
        usageAmount: result.usageAmount,
        selectedAccountHasEnoughCredits: result.hasEnoughProviderCredits,
        submittedPaidJob: false,
      }, null, 2));
    } else {
      if (!('url' in result) || !result.url) throw new Error('Generation completed without a result URL');
      const response = await fetch(result.url);
      if (!response.ok) throw new Error(`Result download failed with HTTP ${response.status}`);
      const output = Buffer.from(await response.arrayBuffer());
      if (!output.length || output.length > 100 * 1024 * 1024) {
        throw new Error('Generated result is empty or exceeds the 100MB download cap');
      }
      const videoLabel = `${basename(dirname(videoPath))}-${basename(videoPath, extname(videoPath))}`
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'source';
      const outputPath = resolve(process.cwd(), `../generated-artifacts/seedance25-flash-edit-${videoLabel}/output.mp4`);
      await mkdir(resolve(outputPath, '..'), { recursive: true });
      await writeFile(outputPath, output);
      console.log(JSON.stringify({
        taskType: 'edit',
        inputVideoSeconds: Math.round(videoDuration * 1000) / 1000,
        providerCredits: result.credits,
        submittedPaidJob: true,
        outputPath,
        outputBytes: output.length,
      }, null, 2));
    }
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
