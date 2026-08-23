/*
 * Freebeat Bridge for Windows
 *
 * Browser session credentials never leave this computer. This agent polls the
 * Telegram bot over HTTPS, runs the Freebeat web flow in a visible browser, and
 * returns only the completed video URL.
 */
const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
const { chromium } = require('playwright');

const CONFIG_PATH = path.join(__dirname, 'freebeat-bridge.config.json');
const PROFILE_DIR = path.join(__dirname, '.freebeat-browser-profile');
const POLL_MS = 5_000;
const POLL_VIDEO_MS = 10_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message) {
  console.log(`[Bridge] ${message}`);
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveConfig(config) {
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

async function collectSetup(config) {
  const rl = readline.createInterface({ input, output });
  try {
    config.apiUrl = String(
      config.apiUrl || process.env.BRIDGE_API_URL || await rl.question('URL bot Railway (contoh https://namabot.up.railway.app): ')
    ).trim().replace(/\/+$/, '');
    if (!config.agentId || !config.agentSecret) {
      const code = String(process.env.BRIDGE_ENROLLMENT_CODE || await rl.question('Kode setup dari perintah /bridgecode: ')).trim();
      if (!config.apiUrl || !code) throw new Error('URL bot dan kode setup wajib diisi.');
      const result = await fetchJson(`${config.apiUrl}/bridge/enroll`, {
        method: 'POST',
        body: { code, name: `Windows Bridge ${process.env.COMPUTERNAME || 'PC'}` },
      });
      config.agentId = result.agentId;
      config.agentSecret = result.agentSecret;
      delete config.enrollmentCode;
      saveConfig(config);
      log('Bridge terhubung. Kode setup tidak disimpan lagi.');
    }
    if (!config.apiUrl) throw new Error('URL bot wajib diisi.');
    saveConfig(config);
    return config;
  } finally {
    rl.close();
  }
}

async function fetchJson(url, { method = 'GET', headers = {}, body } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function agentHeaders(config) {
  return {
    'x-bridge-agent': config.agentId,
    Authorization: `Bearer ${config.agentSecret}`,
  };
}

async function bridgeApi(config, method, pathname, body) {
  return fetchJson(`${config.apiUrl}${pathname}`, {
    method,
    headers: agentHeaders(config),
    body,
  });
}

async function downloadJobImage(config, imagePath) {
  const response = await fetch(`${config.apiUrl}${imagePath}`, { headers: agentHeaders(config) });
  if (!response.ok) throw new Error(`Foto order tidak bisa diunduh (HTTP ${response.status})`);
  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') || 'image/jpeg',
  };
}

async function uploadImage(buffer, filename) {
  const key = `freebeat-bridge/${Date.now()}-${filename}`;
  const sign = await fetchJson('https://api.freebeatfit.com/api/v2/file/genUploadSignUrl', {
    method: 'POST',
    body: { reqList: [{ key, fileName: filename, bucketName: 'freebeat-static' }] },
  });
  const target = sign?.data?.[0];
  if (!target?.signURL || !target?.finalStaticUrl) throw new Error('Freebeat tidak memberi URL upload.');
  const uploaded = await fetch(target.signURL, {
    method: 'PUT',
    headers: { 'Content-Type': 'image/jpeg' },
    body: buffer,
  });
  if (!uploaded.ok) throw new Error(`Upload Freebeat gagal (HTTP ${uploaded.status})`);
  return target.finalStaticUrl;
}

function findVideo(value, name) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findVideo(item, name);
      if (found) return found;
    }
    return null;
  }
  if (value.name === name) {
    const url = value.videoUrl || value.video_url || value.url;
    return typeof url === 'string' && url ? url : null;
  }
  for (const child of Object.values(value)) {
    const found = findVideo(child, name);
    if (found) return found;
  }
  return null;
}

async function postFromFreebeatPage(page, session, pathname, body) {
  return page.evaluate(async ({ sessionHeaders, requestPath, requestBody }) => {
    const response = await fetch(requestPath, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        Accept: '*/*',
        'fb-language': 'en',
        'x-platform-type': 'WEB',
        token: sessionHeaders.token,
        udt: sessionHeaders.udt,
      },
      body: JSON.stringify(requestBody),
    });
    return {
      status: response.status,
      body: await response.json().catch(() => ({})),
    };
  }, { sessionHeaders: session, requestPath: pathname, requestBody: body });
}

async function processJob(config, page, session, job) {
  const heartbeat = setInterval(() => {
    bridgeApi(config, 'POST', `/bridge/jobs/${job.id}/heartbeat`, {}).catch(() => {});
  }, 60_000);
  try {
    log(`Memproses order ${job.id.slice(0, 8)}…`);
    const image = await downloadJobImage(config, job.imagePath);
    const imageUrl = await uploadImage(image.buffer, `bridge-${job.id}.jpg`);
    const generationName = `bridge-${job.id}`;
    const payload = {
      prompt: job.prompt,
      generationType: 0,
      model: 'seedance-2.5',
      modelId: 134,
      duration: 30,
      resolution: '480p',
      style: '',
      images: [imageUrl],
      watermark: 0,
      name: generationName,
      aspectRatio: '16:9',
      extraParams: {},
    };
    const submission = await postFromFreebeatPage(page, session, '/api/proxy/v1/aiVideo/createAiVideo', payload);
    if (submission.status < 200 || submission.status >= 300 || submission.body?.code !== 0) {
      throw new Error(submission.body?.msg || `Freebeat menolak submit (HTTP ${submission.status})`);
    }
    const providerRef = String(submission.body?.data?.id || submission.body?.data?.taskId || '');
    await bridgeApi(config, 'POST', `/bridge/jobs/${job.id}/accepted`, { providerRef });
    log('Freebeat menerima order. Menunggu video…');

    const deadline = Date.now() + 35 * 60_000;
    while (Date.now() < deadline) {
      await sleep(POLL_VIDEO_MS);
      const status = await postFromFreebeatPage(page, session, '/api/proxy/v1/aiVideo/list', { limit: 50, anchor: 0 });
      if (status.status !== 200 || status.body?.code !== 0) continue;
      const videoUrl = findVideo(status.body?.data, generationName);
      if (videoUrl) {
        await bridgeApi(config, 'POST', `/bridge/jobs/${job.id}/complete`, { videoUrl });
        log('Video selesai dan dikirim ke bot.');
        return;
      }
    }
    throw new Error('Freebeat belum memberi hasil setelah 35 menit.');
  } catch (error) {
    const message = String(error?.message || error).slice(0, 500);
    log(`Order gagal: ${message}`);
    await bridgeApi(config, 'POST', `/bridge/jobs/${job.id}/fail`, { message }).catch(() => {});
  } finally {
    clearInterval(heartbeat);
  }
}

async function main() {
  console.log('\n==========================================');
  console.log('          Freebeat Bridge Windows');
  console.log('==========================================\n');
  const config = await collectSetup(loadConfig());
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: null,
  });
  const page = context.pages()[0] || await context.newPage();
  let session = null;
  const watchRequest = (request) => {
    if (!request.url().includes('/api/proxy/v1/')) return;
    const headers = request.headers();
    if (headers.token && headers.udt) {
      session = { token: headers.token, udt: headers.udt };
      log('Sesi Freebeat terdeteksi di browser lokal.');
    }
  };
  page.on('request', watchRequest);
  await page.goto('https://freebeat.ai/ai-video-generator', { waitUntil: 'domcontentloaded' });
  console.log('\nLogin Freebeat di jendela browser yang terbuka. Setelah dashboard termuat, Bridge akan aktif otomatis.\n');

  for (;;) {
    try {
      if (!session) {
        await sleep(POLL_MS);
        continue;
      }
      const response = await bridgeApi(config, 'POST', '/bridge/jobs/claim', {});
      if (response.job) await processJob(config, page, session, response.job);
      else await sleep(POLL_MS);
    } catch (error) {
      log(`Koneksi Bridge: ${String(error?.message || error)}. Coba lagi 10 detik.`);
      await sleep(10_000);
    }
  }
}

main().catch((error) => {
  console.error(`\nBridge berhenti: ${error?.message || error}`);
  process.exitCode = 1;
});