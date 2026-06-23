/*
 * Picsart Local Runner — PROOF: Google login via "Continue with Google".
 *
 * Tujuan: nguji apakah login Google otomatis (lewat tombol "Continue with
 * Google" di Picsart) bisa nembus blokir "unusual activity" pas dijalanin di
 * PC kamu dengan SURFSHARK NYALA.
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

/** Klik elemen pertama yang ketemu dari daftar locator. */
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

async function doGoogleLogin(gpage, cfg) {
  log("GOOGLE", "Mengisi email...");
  const emailOk = await fillFirst(
    gpage,
    [
      (p) => p.locator('input[type="email"]'),
      (p) => p.locator("#identifierId"),
      (p) => p.getByLabel(/email|phone/i),
    ],
    cfg.googleEmail
  );
  if (!emailOk) {
    await shot(gpage, "google-email-not-found");
    throw new Error("Kolom email Google tidak ketemu.");
  }
  await shot(gpage, "google-email-filled");

  await clickFirst(gpage, [
    (p) => p.locator("#identifierNext"),
    (p) => p.getByRole("button", { name: /next|berikutnya|lanjut/i }),
  ]);

  await gpage.waitForTimeout(2500);
  await shot(gpage, "google-after-email-next");

  log("GOOGLE", "Mengisi password...");
  const pwOk = await fillFirst(
    gpage,
    [
      (p) => p.locator('input[type="password"]'),
      (p) => p.locator('input[name="Passwd"]'),
      (p) => p.getByLabel(/password|sandi/i),
    ],
    cfg.googlePassword,
    15000
  );
  if (!pwOk) {
    await shot(gpage, "google-password-not-found");
    throw new Error(
      "Kolom password Google tidak ketemu (mungkin kena blokir / minta verifikasi)."
    );
  }
  await shot(gpage, "google-password-filled");

  await clickFirst(gpage, [
    (p) => p.locator("#passwordNext"),
    (p) => p.getByRole("button", { name: /next|berikutnya|lanjut/i }),
  ]);

  await gpage.waitForTimeout(4000);
  await shot(gpage, "google-after-password-next");
}

async function main() {
  const cfg = loadConfig();

  console.log("\n=================================================");
  console.log(" Picsart Local Runner — PROOF Google Login");
  console.log("=================================================");
  console.log(" PASTIKAN SURFSHARK SUDAH NYALA.");
  console.log(` Target login : ${cfg.picsartLoginUrl}`);
  console.log(` Akun         : ${cfg.googleEmail}`);
  console.log("=================================================\n");

  const browser = await chromium.launch({
    headless: false,
    channel: "chrome",
    slowMo: 120,
    args: ["--disable-blink-features=AutomationControlled", "--start-maximized"],
  });

  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  try {
    log("STEP 1", `Buka halaman login Picsart: ${cfg.picsartLoginUrl}`);
    await page.goto(cfg.picsartLoginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(3000);
    await shot(page, "picsart-login-page");

    log("STEP 2", 'Klik tombol "Continue with Google"...');
    let popupPromise = context.waitForEvent("page", { timeout: 8000 }).catch(() => null);

    const clicked = await clickFirst(page, [
      (p) => p.getByRole("button", { name: /continue with google|sign in with google|google/i }),
      (p) => p.getByRole("link", { name: /continue with google|google/i }),
      (p) => p.locator('[aria-label*="Google" i]'),
      (p) => p.locator('button:has-text("Google")'),
      (p) => p.locator('a:has-text("Google")'),
    ]);

    if (!clicked) {
      await shot(page, "google-button-not-found");
      throw new Error(
        'Tombol "Continue with Google" tidak ketemu di halaman ini. ' +
          "Kirim screenshot picsart-login-page.png biar aku benerin selektornya."
      );
    }

    // Login Google bisa muncul di POPUP atau di tab yang sama (redirect).
    let gpage = await popupPromise;
    if (gpage) {
      log("STEP 3", "Login Google terbuka di POPUP.");
      await gpage.waitForLoadState("domcontentloaded").catch(() => {});
    } else {
      log("STEP 3", "Login Google di tab yang sama (redirect).");
      gpage = page;
      await gpage.waitForTimeout(3000);
    }
    await shot(gpage, "google-login-start");

    await doGoogleLogin(gpage, cfg);

    log("STEP 4", "Menunggu kembali ke Picsart (login selesai)...");
    await page.bringToFront().catch(() => {});
    await page.waitForTimeout(6000);
    await page.goto("https://picsart.com/", { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(4000);
    await shot(page, "picsart-after-login");

    const url = page.url();
    const bodyText = (await page.locator("body").innerText().catch(() => "")) || "";
    const blocked = /unusual activity|try again|verify|verifikasi|couldn.?t sign you in/i.test(
      bodyText
    );

    console.log("\n=================================================");
    if (blocked) {
      console.log(" HASIL: ⚠️  Kemungkinan KENA BLOKIR / verifikasi.");
      console.log(" Cek screenshot terakhir di folder screenshots/.");
    } else {
      console.log(" HASIL: ✅  Sepertinya BERHASIL login (tidak ada pesan blokir).");
      console.log(` URL akhir: ${url}`);
    }
    console.log("=================================================\n");
    console.log("Browser dibiarkan terbuka 30 detik biar kamu bisa lihat sendiri...");
    await page.waitForTimeout(30000);
  } catch (err) {
    console.error("\n[GAGAL] " + err.message);
    await shot(page, "error-final");
    console.log("\nBrowser dibiarkan terbuka 30 detik buat dilihat...");
    await page.waitForTimeout(30000);
  } finally {
    await browser.close();
    console.log("\nSelesai. Lihat folder screenshots/ untuk detailnya.");
  }
}

main();
