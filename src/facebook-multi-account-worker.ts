/**
 * ============================================================
 * Facebook Group Auto-Poster â€” Batch Edition
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
import { generateCaption } from "./caption-generator";

// â”€â”€â”€ Constants â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const ROOT_DIR = path.resolve("accounts");
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".gif", ".webp"];

const ACCOUNT_ID = (process.argv[2] || process.env.ACCOUNT_ID || "").trim();
// Waktu spawn (di-set dashboard) untuk membedakan stop.request lama vs yang
// ditulis setelah proses ini hidup â€” mencegah STOP kilat saat start terabaikan.
const LAUNCH_AT = Number(process.env.WORKER_LAUNCH_AT) || Date.now();
// Mode: "collect" = kumpulkan grup yang sudah di-join akun ini ke groups-pool.txt,
// "join" = join grup dari groups-pool.txt. Kosong = auto-poster biasa.
const RUN_MODE = (process.argv[3] || process.env.RUN_MODE || "").trim();
const RUN_BATCH = Number(process.argv[4] || process.env.RUN_BATCH || "0");
const RUN_GROUP = Number(process.argv[5] || process.env.RUN_GROUP || "0");
const DASHBOARD_MODE = process.env.DASHBOARD_MODE === "1" || RUN_MODE !== "";
const COLLECT_MODE = RUN_MODE === "collect";
const JOIN_MODE = RUN_MODE === "join";
// Mode "one": uji 1 posting (batch/group tertentu, default 1/1), lalu close.
// Untuk deteksi limit per akun; progress asli tidak ditimpa.
const ONE_POST_MODE = RUN_MODE === "one";
// Akun dengan titik mulai batch diacak setiap start + siklus ulang ke batch 1
// setelah semua batch habis (tidak idle menunggu konten baru).
const RANDOM_START_ACCOUNTS = /^fb(0[1-9]|1[01])$/;

if (!ACCOUNT_ID) {
  console.error("âŒ Account ID belum diberikan. Contoh: npm start -- fb01");
  process.exit(1);
}

// Mencegah path traversal seperti ../../folder
if (!/^[a-zA-Z0-9_-]+$/.test(ACCOUNT_ID)) {
  console.error("âŒ Account ID hanya boleh berisi huruf, angka, _ atau -");
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
const JOIN_PROGRESS_FILE = path.join(ACCOUNT_DIR, "join-progress.json");
// Pool grup hasil "collect" dari akun-akun yang sudah join; diedit manual juga boleh.
const POOL_FILE = path.resolve("groups-pool.txt");

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
const POST_DELAY_MIN_MS = Number(process.env.POST_DELAY_MIN_MS || "45000");
const POST_DELAY_MAX_MS = Number(process.env.POST_DELAY_MAX_MS || "150000");

// â”€â”€â”€ Human-like session pacing â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Setelah N posting sukses, worker "istirahat" seperti manusia (break 1 jam).
// Heartbeat log tiap 5 menit supaya dashboard watchdog tidak menganggap hang.
const HUMAN_SESSION_POSTS = Number(process.env.HUMAN_SESSION_POSTS || "15");
const HUMAN_BREAK_MS = Number(process.env.HUMAN_BREAK_MS || String(60 * 60 * 1000));
const HUMAN_HEARTBEAT_MS = Number(process.env.HUMAN_HEARTBEAT_MS || String(5 * 60 * 1000));

/**
 * Istirahat manusiawi dengan heartbeat + STOP check.
 * Returns true bila STOP diminta (caller harus keluar rapi).
 */
async function humanBreak(totalMs: number): Promise<boolean> {
  if (totalMs <= 0) return false;
  const end = Date.now() + totalMs;
  await log(
    `â¸ï¸ Istirahat manusiawi ${(totalMs / 60000).toFixed(0)} menit sebelum lanjut...`
  );
  while (Date.now() < end) {
    const remaining = end - Date.now();
    const chunk = Math.min(HUMAN_HEARTBEAT_MS, remaining);
    if (await waitWithStopCheck(chunk)) {
      await log("â¹ STOP diminta saat istirahat â†’ keluar rapi.");
      return true;
    }
    if (Date.now() < end) {
      await log(
        `â¸ï¸ Masih istirahat â€” sisa ${Math.ceil((end - Date.now()) / 60000)} menit...`
      );
    }
  }
  await log("â–¶ï¸ Istirahat selesai â€” lanjut posting.");
  return false;
}

// Jika UI gagal terdeteksi, grup yang sama dicoba lagi agar tidak diam-diam ter-skip.
const MAX_POST_ATTEMPTS = Number(process.env.MAX_POST_ATTEMPTS || "2");

// Safety-net: kalau ada N grup BERTURUT-TURUT yang gagal (bukan LIMIT terverifikasi),
// worker berhenti sepenuhnya. Ini untuk berjaga-jaga kalau sebenarnya akun sedang
// kena limit tapi tidak lolos terdeteksi oleh detectFacebookPostingRestriction/detectLimitOnly.
// Set ke 0 untuk menonaktifkan safety-net ini (grup gagal akan terus di-skip tanpa batas).
const MAX_CONSECUTIVE_SKIPS = Number(process.env.MAX_CONSECUTIVE_SKIPS || "5");

// â”€â”€â”€ Types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

// â”€â”€â”€ Logging â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Rotasi log.txt â†’ log-<tanggal>.txt setiap kali tanggal berganti supaya file
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
    // log.txt belum ada / tidak bisa di-rename â€” biarkan
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

// â”€â”€â”€ Random Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function randomBetween(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function randomDelay(minMs: number, maxMs: number): Promise<void> {
  await new Promise((r) => setTimeout(r, randomBetween(minMs, maxMs)));
}

// â”€â”€â”€ Human-like Interaction Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Cursor yang melompat + klik instan adalah sinyal automation. Helper di bawah
// memakai mouse asli (CDP input) dengan jalur bertahap, hover, dan jeda.

interface Point {
  x: number;
  y: number;
}

/** Gerakkan mouse ke titik target lewat 1-2 waypoint, dengan jitter kecil. */
async function humanMouseMove(
  page: Page,
  target: Point,
  steps = randomBetween(8, 24)
): Promise<void> {
  try {
    // 1-2 waypoint acak di sekitar target supaya jalur tidak garis lurus.
    const waypoints = randomBetween(1, 2);
    for (let i = 1; i <= waypoints; i++) {
      const t = i / (waypoints + 1);
      const wx = target.x + (1 - t) * randomBetween(-120, 120);
      const wy = target.y + (1 - t) * randomBetween(-80, 80);
      await page.mouse.move(wx, wy, { steps: Math.max(3, Math.floor(steps / 2)) });
      await randomDelay(40, 160);
    }
    await page.mouse.move(target.x, target.y, { steps });
    await randomDelay(60, 220);
  } catch {}
}

/** Klik elemen seperti manusia: scroll ke tengah, hover, lalu down/up. */
async function humanClick(
  page: Page,
  handle: ElementHandle<Element> | null
): Promise<boolean> {
  if (!handle) return false;
  try {
    const box = await handle.boundingBox();
    if (!box || box.width <= 0 || box.height <= 0) {
      // Fallback: klik elemen langsung (real mouse via CDP di dalam Puppeteer).
      await handle.click();
      await randomDelay(300, 800);
      return true;
    }
    // Titik klik acak di area tengah 60% elemen, bukan tepat di tengah.
    const x = box.x + box.width * (0.2 + Math.random() * 0.6);
    const y = box.y + box.height * (0.2 + Math.random() * 0.6);

    await humanMouseMove(page, { x, y });
    // Hover sebelum klik: manusia membaca dulu sebelum menekan.
    await randomDelay(250, 700);
    await page.mouse.down();
    await randomDelay(80, 180);
    await page.mouse.up();
    await randomDelay(200, 500);
    return true;
  } catch {
    try {
      await handle.click();
      await randomDelay(300, 800);
      return true;
    } catch {
      return false;
    }
  }
}

/** Scroll halus pakai mouse wheel, kadang scroll balik sedikit. */
async function humanScroll(
  page: Page,
  screens = randomBetween(1, 3)
): Promise<void> {
  try {
    for (let i = 0; i < screens; i++) {
      await page.mouse.wheel({ deltaY: randomBetween(300, 650) });
      await randomDelay(500, 1400);
      // Kadang scroll balik sedikit (membaca ulang).
      if (Math.random() < 0.25) {
        await page.mouse.wheel({ deltaY: -randomBetween(80, 200) });
        await randomDelay(400, 900);
      }
    }
  } catch {}
}

/** Gerakan mouse idle + scroll kecil sebelum aksi (terlihat seperti membaca). */
async function humanIdle(page: Page): Promise<void> {
  try {
    const viewport = page.viewport();
    const w = viewport?.width ?? 1280;
    const h = viewport?.height ?? 800;
    for (let i = 0; i < randomBetween(1, 3); i++) {
      await humanMouseMove(page, {
        x: randomBetween(100, Math.max(200, w - 100)),
        y: randomBetween(100, Math.max(200, h - 100)),
      });
    }
    await humanScroll(page, randomBetween(1, 2));
    await randomDelay(1200, 3500);
  } catch {}
}

/**
 * Ketik teks seperti manusia: delay per karakter bervariasi, pause antar
 * kata/tanda baca, kadang pause panjang. Tidak ada typo (caption harus exact).
 */
async function typeHumanLike(page: Page, text: string): Promise<void> {
  let sincePause = 0;
  for (const char of text) {
    let delay = randomBetween(45, 140);
    if (char === " ") delay = randomBetween(30, 90);
    else if (/[.,!?]/.test(char)) delay = randomBetween(150, 400);
    else if (char === "\n") delay = randomBetween(300, 800);

    await page.keyboard.type(char, { delay });
    sincePause++;

    if (char === " " || /[.,!?]/.test(char)) {
      // Pause antar kata / kalimat.
      if (Math.random() < 0.3) await randomDelay(200, 600);
      else await randomDelay(60, 220);
    }
    // Sesekali pause "mikir" 1-2 detik setelah 30-70 karakter.
    if (sincePause > randomBetween(30, 70)) {
      if (Math.random() < 0.35) await randomDelay(1000, 2000);
      sincePause = 0;
    }
  }
}

/**
 * Teks yang sedang ada di editor composer (scoped ke dialog). Dipakai untuk
 * memastikan caption/link benar-benar masuk sebelum tombol Post diklik.
 */
async function readComposerText(page: Page): Promise<string> {
  try {
    const text = await page.evaluate(() => {
      const editors = Array.from(
        document.querySelectorAll('[role="dialog"] div[contenteditable="true"]')
      ) as HTMLElement[];
      return editors.map((el) => el.innerText || "").join(" ");
    });
    return normalizeUiText(text);
  } catch {
    return "";
  }
}

// â”€â”€â”€ Progress Management â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
  // Mode 1/1 hanya probe — jangan menimpa progress resume asli.
  if (ONE_POST_MODE) return;
  const progress: Progress = {
    accountId: ACCOUNT_ID,
    batch,
    groupIdx,
    timestamp: new Date().toISOString(),
  };
  await fs.writeFile(PROGRESS_FILE, JSON.stringify(progress, null, 2));
}

// â”€â”€â”€ Content Loader â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function loadContentBatch(batchIndex: number): Promise<ContentBatch> {
  const batchDir = path.join(CONTENT_DIR, String(batchIndex));
  const textFile = path.join(batchDir, "text.txt");
  const imagesDir = path.join(batchDir, "images");

  let postContent = "";
  try {
    postContent = await fs.readFile(textFile, "utf-8");
  } catch {
    await log(`âš ï¸  content/${batchIndex}/text.txt not found â€” batch akan diskip`);
    throw new Error(`text.txt tidak ditemukan untuk batch ${batchIndex}`);
  }

  let imagePaths: string[] = [];
  try {
    const files = await fs.readdir(imagesDir);
    imagePaths = files
      .filter((f) => IMAGE_EXTENSIONS.includes(path.extname(f).toLowerCase()))
      .map((f) => path.join(imagesDir, f));
  } catch {
    // Folder images tidak ada â€” tidak masalah
  }

  await log(
    `ðŸ“¦ Batch ${batchIndex}: "${postContent.slice(0, 60).replace(/\n/g, " ")}..." | ${imagePaths.length} gambar`
  );
  return { postContent, imagePaths };
}

// â”€â”€â”€ Cookie & LocalStorage â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function loadCookieAndLocalStorage(page: Page): Promise<void> {
  // cookie.txt & localstorage.txt = BOOTSTRAP untuk profil yang tidak punya
  // session (rebuild / PC baru). Profil persistent adalah sumber kebenaran;
  // file tidak pernah di-inject saat profil masih login karena menimpa
  // cookie valid dengan nilai basi membuat FB logout/checkpoint. File
  // di-refresh otomatis via exportSessionFiles() setiap sesi login valid.

  let cookieCount = 0;
  let localStorageCount = 0;

  // â”€â”€ Load cookies jika tersedia â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

          if (parts[6] === "âœ“") cookie.httpOnly = true;
          if (parts[7] === "âœ“") cookie.secure = true;

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
        await log(`ðŸª Loaded ${cookieCount} cookies dari cookie.txt`);
      }
    } else {
      await log("ðŸª cookie.txt kosong â†’ dilewati (persistent profile digunakan)");
    }
  } catch {
    await log("ðŸª cookie.txt belum ada/tidak bisa dibaca â†’ dilewati");
  }

  // Buka Facebook sebelum mengakses localStorage.
  try {
    await page.goto("https://web.facebook.com", {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });
  } catch (error) {
    await log(`âš ï¸ Gagal membuka Facebook saat inisialisasi session: ${error}`);
  }

  // â”€â”€ Load localStorage jika tersedia â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  try {
    const localStorageData = await fs.readFile(
      LOCALSTORAGE_FILE,
      "utf-8"
    );
    const trimmed = localStorageData.trim();

    if (trimmed.length === 0) {
      await log(
        "ðŸ’¾ localstorage.txt kosong â†’ dilewati (persistent profile digunakan)"
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
        `ðŸ’¾ Loaded ${localStorageCount} localStorage items dari localstorage.txt`
      );
    }
  } catch {
    await log("ðŸ’¾ localstorage.txt belum ada/tidak bisa dibaca â†’ dilewati");
  }

  await log(
    `ðŸ” Session source â†’ persistent profile${
      cookieCount || localStorageCount
        ? ` + file session (${cookieCount} cookies, ${localStorageCount} localStorage)`
        : ""
    }`
  );
}

// Deteksi apakah halaman Facebook masih "belum login".
// ANDA: cookie `c_user` (hanya ada saat login) TIDAK ada, ATAU url /login,
// ATAU ada login form. Jangan andalkan DOM saja â€” homepage log-out dengan
// dropdown login pernah lolos deteksi DOM dan bikin sesi tidak di-load.
async function checkNeedsLogin(page: Page): Promise<boolean> {
  try {
    await page.goto("https://web.facebook.com/", {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });
  } catch (error) {
    await log(`âš ï¸ Gagal membuka halaman Facebook: ${error}`);
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
    // Halaman gagal dievaluasi (tab error dsb) â†’ anggap belum login.
    return true;
  }
}

// Snapshot session browser yang HIDUP ke file bootstrap setiap login
// terverifikasi. Hanya dipanggil dari jalur login-valid â€” jangan pernah
// menimpa file dengan isi profil yang belum login. Format kompatibel dengan
// parser loadCookieAndLocalStorage (kolom ke-5 tidak dipakai, âœ“ = true).
async function exportSessionFiles(page: Page): Promise<void> {
  try {
    const cookies = await page.cookies(
      "https://web.facebook.com",
      "https://www.facebook.com"
    );

    // Proteksi: tanpa c_user = profil tidak benar-benar login â†’ JANGAN
    // menimpa file bootstrap (cookie anonim tidak berharga & bisa menghapus
    // file yang barusan dipaste user).
    const loggedIn = cookies.some((c) => c.name === "c_user" && !!c.value);
    if (!loggedIn) {
      await log(
        "âš ï¸ c_user tidak ditemukan â€” skip export, file session dibiarkan."
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
          c.httpOnly ? "âœ“" : "-",
          c.secure ? "âœ“" : "-",
          sameSite,
        ].join("\t")
      );
    }

    if (cookieLines.length > 0) {
      await fs.writeFile(COOKIE_FILE, cookieLines.join("\n") + "\n", "utf-8");
      await log(
        `ðŸ’¾ cookie.txt di-refresh dari session live (${cookieLines.length} cookies)` +
          (cookieSkip ? `, ${cookieSkip} dilewati (ada tab/newline)` : "")
      );
    } else {
      await log("âš ï¸ Tidak ada cookie untuk di-export â€” cookie.txt dibiarkan.");
    }

    // FB kadang masih navigasi tepat setelah login â†’ execution context hancur.
    // Retry singkat supaya localstorage.txt tetap ikut ter-refresh.
    let items: { key: string; value: string }[] = [];
    for (let attempt = 1; ; attempt++) {
      try {
        items = await page.evaluate(() =>
          Object.entries(localStorage).map(([key, value]) => ({ key, value: String(value) }))
        );
        break;
      } catch (err) {
        if (attempt >= 3) throw err;
        await randomDelay(2000, 3000);
      }
    }
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
        `ðŸ’¾ localstorage.txt di-refresh dari session live (${lsLines.length} items)` +
          (lsSkip ? `, ${lsSkip} dilewati` : "")
      );
    } else {
      await log("âš ï¸ localStorage kosong â€” localstorage.txt dibiarkan.");
    }
  } catch (err) {
    await log(`âš ï¸ Gagal export session files (tidak fatal): ${err}`);
  }
}

// â”€â”€â”€ Sesi: PROFIL DULU, file hanya bootstrap â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// - Profil login      â†’ file tidak disentuh (cookie valid tidak dihalangi)
//                       + file di-refresh dari session live
// - Profil kosong     â†’ inject file â†’ login via file
// - Masih belum login â†’ login manual 10 menit
// Tujuan: sesi tahan selama FB mengizinkan, tidak fasih kena logout oleh
// injeksi berulang (penyebab utama "harus masukin cookies terus-terusan").
async function ensureSessionReady(page: Page): Promise<void> {
  if (!(await checkNeedsLogin(page))) {
    await log("âœ… Session Facebook tersedia di persistent browser profile");
    await exportSessionFiles(page);
    return;
  }

  await log("âš ï¸ FB account belum login pada browser profile ini.");
  await log("ðŸ” Bootstrap session dari cookie.txt / localstorage.txt...");
  await loadCookieAndLocalStorage(page);

  if (!(await checkNeedsLogin(page))) {
    await log("âœ… Login berhasil via file session.");
    await exportSessionFiles(page);
    return;
  }

  // Auto-login (opsional): hanya kalau creds.json tersedia untuk akun ini.
  // Gagal (checkpoint/salah password/form aneh) â†’ jatuh ke login manual.
  if (process.env.SKIP_AUTOLOGIN === "1") {
    await log("â­ï¸ Auto-login dilewati (SKIP_AUTOLOGIN=1) â€” login manual.");
  } else {
    const creds = await loadCreds();
    if (creds && (await tryAutoLogin(page, creds))) {
      await log("âœ… Auto-login sukses via creds.json.");
      await exportSessionFiles(page);
      return;
    }
  }

  await ensureFacebookLoggedIn(page);
  await exportSessionFiles(page);
}

// Baca kredensial opsional accounts/<id>/creds.json (plaintext, dibuat manual
// oleh user). Tanpa file / JSON rusak / field kosong â†’ null (perilaku lama).
async function loadCreds(): Promise<{ email: string; password: string } | null> {
  try {
    const raw = await fs.readFile(path.join(ACCOUNT_DIR, "creds.json"), "utf-8");
    const parsed = parseJsonSafe<{ email?: string; password?: string }>(raw);
    if (parsed?.email && parsed?.password) {
      return { email: parsed.email, password: parsed.password };
    }
    await log("âš ï¸ creds.json tidak lengkap (butuh email & password) â€” dilewati.");
  } catch {
    // File tidak ada â†’ normal, auto-login tidak diaktifkan untuk akun ini.
  }
  return null;
}

// Isi form login (email + password) lalu klik submit. Dipakai auto-login awal
// dan submit ulang setelah 2FA. true = form lengkap & submit diklik.
async function submitLoginForm(
  page: Page,
  creds: { email: string; password: string }
): Promise<boolean> {
  const emailInput = await page
    .waitForSelector('input[name="email"]', { timeout: 10000 })
    .catch(() => null);
  if (!emailInput) {
    await log("âš ï¸ Form login tidak ditemukan â€” auto-login dibatalkan.");
    return false;
  }
  // focus() lebih aman daripada click() â€” elemen kadang tertutup overlay
  // (banner cookie-consent dsb) sehingga click() gagal "not clickable".
  // select() dulu supaya email yang sudah terisi tidak menumpuk saat submit ulang.
  await emailInput.focus();
  await emailInput.evaluate((el) => (el as HTMLInputElement).select());
  await emailInput.type(creds.email, { delay: randomBetween(40, 110) });
  await randomDelay(500, 1200);

  const passInput = await page
    .waitForSelector('input[name="pass"]', { timeout: 10000 })
    .catch(() => null);
  if (!passInput) {
    await log("âš ï¸ Input password tidak ditemukan â€” auto-login dibatalkan.");
    return false;
  }
  await passInput.focus();
  await passInput.evaluate((el) => (el as HTMLInputElement).select());
  await passInput.type(creds.password, { delay: randomBetween(40, 110) });
  await randomDelay(500, 1200);

  // Tombol submit: button[name="login"] (varian umum), fallback
  // button[type="submit"] & input[type="submit"] (varian lama).
  const submit: ElementHandle<Element> | null =
    (await page.$('button[name="login"]')) ||
    (await page.$('button[type="submit"]')) ||
    (await page.$('input[type="submit"]'));
  if (!submit) {
    await log("âš ï¸ Tombol login tidak ditemukan â€” auto-login dibatalkan.");
    return false;
  }
  try {
    await submit.click();
  } catch {
    // Elemen tertutup overlay / di luar viewport â†’ klik via DOM langsung.
    await submit.evaluate((el) => (el as HTMLElement).click());
  }
  return true;
}

// Isi form login Facebook otomatis. true = login sukses (c_user muncul).
// Selalu aman-gagal: checkpoint / salah password / error â†’ false â†’ fallback
// ke jendela login manual yang sudah ada.
async function tryAutoLogin(
  page: Page,
  creds: { email: string; password: string }
): Promise<boolean> {
  try {
    await log("ðŸ¤– Auto-login dari creds.json...");
    await page.goto("https://web.facebook.com/login", {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });
    await randomDelay(2000, 3000);

    if (!(await submitLoginForm(page, creds))) {
      return false;
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
        // JANGAN navigasi/return: halaman verifikasi harus tetap terbuka supaya
        // user bisa menyelesaikan 2FA. Tunggu c_user tanpa batas (STOP tetap
        // dihormati) â€” jangan tutup browser/terminal saat login belum selesai.
        await log(
          "âš ï¸ Facebook minta checkpoint/2FA â€” selesaikan verifikasi di jendela browser. " +
            "Worker menunggu (STOP untuk keluar)."
        );
        let lastHeartbeat = Date.now();
        let reloginAttempts = 0;
        for (;;) {
          if (await waitWithStopCheck(3500)) {
            await log("â¹ STOP diminta saat menunggu verifikasi 2FA â†’ keluar rapi.");
            process.exit(0);
          }
          if (page.isClosed()) {
            await log("âš ï¸ Browser ditutup saat menunggu verifikasi 2FA.");
            return false;
          }
          if (await waitForCuser(page, 2000)) {
            await log("âœ… Verifikasi 2FA selesai â€” login berhasil.");
            return true;
          }

          // FB kadang menampilkan form login lagi setelah 2FA (email terisi,
          // password kosong). Isi password lalu submit ulang â€” jangan anggap gagal.
          const form = await page
            .evaluate(() => {
              const url = location.href.toLowerCase();
              const atCheckpoint =
                url.includes("checkpoint") ||
                url.includes("two_step_verification") ||
                url.includes("login/approval");
              const email = document.querySelector(
                'input[name="email"]'
              ) as HTMLInputElement | null;
              const pass = document.querySelector(
                'input[name="pass"]'
              ) as HTMLInputElement | null;
              return {
                atCheckpoint,
                hasForm: !!email && !!pass,
                passEmpty: !pass || pass.value === "",
              };
            })
            .catch(() => ({ atCheckpoint: false, hasForm: false, passEmpty: false }));
          if (
            !form.atCheckpoint &&
            form.hasForm &&
            form.passEmpty &&
            reloginAttempts < 2
          ) {
            reloginAttempts++;
            await log(
              `ðŸ”„ Facebook kembali ke form login setelah 2FA â€” isi kredensial otomatis (${reloginAttempts}/2)...`
            );
            if (!(await submitLoginForm(page, creds))) {
              await log(
                "âš ï¸ Form login ulang tidak lengkap â€” silakan isi manual di jendela browser."
              );
            }
          }

          if (Date.now() - lastHeartbeat > 2 * 60 * 1000) {
            await log(
              "â³ Masih menunggu login/2FA selesai â€” browser dibiarkan terbuka (STOP untuk keluar)."
            );
            lastHeartbeat = Date.now();
          }
        }
      }
      const cookies = await page.cookies(
        "https://web.facebook.com",
        "https://www.facebook.com"
      );
      if (cookies.some((c) => c.name === "c_user" && !!c.value)) {
        return true;
      }
      // FB menampilkan pesan ini tanpa mengubah URL â€” deteksi langsung supaya
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
          "âŒ Password ditolak Facebook (creds.json salah) â€” perlu login manual."
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
      await log("âš ï¸ Form login masih tampil (kemungkinan email/password salah).");
      try {
        await page.screenshot({
          path: path.join(ACCOUNT_DIR, "debug-autologin.png"),
        });
        await log("ðŸ“¸ Screenshot state login disimpan: debug-autologin.png");
      } catch {}
      return false;
    }

    await log("âš ï¸ Timeout menunggu hasil auto-login.");
    return false;
  } catch (err) {
    await log(`âš ï¸ Auto-login gagal: ${err}`);
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

// â”€â”€â”€ Facebook Session Check â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function ensureFacebookLoggedIn(page: Page): Promise<void> {
  await log("ðŸ” Mengecek session Facebook...");

  try {
    await page.goto("https://web.facebook.com/", {
      waitUntil: "domcontentloaded",
      timeout: NAV_TIMEOUT,
    });
  } catch (error) {
    await log(`âš ï¸ Gagal membuka halaman Facebook: ${error}`);
  }

  // c_user adalah satu-satunya bukti login. URL/form saja tidak cukup karena
  // halaman login bisa tampil tanpa URL /login dan form bisa telat render.
  if (await waitForCuser(page, 5000)) {
    await log("âœ… Session Facebook tersedia di persistent browser profile");
    return;
  }

  await log("âš ï¸ FB account belum login pada browser profile ini.");

  await log("ðŸ” LOGIN_REQUIRED â€” silakan login manual di jendela Chrome worker ini.");
  await log(
    "â³ Menunggu login Facebook (c_user). Browser & terminal dibiarkan terbuka sampai login berhasil atau STOP."
  );

  // Mode uji 1/1 tidak menunggu login manual â€” akun tanpa sesi = hasil "SKIP (login hilang)".
  if (ONE_POST_MODE) {
    await log("ðŸ§ª MODE 1/1: login hilang â€” SKIP akun ini (hasil: belum bisa diuji).");
    process.exit(0);
  }

  // Tanpa deadline: login gagal/2FA tidak boleh menutup browser atau mematikan
  // worker. Heartbeat tiap ~2 menit menjaga watchdog dashboard tidak mengira hang.
  let lastHeartbeat = Date.now();
  for (;;) {
    // stop.request dicek juga saat menunggu login manual, supaya STOP admin
    // tetap dihormati dan worker keluar rapi (bukan terpaksa-kill 30 detik).
    if (await waitWithStopCheck(2000)) {
      await log("â¹ STOP diminta saat menunggu login â†’ keluar rapi.");
      process.exit(0);
    }
    if (page.isClosed()) {
      throw new Error("Browser ditutup saat menunggu login manual.");
    }
    if (await waitForCuser(page, 2000)) {
      await log(
        "âœ… Login Facebook berhasil (c_user ada). Session akan dipertahankan oleh persistent profile."
      );
      return;
    }
    if (Date.now() - lastHeartbeat > 2 * 60 * 1000) {
      await log(
        "â³ Masih menunggu login manual â€” browser dibiarkan terbuka (STOP untuk keluar)."
      );
      lastHeartbeat = Date.now();
    }
  }
}

// â”€â”€â”€ Page Listeners â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function setupPageListeners(page: Page): void {
  // Auto-dismiss dialog "Leave site?" dll
  page.on("dialog", async (dialog) => {
    await log(`[Dialog] ${dialog.type()} â†’ auto-accept`);
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

  // Crash/renderer mati sebelumnya membuat worker keluar tanpa jejak.
  page.on("error", (err) => {
    void log(`âš ï¸ Page error: ${err}`);
  });
}

// â”€â”€â”€ esbuild/tsx `__name` shim â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// tsx (esbuild) kadang menyisipkan pemanggilan helper internal `__name(fn, "namaFn")`
// saat mentranspile arrow function yang di-assign ke const (misalnya `const normalize = ...`).
// Helper itu hanya ada di scope Node.js. Tapi page.evaluate() mengirim ulang isi fungsi
// sebagai string murni ke context browser, sehingga saat dieksekusi di sana
// `__name` tidak dikenal â†’ "ReferenceError: __name is not defined" dan fungsi yang
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
    // Jika page sudah tertutup dsb, abaikan â€” bukan fatal.
  }
}

// â”€â”€â”€ Page Lifecycle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function isDetachedError(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err);
  return /detached|target closed|session closed|protocol error/i.test(msg);
}

async function configurePage(browser: Browser, page: Page): Promise<void> {
  setupPageListeners(page);
  await ensureNameShim(page);
  // Locale konsisten dengan akun Indonesia (UI FB berbahasa Indonesia).
  await page.setExtraHTTPHeaders({
    "Accept-Language": "id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7",
  });
  await page.emulateTimezone("Asia/Jakarta").catch(() => {});
  const context = browser.defaultBrowserContext();
  await context.overridePermissions("https://www.facebook.com", [
    "clipboard-read",
    "clipboard-write",
  ]);
  await context.overridePermissions("https://web.facebook.com", [
    "clipboard-read",
    "clipboard-write",
  ]);
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
}

async function replacePage(browser: Browser, page: Page): Promise<Page> {
  try {
    await page.close();
  } catch {}
  const fresh = await browser.newPage();
  await configurePage(browser, fresh);
  return fresh;
}

// â”€â”€â”€ Safe Navigation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
      await log(`âš ï¸  Page detached â€” membuat page baru (attempt ${attempt})`);
      page = await replacePage(browser, page);
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
          `âš ï¸  Navigasi gagal (attempt ${attempt}/${maxRetry}): ${msg.split("\n")[0]}`
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

// â”€â”€â”€ Posting Result Detection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        `ðŸš¨ ${groupLabel} â†’ SPAM/POSTING RESTRICTION FACEBOOK TERDETEKSI ` +
        `(phrase=${result.phraseFound}, redText=${result.redTextFound})`
      );
      return true;
    }
  } catch (error) {
    await log(
      `âš ï¸ ${groupLabel} â†’ gagal mengecek posting restriction: ${error}`
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
      await log(`ðŸš¨ ${groupLabel} â†’ LIMIT terdeteksi: "${limited}"`);
      return true;
    }
  } catch (error) {
    await log(`âš ï¸ ${groupLabel} â†’ gagal mengecek limit: ${error}`);
  }

  return false;
}

async function detectPendingApprovalNotice(page: Page): Promise<boolean> {
  try {
    const text = (await page.evaluate(() => document.body?.innerText || ""))
      .toLowerCase()
      .replace(/\s+/g, " ");
    return /menunggu persetujuan[^.]{0,40}postingan|postingan[^.]{0,40}menunggu persetujuan|pending (admin )?approval|your post is pending/.test(
      text
    );
  } catch {
    return false;
  }
}

async function detectPostingResult(
  page: Page,
  groupLabel: string,
  postContent: string
): Promise<{ status: PostingStatus; submitted: boolean }> {
  try {
    // Beri waktu untuk toast/dialog hasil submit muncul.
    await randomDelay(3000, 5000);
    const uiText = normalizeUiText(await page.evaluate(() => document.body?.innerText || ""));

    const limited = LIMITED_KEYWORDS.find((k) => uiText.includes(k));
    if (limited) {
      await log(`ðŸš¨ ${groupLabel} â†’ LIMIT terdeteksi: "${limited}"`);
      return { status: "LIMITED", submitted: false };
    }

    const pending = PENDING_KEYWORDS.find((k) => uiText.includes(k));
    if (pending) {
      await log(`ðŸŸ¡ ${groupLabel} â†’ PENDING approval: "${pending}"`);
      return { status: "PENDING_APPROVAL", submitted: true };
    }

    const error = ERROR_KEYWORDS.find((k) => uiText.includes(k));
    if (error) {
      await log(`âŒ ${groupLabel} â†’ ERROR posting: "${error}"`);
      return { status: "ERROR", submitted: false };
    }

    // Untuk DIRECT kita minta dua bukti: composer tertutup + sebagian caption
    // muncul kembali di halaman. Jika caption tidak terlihat tetapi composer
    // sudah tertutup, post kemungkinan besar terkirim â€” jangan retry (dobel).
    const caption = normalizeUiText(
      postContent.replace(/https?:\/\/[^\s]+/g, "").replace(/\s+/g, " ").trim()
    );
    const probe = caption.slice(0, 80);
    // Hanya teks yang BUKAN composer/dialog/kotak komentar yang dihitung:
    // caption yang belum terkirim tidak boleh dianggap bukti posting.
    const pageText = normalizeUiText(
      await page.evaluate(() => {
        const clone = document.body.cloneNode(true) as HTMLElement;
        clone
          .querySelectorAll('[role="dialog"], [contenteditable="true"], textarea, input')
          .forEach((el) => el.remove());
        return clone.textContent || "";
      })
    );
    const captionFound = probe.length >= 12 && pageText.includes(probe);

    const composerOpen = await page.evaluate(() => {
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
      return dialogs.some((dialog) => {
        const text = (dialog.textContent || "").toLowerCase().replace(/\s+/g, " ").trim();
        return ["create a post", "write something", "tulis sesuatu", "buat postingan"]
          .some((k) => text.includes(k));
      });
    });

    if (!composerOpen && captionFound) {
      await log(`âœ… ${groupLabel} â†’ DIRECT: bukti caption ditemukan setelah submit`);
      return { status: "POSTING_OK", submitted: true };
    }

    await log(`âš ï¸ ${groupLabel} â†’ UNKNOWN (composerOpen=${composerOpen}, captionFound=${captionFound})`);
    return { status: "UNKNOWN", submitted: !composerOpen };
  } catch (error) {
    await log(`âš ï¸ ${groupLabel} â†’ gagal mendeteksi hasil posting: ${error}`);
    // Detect dipanggil setelah tombol Post diklik â€” anggap terkirim agar
    // tidak retry buta dan menghasilkan posting dobel.
    return { status: "UNKNOWN", submitted: true };
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
  await log(`ðŸ“Š RINGKASAN â†’ total=${stats.total} | direct=${stats.direct} | pending=${stats.pending} | error=${stats.error} | limited=${stats.limited} | unknown=${stats.unknown}${todayLine}`);
}

// â”€â”€â”€ Post to Single Group â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
  await log(`ðŸŒ ${groupLabel} â†’ navigated`);

// Fail-safe: hanya cek LIMIT.
// Jangan memakai detectPostingResult("", ...) di sini karena halaman grup
// bisa mengandung teks/status lama dan menyebabkan false-positive.
if (await detectLimitOnly(page, groupLabel)) {
  await log(`ðŸ›‘ ${groupLabel} â†’ akun terdeteksi LIMIT sebelum posting`);

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
    await log(`â­ï¸  ${groupLabel} â†’ skip (Sell Something group)`);
    return { page, success: false, status: "UNKNOWN" };
  }

  // Cari tombol "Tulis sesuatu..." / "Write something..."
  // Fallback: aria-label dulu, lalu XPath teks lama.
  const writeButtonXPath =
    '//div[@role="button" and (' +
    './/span[contains(text(), "Tulis sesuatu...")] or ' +
    './/span[contains(text(), "Write something...")] or ' +
    './/span[contains(text(), "Tulis di grup...")] or ' +
    './/span[contains(text(), "Write something in the group...")] or ' +
    './/span[contains(text(), "Buat postingan")] or ' +
    './/span[contains(text(), "Create a post")]' +
    ')]';
  const writeButtonSelectors = [
    'div[aria-label="Write something..."]',
    'div[aria-label="Tulis sesuatu..."]',
    'div[aria-label="Create a post"]',
    'div[aria-label="Buat postingan"]',
  ];
  let writeButton = null;
  try {
    writeButton = await page.waitForSelector(`xpath/${writeButtonXPath}`, {
      timeout: WAIT_TIMEOUT,
    });
  } catch {}
  if (!writeButton) {
    for (const sel of writeButtonSelectors) {
      try {
        writeButton = await page.$(sel);
        if (writeButton) break;
      } catch {}
    }
  }

  if (writeButton) {
    await log(`âœ… ${groupLabel} â†’ write button ditemukan`);
  } else {
    const blockedReason = await page
      .evaluate(() => {
        const text = (document.body?.innerText || "")
          .toLowerCase()
          .replace(/\s+/g, " ")
          .slice(0, 2000);
        if (/only members can post|hanya anggota (grup )?yang dapat memposting|join (this )?group to post|bergabunglah dengan grup ini/.test(text)) {
          return "members-only";
        }
        if (/only admins can post|hanya admin yang dapat memposting/.test(text)) {
          return "admin-only";
        }
        if (/you must be a member|anda harus menjadi anggota|not a member of this group|bukan anggota grup ini/.test(text)) {
          return "not-a-member";
        }
        if (/this content isn't available|konten ini tidak tersedia/.test(text)) {
          return "unavailable";
        }
        return "";
      })
      .catch(() => "");
    await log(
      `â­ï¸  ${groupLabel} â†’ write button tidak ditemukan` +
        (blockedReason ? ` (${blockedReason})` : "") +
        `, skip`
    );
    return { page, success: false, status: "UNKNOWN" };
  }

  await humanClick(page, writeButton);
  await randomDelay(2000, 4000);

  // Cari editor teks DI DALAM dialog. Tanpa scope dialog, selector bisa
  // menangkap kotak komentar di feed (caption masuk ke sana → post gambar saja).
  const editorSelectors = [
    'div[role="dialog"] div[contenteditable="true"][role="textbox"]',
    'div[role="dialog"] div[contenteditable="true"][data-lexical-editor="true"]',
    'div[role="dialog"] div[contenteditable="true"]',
  ];

  let editor = null;
  for (const sel of editorSelectors) {
    try {
      editor = await page.waitForSelector(sel, { timeout: WAIT_TIMEOUT });
      if (editor) {
        await log(`âœ… ${groupLabel} â†’ editor ditemukan`);
        break;
      }
    } catch {}
  }

  // Fallback terakhir: cari via page.$ per selector
  if (!editor) {
    for (const sel of editorSelectors) {
      try {
        editor = await page.$(sel);
        if (editor) break;
      } catch {}
    }
  }

  // Fallback terakhir: cari via XPath yang lebih fleksibel
  if (!editor) {
    try {
      const xpath = "xpath///*[@role='dialog']//div[@contenteditable='true' and @role='textbox']";
      const elements = await page.$$(xpath);
      if (elements.length > 0) {
        editor = elements[0];
        await log(`âœ… ${groupLabel} â†’ editor ditemukan via XPath fallback`);
      }
    } catch {}
  }

  if (!editor) {
    await log(`âŒ ${groupLabel} â†’ editor tidak ditemukan, skip`);
    return { page, success: false, status: "UNKNOWN" };
  }

  await humanClick(page, editor);
  await editor.focus();
  await randomDelay(400, 800);

  // ── Parse caption dan URL ─────────────────────────────────────────────────
  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const urlMatches = postContent.match(urlRegex) || [];
  const firstUrl = urlMatches[0] || null;
  const captionOnly = postContent
    .replace(urlRegex, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  const captionProbe = normalizeUiText(captionOnly).slice(0, 40);

  // Ketik caption seperti manusia (delay variatif, pause antar kata).
  if (captionOnly.length > 0) {
    await typeHumanLike(page, captionOnly);
    await randomDelay(600, 1400);

    // Fokus bisa lepas / FB bisa mengganti editor: ketik ulang sekali bila perlu.
    if (!(await readComposerText(page)).includes(captionProbe)) {
      await editor.focus();
      await typeHumanLike(page, captionOnly);
      await randomDelay(600, 1400);
    }
    if (!(await readComposerText(page)).includes(captionProbe)) {
      await log(`❌ ${groupLabel} → caption tidak masuk editor, tidak posting`);
      return { page, success: false, status: "UNKNOWN" };
    }
    await log(`✍️  ${groupLabel} → caption selesai (${captionOnly.length} chars)`);
  }

  // Sisipkan URL di baris baru, lalu pastikan benar-benar ada di editor.
  if (firstUrl) {
    await editor.evaluate((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      (el as HTMLElement).focus();
    });
    await page.keyboard.press("Enter");

    try {
      await page.evaluate((url: string) => {
        document.execCommand("insertText", false, url);
      }, firstUrl);
    } catch {}

    const urlProbe = normalizeUiText(firstUrl);
    if (!(await readComposerText(page)).includes(urlProbe)) {
      // Fallback: ketik per karakter (tidak bergantung fokus DOM).
      await typeHumanLike(page, firstUrl);
      await randomDelay(500, 1000);
    }
    if (!(await readComposerText(page)).includes(urlProbe)) {
      await log(`❌ ${groupLabel} → link tidak masuk editor, tidak posting`);
      return { page, success: false, status: "UNKNOWN" };
    }
    await log(`📋 ${groupLabel} → URL masuk editor`);

    // Tunggu Facebook generate link preview
    await log(`⏳ ${groupLabel} → menunggu link preview...`);
    await randomDelay(5000, 7000);
  }

  // â”€â”€ Upload gambar (jika ada) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (imagePaths.length > 0) {
    await log(`ðŸ–¼ï¸  ${groupLabel} â†’ upload ${imagePaths.length} gambar...`);
    const fileInput = (
      await page.evaluateHandle(() => {
        const scoped = Array.from(
          document.querySelectorAll('[role="dialog"] input[type="file"]')
        ) as HTMLInputElement[];
        const inputs = scoped.length
          ? scoped
          : (Array.from(
              document.querySelectorAll('input[type="file"]')
            ) as HTMLInputElement[]);

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
      await log(`âœ… ${groupLabel} â†’ gambar terupload`);
      await randomDelay(5000, 7000);
    } else {
      await log(`âš ï¸  ${groupLabel} â†’ file input tidak ditemukan, skip upload gambar`);
    }
  }

  // Guard terakhir: jangan pernah klik Post kalau caption tidak ada di composer
  // (mencegah posting gambar saja tanpa caption/link).
  if (captionProbe && !(await readComposerText(page)).includes(captionProbe)) {
    await log(`❌ ${groupLabel} → caption hilang dari composer, tidak posting`);
    return { page, success: false, status: "UNKNOWN" };
  }

  // â”€â”€ Klik tombol Post / Posting / Kirim â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  await randomDelay(1500, 2500);

  const postButtonSelectors = [
    '[role="dialog"] div[aria-label="Posting"][role="button"]',
    '[role="dialog"] div[aria-label="Post"][role="button"]',
    '[role="dialog"] div[aria-label="Kirim"][role="button"]',
    '[role="dialog"] div[aria-label="Publish"][role="button"]',
    '[role="dialog"] button[aria-label="Posting"]',
    '[role="dialog"] button[aria-label="Post"]',
    '[role="dialog"] button[aria-label="Kirim"]',
    '[role="dialog"] button[aria-label="Publish"]',
  ];
  const postButtonXPaths = [
    '//*[@role="dialog"]//div[@role="button" and .//span[normalize-space()="Posting"]]',
    '//*[@role="dialog"]//div[@role="button" and .//span[normalize-space()="Post"]]',
    '//*[@role="dialog"]//div[@role="button" and .//span[normalize-space()="Kirim"]]',
    '//*[@role="dialog"]//div[@role="button" and .//span[normalize-space()="Publish"]]',
    '//*[@role="dialog"]//button[.//span[normalize-space()="Posting"]]',
    '//*[@role="dialog"]//button[.//span[normalize-space()="Post"]]',
    '//*[@role="dialog"]//button[.//span[normalize-space()="Kirim"]]',
    '//*[@role="dialog"]//button[.//span[normalize-space()="Publish"]]',
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
    await log(`âŒ ${groupLabel} â†’ tombol Post tidak ditemukan`);
    return { page, success: false, status: "UNKNOWN" };
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
    await log(`âš ï¸ ${groupLabel} â†’ tombol Post tetap disabled setelah menunggu`);
    return { page, success: false, status: "UNKNOWN" };
  }

  // Hover sejenak seperti membaca ulang, lalu klik.
  await humanClick(page, postButton);
  await log(`ðŸ“¤ ${groupLabel} â†’ Post diklik!`);

  // Cek segera apakah Facebook menampilkan peringatan pembatasan posting.
  // Jika iya, jangan retry grup ini karena retry justru berisiko memperparah limit.
  await randomDelay(1000, 2000);
  if (await detectFacebookPostingRestriction(page, groupLabel)) {
    return { page, success: false, status: "LIMITED" };
  }

  const { status: postStatus, submitted } = await detectPostingResult(
    page,
    groupLabel,
    postContent
  );

  if (postStatus === "LIMITED") {
    await log(`ðŸ›‘ ${groupLabel} â†’ proses dihentikan karena LIMIT.`);
    return { page, success: false, status: "LIMITED" };
  }

  if (postStatus === "PENDING_APPROVAL") {
    await log(`ðŸŸ¡ ${groupLabel} â†’ posting diterima tetapi menunggu approval admin.`);
    return { page, success: true, status: "PENDING_APPROVAL" };
  }

  if (postStatus === "POSTING_OK") {
    await log(`âœ… ${groupLabel} â†’ posting langsung tayang terverifikasi.`);
    return { page, success: true, status: "POSTING_OK" };
  }

  if (postStatus === "ERROR") {
    await log(`âŒ ${groupLabel} â†’ Facebook melaporkan posting gagal.`);
    return { page, success: false, status: "ERROR" };
  }

  // Composer tertutup tapi belum ada bukti caption. Jangan langsung retry
  // (bisa dobel) dan jangan langsung skip (bisa terlewat). Reload feed grup
  // sekali: kalau post sudah tampil / masuk pending approval, selesai;
  // kalau tidak ada bukti, izinkan retry.
  if (submitted) {
    await log(`ðŸ”Ž ${groupLabel} â†’ composer tertutup, cek ulang feed sebelum retry...`);
    page = await safeGoto(browser, page, groupLink);
    await randomDelay(4000, 6000);

    if (await detectPendingApprovalNotice(page)) {
      await log(`ðŸŸ¡ ${groupLabel} â†’ menunggu persetujuan admin â€” dianggap terkirim (tidak retry).`);
      return { page, success: true, status: "PENDING_APPROVAL" };
    }

    const verify = await detectPostingResult(page, groupLabel, postContent);
    if (verify.status === "POSTING_OK") {
      await log(`âœ… ${groupLabel} â†’ terverifikasi setelah reload.`);
      return { page, success: true, status: "POSTING_OK" };
    }
    if (verify.status === "PENDING_APPROVAL") {
      return { page, success: true, status: "PENDING_APPROVAL" };
    }
    if (verify.status === "LIMITED") {
      return { page, success: false, status: "LIMITED" };
    }
    await log(`âš ï¸ ${groupLabel} â†’ belum ada bukti post setelah reload; retry diizinkan.`);
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
  let highestDir = 0;
  try {
    const entries = await fs.readdir(CONTENT_DIR, { withFileTypes: true });
    const batches = entries
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => Number(entry.name))
      .filter((n) => Number.isInteger(n) && n > 0);

    highestDir = batches.length ? Math.max(...batches) : 0;
  } catch {}

  // Batch baru bisa ditambahkan lewat dashboard tanpa menunggu config akun.
  // Config tetap dihormati bila lebih tinggi (mis. override manual).
  return Math.max(config.totalBatches ?? 0, highestDir);
}

// â”€â”€â”€ Group Pool (collect / join) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Ambil link grup yang SUDAH di-join akun ini (halaman /groups/joins/).
async function collectGroupLinks(page: Page): Promise<string[]> {
  await log("ðŸ“‹ Mengumpulkan group links...");

  try {
    await page.goto(
      "https://web.facebook.com/groups/joins/?nav_source=tab",
      {
        waitUntil: "domcontentloaded", // lebih cepat dari networkidle2
        timeout: NAV_TIMEOUT,
      }
    );
  } catch (err) {
    await log(`âš ï¸  Timeout ke halaman groups, coba lanjutkan... (${err})`);
  }

  // Tunggu konten muncul
  await randomDelay(3000, 5000);
  await page.waitForSelector('div[role="listitem"]', { timeout: 15000 }).catch(() => {
    log("âš ï¸  listitem tidak terdeteksi, tetap lanjut scroll...");
  });

  // Scroll ke bawah untuk load semua grup. Evaluasi bisa gagal sesaat kalau
  // FB sedang navigasi (execution context destroyed) â€” anggap selesai, jangan
  // sampai mematikan worker.
  await log("ðŸ“œ Scrolling untuk load semua grup...");
  const readHeight = async (): Promise<number | null> => {
    try {
      return (await page.evaluate("document.body.scrollHeight")) as number;
    } catch {
      return null;
    }
  };
  let lastHeight = await readHeight();
  let scrollAttempts = 0;
  while (scrollAttempts < 20) {
    try {
      await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
    } catch {
      break;
    }
    await randomDelay(2000, 3000);
    const newHeight = await readHeight();
    if (newHeight === null) break;
    if (lastHeight !== null && newHeight === lastHeight) break;
    lastHeight = newHeight;
    scrollAttempts++;
    await log(`   Scroll ${scrollAttempts}: height=${newHeight}`);
  }

  // Screenshot untuk debug
  await page.screenshot({ path: DEBUG_SCREENSHOT, fullPage: false }).catch(() => {});
  await log(`ðŸ“¸ Screenshot disimpan: ${DEBUG_SCREENSHOT}`);

  // Ekstrak semua link grup (retry sebentar kalau halaman masih berpindah).
  const extractGroupLinks = () =>
    page.evaluate(() => {
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

  let groupLinks: string[] = [];
  for (let attempt = 1; ; attempt++) {
    try {
      groupLinks = await extractGroupLinks();
      break;
    } catch (err) {
      if (attempt >= 3) throw err;
      await log(
        `âš ï¸  Gagal membaca daftar grup (attempt ${attempt}/3): ${String(err).split("\n")[0]}`
      );
      await randomDelay(2000, 3000);
    }
  }

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

  await log(`ðŸ“Š Ditemukan ${groupLinks.length} grup`);
  return groupLinks;
}

async function readPool(): Promise<string[]> {
  const raw = await fs.readFile(POOL_FILE, "utf-8").catch(() => "");
  return [
    ...new Set(
      raw
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
    ),
  ];
}

async function collectGroupsToPool(page: Page): Promise<void> {
  const links = await collectGroupLinks(page);
  if (!links.length) {
    await log("âŒ Tidak ada grup ditemukan di akun ini â€” groups-pool.txt tidak diubah.");
    return;
  }
  const pool = await readPool();
  const set = new Set(pool);
  let added = 0;
  for (const link of links) {
    if (!set.has(link)) {
      set.add(link);
      added++;
    }
  }
  await fs.writeFile(POOL_FILE, [...set].join("\n") + "\n", "utf-8");
  await log(
    `ðŸ§² ${links.length} grup dari akun ini, ${added} baru â†’ total ${set.size} di groups-pool.txt`
  );
}

interface JoinProgress {
  accountId: string;
  index: number;
  joined: string[];
  failed: string[];
  timestamp: string;
}

async function loadJoinProgress(): Promise<JoinProgress> {
  const raw = await fs.readFile(JOIN_PROGRESS_FILE, "utf-8").catch(() => "");
  const parsed = raw ? parseJsonSafe<JoinProgress>(raw) : null;
  if (!parsed || parsed.accountId !== ACCOUNT_ID) {
    return { accountId: ACCOUNT_ID, index: 0, joined: [], failed: [], timestamp: "" };
  }
  parsed.joined ??= [];
  parsed.failed ??= [];
  parsed.index = Number.isInteger(parsed.index) ? parsed.index : 0;
  return parsed;
}

async function saveJoinProgress(p: JoinProgress): Promise<void> {
  p.timestamp = new Date().toISOString();
  await fs.writeFile(JOIN_PROGRESS_FILE, JSON.stringify(p, null, 2));
}

type JoinOutcome =
  | "joined"
  | "pending"
  | "already"
  | "manual"
  | "not-found"
  | "blocked"
  | "login"
  | "error";

// Kata yang menandakan akun kena limit/checkpoint saat join. Sengaja kuat
// supaya grup yang sekadar tidak tersedia tidak memicu stop.
const JOIN_BLOCK_KEYWORDS = [
  ...LIMITED_KEYWORDS,
  "checkpoint",
  "confirm your identity",
  "verifikasi identitas",
  "security check",
  "suspicious activity",
  "aktivitas mencurigakan",
  "too many requests",
  "you're blocked",
  "anda diblokir",
  "kamu diblokir",
  "batas permintaan",
];

const JOIN_MEMBERSHIP_QUESTIONS_RE =
  /membership questions|answer questions|questions to join|pertanyaan keanggotaan|jawab pertanyaan|pertanyaan untuk bergabung/i;

const JOIN_CONFIRM_PENDING_RE =
  /request to join (?:was )?sent|request sent|permintaan bergabung (?:telah )?dikirim|permintaan dikirim|waiting for admin approval|menunggu persetujuan admin/i;

const JOIN_CONFIRM_JOINED_RE =
  /you(?:'|â€™)re now a member|you are now a member|now a member of|sekarang menjadi anggota|berhasil bergabung|you joined/i;

async function joinBodyText(page: Page): Promise<string> {
  return page
    .evaluate(() => document.body?.innerText || "")
    .then(normalizeUiText)
    .catch(() => "");
}

async function isJoinLoginPage(page: Page): Promise<boolean> {
  if (page.url().toLowerCase().includes("/login")) return true;
  return page
    .evaluate(
      () =>
        !!(
          document.querySelector('input[name="email"]') ||
          document.querySelector('input[name="pass"]')
        )
    )
    .catch(() => false);
}

async function detectJoinBlocker(page: Page): Promise<string | null> {
  if (page.url().toLowerCase().includes("/checkpoint")) return "redirect checkpoint";
  const text = await joinBodyText(page);
  return JOIN_BLOCK_KEYWORDS.find((k) => text.includes(k)) ?? null;
}

// Baca tombol aksi utama grup (yang paling atas di halaman, bukan tombol
// "Join" milik grup rekomendasi di bawah). click=true â†’ klik tombol Join.
async function inspectJoinAction(
  page: Page,
  click: boolean
): Promise<{ state: "join" | "pending" | "member" | "none"; clicked: boolean }> {
  const target = await page.evaluate((doClick) => {
    const norm = (value: string | null) =>
      (value || "").replace(/\s+/g, " ").trim();
    const joinRe = /^(join group|join|gabung grup|gabung ke grup|gabung|minta bergabung|minta ikut|ikut grup)$/i;
    const pendingRe = /^(cancel request|batalkan permintaan|requested|diminta|permintaan terkirim|permintaan bergabung terkirim)$/i;
    // "Bergabung" = sudah member (dropdown berisi "Keluar dari grup").
    // Tombol join untuk non-member berlabel "Gabung ke grup".
    const memberRe = /^(joined|joined group|leave group|keluar dari grup|keluar grup|bergabung)$/i;

    const candidates: {
      el: HTMLElement;
      state: "join" | "pending" | "member";
      top: number;
    }[] = [];

    for (const el of Array.from(
      document.querySelectorAll<HTMLElement>(
        'div[role="button"], button, a[role="button"], [role="button"]'
      )
    )) {
      const rect = el.getBoundingClientRect();
      const style = window.getComputedStyle(el);
      if (
        rect.width <= 0 ||
        rect.height <= 0 ||
        style.visibility === "hidden" ||
        style.display === "none"
      ) {
        continue;
      }

      let state: "join" | "pending" | "member" | null = null;
      for (const raw of [norm(el.innerText), norm(el.getAttribute("aria-label"))]) {
        if (!raw) continue;
        if (joinRe.test(raw)) { state = "join"; break; }
        if (pendingRe.test(raw)) { state = "pending"; break; }
        if (memberRe.test(raw)) { state = "member"; break; }
      }
      if (state) candidates.push({ el, state, top: rect.top });
    }

    if (!candidates.length) {
      return { state: "none" as const, clicked: false, x: null, y: null };
    }
    candidates.sort((a, b) => a.top - b.top);
    const best = candidates[0];
    if (best.state === "join" && doClick) {
      best.el.scrollIntoView({ block: "center" });
      const rect = best.el.getBoundingClientRect();
      return {
        state: best.state,
        clicked: false,
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
      };
    }
    return { state: best.state, clicked: false, x: null, y: null };
  }, click);

  // Klik lewat mouse asli. FB mengabaikan el.click() (DOM synthetic) pada
  // tombol join, jadi harus pointerdown/up seperti manusia.
  if (click && target.state === "join" && target.x !== null && target.y !== null) {
    await page.mouse.move(target.x, target.y, { steps: 5 });
    await page.mouse.down();
    await new Promise((resolve) => setTimeout(resolve, 120));
    await page.mouse.up();
    return { state: "join", clicked: true };
  }
  return { state: target.state, clicked: false };
}

async function joinActionLabels(page: Page): Promise<string[]> {
  return page
    .evaluate(() =>
      Array.from(
        document.querySelectorAll<HTMLElement>(
          'div[role="button"], button, a[role="button"], [role="button"]'
        )
      )
        .map((el) =>
          (el.innerText || el.getAttribute("aria-label") || "")
            .replace(/\s+/g, " ")
            .trim()
        )
        .filter(Boolean)
        .slice(0, 12)
    )
    .catch(() => []);
}

// Join satu grup. Aman-gagal: tombol tidak ketemu / butuh jawab pertanyaan
// (manual) / halaman error â†’ dicatat, lanjut grup berikutnya. Limit/checkpoint
// atau login hilang â†’ return khusus supaya pemanggil berhenti, bukan memaksa.
async function joinGroup(
  browser: Browser,
  page: Page,
  link: string
): Promise<{ page: Page; result: JoinOutcome }> {
  try {
    page = await safeGoto(browser, page, link);
    await randomDelay(2500, 4500);

    if (await isJoinLoginPage(page)) {
      await log("ðŸ” Halaman login muncul saat join â€” sesi Facebook hilang.");
      return { page, result: "login" };
    }

    const blocked = await detectJoinBlocker(page);
    if (blocked) {
      await log(`ðŸ›‘ Indikasi limit/checkpoint saat join: "${blocked}"`);
      return { page, result: "blocked" };
    }

    const before = await inspectJoinAction(page, true);
    if (before.state === "member") return { page, result: "already" };
    if (before.state === "pending") return { page, result: "pending" };
    if (before.state === "none") {
      const text = await joinBodyText(page);
      if (JOIN_CONFIRM_JOINED_RE.test(text)) return { page, result: "already" };
      if (JOIN_CONFIRM_PENDING_RE.test(text)) return { page, result: "pending" };
      await log(
        `   Tombol Join tidak ditemukan (label: ${(await joinActionLabels(page)).slice(0, 6).join(" | ") || "-"})`
      );
      return { page, result: "not-found" };
    }

    if (!before.clicked) {
      await log("   Tombol Join ditemukan tetapi tidak bisa diklik.");
      return { page, result: "error" };
    }

    // Tunggu perubahan status tombol / konfirmasi / dialog pertanyaan.
    for (let attempt = 0; attempt < 8; attempt++) {
      await randomDelay(1200, 1800);

      if (JOIN_MEMBERSHIP_QUESTIONS_RE.test(await joinBodyText(page))) {
        return { page, result: "manual" };
      }

      const blockedAfter = await detectJoinBlocker(page);
      if (blockedAfter) {
        await log(`ðŸ›‘ Indikasi limit/checkpoint setelah klik Join: "${blockedAfter}"`);
        return { page, result: "blocked" };
      }

      const after = await inspectJoinAction(page, false);
      if (after.state === "pending") return { page, result: "pending" };
      if (after.state === "member") return { page, result: "joined" };

      const text = await joinBodyText(page);
      if (JOIN_CONFIRM_PENDING_RE.test(text)) return { page, result: "pending" };
      if (JOIN_CONFIRM_JOINED_RE.test(text)) return { page, result: "joined" };
    }

    await log(
      `   Status join tidak berubah (label: ${(await joinActionLabels(page)).slice(0, 6).join(" | ") || "-"})`
    );
    return { page, result: "error" };
  } catch (err) {
    await log(`âš ï¸ Join error ${link}: ${err}`);
    return { page, result: "error" };
  }
}

// Batas kegagalan berturut-turut; kalau UI FB berubah total / akun bermasalah,
// lebih aman berhenti daripada menandai semua grup gagal.
const MAX_CONSECUTIVE_JOIN_FAILURES = Number(
  process.env.MAX_CONSECUTIVE_JOIN_FAILURES || "5"
);

async function joinGroupsFromPool(browser: Browser, page: Page): Promise<void> {
  const pool = await readPool();
  if (!pool.length) {
    await log("âŒ groups-pool.txt kosong â€” jalankan mode collect dulu.");
    return;
  }

  const progress = await loadJoinProgress();
  if (progress.index >= pool.length) {
    await log(
      `âœ… Semua ${pool.length} grup sudah diproses (${progress.joined.length} ok, ${progress.failed.length} gagal). ` +
        `Gunakan Reset Join untuk mengulang dari grup 1.`
    );
    return;
  }

  if (progress.index > 0) {
    await log(`â–¶ï¸ Lanjut join dari grup ke-${progress.index + 1}/${pool.length}`);
  }
  await log(`âž• Join ${pool.length - progress.index} grup dari groups-pool.txt`);
  await log("Mulai join dalam 3 detik...");

  let joined = 0;
  let pending = 0;
  let already = 0;
  let failed = 0;
  let consecutiveFailures = 0;

  for (let i = progress.index; i < pool.length; i++) {
    if (await stopRequested()) {
      await saveJoinProgress(progress);
      await log(`â¹ STOP diminta â†’ join berhenti di grup ke-${i + 1}/${pool.length}`);
      return;
    }

    const link = pool[i];
    const label = `[${i + 1}/${pool.length}]`;
    await log(`\n${label} â†’ ${link}`);
    const outcome = await joinGroup(browser, page, link);
    page = outcome.page;

    // Limit/checkpoint/login = kondisi akun, bukan grup. Jangan tandai gagal
    // dan jangan maju index supaya grup ini dicoba lagi setelah pulih.
    if (outcome.result === "blocked" || outcome.result === "login") {
      await saveJoinProgress(progress);
      await log(
        `ðŸ›‘ JOIN STOP: ${outcome.result === "blocked" ? "akun terindikasi limit/checkpoint" : "sesi login hilang"} ` +
          `pada grup ke-${i + 1}/${pool.length}. Progress tidak dimajukan.`
      );
      return;
    }

    if (outcome.result === "joined" || outcome.result === "pending" || outcome.result === "already") {
      progress.joined = [...new Set([...progress.joined, link])];
      consecutiveFailures = 0;
      if (outcome.result === "joined") joined++;
      else if (outcome.result === "pending") pending++;
      else already++;
      await log(
        outcome.result === "already"
          ? `${label} sudah member â€” dilewati.`
          : outcome.result === "pending"
            ? `${label} permintaan join terkirim (menunggu approval).`
            : `${label} JOIN OK.`
      );
    } else {
      progress.failed = [...new Set([...progress.failed, link])];
      failed++;
      consecutiveFailures++;
      await log(`${label} GAGAL (${outcome.result}).`);
    }

    progress.index = i + 1;
    await saveJoinProgress(progress);

    if (consecutiveFailures >= MAX_CONSECUTIVE_JOIN_FAILURES) {
      await log(
        `ðŸ›‘ JOIN STOP: ${consecutiveFailures} grup gagal berturut-turut â€” kemungkinan UI berubah / akun bermasalah.`
      );
      return;
    }

    if (i < pool.length - 1) {
      const delay = randomBetween(15000, 30000);
      await log(`â±ï¸ Delay antar join: ${(delay / 1000).toFixed(0)}s...`);
      if (await waitWithStopCheck(delay)) {
        await saveJoinProgress(progress);
        await log(`â¹ STOP diminta â†’ join berhenti di grup ke-${i + 2}/${pool.length}`);
        return;
      }
    }
  }

  await log(
    `âœ… Selesai join: ${joined} join, ${pending} pending, ${already} sudah member, ${failed} gagal ` +
      `â€” ${progress.index}/${pool.length} diproses (total tersimpan: ${progress.joined.length} ok, ${progress.failed.length} gagal).`
  );
}

// â”€â”€â”€ Main â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function main(): Promise<void> {
  await fs.mkdir(ACCOUNT_DIR, { recursive: true });
  // Hapus stop.request sisa run lama saja; STOP yang masuk setelah spawn
  // (mtime >= LAUNCH_AT) harus tetap dihormati.
  try {
    const stopStat = await fs.stat(STOP_FILE);
    if (stopStat.mtimeMs < LAUNCH_AT) await fs.rm(STOP_FILE, { force: true });
  } catch {}
  const accountConfig = await loadAccountConfig();
  let totalBatches = await detectTotalBatches(accountConfig);

  if (totalBatches === 0 && !COLLECT_MODE && !JOIN_MODE) {
    await log(`âŒ Tidak ada batch di ${CONTENT_DIR}`);
    await log(`   Buat folder seperti accounts/${ACCOUNT_ID}/content/1/`);
    return;
  }

  await log("â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•");
  await log(`ðŸš€ Facebook Group Auto-Poster â€” ${accountConfig.name || ACCOUNT_ID}`);
  await log(`ðŸ‘¤ Account ID: ${ACCOUNT_ID}`);
  await log(`ðŸ“¦ Total batch: ${totalBatches}`);
  await log("â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•");

  // â”€â”€ Auto-resume â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Tidak ada lagi menu mode 1/2/3.
  // Setiap start selalu membaca progress terakhir.
  // Override manual: RUN_BATCH/RUN_GROUP (atau argv ke-4/5) memaksa mulai dari
  // batch/grup tertentu, mis. test batch konten tertentu: npm start -- fb07 "" 3 0
  let startBatch = 1;
  let startGroupIdx = 0;

  const savedProgress = COLLECT_MODE || JOIN_MODE ? null : await loadProgress();

  if (RUN_BATCH > 0 || RUN_GROUP > 0) {
    startBatch = Math.max(1, RUN_BATCH || savedProgress?.batch || 1);
    startGroupIdx = Math.max(0, (RUN_GROUP || 1) - 1 || savedProgress?.groupIdx || 0);
    await log(
      `ðŸŽ¯ Override manual: batch ${startBatch}, group berikutnya ke-${startGroupIdx + 1}`
    );
  } else if (savedProgress) {
    startBatch = Math.max(1, savedProgress.batch);
    startGroupIdx = Math.max(0, savedProgress.groupIdx);

    await log(
      `â–¶ï¸  Auto-resume: batch ${startBatch}, group berikutnya ke-${startGroupIdx + 1}`
    );
  } else if (!COLLECT_MODE && !JOIN_MODE) {
    await resetPostingStats();
    await log("â–¶ï¸  Belum ada progress â†’ mulai dari batch 1, group 1");
  }

  // Akun RANDOM_START_ACCOUNTS: titik mulai diacak setiap start (menimpa resume).
  // Override manual RUN_BATCH/RUN_GROUP tetap dihormati.
  if (
    !COLLECT_MODE &&
    !JOIN_MODE &&
    !ONE_POST_MODE &&
    !(RUN_BATCH > 0 || RUN_GROUP > 0) &&
    RANDOM_START_ACCOUNTS.test(ACCOUNT_ID)
  ) {
    startBatch = Math.floor(Math.random() * totalBatches) + 1;
    startGroupIdx = 0;
    await log(
      `🎲 Titik mulai diacak â†’ batch ${startBatch}/${totalBatches}, group 1`
    );
  }

  // Progress sentinel (totalBatches + 1) = semua batch sudah pernah selesai.
  // Keluar sebelum launch Chrome; batch berikutnya otomatis diproses saat
  // dashboard menambah konten baru (nomor batch mengikuti sentinel ini).
  if (
    !COLLECT_MODE &&
    !JOIN_MODE &&
    !(RUN_BATCH > 0 || RUN_GROUP > 0) &&
    startBatch > totalBatches
  ) {
    await log(
      `ðŸŽ‰ Semua batch selesai (${totalBatches} batch). Menunggu konten berikutnya.`
    );
    return;
  }

  // â”€â”€ Launch browser â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // userDataDir membuat browser profile PERSISTENT khusus untuk akun ini.
  // Jangan gunakan profile yang sama untuk dua account secara bersamaan.
  // Window size deterministik per akun (variasi kecil, bukan selalu sama).
  const accountSeed = ACCOUNT_ID.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
  const windowSizes = [
    [1366, 768],
    [1440, 900],
    [1536, 864],
    [1600, 900],
  ];
  const [winW, winH] = windowSizes[accountSeed % windowSizes.length];
  const browser = await puppeteer.launch({
    headless: false,
    userDataDir: BROWSER_PROFILE_DIR,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      `--window-size=${winW},${winH}`,
      `--lang=id-ID`,
      // Anti-automation: hilangkan sinyal "bot" supaya FB lebih jarang
      // checkpoint/logout yang mematikan sesi.
      "--disable-blink-features=AutomationControlled",
      "--enable-features=AsyncClipboardAPI",
    ],
    ignoreDefaultArgs: ["--enable-automation"],
    defaultViewport: null,
  });

  // Pakai tab awal Chrome (jangan buka tab kedua): newPage() tepat setelah
  // launch kadang menghasilkan frame detached yang mematikan session init.
  const initialPages = await browser.pages();
  let page = initialPages[0] ?? (await browser.newPage());
  for (const extra of initialPages.slice(1)) {
    await extra.close().catch(() => {});
  }
  await configurePage(browser, page);

  browser.on("disconnected", () => {
    void log("ðŸ”Œ Browser disconnected (normal saat selesai/stop; abnormal jika tiba-tiba saat posting).");
  });

  // Sesi: profil dulu, file hanya bootstrap â€” sekali login tahan lama.
  for (let attempt = 1; ; attempt++) {
    try {
      await ensureSessionReady(page);
      break;
    } catch (err) {
      if (attempt >= 2 || !isDetachedError(err)) throw err;
      await log(
        `âš ï¸ Session init gagal karena page detached â€” buat page baru lalu retry: ` +
          String((err as any)?.message ?? err).split("\n")[0]
      );
      page = await replacePage(browser, page);
    }
  }

  // â”€â”€ Mode khusus: kumpulkan grup / join grup â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  if (COLLECT_MODE) {
    await collectGroupsToPool(page);
    await browser.close();
    return;
  }
  if (JOIN_MODE) {
    await joinGroupsFromPool(browser, page);
    await browser.close();
    return;
  }

  // Mode uji 1 posting: paksa batch/group dari RUN_BATCH/RUN_GROUP (default 1/1),
  // posting TEPAT SATU kali lalu close — untuk deteksi limit per akun.
  if (ONE_POST_MODE) {
    const oneBatch = Math.max(1, RUN_BATCH || 1);
    const oneGroupIdx = Math.max(0, (RUN_GROUP || 1) - 1);
    await log("🧪 MODE 1/1: uji 1 posting lalu close (progress asli tidak disentuh).");

    let oneContent: ContentBatch;
    try {
      oneContent = await loadContentBatch(oneBatch);
    } catch (err) {
      await log(`❌ MODE 1/1: konten batch ${oneBatch} tidak tersedia: ${err}`);
      await browser.close();
      return;
    }

    // Group links dari pool (stabil & cepat) — fallback ke collect jika kosong.
    let oneLinks = await readPool();
    if (oneLinks.length === 0) {
      await log("🧪 MODE 1/1: groups-pool.txt kosong — collect dari akun...");
      oneLinks = await collectGroupLinks(page);
    }
    if (oneLinks.length === 0) {
      await log("❌ MODE 1/1: tidak ada grup tersedia.");
      await browser.close();
      return;
    }

    const oneLink = oneLinks[oneGroupIdx % oneLinks.length];
    const oneLabel = `[ONE B${oneBatch} G${oneGroupIdx + 1}]`;
    await log(`🧪 MODE 1/1 → ${oneLink}`);

    if (await detectFacebookPostingRestriction(page, oneLabel)) {
      await recordPostingResult("LIMITED");
      await log("🚫 HASIL 1/1: LIMIT terdeteksi SEBELUM posting.");
      await logPostingSummary();
      await browser.close();
      return;
    }

    const oneGen = await generateCaption(oneContent.postContent, {
      accountId: ACCOUNT_ID,
      batch: oneBatch,
      groupIndex: oneGroupIdx,
    });

    try {
      const result = await postToGroup(
        browser,
        page,
        oneLink,
        oneGen.text,
        oneContent.imagePaths,
        oneLabel
      );
      await recordPostingResult(result.status ?? "UNKNOWN");
      if (result.status === "LIMITED") {
        await log("🚫 HASIL 1/1: LIMIT terdeteksi saat posting.");
      } else if (result.status === "POSTING_OK" || result.status === "PENDING_APPROVAL") {
        await log(`✅ HASIL 1/1: posting sukses (${result.status}) — akun belum limit.`);
      } else {
        await log(`⚠️ HASIL 1/1: status ${result.status} — limit tidak terkonfirmasi.`);
      }
    } catch (err) {
      await log(`❌ MODE 1/1: error posting: ${err}`);
      await log("⚠️ HASIL 1/1: error — limit tidak terkonfirmasi.");
    }

    await logPostingSummary();
    await browser.close();
    return;
  }

  // â”€â”€ Kumpulkan semua group links sekali di awal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const groupLinks = await collectGroupLinks(page);

  if (groupLinks.length === 0) {
    await log(
      "âŒ Tidak ada grup ditemukan!\n" +
        "   â†’ Cek debug-groups-page.png\n" +
        "   â†’ Pastikan cookie.txt sudah benar dan tidak expired\n" +
        "   â†’ Pastikan akun sudah join minimal 1 grup"
    );
    await browser.close();
    return;
  }

  // Tampilkan ringkasan sebelum mulai
  await log(`\nðŸ“£ Ringkasan:`);
  await log(`   â€¢ Batch: ${startBatch} â†’ ${totalBatches}`);
  await log(`   â€¢ Grup per batch: ${groupLinks.length}`);
  await log(`   â€¢ Mulai dari group index: ${startGroupIdx}`);
  await log(`   â€¢ Delay antar post: ${(POST_DELAY_MIN_MS / 1000).toFixed(0)}â€“${(POST_DELAY_MAX_MS / 1000).toFixed(0)} detik`);
  await log(`   â€¢ Retry per grup: maksimal ${MAX_POST_ATTEMPTS} kali`);
     await log(`   â€¢ Delay antar batch: 45â€“90 detik`);
  await log(`   â€¢ Mulai dalam 3 detik...\n`);
  await randomDelay(3000, 3000);

  // â”€â”€ Loop batch utama â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Menghitung berapa banyak grup BERTURUT-TURUT yang gagal diposting (bukan LIMIT
  // terverifikasi). Reset ke 0 setiap kali ada grup yang berhasil.
  let consecutiveSkips = 0;
  // Posting sukses dalam sesi saat ini (reset setelah istirahat manusiawi).
  let postedInSession = 0;

  // Loop batch utama. Untuk RANDOM_START_ACCOUNTS siklus berulang: setelah
  // batch terakhir selesai kembali ke batch 1 (re-detect total batch supaya
  // konten baru dari dashboard langsung ikut di siklus berikutnya). Akun lain
  // keluar seperti dulu setelah semua batch selesai.
  const loopForever = RANDOM_START_ACCOUNTS.test(ACCOUNT_ID) && !COLLECT_MODE && !JOIN_MODE;
  let batch = startBatch;
  while (true) {
    if (batch > totalBatches) {
      if (!loopForever) break;
      totalBatches = await detectTotalBatches(accountConfig);
      await log(`\n🔁 Semua batch selesai â†’ kembali ke batch 1 (total: ${totalBatches})`);
      batch = 1;
      startGroupIdx = 0;
      const wrapDelay = randomBetween(5 * 60000, 15 * 60000);
      if (await waitWithStopCheck(wrapDelay)) {
        await saveProgress(1, 0);
        await log(`â¹ STOP diminta â†’ progress disimpan untuk batch 1, group 1`);
        await browser.close();
        return;
      }
    }
    {
    await log(`\n${"â•".repeat(50)}`);
    await log(`ðŸ—‚ï¸  BATCH ${batch}/${totalBatches}`);
    await log(`${"â•".repeat(50)}`);

    let content: ContentBatch;
    try {
      content = await loadContentBatch(batch);
    } catch (err) {
      await log(`â❌ Batch ${batch} tidak dapat diproses karena kontennya tidak tersedia: ${err}`);
      batch++; // jangan infinite-loop di batch tanpa konten
      continue;
    }

    // Untuk resume: hanya batch pertama yang mulai dari startGroupIdx
    const groupStart = batch === startBatch ? startGroupIdx : 0;

    for (let i = groupStart; i < groupLinks.length; i++) {
      if (await stopRequested()) {
        await saveProgress(batch, i);
        await log(`â¹ STOP diminta â†’ menyimpan progress B${batch} G${i + 1}`);
        await browser.close();
        return;
      }

      const link = groupLinks[i];
      if (!link) continue;

      const groupLabel = `[B${batch} G${i + 1}/${groupLinks.length}]`;
      await log(`\n${groupLabel} â†’ ${link}`);

      try {
        let completed = false;
        let lastStatus: PostingStatus | undefined;
        // Caption hasil generate untuk grup ini; null = belum digenerate.
        let groupCaption: string | null = null;

        // Jangan langsung skip jika selector/UI gagal.
        // Progress hanya maju jika posting mendapat hasil yang terverifikasi.
        for (let attempt = 1; attempt <= MAX_POST_ATTEMPTS; attempt++) {
          if (await stopRequested()) {
            await saveProgress(batch, i);
            await log(`â¹ STOP diminta â†’ menyimpan progress B${batch} G${i + 1}`);
            await browser.close();
            return;
          }

          await log(`ðŸ” ${groupLabel} â†’ percobaan ${attempt}/${MAX_POST_ATTEMPTS}`);

          // Jangan melakukan retry jika Facebook sudah memberi restriction.
          if (await detectFacebookPostingRestriction(page, groupLabel)) {
            await log(
              `ðŸ›‘ ${groupLabel} â†’ proses dihentikan sebelum retry karena Facebook membatasi aktivitas posting.`
            );
            await recordPostingResult("LIMITED");
            await saveProgress(batch, i);
            await browser.close();
            return;
          }

          // Caption unik per posting: digenerate sekali per grup (retry memakai
          // caption yang sama supaya verifikasi tidak berubah).
          if (!groupCaption) {
            const gen = await generateCaption(content.postContent, {
              accountId: ACCOUNT_ID,
              batch,
              groupIndex: i,
            });
            groupCaption = gen.text;
            await log(
              `âœï¸ ${groupLabel} â†’ caption baru (${gen.source}, ${gen.text.length} chars): ${gen.text.slice(0, 60).replace(/\n/g, " ")}...`
            );
          }

          try {
            const result = await postToGroup(
              browser,
              page,
              link,
              groupCaption,
              content.imagePaths,
              groupLabel
            );
            page = result.page;
            lastStatus = result.status;

            if (result.status === "LIMITED") {
              await recordPostingResult("LIMITED");
              await log(`\nðŸ›‘ STOP: Facebook mendeteksi pembatasan posting.`);
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
              await recordPostingResult(result.status);
              consecutiveSkips = 0; // grup berhasil â†’ reset penghitung skip berturut-turut
              postedInSession++;
              await saveProgress(batch, i + 1);
              await log(`ðŸ’¾ Progress: batch=${batch}, nextGroup=${i + 2} (sesi: ${postedInSession}/${HUMAN_SESSION_POSTS})`);
              await logPostingSummary();
              // 15 posting sukses per sesi â†’ istirahat manusiawi 1 jam.
              if (
                HUMAN_SESSION_POSTS > 0 &&
                postedInSession >= HUMAN_SESSION_POSTS
              ) {
                postedInSession = 0;
                if (await humanBreak(HUMAN_BREAK_MS)) {
                  await saveProgress(batch, i + 1);
                  await browser.close();
                  return;
                }
              }
              break;
            }

            // ERROR/UNKNOWN tidak dianggap selesai.
            // Grup yang sama dicoba ulang agar tidak terlewat.
            await log(
              `âš ï¸ ${groupLabel} â†’ status ${result.status || "UNKNOWN"}, ` +
              `belum dianggap selesai.`
            );

            if (attempt < MAX_POST_ATTEMPTS) {
              const retryDelay = randomBetween(30000, 90000);
              await log(
                `â³ ${groupLabel} â†’ retry dalam ${(retryDelay / 1000).toFixed(1)}s...`
              );

              if (await waitWithStopCheck(retryDelay)) {
                await saveProgress(batch, i);
                await log(`â¹ STOP diminta â†’ progress disimpan di B${batch} G${i + 1}`);
                await browser.close();
                return;
              }
            }
          } catch (err) {
            await log(`âŒ ${groupLabel} â†’ percobaan ${attempt} gagal: ${err}`);

            // Browser tertutup: retry/grup berikutnya pasti gagal instan.
            // Simpan posisi grup ini lalu keluar; dashboard akan restart.
            if (!browser.connected) {
              await saveProgress(batch, i);
              await log(`ðŸ›‘ Browser tertutup â€” berhenti di B${batch} G${i + 1}.`);
              return;
            }

            if (attempt < MAX_POST_ATTEMPTS) {
              const retryDelay = randomBetween(30000, 90000);
              await log(
                `â³ ${groupLabel} â†’ retry dalam ${(retryDelay / 1000).toFixed(1)}s...`
              );

              if (await waitWithStopCheck(retryDelay)) {
                await saveProgress(batch, i);
                await log(`â¹ STOP diminta â†’ progress disimpan di B${batch} G${i + 1}`);
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
          // BERIKUTNYA â€” tapi JANGAN loncat ke batch berikutnya. Progress disimpan
          // sebagai i+1 (grup ini dilewati), dan for-loop di bawah secara alami tetap
          // berada di batch yang sama sampai semua grup di batch ini diproses.
          consecutiveSkips++;
          await recordPostingResult(lastStatus ?? "UNKNOWN");
          await saveProgress(batch, i + 1);
          await log(
            `â­ï¸ ${groupLabel} â†’ GAGAL setelah ${MAX_POST_ATTEMPTS} percobaan (bukan limit). ` +
            `Grup ini DI-SKIP (${consecutiveSkips} gagal berturut-turut), lanjut ke grup berikutnya ` +
            `â€” batch ${batch} TIDAK dilanjutkan ke batch berikutnya sebelum semua grup selesai.`
          );

          if (
            MAX_CONSECUTIVE_SKIPS > 0 &&
            consecutiveSkips >= MAX_CONSECUTIVE_SKIPS
          ) {
            await log(
              `ðŸ›‘ STOP: ${consecutiveSkips} grup berturut-turut gagal diposting. ` +
              `Ini bisa jadi tanda limit yang tidak terdeteksi otomatis, jadi worker ` +
              `dihentikan sebagai safety-net. Progress tersimpan di B${batch} G${i + 2}. ` +
              `Cek akun secara manual sebelum resume (atau naikkan MAX_CONSECUTIVE_SKIPS).`
            );
            await browser.close();
            return;
          }

          const skipDelay = randomBetween(30000, 120000);
          await log(
            `â³ Jeda ${(skipDelay / 1000).toFixed(1)}s sebelum lanjut ke grup berikutnya...`
          );
          if (await waitWithStopCheck(skipDelay)) {
            await log(`â¹ STOP diminta â†’ progress disimpan di B${batch} G${i + 2}`);
            await browser.close();
            return;
          }

          continue; // lanjut ke grup berikutnya DI BATCH YANG SAMA
        }

        // Delay antar posting yang sudah berhasil diproses.
        const delay = randomBetween(POST_DELAY_MIN_MS, POST_DELAY_MAX_MS);
        await log(
          `â±ï¸ Delay antar posting: ${(delay / 1000).toFixed(1)}s...`
        );

        if (await waitWithStopCheck(delay)) {
          await saveProgress(batch, i + 1);
          await log(`â¹ STOP diminta â†’ progress disimpan di B${batch} G${i + 2}`);
          await browser.close();
          return;
        }
      } catch (err) {
        // Error tak terduga juga TIDAK memajukan progress.
        await log(`âŒ ${groupLabel} â†’ Error tidak terduga: ${err}`);
        await saveProgress(batch, i);
        await log(
          `â¸ï¸ ${groupLabel} â†’ progress tetap di grup ini agar tidak ter-skip.`
        );
        await browser.close();
        return;
      }
    }

    await log(`\nâœ… Batch ${batch} selesai`);

    // Delay antar batch (kecuali batch terakhir)
    if (batch < totalBatches) {
      const batchDelay = randomBetween(5 * 60000, 15 * 60000);
      await log(
        `â¸ï¸  Delay batch: ${(batchDelay / 1000).toFixed(0)}s sebelum batch ${batch + 1}...`
      );
      if (await waitWithStopCheck(batchDelay)) {
        await saveProgress(batch + 1, 0);
        await log(`â¹ STOP diminta â†’ progress disimpan untuk batch ${batch + 1}, group 1`);
        await browser.close();
        return;
      }
      startGroupIdx = 0; // reset untuk batch berikutnya
    }
    batch++;
  }
  }

  await log("\nðŸŽ‰ Semua batch selesai!");
  await logPostingSummary();
  // Simpan sentinel (bukan hapus progress) supaya start berikutnya tidak
  // memposting ulang dari batch 1. Batch baru akan memakai nomor sentinel ini.
  await saveProgress(totalBatches + 1, 0);
  await browser.close();
}

main().catch(async (err) => {
  await log(`ðŸ’¥ Fatal error: ${err}`);
  process.exit(1);
});