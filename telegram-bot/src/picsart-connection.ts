import axios, { type AxiosAdapter, type AxiosInstance, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';

export type PicsartConnectionMode = 'auto' | 'isp' | 'direct';
type RouteConfig = InternalAxiosRequestConfig & {
  _picsartRoute?: 'isp' | 'direct';
  _picsartDirectRetry?: boolean;
  _picsartProxyIndex?: number;
  _picsartTriedProxies?: number[];
};
const NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT',
  'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
]);

/** Switch transport only; never rerun generation orchestration or accepted jobs. */
export function createPicsartConnection(options: {
  mode: PicsartConnectionMode;
  agent?: unknown;
  agents?: readonly unknown[];
  adapter?: AxiosAdapter;
  probe?: (agent: unknown, index: number) => Promise<boolean>;
  now?: () => number;
  log?: (message: string) => void;
  recoveryDelayMs?: number;
}): AxiosInstance {
  const agents = options.agents?.length ? [...options.agents] : options.agent ? [options.agent] : [];
  if (options.mode !== 'direct' && !agents.length) throw new Error('DECODO_PROXY_CONFIG_MISSING');
  const client = axios.create({ timeout: 120_000, proxy: false, ...(options.adapter ? { adapter: options.adapter } : {}) });
  const probeClient = axios.create({ timeout: 10_000, proxy: false });
  const now = options.now ?? Date.now;
  const log = options.log ?? console.log;
  const recoveryDelay = options.recoveryDelayMs ?? 60_000;
  const probe = options.probe ?? (async (agent: unknown) => {
    const response = await probeClient.get('https://api.picsart.com/', {
      httpAgent: agent, httpsAgent: agent, validateStatus: () => true,
    });
    return response.status >= 200 && response.status < 400;
  });
  let route: 'isp' | 'direct' = options.mode === 'direct' ? 'direct' : 'isp';
  let activeProxy = 0;
  const unavailableUntil = agents.map(() => 0);
  let probeAt = 0;
  let probing: Promise<void> | undefined;

  function fallback() {
    if (route === 'direct') return;
    route = 'direct';
    probeAt = now() + recoveryDelay;
    log('[picsart:proxy] No healthy ISP endpoint available; switching to DIRECT; hosting IP visible to Picsart; ISP recovery check after 60s on next request');
  }

  function candidatesAfter(index: number): number[] {
    return agents.map((_, offset) => (index + offset + 1) % agents.length)
      .filter(candidate => unavailableUntil[candidate] <= now());
  }

  async function findHealthy(candidates: number[]): Promise<number | undefined> {
    // Free connectivity checks run in parallel, bounded to ten configured
    // endpoints. Do not spend 120 seconds retrying the paid request on each IP.
    const results = await Promise.all(candidates.map(async index => {
      try {
        if (await probe(agents[index], index)) return index;
      } catch { /* Never expose credentials, proxy URLs or request configs. */ }
      unavailableUntil[index] = now() + recoveryDelay;
      return undefined;
    }));
    return results.find(index => index !== undefined && unavailableUntil[index] <= now());
  }

  async function switchAfterFailure(failedProxy: number, reason: string) {
    unavailableUntil[failedProxy] = now() + recoveryDelay;
    // Late failures from an older endpoint must not displace a healthy one.
    if (route === 'isp' && activeProxy !== failedProxy && unavailableUntil[activeProxy] <= now()) return;
    if (!probing) {
      probing = (async () => {
        log(`[picsart:proxy] ISP endpoint #${failedProxy + 1} failed (${reason}); checking remaining ISP endpoints`);
        const next = await findHealthy(candidatesAfter(failedProxy));
        if (next === undefined) {
          fallback();
        } else {
          activeProxy = next;
          route = 'isp';
          log(`[picsart:proxy] Switching to ISP endpoint #${next + 1}/${agents.length}; direct fallback not needed`);
        }
      })().finally(() => { probing = undefined; });
    }
    await probing;
  }

  async function recover() {
    if (options.mode !== 'auto' || route !== 'direct' || now() < probeAt) return;
    if (!probing) {
      probing = (async () => {
        // Only free connectivity probes go through ISP. No paid job is replayed.
        try {
          const next = await findHealthy(candidatesAfter(activeProxy));
          if (next !== undefined) {
            activeProxy = next;
            route = 'isp';
            log(`[picsart:proxy] ISP connectivity recovered; switching back to Decodo endpoint #${next + 1}/${agents.length}`);
          }
        } catch { /* Stay direct; never log proxy credentials or request configs. */ }
        finally { probeAt = now() + recoveryDelay; }
      })().finally(() => { probing = undefined; });
    }
    await probing;
  }

  client.interceptors.request.use(async (config: RouteConfig) => {
    if (!config._picsartDirectRetry) await recover();
    config._picsartRoute = config._picsartDirectRetry ? 'direct' : route;
    config._picsartProxyIndex = config._picsartRoute === 'isp' ? activeProxy : undefined;
    if (config._picsartProxyIndex !== undefined) {
      config._picsartTriedProxies = [...(config._picsartTriedProxies ?? []), config._picsartProxyIndex];
    }
    config.proxy = false;
    config.httpAgent = config._picsartRoute === 'isp' ? agents[activeProxy] : undefined;
    config.httpsAgent = config.httpAgent;
    return config;
  });

  function mayReplay(config: RouteConfig, proxyRejected: boolean): boolean {
    // Multipart streams must be rebuilt by uploadFile's bounded pre-submit retry.
    if (config.data && typeof config.data.pipe === 'function') return false;
    // An explicit proxy 407 rejected the request before it reached Picsart.
    if (proxyRejected) return true;
    const method = String(config.method ?? 'get').toLowerCase();
    if (['get', 'head', 'options'].includes(method)) return true;
    // Only explicitly free POST endpoints may be retried after transport loss.
    // In particular, NEVER replay /submit or any other paid POST on a timeout.
    try {
      const pathname = new URL(config.url!, config.baseURL).pathname;
      return method === 'post' && (pathname === '/oauth2/refresh' || pathname.endsWith('/options'));
    } catch { return false; }
  }

  function handleFailure(
    config: RouteConfig | undefined,
    proxyRejected: boolean,
    networkFailure: boolean,
    reason: string,
  ): Promise<AxiosResponse | undefined> | undefined {
    if (options.mode !== 'auto' || config?._picsartRoute !== 'isp'
      || config._picsartDirectRetry || (!proxyRejected && !networkFailure)) return;
    return (async () => {
      await switchAfterFailure(config._picsartProxyIndex ?? 0, reason);
      if (!mayReplay(config, proxyRejected)) return;
      if (route === 'isp' && config._picsartTriedProxies?.includes(activeProxy)) return;
      return client.request({ ...config, _picsartDirectRetry: route === 'direct' } as RouteConfig);
    })();
  }

  client.interceptors.response.use(
    async response => (await handleFailure(response.config as RouteConfig, response.status === 407, false, 'PROXY_AUTH_407')) ?? response,
    async error => {
      const code = error?.code ?? error?.cause?.code;
      const replay = await handleFailure(
        error?.config,
        error?.response?.status === 407,
        NETWORK_CODES.has(code),
        error?.response?.status === 407 ? 'PROXY_AUTH_407' : NETWORK_CODES.has(code) ? code : 'NETWORK_FAILURE',
      );
      return replay ?? Promise.reject(error);
    },
  );
  return client;
}
