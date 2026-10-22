import axios, { type AxiosAdapter, type AxiosInstance, type AxiosResponse, type InternalAxiosRequestConfig } from 'axios';

export type PicsartConnectionMode = 'auto' | 'isp' | 'direct';
type RouteConfig = InternalAxiosRequestConfig & {
  _picsartRoute?: 'isp' | 'direct';
  _picsartDirectRetry?: boolean;
};
const NETWORK_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT',
  'EAI_AGAIN', 'ENOTFOUND', 'EPIPE', 'EHOSTUNREACH', 'ENETUNREACH',
]);

/** Switch transport only; never rerun generation orchestration or accepted jobs. */
export function createPicsartConnection(options: {
  mode: PicsartConnectionMode;
  agent?: unknown;
  adapter?: AxiosAdapter;
  probe?: () => Promise<boolean>;
  now?: () => number;
  log?: (message: string) => void;
  recoveryDelayMs?: number;
}): AxiosInstance {
  if (options.mode !== 'direct' && !options.agent) throw new Error('DECODO_PROXY_CONFIG_MISSING');
  const client = axios.create({ timeout: 120_000, proxy: false, ...(options.adapter ? { adapter: options.adapter } : {}) });
  const probeClient = axios.create({
    timeout: 10_000, proxy: false, httpAgent: options.agent, httpsAgent: options.agent,
  });
  const now = options.now ?? Date.now;
  const log = options.log ?? console.log;
  const recoveryDelay = options.recoveryDelayMs ?? 60_000;
  const probe = options.probe ?? (async () => {
    const response = await probeClient.get('https://api.picsart.com/', { validateStatus: () => true });
    return response.status >= 200 && response.status < 400;
  });
  let route: 'isp' | 'direct' = options.mode === 'direct' ? 'direct' : 'isp';
  let probeAt = 0;
  let probing: Promise<void> | undefined;

  function fallback() {
    if (route === 'direct') return;
    route = 'direct';
    probeAt = now() + recoveryDelay;
    log('[picsart:proxy] ISP unavailable; switching to DIRECT; hosting IP visible to Picsart; ISP recovery check after 60s on next request');
  }

  async function recover() {
    if (options.mode !== 'auto' || route !== 'direct' || now() < probeAt) return;
    if (!probing) {
      probing = (async () => {
        // Only a free connectivity probe goes through ISP. No paid job is replayed.
        try {
          if (await probe()) {
            route = 'isp';
            log('[picsart:proxy] ISP connectivity recovered; switching back to Decodo');
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
    config.proxy = false;
    config.httpAgent = config._picsartRoute === 'isp' ? options.agent : undefined;
    config.httpsAgent = config._picsartRoute === 'isp' ? options.agent : undefined;
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
  ): Promise<AxiosResponse> | undefined {
    if (options.mode !== 'auto' || config?._picsartRoute !== 'isp'
      || config._picsartDirectRetry || (!proxyRejected && !networkFailure)) return;
    fallback();
    if (!mayReplay(config, proxyRejected)) return;
    return client.request({ ...config, _picsartDirectRetry: true } as RouteConfig);
  }

  client.interceptors.response.use(
    response => handleFailure(response.config as RouteConfig, response.status === 407, false) ?? response,
    error => {
      const replay = handleFailure(
        error?.config,
        error?.response?.status === 407,
        NETWORK_CODES.has(error?.code ?? error?.cause?.code),
      );
      return replay ?? Promise.reject(error);
    },
  );
  return client;
}
