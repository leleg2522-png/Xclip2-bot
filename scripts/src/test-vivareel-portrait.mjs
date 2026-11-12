import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const dir = 'generated-artifacts/vivareel-wan30-portrait-test-20261112';
const base = 'https://vivareel.ai/api/developer/v1';
const mode = process.argv[2];
const key = process.env.VIVAREEL_API_KEY;
if (!key || !['submit', 'watch'].includes(mode)) throw Error('Use submit or watch with the configured API key.');
await mkdir(dir, { recursive: true });
const save = (name, data) => writeFile(`${dir}/${name}.json`, JSON.stringify(data, null, 2));
const load = async name => JSON.parse(await readFile(`${dir}/${name}.json`, 'utf8'));
async function exists(path) {
  try { await access(path); return true; } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}
async function api(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${key}`, ...(body && { 'Content-Type': 'application/json' }) },
    ...(body && { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(60000),
  });
  const json = await response.json();
  if (!response.ok || json.code !== 200) {
    throw Error(`Vivareel HTTP ${response.status}; application code ${json.code}. No automatic resubmission.`);
  }
  return json;
}

if (mode === 'submit') {
  if (await exists(`${dir}/submit-attempt.json`)) {
    throw Error('A submission was already attempted. Inspect its saved result; never resubmit automatically.');
  }
  const input = JSON.parse(await readFile(
    'generated-artifacts/vivareel-wan30-battle-test-20261112/input.json', 'utf8',
  ));
  input.aspect_ratio = '9:16';
  await save('input', input);
  // Write the guard before the paid POST: a lost response is not safe to replay.
  await save('submit-attempt', { attemptedAt: new Date().toISOString(), automaticRetry: false });
  const result = await api('/videos/generations', input);
  await save('submission', result);
  if (!result.data?.task_id) throw Error('No task ID returned. Inspect saved submission; do not resubmit.');
  console.log(JSON.stringify({ task_id: result.data.task_id, aspect_ratio: input.aspect_ratio,
    duration_seconds: input.duration_seconds, resolution: input.resolution }));
} else {
  const submission = await load('submission');
  const taskId = submission.data?.task_id;
  if (!taskId) throw Error('Missing task ID.');
  const startedAt = Date.now();
  let previousState;
  let readFailures = 0;
  for (;;) {
    if (Date.now() - startedAt > 45 * 60 * 1000) {
      throw Error('Polling window ended. Resume watch for the existing task, never submit again.');
    }
    let result;
    try {
      result = await api(`/tasks/${encodeURIComponent(taskId)}`);
      readFailures = 0;
    } catch (error) {
      if (++readFailures >= 5) throw error;
      console.log(`Status read failed (${readFailures}/5); retrying only this read.`);
      await new Promise(resolve => setTimeout(resolve, 10000));
      continue;
    }
    await save('status', result);
    const data = result.data;
    if (!data || !data.status) throw Error('Malformed status response.');
    if (data.status !== previousState) {
      console.log(JSON.stringify({ status: data.status, progress: data.progress, points_cost: data.points_cost }));
      previousState = data.status;
    }
    if (['failed', 'cancelled', 'canceled'].includes(data.status)) {
      await save('result-summary', { task_id: taskId, status: data.status,
        points_cost: data.points_cost, error_message: data.error_message });
      throw Error('Upstream generation failed. No paid resubmission.');
    }
    if (data.status === 'completed') {
      if (!data.result_url || !data.result_url.startsWith('https://')) {
        throw Error('Completed task has no HTTPS result URL. Inspect saved status.');
      }
      const output = `${dir}/vivareel-wan30-battle-portrait-original.mp4`;
      // A polling restart reuses the same paid task, never starts another generation.
      if (!(await exists(output))) {
        const video = await fetch(data.result_url, { signal: AbortSignal.timeout(180000) });
        if (!video.ok || !video.body) throw Error(`Download failed HTTP ${video.status}. Resume existing task.`);
        const partial = `${output}.partial`;
        await pipeline(Readable.fromWeb(video.body), createWriteStream(partial));
        const { rename } = await import('node:fs/promises');
        await rename(partial, output);
      }
      const summary = { task_id: taskId, status: data.status, points_cost: data.points_cost,
        billing_points: data.extra?.billing_points, output };
      await save('result-summary', summary);
      console.log(JSON.stringify(summary));
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 5000));
  }
}
