import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import ts from 'typescript';
import { AxiosError, type AxiosAdapter } from 'axios';
import { createPicsartConnection } from '../src/picsart-connection';

const source = fs.readFileSync(path.resolve(__dirname, '../src/picsart.ts'), 'utf8');
const start = source.indexOf('const PICSART_PROXY_MODE =');
const end = source.indexOf('// Picsart returns any 2xx', start);
const code = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function startup(env: Record<string, string> = {}) {
  const agents: any[] = [], configs: any[] = [], logs: string[] = [];
  vm.runInNewContext(code, {
    process: { env }, encodeURIComponent,
    HttpsProxyAgent: class {
      proxy: URL;
      constructor(url: string) { this.proxy = new URL(url); agents.push(this); }
    },
    createPicsartConnection: (config: any) => { configs.push(config); return {}; },
    console: { log: (message: string) => logs.push(message) },
  });
  return { agents, config: configs[0], logs };
}

function harness(failure: '407' | 'reset' | 'timeout' | 'rejected407' | '403' | '500' = '407') {
  const agent = {}, reads: Array<{ route: string; url: string; data: any }> = [], logs: string[] = [];
  let clock = 0, probes = 0, recovered = false, directFails = false;
  const adapter: AxiosAdapter = async config => {
    assert.equal(config.proxy, false);
    const route = config.httpsAgent === agent ? 'isp' : 'direct';
    assert.equal(config.httpAgent, route === 'isp' ? agent : undefined);
    reads.push({ route, url: config.url!, data: config.data });
    if (route === 'isp' && !recovered) {
      if (failure === 'reset' || failure === 'timeout') {
        throw new AxiosError('network failure', failure === 'reset' ? 'ECONNRESET' : 'ETIMEDOUT', config);
      }
      const response = { status: failure === '403' ? 403 : failure === '500' ? 500 : 407,
        statusText: 'fixture', data: {}, headers: {}, config };
      if (failure === 'rejected407') throw new AxiosError('proxy rejected', 'ERR_BAD_REQUEST', config, undefined, response);
      return response;
    }
    if (route === 'direct' && directFails) throw new AxiosError('direct failure', 'ECONNRESET', config);
    return { status: 200, statusText: 'OK', data: { ok: true }, headers: {}, config };
  };
  const client = createPicsartConnection({
    mode: 'auto', agent, adapter, now: () => clock,
    log: text => logs.push(text),
    probe: async () => { probes++; return recovered; },
  });
  return {
    client, reads, logs, probes: () => probes,
    advance: () => { clock += 60_000; },
    recover: () => { recovered = true; },
    failDirect: () => { directFails = true; },
  };
}

async function main() {
  const secrets = { DECODO_PROXY_USERNAME: 'fixture:user', DECODO_PROXY_PASSWORD: 'fixture@password' };
  const auto = startup(secrets);
  assert.equal(auto.config.mode, 'auto', 'ISP primary with automatic fallback is the default');
  assert.equal(auto.agents.length, 1);
  assert.equal(auto.agents[0].proxy.hostname, 'isp.decodo.com');
  assert.equal(auto.agents[0].proxy.port, '10003');
  assert.equal(auto.config.agent, auto.agents[0]);
  assert.doesNotMatch(auto.logs.join(' '), /fixture|password/);
  assert.equal(startup({ ...secrets, PICSART_PROXY_MODE: 'isp' }).config.mode, 'isp');
  assert.equal(startup({ PICSART_PROXY_MODE: 'direct' }).agents.length, 0);
  assert.throws(() => startup(), /DECODO_PROXY_CONFIG_MISSING/);
  assert.throws(() => startup({ PICSART_PROXY_MODE: 'invalid' }), /PICSART_PROXY_MODE_INVALID/);

  for (const failure of ['407', 'reset', 'timeout', 'rejected407'] as const) {
    const h = harness(failure);
    const result = await h.client.get('https://api.picsart.com/guard/credits');
    assert.equal(result.status, 200);
    assert.deepEqual(h.reads.map(read => read.route), ['isp', 'direct']);
    await h.client.get('https://api.picsart.com/workflows/model/job-id/result');
    assert.equal(h.reads.at(-1)!.route, 'direct');
    assert.equal(h.probes(), 0);
    h.advance();
    await h.client.get('https://api.picsart.com/guard/credits');
    assert.equal(h.probes(), 1);
    assert.equal(h.reads.at(-1)!.route, 'direct', 'Failed recovery stays direct');
    h.recover(); h.advance();
    await Promise.all(Array.from({ length: 5 }, () => h.client.get('https://api.picsart.com/guard/credits')));
    assert.equal(h.probes(), 2, 'Concurrent requests share one recovery probe');
    assert.ok(h.reads.slice(-5).every(read => read.route === 'isp'));
    assert.ok(h.logs.some(text => text.includes('switching back')));
  }
  // Destination errors do not cause network switching or replay.
  for (const failure of ['403', '500'] as const) {
    const h = harness(failure);
    assert.equal((await h.client.get('https://api.picsart.com/')).status, Number(failure));
    assert.deepEqual(h.reads.map(read => read.route), ['isp']);
    assert.equal(h.logs.length, 0);
  }
  // Explicit proxy rejection is safe to replay: it never reached the provider.
  const rejected = harness('407');
  await rejected.client.post('https://api.picsart.com/gw-v2/workflows/model/submit', { params: { prompt: 'test' } });
  assert.deepEqual(rejected.reads.map(read => read.route), ['isp', 'direct']);
  assert.equal(rejected.reads[0].data, rejected.reads[1].data);
  // But an ambiguous paid POST must NEVER be replayed, even if direct is healthy.
  for (const failure of ['reset', 'timeout'] as const) {
    const h = harness(failure);
    await assert.rejects(h.client.post('https://api.picsart.com/gw-v2/workflows/model/submit', { params: {} }));
    assert.equal(h.reads.length, 1);
    await h.client.get('https://api.picsart.com/gw-v2/workflows/model/accepted-job/result');
    assert.equal(h.reads.at(-1)!.route, 'direct');
    assert.ok(h.reads.at(-1)!.url.includes('accepted-job'), 'Poll the same job; no new submit');
  }
  for (const url of ['/oauth2/refresh', '/gw-v2/workflows/model/options']) {
    const h = harness('reset');
    await h.client.post(`https://api.picsart.com${url}`, {});
    assert.deepEqual(h.reads.map(read => read.route), ['isp', 'direct']);
  }
  const failed = harness('reset');
  failed.failDirect();
  await assert.rejects(failed.client.get('https://api.picsart.com/'));
  assert.equal(failed.reads.length, 2, 'Direct failure cannot start a retry loop');

  // Multipart bodies cannot be reused. The caller must rebuild the stream.
  const multipart = harness('407');
  const stream = { pipe() {}, on() {}, once() {}, emit() {} };
  const response = await multipart.client.post('https://upload.picsart.com/v2/files', stream, { transformRequest: [data => data] });
  assert.equal(response.status, 407);
  assert.equal(multipart.reads.length, 1);
  await multipart.client.post('https://upload.picsart.com/v2/files', 'fresh-upload');
  assert.equal(multipart.reads.at(-1)!.route, 'direct');

  // Explicit ISP-only mode never falls back, and direct-only mode never probes.
  for (const mode of ['isp', 'direct'] as const) {
    let calls = 0;
    const client = createPicsartConnection({
      mode, agent: {}, probe: async () => { assert.fail('Forced modes do not probe'); },
      adapter: async config => {
        calls++;
        assert.equal(Boolean(config.httpsAgent), mode === 'isp');
        return { status: 407, statusText: '', headers: {}, data: {}, config };
      },
    });
    assert.equal((await client.get('https://api.picsart.com/')).status, 407);
    assert.equal(calls, 1);
  }
  console.log('Picsart connection: ISP primary, direct failover, shared recovery probes, no paid replay on ambiguous failures, stream safety and secret-safe startup passed.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
