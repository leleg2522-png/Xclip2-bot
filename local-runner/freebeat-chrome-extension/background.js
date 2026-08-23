const SETTINGS_KEY = 'freebeatBridgeSettings';
const ACTIVE_JOB_KEY = 'freebeatBridgeActiveJob';
const SESSION_KEY = 'freebeatBridgeSession';
const ALARM_NAME = 'freebeat-bridge-poll';
const FREEBEAT_TAB_URL = 'https://freebeat.ai/ai-video-generator';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function normalizeApiUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '');
}

async function getSettings() {
  return (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] || null;
}

async function setSettings(settings) {
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
}

async function getActiveJob() {
  return (await chrome.storage.local.get(ACTIVE_JOB_KEY))[ACTIVE_JOB_KEY] || null;
}

async function setActiveJob(job) {
  if (job) await chrome.storage.local.set({ [ACTIVE_JOB_KEY]: job });
  else await chrome.storage.local.remove(ACTIVE_JOB_KEY);
}

async function getSession() {
  const stored = (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY];
  if (!stored || Date.now() - stored.updatedAt > 60 * 60_000) return null;
  return stored;
}

async function setSession(session) {
  await chrome.storage.session.set({ [SESSION_KEY]: { ...session, updatedAt: Date.now() } });
}

function agentHeaders(settings) {
  return {
    'x-bridge-agent': settings.agentId,
    authorization: `Bearer ${settings.agentSecret}`
  };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {})
    }
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

async function bridgeApi(settings, method, pathname, body) {
  return fetchJson(`${settings.apiUrl}${pathname}`, {
    method,
    headers: agentHeaders(settings),
    body: body ? JSON.stringify(body) : undefined
  });
}

async function findFreebeatTab() {
  const session = await getSession();
  if (!session?.tabId) return null;
  const tab = await chrome.tabs.get(session.tabId).catch(() => null);
  return tab?.id && !tab.discarded && tab.url?.startsWith('https://freebeat.ai/') ? tab : null;
}

async function pageRequest(tabId, session, path, body) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'ISOLATED',
    func: async (requestPath, requestBody, requestSession) => {
      try {
        const response = await fetch(requestPath, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json',
            Accept: '*/*',
            'fb-language': 'en',
            'x-platform-type': 'WEB',
            token: requestSession.token,
            udt: requestSession.udt
          },
          body: JSON.stringify(requestBody)
        });
        return {
          ok: true,
          status: response.status,
          body: await response.json().catch(() => ({}))
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
    args: [path, body, { token: session.token, udt: session.udt }]
  });
  if (!result?.ok) throw new Error(result?.error || 'Freebeat tidak merespons.');
  return result;
}

async function downloadImage(settings, imagePath) {
  const response = await fetch(`${settings.apiUrl}${imagePath}`, { headers: agentHeaders(settings) });
  if (!response.ok) throw new Error(`Foto order tidak bisa diunduh (HTTP ${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

async function uploadImage(buffer, filename) {
  const key = `freebeat-bridge/${Date.now()}-${filename}`;
  const signed = await fetchJson('https://api.freebeatfit.com/api/v2/file/genUploadSignUrl', {
    method: 'POST',
    body: JSON.stringify({ reqList: [{ key, fileName: filename, bucketName: 'freebeat-static' }] })
  });
  const target = signed?.data?.[0];
  if (!target?.signURL || !target?.finalStaticUrl) throw new Error('Freebeat tidak memberi URL upload.');
  const uploaded = await fetch(target.signURL, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/jpeg' },
    body: buffer
  });
  if (!uploaded.ok) throw new Error(`Upload Freebeat gagal (HTTP ${uploaded.status})`);
  return target.finalStaticUrl;
}

function findVideo(value, name) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findVideo(item, name);
      if (result) return result;
    }
    return null;
  }
  if (value.name === name) {
    const url = value.videoUrl || value.video_url || value.url;
    return typeof url === 'string' && url ? url : null;
  }
  for (const child of Object.values(value)) {
    const result = findVideo(child, name);
    if (result) return result;
  }
  return null;
}

function findGeneration(value, name) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const result = findGeneration(item, name);
      if (result) return result;
    }
    return null;
  }
  if (value.name === name) return value;
  for (const child of Object.values(value)) {
    const result = findGeneration(child, name);
    if (result) return result;
  }
  return null;
}

function jobPayload(job, imageUrl) {
  return {
    prompt: job.prompt,
    generationType: 0,
    model: 'seedance-2.5',
    modelId: 134,
    duration: 30,
    resolution: '480p',
    style: '',
    images: [imageUrl],
    watermark: 0,
    name: job.generationName,
    aspectRatio: '16:9',
    extraParams: {}
  };
}

async function failActiveJob(settings, active, message) {
  try {
    await bridgeApi(settings, 'POST', `/bridge/jobs/${active.id}/fail`, { message: String(message).slice(0, 500) });
  } finally {
    await setActiveJob(null);
  }
}

async function startClaimedJob(settings, session, tab, job) {
  const active = {
    ...job,
    state: 'preparing',
    generationName: `bridge-${job.id}`,
    startedAt: Date.now()
  };
  await setActiveJob(active);
  let submissionMayHaveStarted = false;
  try {
    const image = await downloadImage(settings, job.imagePath);
    const imageUrl = await uploadImage(image, `bridge-${job.id}.jpg`);
    await setActiveJob({ ...active, state: 'submitting' });
    submissionMayHaveStarted = true;
    const submission = await pageRequest(tab.id, session, '/api/proxy/v1/aiVideo/createAiVideo', jobPayload(active, imageUrl));
    if (submission.status < 200 || submission.status >= 300 || submission.body?.code !== 0) {
      throw new Error(submission.body?.msg || `Freebeat menolak submit (HTTP ${submission.status})`);
    }
    const providerRef = String(submission.body?.data?.id || submission.body?.data?.taskId || '');
    const accepted = await bridgeApi(settings, 'POST', `/bridge/jobs/${job.id}/accepted`, { providerRef });
    if (!accepted.accepted) throw new Error('Server tidak menerima status order.');
    await setActiveJob({ ...active, state: 'accepted', acceptedAt: Date.now() });
  } catch (error) {
    if (submissionMayHaveStarted) {
      // The provider may have accepted the job even if the browser lost its response.
      // The next alarm reconciles by deterministic generationName; it never resubmits.
      return;
    }
    await failActiveJob(settings, active, error instanceof Error ? error.message : String(error));
  }
}

async function continueActiveJob(settings, session, tab, active) {
  if (active.state === 'submitting') {
    const reconciliation = await pageRequest(tab.id, session, '/api/proxy/v1/aiVideo/list', { limit: 50, anchor: 0 });
    const generation = reconciliation.status === 200 && reconciliation.body?.code === 0
      ? findGeneration(reconciliation.body?.data, active.generationName)
      : null;
    if (!generation) {
      if (Date.now() - active.startedAt > 2 * 60_000) {
        await failActiveJob(settings, active, 'Status submit Freebeat tidak dapat dipastikan');
      }
      return;
    }
    const providerRef = String(generation.id || generation.taskId || '');
    const accepted = await bridgeApi(settings, 'POST', `/bridge/jobs/${active.id}/accepted`, { providerRef });
    if (!accepted.accepted) {
      await failActiveJob(settings, active, 'Server tidak menerima status submit Freebeat');
      return;
    }
    active = { ...active, state: 'accepted', acceptedAt: Date.now() };
    await setActiveJob(active);
  }
  if (active.state === 'accepted') {
    if (Date.now() - active.acceptedAt > 35 * 60_000) {
      await failActiveJob(settings, active, 'Freebeat belum memberi hasil setelah 35 menit');
      return;
    }
    const alive = await bridgeApi(settings, 'POST', `/bridge/jobs/${active.id}/heartbeat`, {});
    if (!alive.active) {
      await setActiveJob(null);
      return;
    }
    const result = await pageRequest(tab.id, session, '/api/proxy/v1/aiVideo/list', { limit: 50, anchor: 0 });
    if (result.status !== 200 || result.body?.code !== 0) return;
    const videoUrl = findVideo(result.body?.data, active.generationName);
    if (!videoUrl) return;
    await bridgeApi(settings, 'POST', `/bridge/jobs/${active.id}/complete`, { videoUrl });
    await setActiveJob(null);
    return;
  }
  await failActiveJob(settings, active, 'Bridge berhenti sebelum order diterima Freebeat');
}

let polling = false;
async function pollBridge() {
  if (polling) return;
  polling = true;
  try {
    const settings = await getSettings();
    if (!settings?.apiUrl || !settings?.agentId || !settings?.agentSecret) return;
    const session = await getSession();
    const tab = await findFreebeatTab();
    if (!session || !tab?.id) return;

    const active = await getActiveJob();
    if (active) {
      await continueActiveJob(settings, session, tab, active);
      return;
    }
    const claimed = await bridgeApi(settings, 'POST', '/bridge/jobs/claim', {});
    if (claimed.job) await startClaimedJob(settings, session, tab, claimed.job);
  } catch (error) {
    console.warn('Freebeat Bridge poll gagal:', error instanceof Error ? error.message : error);
  } finally {
    polling = false;
  }
}

async function ensureAlarm() {
  await chrome.alarms.create(ALARM_NAME, { periodInMinutes: 0.5 });
}

chrome.runtime.onInstalled.addListener(() => { void ensureAlarm(); });
chrome.runtime.onStartup.addListener(() => { void ensureAlarm(); });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_NAME) void pollBridge();
});

chrome.webRequest.onBeforeSendHeaders.addListener((details) => {
  if (!details.url.includes('/api/proxy/v1/')) return;
  const headers = Object.fromEntries((details.requestHeaders || []).map((header) => [
    String(header.name || '').toLowerCase(),
    String(header.value || '')
  ]));
  if (headers.token && headers.udt) {
    void setSession({ token: headers.token, udt: headers.udt, tabId: details.tabId });
  }
}, { urls: ['https://freebeat.ai/api/proxy/v1/*'] }, ['requestHeaders', 'extraHeaders']);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'get-status') {
    Promise.all([getSettings(), getSession(), findFreebeatTab(), getActiveJob()]).then(([settings, session, tab, active]) => {
      sendResponse({
        connected: Boolean(settings?.agentId),
        sessionReady: Boolean(session),
        tabReady: Boolean(tab?.id),
        activeJob: active?.id || null
      });
    });
    return true;
  }
  if (message?.type === 'save-setup') {
    (async () => {
      const apiUrl = normalizeApiUrl(message.apiUrl);
      const code = String(message.code || '').trim().toUpperCase();
      if (!apiUrl || !code) throw new Error('URL bot dan kode setup wajib diisi.');
      const origin = new URL(apiUrl).origin;
      const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
      if (!granted) throw new Error('Izin koneksi ke bot belum diberikan.');
      const enrollment = await fetchJson(`${apiUrl}/bridge/enroll`, {
        method: 'POST',
        body: JSON.stringify({ code, name: `Chrome Bridge ${navigator.userAgent.includes('Windows') ? 'Windows' : 'PC'}` })
      });
      await setSettings({ apiUrl, agentId: enrollment.agentId, agentSecret: enrollment.agentSecret });
      await ensureAlarm();
      await pollBridge();
      return { ok: true };
    })().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type === 'open-freebeat') {
    chrome.tabs.create({ url: FREEBEAT_TAB_URL }).then(() => sendResponse({ ok: true }));
    return true;
  }
  return undefined;
});

void ensureAlarm();