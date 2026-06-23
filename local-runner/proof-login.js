/*
 * Picsart Local Runner — PROOF v2: Login Google langsung di accounts.google.com.
 *
 * Tujuan utama: nguji apakah login Google OTOMATIS (email + password, tanpa 2FA)
 * bisa nembus blokir "unusual activity" / deteksi bot, pas dijalanin di PC kamu
 * dengan SURFSHARK NYALA.
 *
 * Alur:
 *   STEP A  -> login ke Google langsung (accounts.google.com)   [BAGIAN PENTING]
 *   STEP B  -> mampir ke Picsart, klik "Continue with Google"   [bonus/plumbing]
 *
 * Jalanin lewat run.bat, atau: node proof-login.js
 * Hasil + screenshot tiap langkah disimpan di folder ./screenshots
 */

const fs = require("fs");
const path = require("path");

const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();
chromium.use(stealth);

const SHOTS_DIR = path.join(__dirname, "screenshots");
const GOOGLE_LOGIN_URL =
  "https://accounts.google.com/v3/signin/identifier?flowName=GlifWebSignIn&flowEntry=ServiceLogin&continue=https://myaccount.google.com/";

function loadConfig() {
  const configPath = path.join(__dirname, "config.json");
  if (!fs.existsSync(configPath)) {
    console.error(
      "\n[ERROR] File config.json belum ada.\n" +
        "Copy config.example.json jadi config.json, lalu isi email & password.\n"
    );
    process.exit(1);
  }
  const cfg = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if (!cfg.googleEmail || !cfg.googlePassword) {
    console.error("[ERROR] config.json harus berisi googleEmail dan googlePassword.");
    process.exit(1);
  }
  cfg.picsartLoginUrl = cfg.picsartLoginUrl || "https://picsart.com/login";
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

async function clickFirst(scope, locators, timeoutEach = 6000) {
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
  if (/unusual activity|aktivitas yang tidak biasa/.test(t))
    return { ok: false, reason: 'BLOKIR: "unusual activity"' };
  if (/couldn.?t sign you in|tidak dapat memverifikasi|browser or app may not be secure/.test(t))
    return { ok: false, reason: "BLOKIR: Google nolak (kemungkinan deteksi bot)" };
  if (/verify it.?s you|verifikasi bahwa ini memang kamu|2-step|verifikasi 2-langkah/.test(t))
    return { ok: false, reason: "DIMINTA VERIFIKASI (HP/2FA)" };
  if (/wrong password|password salah|sandi yang Anda masukkan salah/.test(t))
    return { ok: false, reason: "PASSWORD SALAH" };
  if (/myaccount\.google\.com/.test(url || "")) return { ok: true, reason: "Login sukses" };
  return { ok: null, reason: "Tidak yakin — cek screenshot terakhir" };
}

async function googleLogin(page, cfg) {
  log("STEP A", `Buka halaman login Google langsung...`);
  await page.goto(GOOGLE_LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(2500);
  await shot(page, "google-login-page");

  log("STEP A", "Mengisi email...");
  const emailOk = await fillFirst(
    page,
    [
      (p) => p.locator('input[type="email"]'),
      (p) => p.locator("#identifierId"),
      (p) => p.getByLabel(/email|phone|telepon/i),
    ],
    cfg.googleEmail
  );
  if (!emailOk) {
    await shot(page, "google-email-not-found");
    throw new Error("Kolom email Google tidak ketemu — kirim screenshot google-login-page.png.");
  }
  await shot(page, "google-email-filled");
  await clickFirst(page, [
    (p) => p.locator("#identifierNext"),
    (p) => p.getByRole("button", { name: /next|berikutnya|lanjut/i }),
  ]);
  await page.waitForTimeout(3500);
  await shot(page, "google-after-email");

  log("STEP A", "Mengisi password...");
  const pwOk = await fillFirst(
    page,
    [
      (p) => p.locator('input[type="password"]'),
      (p) => p.locator('input[name="Passwd"]'),
      (p) => p.getByLabel(/password|sandi/i),
    ],
    cfg.googlePassword,
    15000
  );
  if (!pwOk) {
    await shot(page, "google-password-not-found");
    const txt = (await page.locator("body").innerText().catch(() => "")) || "";
    const c = classifyGoogle(txt, page.url());
    throw new Error(
      "Kolom password tidak muncul. Kemungkinan: " + c.reason + " (cek screenshot terakhir)."
    );
  }
  await shot(page, "google-password-filled");
  await clickFirst(page, [
    (p) => p.locator("#passwordNext"),
    (p) => p.getByRole("button", { name: /next|berikutnya|lanjut/i }),
  ]);
  await page.waitForTimeout(6000);
  await shot(page, "google-after-password");

  const bodyText = (await page.locator("body").innerText().catch(() => "")) || "";
  return classifyGoogle(bodyText, page.url());
}

/** Dump semua tombol & link biar gampang nemu selektor yang bener. */
async function dumpClickables(page) {
  try {
    const items = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll("button, a, [role=button]").forEach((el) => {
        const text = (el.innerText || el.textContent || "").trim().replace(/\s+/g, " ");
        const href = el.getAttribute("href") || "";
        if (text || href) out.push({ tag: el.tagName, text: text.slice(0, 80), href: href.slice(0, 120) });
      });
      return out;
    });
    const file = path.join(SHOTS_DIR, "_debug-clickables.txt");
    fs.writeFileSync(file, JSON.stringify(items, null, 2));
    console.log(`   [debug] daftar tombol/link disimpan: _debug-clickables.txt (${items.length} item)`);
  } catch (e) {
    console.log(`   [debug dump gagal: ${e.message}]`);
  }
}

async function picsartGoogleConnect(context, page, cfg) {
  log("STEP B", `Buka Picsart: ${cfg.picsartLoginUrl}`);
  await page.goto(cfg.picsartLoginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(3000);
  await shot(page, "picsart-login-page");

  log("STEP B", 'Cari & klik "Continue with Google" (hindari link Marketplace)...');
  const popupPromise = context.waitForEvent("page", { timeout: 9000 }).catch(() => null);

  const clicked = await clickFirst(page, [
    (p) => p.getByRole("button", { name: /continue with google|sign in with google|log in with google/i }),
    (p) => p.getByText(/continue with google|sign in with google|log in with google/i),
    (p) => p.locator('button:has-text("Google")').filter({ hasNotText: /marketplace|workspace|play/i }),
  ]);

  if (!clicked) {
    await dumpClickables(page);
    await shot(page, "picsart-google-button-not-found");
    console.log('   [STEP B] Tombol "Continue with Google" belum ketemu (lihat _debug-clickables.txt).');
    return;
  }

  let gpage = await popupPromise;
  if (gpage) {
    await gpage.waitForLoadState("domcontentloaded").catch(() => {});
    log("STEP B", "Popup OAuth Google kebuka. Karena udah login, harusnya lanjut otomatis...");
    await gpage.waitForTimeout(5000);
    await shot(gpage, "picsart-oauth-popup");
  } else {
    log("STEP B", "Redirect di tab yang sama (udah login Google, harusnya lanjut otomatis)...");
    await page.waitForTimeout(5000);
  }
  await page.bringToFront().catch(() => {});
  await page.waitForTimeout(4000);
  await shot(page, "picsart-after-connect");
}

async function main() {
  const cfg = loadConfig();

  console.log("\n=================================================");
  console.log(" Picsart Local Runner — PROOF v2 (Login Google)");
  console.log("=================================================");
  console.log(" PASTIKAN SURFSHARK SUDAH NYALA.");
  console.log(` Akun : ${cfg.googleEmail}`);
  console.log("=================================================\n");

  const browser = await chromium.launch({
    headless: false,
    channel: "chrome",
    slowMo: 120,
    args: ["--disable-blink-features=AutomationControlled", "--start-maximized"],
  });
  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  let result = { ok: null, reason: "tidak dijalankan" };
  try {
    result = await googleLogin(page, cfg);

    console.log("\n-------------------------------------------------");
    console.log(" HASIL LOGIN GOOGLE:");
    if (result.ok === true) console.log("   ✅ " + result.reason);
    else if (result.ok === false) console.log("   ⛔ " + result.reason);
    else console.log("   ❓ " + result.reason);
    console.log("-------------------------------------------------");

    if (result.ok === true) {
      // Cuma lanjut ke Picsart kalau login Google sukses.
      await picsartGoogleConnect(context, page, cfg);
    }
  } catch (err) {
    console.error("\n[GAGAL] " + err.message);
    await shot(page, "error-final");
  }

  console.log("\n=================================================");
  console.log(" RINGKASAN:");
  if (result.ok === true)
    console.log("   Login Google OTOMATIS BERHASIL (IP Surfshark lolos). 🎉");
  else if (result.ok === false)
    console.log("   Login Google KEHALANG: " + result.reason);
  else console.log("   Hasil belum pasti — kirim screenshot terakhir ke chat.");
  console.log(" Cek folder screenshots/ untuk detail tiap langkah.");
  console.log("=================================================\n");

  console.log("Browser dibiarkan terbuka 30 detik biar bisa kamu lihat...");
  await page.waitForTimeout(30000);
  await browser.close();
  console.log("Selesai.");
}

main();
