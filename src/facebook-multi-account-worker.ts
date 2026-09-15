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
async function log(message: string): Promise<void> {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${message}`;
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
async function loadProgress(): Promise<Progress | null> {
  try {
    const raw = await fs.readFile(PROGRESS_FILE, "utf-8");
    const progress = JSON.parse(raw) as Progress;
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
  // cookie.txt dan localstorage.txt bersifat OPSIONAL.
  // Session utama dipertahankan oleh persistent browser profile.
  // Jika file kosong/belum ada, worker tetap bisa berjalan.

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

  if (!needsLogin) {
    await log("✅ Session Facebook tersedia di persistent browser profile");
    return;
  }

  await log("⚠️ FB account belum login pada browser profile ini.");

  await log("🔐 LOGIN_REQUIRED — silakan login manual di browser yang terbuka.");
  await log("⏳ Menunggu login Facebook maksimal 10 menit...");

  const deadline = Date.now() + 10 * 60 * 1000;
  while (Date.now() < deadline) {
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
      await log(
        "✅ Login Facebook terdeteksi. Session akan dipertahankan oleh persistent profile."
      );
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
];

function normalizeUiText(text: string): string {
  return text.toLowerCase().replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
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
    const stats = JSON.parse(raw) as PostingStats;
    if (stats.accountId === ACCOUNT_ID) return stats;
  } catch {}
  return { accountId: ACCOUNT_ID, total: 0, direct: 0, pending: 0, error: 0, limited: 0, unknown: 0, lastUpdated: new Date().toISOString() };
}

async function savePostingStats(stats: PostingStats): Promise<void> {
  stats.lastUpdated = new Date().toISOString();
  await fs.writeFile(POSTING_STATS_FILE, JSON.stringify(stats, null, 2));
}

async function resetPostingStats(): Promise<void> {
  const stats: PostingStats = {
    accountId: ACCOUNT_ID,
    total: 0,
    direct: 0,
    pending: 0,
    error: 0,
    limited: 0,
    unknown: 0,
    lastUpdated: new Date().toISOString(),
  };
  await savePostingStats(stats);
}

async function recordPostingResult(status: PostingStatus): Promise<void> {
  const stats = await loadPostingStats();
  stats.total++;
  if (status === "POSTING_OK") stats.direct++;
  else if (status === "PENDING_APPROVAL") stats.pending++;
  else if (status === "ERROR") stats.error++;
  else if (status === "LIMITED") stats.limited++;
  else stats.unknown++;
  await savePostingStats(stats);
}

async function logPostingSummary(): Promise<void> {
  const stats = await loadPostingStats();
  await log(`📊 RINGKASAN → total=${stats.total} | direct=${stats.direct} | pending=${stats.pending} | error=${stats.error} | limited=${stats.limited} | unknown=${stats.unknown}`);
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

// Fail-safe: cek apakah akun sudah LIMIT sebelum posting
const prePostStatus = await detectPostingResult(page, groupLabel, "");

if (prePostStatus === "LIMITED") {
  await log(
    `🛑 ${groupLabel} → akun terdeteksi LIMIT sebelum posting`
  );

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
        return Array.from(
          document.querySelectorAll('input[type="file"].x1s85apg')
        ).find((input) => !input.closest('[aria-hidden="true"]'));
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
  ];
  const postButtonXPaths = [
    '//div[@role="button" and .//span[text()="Posting"]]',
    '//div[@role="button" and .//span[text()="Post"]]',
    '//div[@role="button" and .//span[text()="Kirim"]]',
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

  // Tunggu tombol tidak disabled (max 15 detik)
  let isDisabled = true;
  let retries = 0;
  while (isDisabled && retries < 30) {
    isDisabled = await page.evaluate(
      (el) => el?.getAttribute("aria-disabled") === "true",
      postButton
    );
    if (isDisabled) {
      await new Promise((r) => setTimeout(r, 500));
      retries++;
    }
  }

  await postButton.click();
  await log(`📤 ${groupLabel} → Post diklik!`);

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
    const config = JSON.parse(raw) as AccountConfig;
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
      "--enable-features=AsyncClipboardAPI",
    ],
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
  await page.setExtraHTTPHeaders({ "Accept-Language": "en-US,en;q=0.9" });

  // Load cookie/localStorage jika tersedia. File tersebut opsional.
  await loadCookieAndLocalStorage(page);

  // Pastikan account sudah login. Pada first run, login dilakukan manual.
  await ensureFacebookLoggedIn(page);

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
  await log(`   • Delay antar post: 8–15 detik`);
  await log(`   • Delay antar batch: 45–90 detik`);
  await log(`   • Mulai dalam 3 detik...\n`);
  await randomDelay(3000, 3000);

  // ── Loop batch utama ───────────────────────────────────────────────────────
  for (let batch = startBatch; batch <= totalBatches; batch++) {
    await log(`\n${"═".repeat(50)}`);
    await log(`🗂️  BATCH ${batch}/${totalBatches}`);
    await log(`${"═".repeat(50)}`);

    let content: ContentBatch;
    try {
      content = await loadContentBatch(batch);
    } catch (err) {
      await log(`❌ Batch ${batch} diskip: ${err}`);
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
        const result = await postToGroup(
          browser,
          page,
          link,
          content.postContent,
          content.imagePaths,
          groupLabel
        );
        page = result.page;

        // Jika Facebook menunjukkan pembatasan, hentikan seluruh proses.
        if (result.status === "LIMITED") {
          await log(`\n🛑 STOP: Facebook mendeteksi pembatasan posting.`);
          await log(`   Batch terakhir: ${batch}`);
          await log(`   Group terakhir: ${i + 1}`);
          await log(`   Progress disimpan agar bisa dilanjutkan nanti.`);

          // Simpan grup yang sedang diperiksa agar tidak dianggap selesai.
          await saveProgress(batch, i);

          await browser.close();
          return;
        }

        if (
          result.status === "POSTING_OK" ||
          result.status === "PENDING_APPROVAL" ||
          result.status === "ERROR"
        ) {
          // Hasil sudah diketahui, jadi grup dianggap selesai diproses.
          await saveProgress(batch, i + 1);
          await log(`💾 Progress: batch=${batch}, nextGroup=${i + 2}`);
          await logPostingSummary();

          const delay = randomBetween(8000, 15000);
          await log(`⏱️  Menunggu ${(delay / 1000).toFixed(1)}s...`);
          if (await waitWithStopCheck(delay)) {
            await saveProgress(batch, i + 1);
            await log(`⏹ STOP diminta → progress disimpan di B${batch} G${i + 2}`);
            await browser.close();
            return;
          }
        } else {
          // UNKNOWN: jangan menganggap grup sudah selesai.
          await log(`⚠️ ${groupLabel} → status UNKNOWN, grup tidak ditandai sebagai selesai`);
          await saveProgress(batch, i);
        }
      } catch (err) {
        await log(`❌ ${groupLabel} → Error tidak terduga: ${err}`);
        await log(`   Lanjut ke grup berikutnya...`);
        await saveProgress(batch, i + 1);
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