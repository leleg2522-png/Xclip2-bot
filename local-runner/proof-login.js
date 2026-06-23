/*
 * Picsart Local Runner — PROOF v5 (login MANUAL + terima undangan + auto kirim ke pool).
 *   STEP A -> login Google langsung (accounts.google.com)        [SUDAH TERBUKTI JALAN]
 *   STEP B -> buka Picsart, BERHENTI: kamu login manual + TERIMA UNDANGAN tim Pro, tekan ENTER
 *   STEP C -> ambil cookie REFRESH_TOKEN (rt:...) dan simpan ke token-found.txt
 *   STEP D -> kirim token Pro ke pool bot (kalau apiBaseUrl + uploadSecret diisi di config.json)
 *
 * PASTIKAN SURFSHARK NYALA. Jalanin lewat run.bat atau: node proof-login.js
 * Screenshot tiap langkah ada di folder ./screenshots
 */

const fs = require("fs");
const path = require("path");

const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
chromium.use(stealth);

const SHOTS_DIR = path.join(__dirname, "screenshots");
const GOOGLE_LOGIN_URL =
  "https://accounts.google.com/v3/signin/identifier?flowName=GlifWebSignIn&flowEntry=ServiceLogin&continue=https://myaccount.google.com/";

// Default tujuan upload token ke pool bot. Sudah ketanam di sini biar FULL-AUTO:
// user nggak perlu ngisi config.json. Bisa di-override lewat config.json kalau mau.
// Catatan: ini BUKAN password panel — cuma kunci khusus upload token.
const DEFAULT_API_BASE =
  "https://2582ab98-7591-47d0-9afb-78f266758bf4-00-24gl24vxcm7oq.sisko.replit.dev";
const DEFAULT_UPLOAD_KEY = "pcs-pool-uplink-3f9Kq7Zm2Wp8Lx";

function loadConfig() {
  const configPath = path.join(__dirname, "config.json");
  if (!fs.existsSync(configPath)) {
    console.error("\n[ERROR] File config.json belum ada. Copy dari config.example.json dulu.\n");
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!cfg.googleEmail || !cfg.googlePassword) {
    console.error("[ERROR] config.json harus berisi googleEmail dan googlePassword.");
    process.exit(1);
  }
  cfg.picsartLoginUrl = cfg.picsartLoginUrl || "https://picsart.com/";
  // FULL-AUTO: pakai default kalau config.json nggak ngisi (nggak perlu diisi).
  cfg.apiBaseUrl = cfg.apiBaseUrl || DEFAULT_API_BASE;
  cfg.uploadSecret = cfg.uploadSecret || DEFAULT_UPLOAD_KEY;
  return cfg;
}

let shotCounter = 0;
async function shot(page, label) {
  try {
    if (!fs.existsSync(SHOTS_DIR)) fs.mkdirSync(SHOTS_DIR, { recursive: true });
    shotCounter += 1;
    const name = `${String(shotCounter).padStart(2, "0")}-${label}.png`;
    await page.screenshot({ path: path.join(SHOTS_DIR, name), fullPage: false });
    console.log(`   [screenshot] ${name}`);
  } catch (e) {
    console.log(`   [screenshot gagal: ${e.message}]`);
  }
}

function log(step, msg) {
  console.log(`\n[${step}] ${msg}`);
}

async function clickFirst(scope, locators, timeoutEach = 5000) {
  for (const make of locators) {
    try {
      const loc = make(scope).first();
      await loc.waitFor({ state: "visible", timeout: timeoutEach });
      await loc.click();
      return true;
    } catch (_) {
      /* coba berikutnya */
    }
  }
  return false;
}

async function fillFirst(scope, locators, value, timeoutEach = 8000) {
  for (const make of locators) {
    try {
      const loc = make(scope).first();
      await loc.waitFor({ state: "visible", timeout: timeoutEach });
      await loc.fill(value);
      return true;
    } catch (_) {
      /* coba berikutnya */
    }
  }
  return false;
}

function classifyGoogle(text, url) {
  const t = (text || "").toLowerCase();
  if (/unusual activity|aktivitas yang tidak biasa/.test(t)) return { ok: false, reason: 'BLOKIR: "unusual activity"' };
  if (/couldn.?t sign you in|browser or app may not be secure/.test(t)) return { ok: false, reason: "BLOKIR: Google nolak (deteksi bot)" };
  if (/verify it.?s you|verifikasi bahwa ini memang|2-step|verifikasi 2-langkah/.test(t)) return { ok: false, reason: "DIMINTA VERIFIKASI (HP/2FA)" };
  if (/wrong password|password salah|sandi yang anda masukkan salah/.test(t)) return { ok: false, reason: "PASSWORD SALAH" };
  if (/myaccount\.google\.com/.test(url || "")) return { ok: true, reason: "Login Google sukses" };
  return { ok: null, reason: "Tidak yakin — cek screenshot terakhir" };
}

async function googleLogin(page, cfg) {
  log("STEP A", "Buka login Google langsung...");
  await page.goto(GOOGLE_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
  await shot(page, "google-login-page");

  log("STEP A", "Isi email...");
  const emailOk = await fillFirst(page, [
    (p) => p.locator('input[type="email"]'),
    (p) => p.locator("#identifierId"),
  ], cfg.googleEmail);
  if (!emailOk) { await shot(page, "google-email-not-found"); throw new Error("Kolom email Google tidak ketemu."); }
  await clickFirst(page, [(p) => p.locator("#identifierNext"), (p) => p.getByRole("button", { name: /next|berikutnya|lanjut/i })]);
  await page.waitForTimeout(3500);

  log("STEP A", "Isi password...");
  const pwOk = await fillFirst(page, [
    (p) => p.locator('input[type="password"]'),
    (p) => p.locator('input[name="Passwd"]'),
  ], cfg.googlePassword, 15000);
  if (!pwOk) { await shot(page, "google-password-not-found"); throw new Error("Kolom password Google tidak muncul (cek screenshot)."); }
  await clickFirst(page, [(p) => p.locator("#passwordNext"), (p) => p.getByRole("button", { name: /next|berikutnya|lanjut/i })]);
  await page.waitForTimeout(6000);
  await shot(page, "google-after-password");

  const bodyText = (await page.locator("body").innerText().catch(() => "")) || "";
  return classifyGoogle(bodyText, page.url());
}

/** Dump tombol & link dari halaman utama + semua iframe. */
async function dumpClickables(page, fileName = "_debug-clickables.txt") {
  try {
    const scopes = [page, ...page.frames()];
    const all = [];
    for (const sc of scopes) {
      const items = await sc.evaluate(() => {
        const out = [];
        document.querySelectorAll("button, a, [role=button], div[role=button]").forEach((el) => {
          const text = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
          if (text) out.push({ tag: el.tagName, text: text.slice(0, 70) });
        });
        return out;
      }).catch(() => []);
      all.push(...items);
    }
    fs.writeFileSync(path.join(SHOTS_DIR, fileName), JSON.stringify(all, null, 2));
    console.log(`   [debug] tombol/link disimpan: ${fileName} (${all.length} item, termasuk iframe)`);
  } catch (e) {
    console.log(`   [debug dump gagal: ${e.message}]`);
  }
}

/** Cari & klik "Continue with Google" di halaman utama ATAU di dalam iframe mana pun. */
async function clickGoogleButton(page) {
  const scopes = [page, ...page.frames()];
  for (const sc of scopes) {
    const ok = await clickFirst(sc, [
      (p) => p.getByRole("button", { name: /continue with google|sign in with google|log in with google/i }),
      (p) => p.getByText(/continue with google|sign in with google|log in with google/i),
      (p) => p.locator('[aria-label*="Google" i]'),
    ], 3500);
    if (ok) return true;
  }
  return false;
}

async function extractToken(context) {
  const cookies = await context.cookies();
  const rt = cookies.find((c) => c.name === "REFRESH_TOKEN");
  if (rt && rt.value) {
    fs.writeFileSync(path.join(__dirname, "token-found.txt"), rt.value);
    const masked = rt.value.slice(0, 8) + "..." + rt.value.slice(-4);
    console.log(`   [TOKEN] REFRESH_TOKEN ketemu: ${masked}  (disimpan ke token-found.txt)`);
    return rt.value;
  }
  // Debug: tulis nama + domain + awalan value tiap cookie biar token bisa diidentifikasi.
  fs.writeFileSync(
    path.join(SHOTS_DIR, "_debug-cookies.txt"),
    JSON.stringify(
      cookies.map((c) => ({
        name: c.name,
        domain: c.domain,
        valuePreview: (c.value || "").slice(0, 14),
      })),
      null,
      2
    )
  );
  console.log("   [TOKEN] REFRESH_TOKEN BELUM ketemu (lihat _debug-cookies.txt).");
  return null;
}

/** Kirim token ke pool bot lewat endpoint server (kalau config-nya ada). */
async function uploadToPool(cfg, rawToken) {
  if (!cfg.apiBaseUrl || !cfg.uploadSecret) {
    console.log("   [POOL] Lewati upload (apiBaseUrl / uploadSecret belum diisi di config.json).");
    console.log("   [POOL] Token tetap tersimpan di token-found.txt (bisa dimasukin manual).");
    return;
  }
  // Decode token percent-encoded (rt%3A... -> rt:...) sebelum dikirim.
  let token = String(rawToken || "").trim();
  if (/%[0-9a-f]{2}/i.test(token)) {
    try { token = decodeURIComponent(token); } catch (_) {}
  }
  const url = cfg.apiBaseUrl.replace(/\/+$/, "") + "/api/local-token";
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-upload-secret": cfg.uploadSecret },
      body: JSON.stringify({ email: cfg.googleEmail, token }),
    });
    const data = await resp.json().catch(() => ({}));
    if (resp.ok && data.ok) {
      console.log(`   [POOL] ✅ Token MASUK ke pool bot (id=${data.credentialId}).`);
    } else {
      console.log(`   [POOL] ⛔ Gagal kirim ke pool: ${data.error || ("HTTP " + resp.status)}`);
      console.log("   [POOL] Token tetap aman di token-found.txt.");
    }
  } catch (e) {
    console.log(`   [POOL] ⛔ Gagal hubungi server: ${e.message}`);
    console.log("   [POOL] Token tetap aman di token-found.txt.");
  }
}

/** Tunggu user tekan ENTER di console. */
function waitForEnter(promptMsg) {
  return new Promise((resolve) => {
    const readline = require("readline");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(promptMsg, () => {
      rl.close();
      resolve();
    });
  });
}

/** Coba ambil token berulang (polling) selama beberapa detik. */
async function extractTokenWithRetry(context, tries = 5, gapMs = 2000) {
  for (let i = 0; i < tries; i++) {
    const cookies = await context.cookies();
    const rt = cookies.find((c) => c.name === "REFRESH_TOKEN");
    if (rt && rt.value) return await extractToken(context);
    if (i < tries - 1) await new Promise((r) => setTimeout(r, gapMs));
  }
  return await extractToken(context);
}

async function picsartFlow(context, page, cfg) {
  // ---- STEP B1: BUKA GMAIL DULU buat terima undangan tim Pro ----
  log("STEP B1", "Buka Gmail dulu buat TERIMA UNDANGAN...");
  await page.goto("https://mail.google.com/mail/u/0/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);
  await shot(page, "gmail-inbox");

  console.log("\n   ----------------------------------------------------------");
  console.log("   >>> LANGKAH 1: TERIMA UNDANGAN DI GMAIL <<<");
  console.log("   ----------------------------------------------------------");
  console.log("   1. Di jendela Gmail yg kebuka, cari email dari PICSART");
  console.log('      (subjeknya soal undangan tim / "join team / invitation").');
  console.log("   2. Buka email-nya, klik tombol \"Accept\" / \"Join team\".");
  console.log("   3. Tunggu sampai muncul konfirmasi kamu udah gabung tim Pro.");
  console.log("   ----------------------------------------------------------");
  console.log("   (Kalau emailnya belum ada, pastikan HEAD udah ngirim undangan dulu.)");
  console.log("");

  await waitForEnter("   >> KALAU UNDANGAN UDAH DITERIMA di Gmail, tekan ENTER... ");

  // ---- STEP B2: LANJUT KE PICSART buat login (kalau belum) ----
  log("STEP B2", `Buka Picsart: ${cfg.picsartLoginUrl}`);
  await page.goto(cfg.picsartLoginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);
  await shot(page, "picsart-home");

  console.log("\n   ----------------------------------------------------------");
  console.log("   >>> LANGKAH 2: LOGIN KE PICSART <<<");
  console.log("   ----------------------------------------------------------");
  console.log('   1. Kalau belum masuk, klik "Log in" -> "Continue with Google".');
  console.log(`   2. Pilih akun: ${cfg.googleEmail}`);
  console.log('   3. Kalau ada layar "Picsart ingin mengakses..." klik Continue/Allow.');
  console.log("   4. Tunggu sampai kebuka halaman Picsart (sudah masuk).");
  console.log("   5. Pastikan akun udah Pro (bukan Free lagi).");
  console.log("   ----------------------------------------------------------");
  console.log("   Login Google kamu udah aktif, jadi tinggal pilih akun aja.");
  console.log("");

  await waitForEnter("   >> KALAU SUDAH MASUK PICSART, tekan ENTER... ");

  await page.bringToFront().catch(() => {});
  await page.waitForTimeout(1500);
  await shot(page, "picsart-after-login");

  log("STEP C", "Ambil cookie REFRESH_TOKEN...");
  return await extractTokenWithRetry(context);
}

async function main() {
  const cfg = loadConfig();
  console.log("\n=================================================");
  console.log(" Picsart Local Runner — PROOF v3");
  console.log("=================================================");
  console.log(" PASTIKAN SURFSHARK SUDAH NYALA.");
  console.log(` Akun : ${cfg.googleEmail}`);
  console.log("=================================================\n");

  const browser = await chromium.launch({
    headless: false,
    channel: "chrome",
    slowMo: 100,
    args: ["--disable-blink-features=AutomationControlled", "--start-maximized"],
  });
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  let gres = { ok: null, reason: "tidak dijalankan" };
  let token = null;
  try {
    gres = await googleLogin(page, cfg);
    console.log(`\n   Hasil login Google: ${gres.ok === true ? "✅" : gres.ok === false ? "⛔" : "❓"} ${gres.reason}`);
    if (gres.ok === true) {
      token = await picsartFlow(context, page, cfg);
      if (token) {
        console.log("\n[STEP D] Kirim token ke pool bot...");
        await uploadToPool(cfg, token);
      }
    }
  } catch (err) {
    console.error("\n[GAGAL] " + err.message);
    await shot(page, "error-final");
  }

  console.log("\n=================================================");
  console.log(" RINGKASAN:");
  console.log(`   Login Google : ${gres.ok === true ? "BERHASIL ✅" : gres.ok === false ? "GAGAL ⛔ (" + gres.reason + ")" : "BELUM PASTI ❓"}`);
  if (gres.ok === true) {
    console.log(`   Token Picsart: ${token ? "KETEMU 🎉 (token-found.txt)" : "BELUM ketemu (cek screenshot picsart-*)"}`);
  }
  console.log(" Detail: folder screenshots/");
  console.log("=================================================\n");

  console.log("Browser dibiarkan terbuka 40 detik biar kamu lihat...");
  await page.waitForTimeout(40000);
  await browser.close();
  console.log("Selesai.");
}

main();
