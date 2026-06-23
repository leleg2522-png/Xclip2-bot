/*
 * Picsart Local Runner — PROOF v3.
 *   STEP A -> login Google langsung (accounts.google.com)        [SUDAH TERBUKTI JALAN]
 *   STEP B -> buka Picsart, klik "Log in" -> "Continue with Google" -> pilih akun
 *   STEP C -> ambil cookie REFRESH_TOKEN (rt:...) dan simpan ke token-found.txt
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
  // Debug: tulis nama-nama cookie yang ada.
  fs.writeFileSync(
    path.join(SHOTS_DIR, "_debug-cookies.txt"),
    JSON.stringify(cookies.map((c) => ({ name: c.name, domain: c.domain })), null, 2)
  );
  console.log("   [TOKEN] REFRESH_TOKEN BELUM ketemu (lihat _debug-cookies.txt). Berarti belum login penuh.");
  return null;
}

async function picsartFlow(context, page, cfg) {
  log("STEP B", `Buka Picsart: ${cfg.picsartLoginUrl}`);
  await page.goto(cfg.picsartLoginUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);
  await shot(page, "picsart-home");

  log("STEP B", 'Klik tombol "Log in" buat buka modal login...');
  const loginOpened = await clickFirst(page, [
    (p) => p.getByRole("button", { name: /^\s*log in\s*$/i }),
    (p) => p.getByText(/^\s*log in\s*$/i),
    (p) => p.getByRole("link", { name: /^\s*log in\s*$/i }),
  ]);
  if (!loginOpened) {
    await dumpClickables(page, "_debug-home.txt");
    await shot(page, "picsart-login-button-not-found");
    console.log('   [STEP B] Tombol "Log in" tidak ketemu (lihat _debug-home.txt).');
    return;
  }
  await page.waitForTimeout(4000);
  await shot(page, "picsart-login-modal");

  log("STEP B", 'Cari & klik "Continue with Google" di modal...');
  const popupPromise = context.waitForEvent("page", { timeout: 9000 }).catch(() => null);
  const gClicked = await clickGoogleButton(page);
  if (!gClicked) {
    await dumpClickables(page, "_debug-modal.txt");
    await shot(page, "picsart-google-not-found");
    console.log('   [STEP B] Tombol "Continue with Google" belum ketemu (lihat _debug-modal.txt).');
    return;
  }

  // OAuth Google bisa POPUP atau redirect tab yang sama. Karena udah login Google,
  // tinggal pilih akun / lanjut otomatis.
  let gpage = await popupPromise;
  if (gpage) {
    log("STEP B", "Popup OAuth kebuka, milih akun...");
    await gpage.waitForLoadState("domcontentloaded").catch(() => {});
    await gpage.waitForTimeout(2500);
    await shot(gpage, "oauth-account-chooser");
    await clickFirst(gpage, [
      (p) => p.getByText(cfg.googleEmail, { exact: false }),
      (p) => p.getByRole("button", { name: /continue|allow|izinkan|lanjut/i }),
    ], 6000);
    await gpage.waitForTimeout(5000);
  } else {
    log("STEP B", "OAuth di tab yang sama, milih akun...");
    await page.waitForTimeout(2500);
    await shot(page, "oauth-account-chooser");
    await clickFirst(page, [
      (p) => p.getByText(cfg.googleEmail, { exact: false }),
      (p) => p.getByRole("button", { name: /continue|allow|izinkan|lanjut/i }),
    ], 6000);
    await page.waitForTimeout(5000);
  }

  await page.bringToFront().catch(() => {});
  await page.waitForTimeout(6000);
  await shot(page, "picsart-after-login");

  log("STEP C", "Ambil cookie REFRESH_TOKEN...");
  return await extractToken(context);
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
