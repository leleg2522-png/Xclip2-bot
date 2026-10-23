import assert from 'node:assert/strict';
import { AxiosError, type AxiosAdapter } from 'axios';
import { createPicsartConnection } from '../src/picsart-connection';

function harness(size = 10, ispAgentCount = size) {
  const agents = Array.from({ length: size }, (_, index) => ({ index }));
  const reads: Array<{ index: number; url: string }> = [], probes: number[] = [], logs: string[] = [];
  const failing = new Set([0]);
  const probeFailing = new Set([0]);
  let clock = 0, failure = 'ECONNRESET', onProbe: (() => Promise<void>) | undefined;
  const adapter: AxiosAdapter = async config => {
    const index = agents.indexOf(config.httpsAgent);
    reads.push({ index, url: config.url! });
    if (failing.has(index)) {
      if (failure === '407') {
        const response = { status: 407, statusText: '', config, headers: {}, data: {} };
        throw new AxiosError('fixture proxy rejection', 'ERR_BAD_REQUEST', config, undefined, response);
      }
      throw new AxiosError('fixture network failure', failure, config);
    }
    return { status: 200, statusText: 'OK', config, headers: {}, data: {} };
  };
  const client = createPicsartConnection({
    mode: 'auto', agents, ispAgentCount, adapter, now: () => clock, log: text => logs.push(text),
    probe: async (agent, index) => {
      assert.equal(agent, agents[index]);
      probes.push(index);
      await onProbe?.();
      return !probeFailing.has(index);
    },
  });
  return {
    client, reads, probes, logs, failing, probeFailing,
    advance: () => { clock += 60_000; },
    rejection: () => { failure = '407'; },
    holdProbes: (hold: () => Promise<void>) => { onProbe = hold; },
  };
}

async function main() {
  // The first failure selects another ISP, not direct. Keep the successful IP.
  const h = harness();
  await h.client.get('https://api.picsart.com/guard/credits');
  assert.deepEqual(h.reads.map(read => read.index), [0, 1]);
  assert.equal(h.probes.length, 9);
  await h.client.get('https://api.picsart.com/workflows/model/accepted-job/result');
  assert.equal(h.reads.at(-1)!.index, 1);
  assert.ok(!h.logs.some(text => text.includes('switching to DIRECT')));
  // Failed endpoints are skipped during their cooldown; rotate forward.
  h.failing.add(1); h.probeFailing.add(1);
  await h.client.get('https://api.picsart.com/workflows/model/accepted-job/result');
  assert.equal(h.reads.at(-1)!.index, 2);
  assert.equal(h.probes.filter(index => index === 0).length, 0);
  assert.ok(h.reads.slice(2).every(read => read.url.includes('accepted-job')));

  // All ten checked before direct; later recover to any healthy ISP.
  const exhausted = harness();
  for (let index = 0; index < 10; index++) exhausted.probeFailing.add(index);
  await exhausted.client.get('https://api.picsart.com/');
  assert.deepEqual(exhausted.reads.map(read => read.index), [0, -1]);
  assert.equal(exhausted.probes.length, 9);
  await exhausted.client.get('https://api.picsart.com/');
  assert.equal(exhausted.probes.length, 9, 'No extra probes during cooldown');
  exhausted.advance(); exhausted.probeFailing.delete(7);
  await exhausted.client.get('https://api.picsart.com/');
  assert.equal(exhausted.reads.at(-1)!.index, 7);
  assert.equal(exhausted.probes.length, 19);
  assert.ok(exhausted.logs.some(text => text.includes('switching back')));

  // A successful free probe does not prove the next real request will work.
  // If each actual endpoint fails, the bounded ring still reaches direct.
  const flaky = harness();
  for (let index = 0; index < 10; index++) flaky.failing.add(index);
  await flaky.client.get('https://api.picsart.com/');
  assert.deepEqual(flaky.reads.map(read => read.index), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, -1]);

  // Never submit an ambiguous paid request again on a new ISP.
  const paid = harness();
  await assert.rejects(paid.client.post('https://api.picsart.com/gw-v2/workflows/model/submit', { params: {} }));
  assert.equal(paid.reads.length, 1);
  await paid.client.get('https://api.picsart.com/workflows/model/existing-job/result');
  assert.equal(paid.reads.at(-1)!.index, 1);
  assert.ok(paid.reads.at(-1)!.url.includes('existing-job'));
  // Explicit proxy rejection is before upstream acceptance, so replay is safe.
  const rejected = harness(); rejected.rejection();
  await rejected.client.post('https://api.picsart.com/gw-v2/workflows/model/submit', { params: {} });
  assert.deepEqual(rejected.reads.map(read => read.index), [0, 1]);

  // Concurrent failures share a single scan; do not send customers to direct
  // while the pool is being checked or keep switching a newly healthy route.
  const concurrent = harness();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  concurrent.holdProbes(() => gate);
  const requests = Array.from({ length: 8 }, () => concurrent.client.get('https://api.picsart.com/'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(concurrent.probes.length, 9);
  release(); await Promise.all(requests);
  assert.equal(concurrent.probes.length, 9);
  assert.ok(concurrent.reads.slice(-8).every(read => read.index === 1));

  // A multipart upload must be rebuilt by the caller, not reused on a new IP.
  const multipart = harness(); multipart.rejection();
  const stream = { pipe() {}, on() {}, once() {}, emit() {} };
  await assert.rejects(multipart.client.post('https://upload.picsart.com/v2/files', stream, {
    transformRequest: [data => data],
  }));
  assert.equal(multipart.reads.length, 1);
  await multipart.client.post('https://upload.picsart.com/v2/files', 'rebuilt-upload');
  assert.equal(multipart.reads.at(-1)!.index, 1);

  // With two pools, healthy ISP must win without checking any datacenter IP.
  const primaryWins = harness(20, 10);
  await primaryWins.client.get('https://api.picsart.com/');
  assert.deepEqual(primaryWins.reads.map(read => read.index), [0, 1]);
  assert.ok(primaryWins.probes.every(index => index < 10));

  // All ISP unavailable -> datacenter, not direct. Rotate within datacenter,
  // then recover back to primary ISP after a shared free probe.
  const dc = harness(20, 10);
  for (let index = 0; index < 10; index++) dc.probeFailing.add(index);
  await dc.client.get('https://api.picsart.com/');
  assert.deepEqual(dc.reads.map(read => read.index), [0, 10]);
  assert.deepEqual(dc.probes.slice(0, 9), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.ok(dc.logs.some(text => text.includes('DATACENTER endpoint #1/10')));
  assert.ok(!dc.logs.some(text => text.includes('switching to DIRECT')));
  const beforeDcRetry = dc.probes.length;
  dc.failing.add(10); dc.probeFailing.add(10);
  await dc.client.get('https://api.picsart.com/workflows/model/existing-job/result');
  assert.equal(dc.reads.at(-1)!.index, 11);
  assert.ok(dc.probes.slice(beforeDcRetry).every(index => index >= 10));
  dc.advance(); dc.probeFailing.delete(3);
  const beforeRecovery = dc.probes.length;
  await dc.client.get('https://api.picsart.com/');
  assert.equal(dc.reads.at(-1)!.index, 3);
  assert.ok(dc.probes.slice(beforeRecovery).every(index => index < 10));

  const bothDown = harness(20, 10);
  for (let index = 0; index < 20; index++) bothDown.probeFailing.add(index);
  await bothDown.client.get('https://api.picsart.com/');
  assert.deepEqual(bothDown.reads.map(read => read.index), [0, -1]);
  assert.equal(bothDown.probes.length, 19, 'Check both pools before exposing the hosting IP');

  // Paid-submit ambiguity is still never replayed when a DC backup exists.
  const paidDc = harness(20, 10);
  for (let index = 0; index < 10; index++) paidDc.probeFailing.add(index);
  await assert.rejects(paidDc.client.post('https://api.picsart.com/gw-v2/workflows/model/submit', { params: {} }));
  assert.equal(paidDc.reads.length, 1);
  await paidDc.client.get('https://api.picsart.com/workflows/model/existing-job/result');
  assert.equal(paidDc.reads.at(-1)!.index, 10);
  assert.ok(paidDc.reads.at(-1)!.url.includes('existing-job'));
  console.log('Picsart proxy pools: ISP -> datacenter -> direct, rotation, ISP recovery, concurrency, stream safety and no ambiguous paid replay passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
