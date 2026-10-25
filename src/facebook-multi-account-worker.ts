/**
 * ============================================================
 * Facebook Group Auto-Poster — Batch Edition
 * ============================================================
 * Usage:
 *   npm install
 *   npm start -- fb01
 *   npm start -- fb02
 *
 * Multi-account structure:
 *   accounts/
 *     fb01/
 *       cookie.txt
 *       localstorage.txt
 *       content/
 *         1/text.txt
 *         1/images/
 *         2/text.txt
 *         2/images/
 *       progress.json
 *       log.txt
 *       debug-groups-page.png
 *       browser-profile/
 *     fb02/
 *       ...
 *
 * Run one account:
 *   npm start -- fb01
 *   npm start -- fb02
 *
 * Each account has its own content, optional session files, progress, logs, and persistent browser profile.
 * ============================================================
 */

import puppeteer, {
  type Page,
  type Browser,
  type ElementHandle,
} from "puppeteer";
import fs from "fs/promises";
import path from "path";
import readline from "readline";

// ─── Constants ────────────────────────────────────────────────────────────────
const ROOT_DIR = path.resolve("accounts");
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

const ACCOUNT_ID = (process.argv[2] || process.env.ACCOUNT_ID || "").trim();
const RUN_MODE = (process.argv[3] || process.env.RUN_MODE || "").trim();
const RUN_BATCH = Number(process.argv[4] || process.env.RUN_BATCH || "0");
const RUN_GROUP = Number(process.argv[5] || process.env.RUN_GROUP || "0");
const DASHBOARD_MODE = process.env.DASHBOARD_MODE === "1" || RUN_MODE !== "";

if (!ACCOUNT_ID) {
  console.error("❌ Account ID belum diberikan. Contoh: npm start -- fb01");
  process.exit(1);
}

// Mencegah path traversal seperti ../../folder
if (!/^[a-zA-Z0-9_-]+$/.test(ACCOUNT_ID)) {
  console.error("❌ Account ID hanya boleh berisi huruf, angka, _ atau -");
  process.exit(1);
}

const ACCOUNT_DIR = path.join(ROOT_DIR, ACCOUNT_ID);
const CONTENT_DIR = path.join(ACCOUNT_DIR, "content");
const PROGRESS_FILE = path.join(ACCOUNT_DIR, "progress.json");
const LOG_FILE = path.join(ACCOUNT_DIR, "log.txt");
const COOKIE_FILE = path.join(ACCOUNT_DIR, "cookie.txt");
const LOCALSTORAGE_FILE = path.join(ACCOUNT_DIR, "localstorage.txt");
const BROWSER_PROFILE_DIR = path.join(ACCOUNT_DIR, "browser-profile");
const DEBUG_SCREENSHOT = path.join(ACCOUNT_DIR, "debug-groups-page.png");
const STOP_FILE = path.join(ACCOUNT_DIR, "stop.request");
const POSTING_STATS_FILE = path.join(ACCOUNT_DIR, "posting-stats.json");

async function stopRequested(): Promise<boolean> {
  try {
    await fs.access(STOP_FILE);
    return true;
  } catch {
    return false;
  }
}

async function waitWithStopCheck(ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await stopRequested()) return true;
    await new Promise((resolve) => setTimeout(resolve, Math.min(1000, end - Date.now())));
  }
  return await stopRequested();
}


// Timeout yang lebih panjang untuk VM/koneksi lambat
const NAV_TIMEOUT = 80000;   // 80 detik untuk navigasi
const WAIT_TIMEOUT = 10000;  // 10 detik untuk waitForSelector

// Pacing antar posting. Bisa dioverride lewat environment variable.
// Delay ini hanya memberi jeda antar aksi dan tidak menjamin lolos dari rate-limit Facebook.
const POST_DELAY_MIN_MS = Number(process.env.POST_DELAY_MIN_MS || "20000");
const POST_DELAY_MAX_MS = Number(process.env.POST_DELAY_MAX_MS || "40000");

// Jika UI gagal terdeteksi, grup yang sama dicoba lagi agar tidak diam-diam ter-skip.
const MAX_POST_ATTEMPTS = Number(process.env.MAX_POST_ATTEMPTS || "2");

// Safety-net: kalau ada N grup BERTURUT-TURUT yang gagal (bukan LIMIT terverifikasi),
// worker berhenti sepenuhnya. Ini untuk berjaga-jaga kalau sebenarnya akun sedang
// kena limit tapi tidak lolos terdeteksi oleh detectFacebookPostingRestriction/detectLimitOnly.
// Set ke 0 untuk menonaktifkan safety-net ini (grup gagal akan terus di-skip tanpa batas).
const MAX_CONSECUTIVE_SKIPS = Number(process.env.MAX_CONSECUTIVE_SKIPS || "5");

// ─── Types ────────────────────────────────────────────────────────────────────
interface Progress {
  accountId: string;
  batch: number;
  groupIdx: number;
  timestamp: string;
}

interface PostingStats {
  accountId: string;
  total: number;
  direct: number;
  pending: number;
  error: number;
  limited: number;
  unknown: number;
  lastUpdated: string;
  // Bucket per hari (kunci tanggal lokal "YYYY-MM-DD"). Dipertahankan saat
  // reset lifetime supaya riwayat harian untuk ringkasan dashboard tidak terputus.
  daily?: Record<string, DailyStat>;
}

interface DailyStat {
  total: number;
  direct: number;
  pending: number;
  error: number;
  limited: number;
  unknown: number;
}

type PostingResultStatus =
  | "POSTING_OK"
  | "PENDING_APPROVAL"
  | "ERROR"
  | "LIMITED"
  | "UNKNOWN";

interface ContentBatch {
  postContent: string;
  imagePaths: string[];
}

interface AccountConfig {
  id: string;
  name?: string;
  totalBatches?: number;
}

// ─── Logging ──────────────────────────────────────────────────────────────────
// Rotasi log.txt → log-<tanggal>.txt setiap kali tanggal berganti supaya file
// tidak tumbuh tanpa batas. Rotasi hanya terpicu saat worker menulis log.
let logDay = "";           // cache tanggal lokal terakhir pada log()
const LOG_ROTATE_KEEP_DAYS = 7;

async function rotateLog(today: string): Promise<void> {
  try {
    const stat = await fs.stat(LOG_FILE);
    const staleDay = new Date(stat.mtime).toLocaleDateString("sv-SE");
    if (staleDay !== today) {
      await fs.rename(LOG_FILE, path.join(ACCOUNT_DIR, `log-${staleDay}.txt`));
    }
  } catch {
    // log.txt belum ada / tidak bisa di-rename — biarkan
  }

  try {
    const entries = await fs.readdir(ACCOUNT_DIR);
    const cutoff = Date.now() - LOG_ROTATE_KEEP_DAYS * 24 * 60 * 60 * 1000;
    for (const entry of entries) {
      if (!/^log-\d{4}-\d{2}-\d{2}\.txt$/.test(entry)) continue;
      const full = path.join(ACCOUNT_DIR, entry);
      try {
        const st = await fs.stat(full);
        if (st.mtimeMs < cutoff) await fs.unlink(full).catch(() => {});
      } catch {}
    }
  } catch {}
}

async function log(message: string): Promise<void> {
  const now = new Date();
  const today = now.toLocaleDateString("sv-SE");
  if (today !== logDay) {
    logDay = today;
    await rotateLog(today);
  }
  const line = `[${now.toISOString()}] ${message}`;
  console.log(line);
  await fs.appendFile(LOG_FILE, line + "\n").catch(() => {});
}

// ─── Random Helpers ───────────────────────────────────────────────────────────
function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function randomDelay(minMs: number, maxMs: number): Promise<void> {
  await new Promise((r) => setTimeout(r, randomBetween(minMs, maxMs)));
}

// ─── Progress Management ──────────────────────────────────────────────────────
// JSON.parse yang aman terhadap BOM (editor seperti Notepad menambahkan BOM).
function parseJsonSafe<T>(raw: string): T | null {
  try {
    return JSON.parse(raw.replace(/^\uFEFF/, "")) as T;
  } catch {
    return null;
  }
}

async function loadProgress(): Promise<Progress | null> {
  try {
    const raw = await fs.readFile(PROGRESS_FILE, "utf-8");
    const progress = parseJsonSafe<Progress>(raw);
    if (!progress) return null;
    if (progress.accountId && progress.accountId !== ACCOUNT_ID) {
      return null;
    }
    return progress;
  } catch {
    return null;
  }
}

async function saveProgress(batch: number, groupIdx: number): Promise<void> {
  const progress: Progress = {
    accountId: ACCOUNT_ID,
    batch,
    groupIdx,
    timestamp: new Date().toISOString(),
  };
  await fs.writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

async function clearProgress(): Promise<void> {
  await fs.rm(PROGRESS_FILE, { force: true });
}

// ─── Content Loader ───────────────────────────────────────────────────────────
async function loadContentBatch(batchIndex: number): Promise<ContentBatch> {
  const batchDir = path.join(CONTENT_DIR, String(batchIndex));
  const textFile = path.join(batchDir, "text.txt");
  const imagesDir = path.join(batchDir, "images");

  let postContent = "";
  try {
    postContent = await fs.readFile(textFile, "utf-8");
  } catch {
    await log(`⚠️  content/${batchIndex}/text.txt not found — batch akan diskip`);
    throw new Error(`text.txt tidak ditemukan untuk batch ${batchIndex}`);
  }

  let imagePaths: string[] = [];
  try {
    const files = await fs.readdir(imagesDir);
    imagePaths = files
      .filter((f) => IMAGE_EXTENSIONS.includes(path.extname(f).toLowerCase()))
      .map((f) => path.join(imagesDir, f));
  } catch {
    // Folder images tidak ada — tidak masalah
  }

  await log(
    `📦 Batch ${batchIndex}: "${postContent.slice(0, 60).replace(/\n/g, " ")}..." | ${imagePaths.length} gambar`
  );
  return { postContent, imagePaths };
}

// ─── Cookie & LocalStorage ────────────────────────────────────────────────────
async function loadCookieAndLocalStorage(page: Page): Promise<void> {
  // cookie.txt & localstorage.txt = BOOTSTRAP untuk profil yang tidak punya
  // session (rebuild / PC baru). Profil persistent adalah sumber kebenaran;
  // file tidak pernah di-inject saat profil masih login karena menimpa
  // cookie valid dengan nilai basi membuat FB logout/checkpoint. File
  // di-refresh otomatis via exportSessionFiles() setiap sesi login valid.

  let cookieCount = 0;
  let localStorageCount = 0;

  // ── Load cookies jika tersedia ────────────────────────────────────────────
  try {
    const cookieData = await fs.readFile(COOKIE_FILE, "utf-8");
    const trimmed = cookieData.trim();

    if (trimmed.length > 0) {
      const rawLines = trimmed
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      const processedLines: string[] = [];
      for (let i = 0; i < rawLines.length; i++) {
        const line = rawLines[i];
        if (!line) continue;

        if (
          line.split("\t").length < 5 &&
          i > 0 &&
          processedLines.length > 0
        ) {
          processedLines[processedLines.length - 1] += "\t" + line;
        } else {
          processedLines.push(line);
        }
      }

      const cookies = processedLines
        .map((line) => {
          const parts = line.split("\t");
          if (parts.length < 2) return null;

          const cookie: any = {
            name: parts[0],
            value: parts[1],
            domain: parts[2] || ".facebook.com",
            path: parts[3] || "/",
          };

          if (parts[6] === "✓") cookie.httpOnly = true;
          if (parts[7] === "✓") cookie.secure = true;

          if (parts[4]) {
            const expiry = new Date(parts[4]).getTime() / 1000;
            if (!isNaN(expiry)) cookie.expires = expiry;
          }

          if (parts[8] && ["Strict", "Lax", "None"].includes(parts[8])) {
            cookie.sameSite = parts[8] as any;
          }

          return cookie;
        })
        .filter((c) => c !== null);

      if (cookies.length > 0) {
        await page.setCookie(...cookies);
        cookieCount = cookies.length;
        await log(`🍪 Loaded ${cookieCount} cookies dari cookie.txt`);
      }
    } else {
      await log("🍪 cookie.txt kosong → dilewati (persistent profile digunakan)");
    }
  } catch {
    await log("🍪 cookie.txt belum ada/tidak bisa dibaca → dilewati");
  }

  // Buka Facebook sebelum mengakses localStorage.
  try {
    await page.goto("https://web.facebook.com", {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });
  } catch (error) {
    await log(`⚠️ Gagal membuka Facebook saat inisialisasi session: ${error}`);
  }

  // ── Load localStorage jika tersedia ──────────────────────────────────────
  try {
    const localStorageData = await fs.readFile(
      LOCALSTORAGE_FILE,
      "utf-8"
    );
    const trimmed = localStorageData.trim();

    if (trimmed.length === 0) {
      await log(
        "💾 localstorage.txt kosong → dilewati (persistent profile digunakan)"
      );
    } else {
      const localStorageItems = trimmed
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => {
          const tabIdx = line.indexOf("\t");
          if (tabIdx === -1) return null;

          const key = line.slice(0, tabIdx).trim();
          const value = line.slice(tabIdx + 1).trim();

          if (!key || !value) return null;
          return { key, value };
        })
        .filter(
          (item): item is { key: string; value: string } => item !== null
        );

      await page.evaluate((items) => {
        for (const item of items) {
          try {
            localStorage.setItem(item.key, item.value);
          } catch {}
        }
      }, localStorageItems);

      localStorageCount = localStorageItems.length;
      await log(
        `💾 Loaded ${localStorageCount} localStorage items dari localstorage.txt`
      );
    }
  } catch {
    await log("💾 localstorage.txt belum ada/tidak bisa dibaca → dilewati");
  }

  await log(
    `🔐 Session source → persistent profile${
      cookieCount || localStorageCount
        ? ` + file session (${cookieCount} cookies, ${localStorageCount} localStorage)`
        : ""
    }`
  );
}

// Deteksi apakah halaman Facebook masih "belum login".
// ANDA: cookie `c_user` (hanya ada saat login) TIDAK ada, ATAU url /login,
// ATAU ada login form. Jangan andalkan DOM saja — homepage log-out dengan
// dropdown login pernah lolos deteksi DOM dan bikin sesi tidak di-load.
async function checkNeedsLogin(page: Page): Promise<boolean> {
  try {
    await page.goto("https://web.facebook.com/", {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });
  } catch (error) {
    await log(`⚠️ Gagal membuka halaman Facebook: ${error}`);
  }
  await randomDelay(2000, 3000);
  try {
    const cookies = await page.cookies(
      "https://web.facebook.com",
      "https://www.facebook.com"
    );
    const hasCuser = cookies.some((c) => c.name === "c_user" && !!c.value);
    const url = page.url().toLowerCase();
    const hasLoginForm = await page
      .evaluate(
        () =>
          !!(
            document.querySelector('input[name="email"]') ||
            document.querySelector('input[name="pass"]')
          )
      )
      .catch(() => false);
    return !hasCuser || url.includes("/login") || hasLoginForm;
  } catch {
    // Halaman gagal dievaluasi (tab error dsb) → anggap belum login.
    return true;
  }
}

// Snapshot session browser yang HIDUP ke file bootstrap setiap login
// terverifikasi. Hanya dipanggil dari jalur login-valid — jangan pernah
// menimpa file dengan isi profil yang belum login. Format kompatibel dengan
// parser loadCookieAndLocalStorage (kolom ke-5 tidak dipakai, ✓ = true).
async function exportSessionFiles(page: Page): Promise<void> {
  try {
    const cookies = await page.cookies(
      "https://web.facebook.com",
      "https://www.facebook.com"
    );

    // Proteksi: tanpa c_user = profil tidak benar-benar login → JANGAN
    // menimpa file bootstrap (cookie anonim tidak berharga & bisa menghapus
    // file yang barusan dipaste user).
    const loggedIn = cookies.some((c) => c.name === "c_user" && !!c.value);
    if (!loggedIn) {
      await log(
        "⚠️ c_user tidak ditemukan — skip export, file session dibiarkan."
      );
      return;
    }

    let cookieSkip = 0;
    const cookieLines: string[] = [];
    for (const c of cookies) {
      if (/[\t\n\r]/.test(c.name) || /[\t\n\r]/.test(c.value)) {
        cookieSkip++;
        continue;
      }
      const expiry =
        typeof c.expires === "number" && c.expires > 0
          ? new Date(c.expires * 1000).toISOString()
          : "";
      const sameSite =
        c.sameSite === "Strict" || c.sameSite === "Lax" || c.sameSite === "None"
          ? c.sameSite
          : "-";
      cookieLines.push(
        [
          c.name,
          c.value,
          c.domain,
          c.path,
          expiry,
          "-",
          c.httpOnly ? "✓" : "-",
          c.secure ? "✓" : "-",
          sameSite,
        ].join("\t")
      );
    }

    if (cookieLines.length > 0) {
      await fs.writeFile(COOKIE_FILE, cookieLines.join("\n") + "\n", "utf-8");
      await log(
        `💾 cookie.txt di-refresh dari session live (${cookieLines.length} cookies)` +
          (cookieSkip ? `, ${cookieSkip} dilewati (ada tab/newline)` : "")
      );
    } else {
      await log("⚠️ Tidak ada cookie untuk di-export — cookie.txt dibiarkan.");
    }

    const items = await page.evaluate(() =>
      Object.entries(localStorage).map(([key, value]) => ({ key, value: String(value) }))
    );
    let lsSkip = 0;
    const lsLines: string[] = [];
    for (const { key, value } of items) {
      if (!key || /[\t\n\r]/.test(key) || /[\t\n\r]/.test(value)) {
        lsSkip++;
        continue;
      }
      lsLines.push(`${key}\t${value}`);
    }
    if (lsLines.length > 0) {
      await fs.writeFile(
        LOCALSTORAGE_FILE,
        lsLines.join("\n") + "\n",
        "utf-8"
      );
      await log(
        `💾 localstorage.txt di-refresh dari session live (${lsLines.length} items)` +
          (lsSkip ? `, ${lsSkip} dilewati` : "")
      );
    } else {
      await log("⚠️ localStorage kosong — localstorage.txt dibiarkan.");
    }
  } catch (err) {
    await log(`⚠️ Gagal export session files (tidak fatal): ${err}`);
  }
}

// ─── Sesi: PROFIL DULU, file hanya bootstrap ─────────────────────────────────
// - Profil login      → file tidak disentuh (cookie valid tidak dihalangi)
//                       + file di-refresh dari session live
// - Profil kosong     → inject file → login via file
// - Masih belum login → login manual 10 menit
// Tujuan: sesi tahan selama FB mengizinkan, tidak fasih kena logout oleh
// injeksi berulang (penyebab utama "harus masukin cookies terus-terusan").
async function ensureSessionReady(page: Page): Promise<void> {
  if (!(await checkNeedsLogin(page))) {
    await log("✅ Session Facebook tersedia di persistent browser profile");
    await exportSessionFiles(page);
    return;
  }

  await log("⚠️ FB account belum login pada browser profile ini.");
  await log("🔁 Bootstrap session dari cookie.txt / localstorage.txt...");
  await loadCookieAndLocalStorage(page);

  if (!(await checkNeedsLogin(page))) {
    await log("✅ Login berhasil via file session.");
    await exportSessionFiles(page);
    return;
  }

  // Auto-login (opsional): hanya kalau creds.json tersedia untuk akun ini.
  // Gagal (checkpoint/salah password/form aneh) → jatuh ke login manual.
  const creds = await loadCreds();
  if (creds && (await tryAutoLogin(page, creds))) {
    await log("✅ Auto-login sukses via creds.json.");
    await exportSessionFiles(page);
    return;
  }

  await ensureFacebookLoggedIn(page);
  await exportSessionFiles(page);
}

// Baca kredensial opsional accounts/<id>/creds.json (plaintext, dibuat manual
// oleh user). Tanpa file / JSON rusak / field kosong → null (perilaku lama).
async function loadCreds(): Promise<{ email: string; password: string } | null> {
  try {
    const raw = await fs.readFile(path.join(ACCOUNT_DIR, "creds.json"), "utf-8");
    const parsed = parseJsonSafe<{ email?: string; password?: string }>(raw);
    if (parsed?.email && parsed?.password) {
      return { email: parsed.email, password: parsed.password };
    }
    await log("⚠️ creds.json tidak lengkap (butuh email & password) — dilewati.");
  } catch {
    // File tidak ada → normal, auto-login tidak diaktifkan untuk akun ini.
  }
  return null;
}

// Isi form login Facebook otomatis. true = login sukses (c_user muncul).
// Selalu aman-gagal: checkpoint / salah password / error → false → fallback
// ke jendela login manual yang sudah ada.
async function tryAutoLogin(
  page: Page,
  creds: { email: string; password: string }
): Promise<boolean> {
  try {
    await log("🤖 Auto-login dari creds.json...");
    await page.goto("https://web.facebook.com/login", {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });
    await randomDelay(2000, 3000);

    const emailInput = await page.waitForSelector('input[name="email"]', {
      timeout: 10000,
    });
    if (!emailInput) {
      await log("⚠️ Form login tidak ditemukan — auto-login dibatalkan.");
      return false;
    }
    // focus() lebih aman daripada click() — elemen kadang tertutup overlay
    // (banner cookie-consent dsb) sehingga click() gagal "not clickable".
    await emailInput.focus();
    await emailInput.type(creds.email, { delay: randomBetween(40, 110) });
    await randomDelay(500, 1200);

    const passInput = await page.waitForSelector('input[name="pass"]', {
      timeout: 10000,
    });
    if (!passInput) {
      await log("⚠️ Input password tidak ditemukan — auto-login dibatalkan.");
      return false;
    }
    await passInput.focus();
    await passInput.type(creds.password, { delay: randomBetween(40, 110) });
    await randomDelay(500, 1200);

    // Tombol submit: button[name="login"] (varian umum), fallback
    // button[type="submit"] & input[type="submit"] (varian lama).
    const submit: ElementHandle<Element> | null =
      (await page.$('button[name="login"]')) ||
      (await page.$('button[type="submit"]')) ||
      (await page.$('input[type="submit"]'));
    if (!submit) {
      await log("⚠️ Tombol login tidak ditemukan — auto-login dibatalkan.");
      return false;
    }
    try {
      await submit.click();
    } catch {
      // Elemen tertutup overlay / di luar viewport → klik via DOM langsung.
      await submit.evaluate((el) => (el as HTMLElement).click());
    }

    // Tunggu proses login selesai (navigasi + verifikasi c_user).
    // Jangan bail saat form masih terlihat: FB menampilkan form + spinner
    // selama submit (bisa >10 detik). Form yang masih ada hanya dianggap
    // "password salah" setelah deadline habis.
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await randomDelay(2000, 3000);
      const url = page.url().toLowerCase();
      if (
        url.includes("checkpoint") ||
        url.includes("two_step_verification") ||
        url.includes("login/approval")
      ) {
        await log(
          "⚠️ Facebook minta checkpoint/2FA setelah auto-login — butuh sentuhan manusia."
        );
        return false;
      }
      const cookies = await page.cookies(
        "https://web.facebook.com",
        "https://www.facebook.com"
      );
      if (cookies.some((c) => c.name === "c_user" && !!c.value)) {
        return true;
      }
      // FB menampilkan pesan ini tanpa mengubah URL — deteksi langsung supaya
      // log tidak menyesatkan ("timeout" padahal password salah).
      const wrongPassword = await page
        .evaluate(() =>
          /password you entered is incorrect|kata sandi yang anda masukkan salah/i.test(
            document.body.innerText
          )
        )
        .catch(() => false);
      if (wrongPassword) {
        await log(
          "❌ Password ditolak Facebook (creds.json salah) — perlu login manual."
        );
        return false;
      }
    }

    const stillForm = await page
      .evaluate(
        () =>
          !!(
            document.querySelector('input[name="email"]') ||
            document.querySelector('input[name="pass"]')
          )
      )
      .catch(() => false);
    if (stillForm) {
      await log("⚠️ Form login masih tampil (kemungkinan email/password salah).");
      try {
        await page.screenshot({
          path: path.join(ACCOUNT_DIR, "debug-autologin.png"),
        });
        await log("📸 Screenshot state login disimpan: debug-autologin.png");
      } catch {}
      return false;
    }

    await log("⚠️ Timeout menunggu hasil auto-login.");
    return false;
  } catch (err) {
    await log(`⚠️ Auto-login gagal: ${err}`);
    return false;
  }
}

// Tunggu cookie c_user benar-benar turun. Setelah login FB kadang telat
// men-set cookie; export yang jalan terlalu cepat akan di-skip guard c_user
// dan sesi tidak tersimpan ke file bootstrap.
async function waitForCuser(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const cookies = await page
      .cookies("https://web.facebook.com", "https://www.facebook.com")
      .catch(() => [] as Awaited<ReturnType<Page["cookies"]>>);
    if (cookies.some((c) => c.name === "c_user" && !!c.value)) return true;
    if (Date.now() >= deadline) return false;
    await randomDelay(1500, 2000);
  }
}

// ─── Facebook Session Check ─────────────────────────────────────────────────
async function ensureFacebookLoggedIn(page: Page): Promise<void> {
  await log("🔐 Mengecek session Facebook...");

  try {
    await page.goto("https://web.facebook.com/", {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });
  } catch (error) {
    await log(`⚠️ Gagal membuka halaman Facebook: ${error}`);
  }

  await randomDelay(2000, 3000);

  const needsLogin = await page.evaluate(() => {
    const url = window.location.href.toLowerCase();
    const hasLoginUrl = url.includes("/login");
    const hasLoginForm = !!(
      document.querySelector('input[name="email"]') ||
      document.querySelector('input[name="pass"]')
    );

    return hasLoginUrl || hasLoginForm;
  });

  if (!needsLogin && (await waitForCuser(page, 5000))) {
    await log("✅ Session Facebook tersedia di persistent browser profile");
    return;
  }

  await log("⚠️ FB account belum login pada browser profile ini.");

  await log("🔐 LOGIN_REQUIRED — silakan login manual di browser yang terbuka.");
  await log("⏳ Menunggu login Facebook maksimal 10 menit...");

  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
    // stop.request dicek juga saat menunggu login manual, supaya STOP admin
    // tetap dihormati dan worker keluar rapi (bukan terpaksa-kill 30 detik).
    if (await waitWithStopCheck(3500)) {
      await log("⏹ STOP diminta saat menunggu login → keluar rapi.");
      process.exit(0);
    }
    await randomDelay(3000, 5000);

    const loggedIn = await page.evaluate(() => {
      const url = window.location.href.toLowerCase();
      const hasLoginForm = !!(
        document.querySelector('input[name="email"]') ||
        document.querySelector('input[name="pass"]')
      );
      return !url.includes("/login") && !hasLoginForm;
    });

    if (loggedIn) {
      // Cookie kadang belum settle saat form hilang. Tunggu c_user dulu supaya
      // exportSessionFiles() tidak di-skip dan file bootstrap ikut ter-refresh.
      await randomDelay(3000, 5000);
      if (await waitForCuser(page, 15000)) {
        await log(
          "✅ Login Facebook terdeteksi (c_user ada). Session akan dipertahankan oleh persistent profile."
        );
      } else {
        await log(
          "⚠️ Login terdeteksi tetapi cookie c_user belum turun — export file session akan di-skip."
        );
      }
      return;
    }
  }

  throw new Error("Login Facebook belum selesai dalam batas waktu 10 menit.");
}

// ─── Page Listeners ───────────────────────────────────────────────────────────
function setupPageListeners(page: Page): void {
  // Auto-dismiss dialog "Leave site?" dll
  page.on("dialog", async (dialog) => {
    await log(`[Dialog] ${dialog.type()} → auto-accept`);
    await dialog.accept();
  });

  // Hapus beforeunload setiap navigasi agar tidak muncul popup
  page.on("framenavigated", async () => {
    try {
      await page.evaluate(() => {
        window.onbeforeunload = null;
      });
    } catch {
      /* abaikan jika frame sudah detach */
    }
  });
}

// ─── esbuild/tsx `__name` shim ────────────────────────────────────────────────
// tsx (esbuild) kadang menyisipkan pemanggilan helper internal `__name(fn, "namaFn")`
// saat mentranspile arrow function yang di-assign ke const (misalnya `const normalize = ...`).
// Helper itu hanya ada di scope Node.js. Tapi page.evaluate() mengirim ulang isi fungsi
// sebagai string murni ke context browser, sehingga saat dieksekusi di sana
// `__name` tidak dikenal → "ReferenceError: __name is not defined" dan fungsi yang
// memanggilnya (mis. detectFacebookPostingRestriction) gagal total.
// Polyfill ini disuntik ke SETIAP dokumen baru pada page tsb (via evaluateOnNewDocument),
// jadi `window.__name` selalu ada sebelum script lain berjalan, apa pun penyebab
// persisnya. Aman dipanggil berkali-kali.
async function ensureNameShim(page: Page): Promise<void> {
  try {
    await page.evaluateOnNewDocument(() => {
      (window as any).__name =
        (window as any).__name || ((fn: any) => fn);
    });
  } catch {
    // Jika page sudah tertutup dsb, abaikan — bukan fatal.
  }
}

// ─── Safe Navigation ──────────────────────────────────────────────────────────
async function safeGoto(
  browser: Browser,
  page: Page,
  url: string,
  maxRetry = 3
): Promise<Page> {
  for (let attempt = 1; attempt <= maxRetry; attempt++) {
    // Cek apakah page masih hidup
    try {
      await page.evaluate(() => document.title);
    } catch {
      await log(`⚠️  Page detached — membuat page baru (attempt ${attempt})`);
      try {
        await page.close();
      } catch {}
      page = await browser.newPage();
      await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
      setupPageListeners(page);
      await ensureNameShim(page);
      const context = browser.defaultBrowserContext();
      await context.overridePermissions("https://www.facebook.com", [
        "clipboard-read",
        "clipboard-write",
      ]);
      await context.overridePermissions("https://web.facebook.com", [
        "clipboard-read",
        "clipboard-write",
      ]);
    }

    try {
      await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: NAV_TIMEOUT, // 80 detik
      });
      return page;
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      const isDetached =
        msg.includes("detached") ||
        msg.includes("Target closed") ||
        msg.includes("Session closed");
      const isNavError =
        msg.includes("net::ERR_") || msg.includes("Navigation timeout") || msg.includes("TimeoutError");

      if (isDetached || isNavError) {
        await log(
          `⚠️  Navigasi gagal (attempt ${attempt}/${maxRetry}): ${msg.split("\n")[0]}`
        );
        if (attempt < maxRetry) {
          await randomDelay(3000 * attempt, 5000 * attempt);
          continue;
        }
      }
      throw err;
    }
  }
  return page;
}

// ─── Posting Result Detection ───────────────────────────────────────────────
type PostingStatus = PostingResultStatus;

const PENDING_KEYWORDS = [
  "pending approval", "awaiting approval", "waiting for approval",
  "post is pending", "your post is pending", "needs approval",
  "requires approval", "waiting for an admin", "menunggu persetujuan",
  "menunggu persetujuan admin", "menunggu persetujuan moderator",
  "perlu persetujuan admin", "memerlukan persetujuan admin",
  "akan ditinjau oleh admin",
];

const ERROR_KEYWORDS = [
  "couldn't post", "could not post", "unable to post", "failed to post",
  "post failed", "something went wrong", "can't post", "cannot post",
  "tidak dapat memposting", "tidak bisa memposting", "gagal memposting",
  "terjadi kesalahan",
];

const LIMITED_KEYWORDS = [
  "temporarily blocked", "temporarily restricted",
  "you've been temporarily blocked", "you have been temporarily blocked",
  "posting is restricted", "posting has been restricted",
  "your account is restricted", "account restricted", "action blocked",
  "we restrict certain activity", "posting limit", "dibatasi sementara",
  "posting dibatasi", "akun dibatasi", "aktivitas dibatasi",
  "tindakan diblokir",

  // Pesan pembatasan frekuensi posting Facebook (Indonesia/Inggris).
  "kami membatasi seberapa sering anda dapat memposting",
  "kami membatasi seberapa sering anda dapat memposting, berkomentar",
  "kami membatasi seberapa sering anda dapat memposting, berkomentar, atau melakukan hal-hal lain",
  "we limit how often you can post",
  "we limit how often you can post, comment",
];

function normalizeUiText(text: string): string {
  return text.toLowerCase().replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

async function detectFacebookPostingRestriction(
  page: Page,
  groupLabel: string
): Promise<boolean> {
  try {
    const result = await page.evaluate(() => {
      const normalize = (value: string) =>
        value
          .toLowerCase()
          .replace(/\u00a0/g, " ")
          .replace(/\s+/g, " ")
          .trim();

      const restrictionPhrases = [
        "kami membatasi seberapa sering anda dapat memposting",
        "kami membatasi seberapa sering anda dapat memposting, berkomentar",
        "we limit how often you can post",
      ];

      const bodyText = normalize(document.body?.innerText || "");
      const phraseFound = restrictionPhrases.some((phrase) =>
        bodyText.includes(phrase)
      );

      // Cari elemen teks yang benar-benar dirender berwarna merah.
      // Warna merah dipakai sebagai penguat deteksi, bukan satu-satunya syarat,
      // karena Facebook dapat mengubah class/CSS sewaktu-waktu.
      let redTextFound = false;
      const elements = Array.from(
        document.querySelectorAll("body *")
      );

      for (const el of elements) {
        const text = normalize(el.textContent || "");
        if (!text || text.length > 500) continue;

        const style = window.getComputedStyle(el);
        const color = style.color;

        const match = color.match(
          /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*[\d.]+)?\s*\)/
        );

        if (!match) continue;

        const r = Number(match[1]);
        const g = Number(match[2]);
        const b = Number(match[3]);

        // Merah dominan, cukup longgar untuk variasi merah Facebook.
        const isRed = r >= 180 && r > g * 1.45 && r > b * 1.45;

        if (
          isRed &&
          restrictionPhrases.some((phrase) => text.includes(phrase))
        ) {
          redTextFound = true;
          break;
        }
      }

      return {
        phraseFound,
        redTextFound,
        detected: phraseFound || redTextFound,
      };
    });

    if (result.detected) {
      await log(
        `🚨 ${groupLabel} → SPAM/POSTING RESTRICTION FACEBOOK TERDETEKSI ` +
        `(phrase=${result.phraseFound}, redText=${result.redTextFound})`
      );
      return true;
    }
  } catch (error) {
    await log(
      `⚠️ ${groupLabel} → gagal mengecek posting restriction: ${error}`
    );
  }

  return false;
}

async function detectLimitOnly(page: Page, groupLabel: string): Promise<boolean> {
  // Deteksi pesan spesifik "Kami membatasi seberapa sering..." terlebih dahulu.
  if (await detectFacebookPostingRestriction(page, groupLabel)) {
    return true;
  }

  try {
    const uiText = normalizeUiText(
      await page.evaluate(() => document.body?.innerText || "")
    );

    const limited = LIMITED_KEYWORDS.find((k) => uiText.includes(k));
    if (limited) {
      await log(`🚨 ${groupLabel} → LIMIT terdeteksi: "${limited}"`);
      return true;
    }
  } catch (error) {
    await log(`⚠️ ${groupLabel} → gagal mengecek limit: ${error}`);
  }

  return false;
}

async function detectPostingResult(
  page: Page,
  groupLabel: string,
  postContent: string
): Promise<PostingStatus> {
  try {
    // Beri waktu untuk toast/dialog hasil submit muncul.
    await randomDelay(3000, 5000);
    const uiText = normalizeUiText(await page.evaluate(() => document.body?.innerText || ""));

    const limited = LIMITED_KEYWORDS.find((k) => uiText.includes(k));
    if (limited) {
      await log(`🚨 ${groupLabel} → LIMIT terdeteksi: "${limited}"`);
      return "LIMITED";
    }

    const pending = PENDING_KEYWORDS.find((k) => uiText.includes(k));
    if (pending) {
      await log(`🟡 ${groupLabel} → PENDING approval: "${pending}"`);
      return "PENDING_APPROVAL";
    }

    const error = ERROR_KEYWORDS.find((k) => uiText.includes(k));
    if (error) {
      await log(`❌ ${groupLabel} → ERROR posting: "${error}"`);
      return "ERROR";
    }

    // Untuk DIRECT kita minta dua bukti: composer tertutup + sebagian caption
    // muncul kembali di halaman. Jika bukti tidak cukup, hasilnya UNKNOWN.
    const caption = normalizeUiText(
      postContent.replace(/https?:\/\/[^\s]+/g, "").replace(/\s+/g, " ").trim()
    );
    const probe = caption.slice(0, 80);
    const captionFound = probe.length >= 12 && uiText.includes(probe);

    const composerOpen = await page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      return dialogs.some((dialog) => {
        const text = (dialog.textContent || "").toLowerCase().replace(/\s+/g, " ").trim();
        return ["create a post", "write something", "tulis sesuatu", "buat postingan"]
          .some((k) => text.includes(k));
      });
    });

    if (!composerOpen && captionFound) {
      await log(`✅ ${groupLabel} → DIRECT: bukti caption ditemukan setelah submit`);
      return "POSTING_OK";
    }

    await log(`⚠️ ${groupLabel} → UNKNOWN (composerOpen=${composerOpen}, captionFound=${captionFound})`);
    return "UNKNOWN";
  } catch (error) {
    await log(`⚠️ ${groupLabel} → gagal mendeteksi hasil posting: ${error}`);
    return "UNKNOWN";
  }
}

async function loadPostingStats(): Promise<PostingStats> {
  try {
    const raw = await fs.readFile(POSTING_STATS_FILE, "utf-8");
    const stats = parseJsonSafe<PostingStats>(raw);
    if (stats && stats.accountId === ACCOUNT_ID) return stats;
  } catch {}
  return { accountId: ACCOUNT_ID, total: 0, direct: 0, pending: 0, error: 0, limited: 0, unknown: 0, lastUpdated: new Date().toISOString() };
}

async function savePostingStats(stats: PostingStats): Promise<void> {
  stats.lastUpdated = new Date().toISOString();
  await fs.writeFile(POSTING_STATS_FILE, JSON.stringify(stats, null, 2));
}

async function resetPostingStats(): Promise<void> {
  // Lifetime di-reset ke 0, tetapi RIWAYAT HARIAN dipertahankan.
  const previous = await loadPostingStats();
  const stats: PostingStats = {
    accountId: ACCOUNT_ID,
    total: 0,
    direct: 0,
    pending: 0,
    error: 0,
    limited: 0,
    unknown: 0,
    lastUpdated: new Date().toISOString(),
    daily: previous.daily ?? {},
  };
  await savePostingStats(stats);
}

// Tanggal lokal hari ini dalam "YYYY-MM-DD" (mengikuti zona waktu komputer).
function todayLocal(): string {
  return new Date().toLocaleDateString("sv-SE");
}

function emptyDailyStat(): DailyStat {
  return { total: 0, direct: 0, pending: 0, error: 0, limited: 0, unknown: 0 };
}

function incrementDailyStat(d: DailyStat, status: PostingStatus): void {
  d.total++;
  if (status === "POSTING_OK") d.direct++;
  else if (status === "PENDING_APPROVAL") d.pending++;
  else if (status === "ERROR") d.error++;
  else if (status === "LIMITED") d.limited++;
  else d.unknown++;
}

async function recordPostingResult(status: PostingStatus): Promise<void> {
  const stats = await loadPostingStats();
  stats.total++;
  if (status === "POSTING_OK") stats.direct++;
  else if (status === "PENDING_APPROVAL") stats.pending++;
  else if (status === "ERROR") stats.error++;
  else if (status === "LIMITED") stats.limited++;
  else stats.unknown++;

  // Increment bucket harian.
  if (!stats.daily) stats.daily = {};
  const day = todayLocal();
  if (!stats.daily[day]) stats.daily[day] = emptyDailyStat();
  incrementDailyStat(stats.daily[day], status);

  // Prune bucket harian lebih tua dari 30 hari.
  const keys = Object.keys(stats.daily).sort();
  while (keys.length > 30) delete stats.daily[keys.shift() as string];

  await savePostingStats(stats);
}

async function logPostingSummary(): Promise<void> {
  const stats = await loadPostingStats();
  const daily = stats.daily?.[todayLocal()];
  const todayLine = daily
    ? ` | hari ini: total=${daily.total} direct=${daily.direct} pending=${daily.pending} error=${daily.error} limited=${daily.limited} unknown=${daily.unknown}`
    : "";
  await log(`📊 RINGKASAN → total=${stats.total} | direct=${stats.direct} | pending=${stats.pending} | error=${stats.error} | limited=${stats.limited} | unknown=${stats.unknown}${todayLine}`);
}

// ─── Post to Single Group ─────────────────────────────────────────────────────
async function postToGroup(
  browser: Browser,
  page: Page,
  groupLink: string,
  postContent: string,
  imagePaths: string[],
  groupLabel: string
): Promise<{
  page: Page;
  success: boolean;
  status?: PostingStatus;
}> {
  // Hapus beforeunload agar tidak ada popup "Leave site?"
  try {
    await page.evaluate(() => {
      window.onbeforeunload = null;
      window.addEventListener(
        "beforeunload",
        (e) => {
          e.stopImmediatePropagation();
          delete (e as any).returnValue;
        },
        true
      );
    });
  } catch {}

  // Navigasi ke grup
  page = await safeGoto(browser, page, groupLink);
  await randomDelay(3000, 5000);
  await log(`🌐 ${groupLabel} → navigated`);

// Fail-safe: hanya cek LIMIT.
// Jangan memakai detectPostingResult("", ...) di sini karena halaman grup
// bisa mengandung teks/status lama dan menyebabkan false-positive.
if (await detectLimitOnly(page, groupLabel)) {
  await log(`🛑 ${groupLabel} → akun terdeteksi LIMIT sebelum posting`);

  return {
    page,
    success: false,
    status: "LIMITED"
  };
}

  // Skip grup marketplace / jual beli
  const isSellSomething = await page.evaluate(() => {
    return !!(
      document.querySelector('div[aria-label="Sell Something"][role="button"]') ||
      document.querySelector('div[aria-label="Jual Sesuatu"][role="button"]')
    );
  });
  if (isSellSomething) {
    await log(`⏭️  ${groupLabel} → skip (Sell Something group)`);
    return { page, success: false };
  }

  // Cari tombol "Tulis sesuatu..." / "Write something..."
  const writeButtonXPaths = [
    '//div[@role="button" and .//span[contains(text(), "Tulis sesuatu...")]]',
    '//div[@role="button" and .//span[contains(text(), "Write something...")]]',
    '//div[@role="button" and .//span[contains(text(), "Tulis di grup...")]]',
    '//div[@role="button" and .//span[contains(text(), "Write something in the group...")]]',
    '//div[@role="button" and .//span[contains(text(), "Buat postingan")]]',
    '//div[@role="button" and .//span[contains(text(), "Create a post")]]',
  ];

  let writeButton = null;
  for (const xp of writeButtonXPaths) {
    try {
      writeButton = await page.waitForSelector(`xpath/${xp}`, {
        timeout: WAIT_TIMEOUT,
      });
      if (writeButton) {
        await log(`✅ ${groupLabel} → write button ditemukan`);
        break;
      }
    } catch {}
  }

  if (!writeButton) {
    await log(`⏭️  ${groupLabel} → write button tidak ditemukan, skip`);
    return { page, success: false };
  }

  await writeButton.click();
  await randomDelay(2000, 3000);

  // Cari editor teks di dalam dialog
  const dialogEditorSelectors = [
    'div[role="dialog"] div[contenteditable="true"][role="textbox"]',
    'div[role="dialog"] div[contenteditable="true"][data-lexical-editor="true"]',
    'div[role="dialog"] div[contenteditable="true"]',
  ];

  let editor = null;
  for (const sel of dialogEditorSelectors) {
    try {
      editor = await page.waitForSelector(sel, { timeout: WAIT_TIMEOUT });
      if (editor) {
        await log(`✅ ${groupLabel} → editor ditemukan`);
        break;
      }
    } catch {}
  }

  if (!editor) {
    await log(`❌ ${groupLabel} → editor tidak ditemukan, skip`);
    return { page, success: false };
  }

  await editor.click();
  await randomDelay(400, 800);

  // ── Parse caption dan URL ──────────────────────────────────────────────────
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const urlMatches = postContent.match(urlRegex) || [];
  const firstUrl = urlMatches[0] || null;
  const captionOnly = postContent
    .replace(urlRegex, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  // Ketik caption karakter per karakter (human-like)
  if (captionOnly.length > 0) {
    for (const char of captionOnly) {
      await page.keyboard.type(char, {
        delay: randomBetween(30, 110),
      });
    }
    await randomDelay(400, 700);
    await log(`✍️  ${groupLabel} → caption selesai (${captionOnly.length} chars)`);
  }

  // Paste URL via clipboard agar Facebook generate link preview
  if (firstUrl) {
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");

    try {
      await page.evaluate(
        (url: string) => navigator.clipboard.writeText(url),
        firstUrl
      );
      await page.keyboard.down("Control");
      await page.keyboard.press("v");
      await page.keyboard.up("Control");
      await log(`📋 ${groupLabel} → URL dipaste via clipboard`);
    } catch {
      // Fallback: execCommand
      await page.evaluate((url: string) => {
        document.execCommand("insertText", false, url);
      }, firstUrl);
      await log(`📋 ${groupLabel} → URL dipaste via execCommand (fallback)`);
    }

    // Tunggu Facebook generate link preview
    await log(`⏳ ${groupLabel} → menunggu link preview...`);
    await randomDelay(5000, 7000);
  }

  // ── Upload gambar (jika ada) ───────────────────────────────────────────────
  if (imagePaths.length > 0) {
    await log(`🖼️  ${groupLabel} → upload ${imagePaths.length} gambar...`);
    const fileInput = (
      await page.evaluateHandle(() => {
        const inputs = Array.from(
          document.querySelectorAll('input[type="file"]')
        ) as HTMLInputElement[];

        return (
          inputs.find((input) => {
            const hiddenAncestor = input.closest('[aria-hidden="true"]');
            return !hiddenAncestor && !input.disabled;
          }) ||
          inputs.find((input) => !input.disabled) ||
          null
        );
      })
    ).asElement() as ElementHandle<HTMLInputElement> | null;

    if (fileInput) {
      await fileInput.uploadFile(...imagePaths);
      await page.evaluate((el) => {
        if (el) {
          el.dispatchEvent(new Event("change", { bubbles: true }));
          el.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }, fileInput);
      await log(`✅ ${groupLabel} → gambar terupload`);
      await randomDelay(5000, 7000);
    } else {
      await log(`⚠️  ${groupLabel} → file input tidak ditemukan, skip upload gambar`);
    }
  }

  // ── Klik tombol Post / Posting / Kirim ────────────────────────────────────
  await randomDelay(1500, 2500);

  const postButtonSelectors = [
    'div[aria-label="Posting"][role="button"]',
    'div[aria-label="Post"][role="button"]',
    'div[aria-label="Kirim"][role="button"]',
    'div[aria-label="Publish"][role="button"]',
    'button[aria-label="Posting"]',
    'button[aria-label="Post"]',
    'button[aria-label="Kirim"]',
    'button[aria-label="Publish"]',
  ];
  const postButtonXPaths = [
    '//div[@role="button" and .//span[normalize-space()="Posting"]]',
    '//div[@role="button" and .//span[normalize-space()="Post"]]',
    '//div[@role="button" and .//span[normalize-space()="Kirim"]]',
    '//div[@role="button" and .//span[normalize-space()="Publish"]]',
    '//button[.//span[normalize-space()="Posting"]]',
    '//button[.//span[normalize-space()="Post"]]',
    '//button[.//span[normalize-space()="Kirim"]]',
    '//button[.//span[normalize-space()="Publish"]]',
  ];

  let postButton = null;
  for (const sel of postButtonSelectors) {
    try {
      postButton = await page.waitForSelector(sel, { timeout: 5000 });
      if (postButton) break;
    } catch {}
  }
  if (!postButton) {
    for (const xp of postButtonXPaths) {
      try {
        postButton = await page.waitForSelector(`xpath/${xp}`, { timeout: 5000 });
        if (postButton) break;
      } catch {}
    }
  }

  if (!postButton) {
    await log(`❌ ${groupLabel} → tombol Post tidak ditemukan`);
    return { page, success: false };
  }

  // Tunggu tombol siap. Cek aria-disabled dan property disabled.
  let isDisabled = true;
  let retries = 0;
  while (isDisabled && retries < 40) {
    isDisabled = await page.evaluate((el) => {
      if (!el) return true;

      const ariaDisabled = el.getAttribute("aria-disabled") === "true";
      const disabledProperty =
        "disabled" in el && Boolean((el as any).disabled);

      return ariaDisabled || disabledProperty;
    }, postButton);

    if (isDisabled) {
      await new Promise((r) => setTimeout(r, 500));
      retries++;
    }
  }

  if (isDisabled) {
    await log(`⚠️ ${groupLabel} → tombol Post tetap disabled setelah menunggu`);
    return { page, success: false, status: "UNKNOWN" };
  }

  await postButton.click();
  await log(`📤 ${groupLabel} → Post diklik!`);

  // Cek segera apakah Facebook menampilkan peringatan pembatasan posting.
  // Jika iya, jangan retry grup ini karena retry justru berisiko memperparah limit.
  await randomDelay(1000, 2000);
  if (await detectFacebookPostingRestriction(page, groupLabel)) {
    await recordPostingResult("LIMITED");
    return { page, success: false, status: "LIMITED" };
  }

  const postStatus = await detectPostingResult(page, groupLabel, postContent);
  await recordPostingResult(postStatus);

  if (postStatus === "LIMITED") {
    await log(`🛑 ${groupLabel} → proses dihentikan karena LIMIT.`);
    return { page, success: false, status: "LIMITED" };
  }

  if (postStatus === "PENDING_APPROVAL") {
    await log(`🟡 ${groupLabel} → posting diterima tetapi menunggu approval admin.`);
    return { page, success: true, status: "PENDING_APPROVAL" };
  }

  if (postStatus === "POSTING_OK") {
    await log(`✅ ${groupLabel} → posting langsung tayang terverifikasi.`);
    return { page, success: true, status: "POSTING_OK" };
  }

  if (postStatus === "ERROR") {
    await log(`❌ ${groupLabel} → Facebook melaporkan posting gagal.`);
    return { page, success: false, status: "ERROR" };
  }

  return { page, success: false, status: "UNKNOWN" };
}

async function loadAccountConfig(): Promise<AccountConfig> {
  await fs.mkdir(CONTENT_DIR, { recursive: true });

  const configPath = path.join(ACCOUNT_DIR, "config.json");
  try {
    const raw = await fs.readFile(configPath, "utf-8");
    const config = parseJsonSafe<AccountConfig>(raw);
    if (!config) return { id: ACCOUNT_ID };
    return { ...config, id: ACCOUNT_ID };
  } catch {
    return { id: ACCOUNT_ID };
  }
}

async function detectTotalBatches(config: AccountConfig): Promise<number> {
  if (config.totalBatches && config.totalBatches > 0) {
    return config.totalBatches;
  }

  try {
    const entries = await fs.readdir(CONTENT_DIR, { withFileTypes: true });
    const batches = entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => Number(entry.name))
      .filter((n) => Number.isInteger(n) && n > 0);

    return batches.length ? Math.max(...batches) : 0;
  } catch {
    return 0;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  await fs.mkdir(ACCOUNT_DIR, { recursive: true });
  await fs.rm(STOP_FILE, { force: true }).catch(() => {});
  const accountConfig = await loadAccountConfig();
  const totalBatches = await detectTotalBatches(accountConfig);

  if (totalBatches === 0) {
    await log(`❌ Tidak ada batch di ${CONTENT_DIR}`);
    await log(`   Buat folder seperti accounts/${ACCOUNT_ID}/content/1/`);
    return;
  }

  await log("═══════════════════════════════════════════");
  await log(`🚀 Facebook Group Auto-Poster — ${accountConfig.name || ACCOUNT_ID}`);
  await log(`👤 Account ID: ${ACCOUNT_ID}`);
  await log(`📦 Total batch: ${totalBatches}`);
  await log("═══════════════════════════════════════════");

  // ── Auto-resume ─────────────────────────────────────────────────────────────
  // Tidak ada lagi menu mode 1/2/3.
  // Setiap start selalu membaca progress terakhir.
  let startBatch = 1;
  let startGroupIdx = 0;

  const savedProgress = await loadProgress();

  if (savedProgress) {
    startBatch = Math.max(1, savedProgress.batch);
    startGroupIdx = Math.max(0, savedProgress.groupIdx);

    await log(
      `▶️  Auto-resume: batch ${startBatch}, group berikutnya ke-${startGroupIdx + 1}`
    );
  } else {
    await resetPostingStats();
    await log("▶️  Belum ada progress → mulai dari batch 1, group 1");
  }

  // ── Launch browser ─────────────────────────────────────────────────────────
  // userDataDir membuat browser profile PERSISTENT khusus untuk akun ini.
  // Jangan gunakan profile yang sama untuk dua account secara bersamaan.
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: BROWSER_PROFILE_DIR,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--start-maximized",
      // Anti-automation: hilangkan sinyal "bot" supaya FB lebih jarang
      // checkpoint/logout yang mematikan sesi.
      "--disable-blink-features=AutomationControlled",
      "--enable-features=AsyncClipboardAPI",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
    defaultViewport: null,
  });

  let page = await browser.newPage();

  // Grant clipboard permission
  const context = browser.defaultBrowserContext();
  await context.overridePermissions("https://web.facebook.com", [
    "clipboard-read",
    "clipboard-write",
  ]);
  await context.overridePermissions("https://www.facebook.com", [
    "clipboard-read",
    "clipboard-write",
  ]);

  setupPageListeners(page);
  await ensureNameShim(page);
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });

  // Sesi: profil dulu, file hanya bootstrap — sekali login tahan lama.
  await ensureSessionReady(page);

  // ── Kumpulkan semua group links sekali di awal ─────────────────────────────
  await log("📋 Mengumpulkan group links...");

  try {
    await page.goto(
      "https://web.facebook.com/groups/joins/?nav_source=tab",
      {
        waitUntil: "domcontentloaded", // lebih cepat dari networkidle2
        timeout: NAV_TIMEOUT,
      }
    );
  } catch (err) {
    await log(`⚠️  Timeout ke halaman groups, coba lanjutkan... (${err})`);
  }

  // Tunggu konten muncul
  await randomDelay(3000, 5000);
  await page.waitForSelector('div[role="listitem"]', { timeout: 15000 }).catch(() => {
    log("⚠️  listitem tidak terdeteksi, tetap lanjut scroll...");
  });

  // Scroll ke bawah untuk load semua grup
  await log("📜 Scrolling untuk load semua grup...");
  let lastHeight = (await page.evaluate("document.body.scrollHeight")) as number;
  let scrollAttempts = 0;
  while (scrollAttempts < 20) {
    await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
    await randomDelay(2000, 3000);
    const newHeight = (await page.evaluate("document.body.scrollHeight")) as number;
    if (newHeight === lastHeight) break;
    lastHeight = newHeight;
    scrollAttempts++;
    await log(`   Scroll ${scrollAttempts}: height=${newHeight}`);
  }

  // Screenshot untuk debug
  await page.screenshot({ path: DEBUG_SCREENSHOT, fullPage: false });
  await log(`📸 Screenshot disimpan: ${DEBUG_SCREENSHOT}`);

  // Ekstrak semua link grup
  let groupLinks: string[] = await page.evaluate(() => {
    const links = Array.from(document.querySelectorAll('a[href*="/groups/"]'));
    return [
      ...new Set(
        links
          .map((el) => (el as HTMLAnchorElement).href)
          .filter((href) => {
            try {
              const url = new URL(href);
              const p = url.pathname;
              return (
                /^\/groups\/[^/]+\/?$/.test(p) &&
                !href.includes("joins") &&
                !href.includes("discover") &&
                !href.includes("create") &&
                !href.includes("feed") &&
                !href.includes("notifications")
              );
            } catch {
              return false;
            }
          })
      ),
    ];
  });

  // Normalisasi URL (hapus query params)
  groupLinks = [
    ...new Set(
      groupLinks.map((href) => {
        try {
          const url = new URL(href);
          return `${url.origin}${url.pathname}`;
        } catch {
          return href;
        }
      })
    ),
  ];

  await log(`📊 Ditemukan ${groupLinks.length} grup`);

  if (groupLinks.length === 0) {
    await log(
      "❌ Tidak ada grup ditemukan!\n" +
        "   → Cek debug-groups-page.png\n" +
        "   → Pastikan cookie.txt sudah benar dan tidak expired\n" +
        "   → Pastikan akun sudah join minimal 1 grup"
    );
    await browser.close();
    return;
  }

  // Tampilkan ringkasan sebelum mulai
  await log(`\n📣 Ringkasan:`);
  await log(`   • Batch: ${startBatch} → ${totalBatches}`);
  await log(`   • Grup per batch: ${groupLinks.length}`);
  await log(`   • Mulai dari group index: ${startGroupIdx}`);
  await log(`   • Delay antar post: ${(POST_DELAY_MIN_MS / 1000).toFixed(0)}–${(POST_DELAY_MAX_MS / 1000).toFixed(0)} detik`);
  await log(`   • Retry per grup: maksimal ${MAX_POST_ATTEMPTS} kali`);
     await log(`   • Delay antar batch: 45–90 detik`);
  await log(`   • Mulai dalam 3 detik...\n`);
  await randomDelay(3000, 3000);

  // ── Loop batch utama ───────────────────────────────────────────────────────
  // Menghitung berapa banyak grup BERTURUT-TURUT yang gagal diposting (bukan LIMIT
  // terverifikasi). Reset ke 0 setiap kali ada grup yang berhasil.
  let consecutiveSkips = 0;

  for (let batch = startBatch; batch <= totalBatches; batch++) {
    await log(`\n${"═".repeat(50)}`);
    await log(`🗂️  BATCH ${batch}/${totalBatches}`);
    await log(`${"═".repeat(50)}`);

    let content: ContentBatch;
    try {
      content = await loadContentBatch(batch);
    } catch (err) {
      await log(`❌ Batch ${batch} tidak dapat diproses karena kontennya tidak tersedia: ${err}`);
      continue;
    }

    // Untuk resume: hanya batch pertama yang mulai dari startGroupIdx
    const groupStart = batch === startBatch ? startGroupIdx : 0;

    for (let i = groupStart; i < groupLinks.length; i++) {
      if (await stopRequested()) {
        await saveProgress(batch, i);
        await log(`⏹ STOP diminta → menyimpan progress B${batch} G${i + 1}`);
        await browser.close();
        return;
      }

      const link = groupLinks[i];
      if (!link) continue;

      const groupLabel = `[B${batch} G${i + 1}/${groupLinks.length}]`;
      await log(`\n${groupLabel} → ${link}`);

      try {
        let completed = false;

        // Jangan langsung skip jika selector/UI gagal.
        // Progress hanya maju jika posting mendapat hasil yang terverifikasi.
        for (let attempt = 1; attempt <= MAX_POST_ATTEMPTS; attempt++) {
          if (await stopRequested()) {
            await saveProgress(batch, i);
            await log(`⏹ STOP diminta → menyimpan progress B${batch} G${i + 1}`);
            await browser.close();
            return;
          }

          await log(`🔁 ${groupLabel} → percobaan ${attempt}/${MAX_POST_ATTEMPTS}`);

          // Jangan melakukan retry jika Facebook sudah memberi restriction.
          if (await detectFacebookPostingRestriction(page, groupLabel)) {
            await log(
              `🛑 ${groupLabel} → proses dihentikan sebelum retry karena Facebook membatasi aktivitas posting.`
            );
            await saveProgress(batch, i);
            await browser.close();
            return;
          }

          try {
            const result = await postToGroup(
              browser,
              page,
              link,
              content.postContent,
              content.imagePaths,
              groupLabel
            );
            page = result.page;

            if (result.status === "LIMITED") {
              await log(`\n🛑 STOP: Facebook mendeteksi pembatasan posting.`);
              await log(`   Batch terakhir: ${batch}`);
              await log(`   Group terakhir: ${i + 1}`);
              await log(`   Progress disimpan agar bisa dilanjutkan nanti.`);
              await saveProgress(batch, i);
              await browser.close();
              return;
            }

            if (
              result.status === "POSTING_OK" ||
              result.status === "PENDING_APPROVAL"
            ) {
              completed = true;
              consecutiveSkips = 0; // grup berhasil → reset penghitung skip berturut-turut
              await saveProgress(batch, i + 1);
              await log(`💾 Progress: batch=${batch}, nextGroup=${i + 2}`);
              await logPostingSummary();
              break;
            }

            // ERROR/UNKNOWN tidak dianggap selesai.
            // Grup yang sama dicoba ulang agar tidak terlewat.
            await log(
              `⚠️ ${groupLabel} → status ${result.status || "UNKNOWN"}, ` +
              `belum dianggap selesai.`
            );

            if (attempt < MAX_POST_ATTEMPTS) {
              const retryDelay = randomBetween(10000, 20000);
              await log(
                `⏳ ${groupLabel} → retry dalam ${(retryDelay / 1000).toFixed(1)}s...`
              );

              if (await waitWithStopCheck(retryDelay)) {
                await saveProgress(batch, i);
                await log(`⏹ STOP diminta → progress disimpan di B${batch} G${i + 1}`);
                await browser.close();
                return;
              }
            }
          } catch (err) {
            await log(`❌ ${groupLabel} → percobaan ${attempt} gagal: ${err}`);

            if (attempt < MAX_POST_ATTEMPTS) {
              const retryDelay = randomBetween(10000, 20000);
              await log(
                `⏳ ${groupLabel} → retry dalam ${(retryDelay / 1000).toFixed(1)}s...`
              );

              if (await waitWithStopCheck(retryDelay)) {
                await saveProgress(batch, i);
                await log(`⏹ STOP diminta → progress disimpan di B${batch} G${i + 1}`);
                await browser.close();
                return;
              }
            }
          }
        }

        if (!completed) {
          // Grup ini benar-benar gagal (ERROR/UNKNOWN) setelah semua percobaan,
          // dan itu BUKAN karena LIMIT terverifikasi (LIMITED sudah return lebih awal di atas).
          // Sesuai kebutuhan: kalau memang tidak bisa post di grup ini, LANJUT KE GRUP
          // BERIKUTNYA — tapi JANGAN loncat ke batch berikutnya. Progress disimpan
          // sebagai i+1 (grup ini dilewati), dan for-loop di bawah secara alami tetap
          // berada di batch yang sama sampai semua grup di batch ini diproses.
          consecutiveSkips++;
          await saveProgress(batch, i + 1);
          await log(
            `⏭️ ${groupLabel} → GAGAL setelah ${MAX_POST_ATTEMPTS} percobaan (bukan limit). ` +
            `Grup ini DI-SKIP (${consecutiveSkips} gagal berturut-turut), lanjut ke grup berikutnya ` +
            `— batch ${batch} TIDAK dilanjutkan ke batch berikutnya sebelum semua grup selesai.`
          );

          if (
            MAX_CONSECUTIVE_SKIPS > 0 &&
            consecutiveSkips >= MAX_CONSECUTIVE_SKIPS
          ) {
            await log(
              `🛑 STOP: ${consecutiveSkips} grup berturut-turut gagal diposting. ` +
              `Ini bisa jadi tanda limit yang tidak terdeteksi otomatis, jadi worker ` +
              `dihentikan sebagai safety-net. Progress tersimpan di B${batch} G${i + 2}. ` +
              `Cek akun secara manual sebelum resume (atau naikkan MAX_CONSECUTIVE_SKIPS).`
            );
            await browser.close();
            return;
          }

          const skipDelay = randomBetween(10000, 20000);
          await log(
            `⏳ Jeda ${(skipDelay / 1000).toFixed(1)}s sebelum lanjut ke grup berikutnya...`
          );
          if (await waitWithStopCheck(skipDelay)) {
            await log(`⏹ STOP diminta → progress disimpan di B${batch} G${i + 2}`);
            await browser.close();
            return;
          }

          continue; // lanjut ke grup berikutnya DI BATCH YANG SAMA
        }

        // Delay antar posting yang sudah berhasil diproses.
        const delay = randomBetween(POST_DELAY_MIN_MS, POST_DELAY_MAX_MS);
        await log(
          `⏱️ Delay antar posting: ${(delay / 1000).toFixed(1)}s...`
        );

        if (await waitWithStopCheck(delay)) {
          await saveProgress(batch, i + 1);
          await log(`⏹ STOP diminta → progress disimpan di B${batch} G${i + 2}`);
          await browser.close();
          return;
        }
      } catch (err) {
        // Error tak terduga juga TIDAK memajukan progress.
        await log(`❌ ${groupLabel} → Error tidak terduga: ${err}`);
        await saveProgress(batch, i);
        await log(
          `⏸️ ${groupLabel} → progress tetap di grup ini agar tidak ter-skip.`
        );
        await browser.close();
        return;
      }
    }

    await log(`\n✅ Batch ${batch} selesai`);

    // Delay antar batch (kecuali batch terakhir)
    if (batch < totalBatches) {
      const batchDelay = randomBetween(45000, 90000);
      await log(
        `⏸️  Delay batch: ${(batchDelay / 1000).toFixed(0)}s sebelum batch ${batch + 1}...`
      );
      if (await waitWithStopCheck(batchDelay)) {
        await saveProgress(batch + 1, 0);
        await log(`⏹ STOP diminta → progress disimpan untuk batch ${batch + 1}, group 1`);
        await browser.close();
        return;
      }
      startGroupIdx = 0; // reset untuk batch berikutnya
    }
  }

  await log("\n🎉 Semua batch selesai!");
  await logPostingSummary();
  await clearProgress();
  await browser.close();
}

main().catch(async (err) => {
  await log(`💥 Fatal error: ${err}`);
  process.exit(1);
});