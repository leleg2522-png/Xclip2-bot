import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve, sep } from 'node:path';
import { Pool } from 'pg';
import * as picsart from '../src/picsart';

type SeedanceFlashJobState = {
  version: 1;
  status: 'polling' | 'completed';
  credentialId: number;
  providerTaskId: string;
  outputPath: string;
  submittedAt: string;
  completedAt?: string;
  outputBytes?: number;
  providerCredits?: number;
};

function isInside(directory: string, filePath: string) {
  return filePath.startsWith(`${directory}${sep}`);
}

async function writeJsonAtomically(filePath: string, value: unknown) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(value, null, 2), 'utf8');
  await rename(temporaryPath, filePath);
}

async function main() {
  const stateArg = process.argv[2];
  if (!stateArg) {
    throw new Error('Usage: resume-seedance25-flash-edit.ts <generated-artifacts/.../job-state.json>');
  }

  const artifactsDirectory = resolve(process.cwd(), '../generated-artifacts');
  const statePath = resolve(stateArg);
  if (!isInside(artifactsDirectory, statePath)) {
    throw new Error('Job state must be inside generated-artifacts');
  }

  const state = JSON.parse(await readFile(statePath, 'utf8')) as SeedanceFlashJobState;
  if (state.version !== 1
    || !Number.isInteger(state.credentialId)
    || state.credentialId <= 0
    || typeof state.providerTaskId !== 'string'
    || !state.providerTaskId.trim()
    || !['polling', 'completed'].includes(state.status)
    || typeof state.outputPath !== 'string') {
    throw new Error('Invalid Seedance Flash job state');
  }

  const outputPath = resolve(state.outputPath);
  if (!isInside(artifactsDirectory, outputPath)) {
    throw new Error('Output path must be inside generated-artifacts');
  }
  if (state.status === 'completed') {
    console.log(JSON.stringify({
      resumed: false,
      status: state.status,
      outputPath,
      outputBytes: state.outputBytes,
      providerCredits: state.providerCredits,
      submittedNewJob: false,
    }, null, 2));
    return;
  }

  const databaseUrl = process.env.RAILWAY_DATABASE_URL;
  if (!databaseUrl) throw new Error('RAILWAY_DATABASE_URL is required');
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl: { rejectUnauthorized: false },
  });
  try {
    picsart.initPicsart(pool);
    let lastPollLog = 0;
    const result = await picsart.pollSeedance25FlashResult(state.credentialId, state.providerTaskId, {
      onTick: elapsedMs => {
        const elapsedSec = Math.round(elapsedMs / 1000);
        if (elapsedSec - lastPollLog >= 30) {
          lastPollLog = elapsedSec;
          console.log(`POLL_ELAPSED_SECONDS=${elapsedSec}`);
        }
      },
    });
    const response = await fetch(result.url);
    if (!response.ok) throw new Error(`Result download failed with HTTP ${response.status}`);
    const output = Buffer.from(await response.arrayBuffer());
    if (!output.length || output.length > 100 * 1024 * 1024) {
      throw new Error('Generated result is empty or exceeds the 100MB download cap');
    }

    await mkdir(dirname(outputPath), { recursive: true });
    const temporaryOutputPath = `${outputPath}.${process.pid}.tmp`;
    await writeFile(temporaryOutputPath, output);
    await rename(temporaryOutputPath, outputPath);
    await writeJsonAtomically(statePath, {
      ...state,
      status: 'completed',
      completedAt: new Date().toISOString(),
      outputBytes: output.length,
      providerCredits: result.credits,
    } satisfies SeedanceFlashJobState);
    console.log(JSON.stringify({
      resumed: true,
      outputPath,
      outputBytes: output.length,
      providerCredits: result.credits,
      submittedNewJob: false,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error: any) => {
  const message = String(error?.message ?? 'Unknown resume error')
    .replace(/rt:[^\s]+/g, 'rt:[redacted]')
    .slice(0, 240);
  console.error(message);
  process.exitCode = 1;
});
