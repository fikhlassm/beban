import "dotenv/config";
import { Telegraf, Markup, Context } from "telegraf";
import { message } from "telegraf/filters";
import { spawn, ChildProcess } from "child_process";
import fs from "fs/promises";
import os from "os";
import path from "path";

const ROOT_DIR = path.resolve(process.cwd());
const ACCOUNTS_DIR = path.join(ROOT_DIR, "accounts");
const WORKER_SCRIPT = path.join(ROOT_DIR, "src", "facebook-multi-account-worker.ts");
const TSX_CLI = path.join(ROOT_DIR, "node_modules", "tsx", "dist", "cli.mjs");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN?.trim();
const ADMIN_IDS = new Set(
  (process.env.TELEGRAM_ADMIN_IDS ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
);

if (!BOT_TOKEN) throw new Error("TELEGRAM_BOT_TOKEN belum di-set di .env");
if (!ADMIN_IDS.size) throw new Error("TELEGRAM_ADMIN_IDS belum di-set di .env");

const bot = new Telegraf(BOT_TOKEN);
const workers = new Map<string, ChildProcess>();
// Mode worker yang berjalan: "" = auto-poster, "collect"/"join" = grup.
// Mode collect/join tidak boleh di-auto-restart saat exit.
const workerModes = new Map<string, string>();
// Akun yang sedang dihentikan secara sengaja lewat tombol/perintah STOP.
// Dipakai supaya notifikasi "worker berhenti" tidak salah label jadi "tak terduga".
const manualStops = new Set<string>();
// Restart terawasi yang diminta watchdog (hang) — exit berikutnya tetap di-restart.
const supervisedRestart = new Set<string>();
// Info sesi berjalan: waktu mulai + snapshot total posting saat START (untuk
// menghitung "N posting sesi ini").
const runInfo = new Map<string, { startedAt: number; startTotal: number }>();
// Timer auto-restart per akun + jumlah kegagalan beruntun (backoff).
const restartTimers = new Map<string, NodeJS.Timeout>();
const failCount = new Map<string, number>();
// Guard agar satu kejadian exit tidak diproses dua kali (listener "error"+ "exit").
const exitHandled = new Set<string>();
// Guard agar alert hang tidak berulang tiap interval untuk worker yang sama.
const hangAlerted = new Set<string>();
// Guard race: START yang ditekan cepat berulang tidak boleh spawn dua child.
const starting = new Set<string>();
const PAGE_SIZE = 10;
const BATCH_PAGE_SIZE = 10;
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const BATCH_STAGING_DIR = path.join(os.tmpdir(), "telegram-batch-staging");
// Draft tambah batch per chat admin.
type BatchDraft =
  | { step: "photo"; at: number }
  | { step: "caption"; file: string; ext: string; at: number };
const batchDrafts = new Map<number, BatchDraft>();
const BATCH_DRAFT_TTL_MS = 10 * 60 * 1000;
// Mutex sederhana: satu operasi tambah/hapus batch dalam satu waktu.
let batchMutation = false;
const periodicPageByChat = new Map<number, number>();
let shutdownStarted = false;
let periodicMessage: { chatId: number; messageId: number } | null = null;

// ─── Konstanta perilaku ──────────────────────────────────────────────────────
const START_ALL_STAGGER_MS = Number(process.env.START_ALL_STAGGER_MS || "30000");
const GRACEFUL_STOP_TIMEOUT_MS = Number(process.env.GRACEFUL_STOP_TIMEOUT_MS || "30000");
const RESTART_MAX_FAILURES = Number(process.env.RESTART_MAX_FAILURES || "3"); // maks auto-restart beruntun
const HANG_TOLERANCE_MS = Number(process.env.HANG_TOLERANCE_MS || String(15 * 60 * 1000)); // log diam = indikasi hang
const WATCHDOG_INTERVAL_MS = Number(process.env.WATCHDOG_INTERVAL_MS || String(5 * 60 * 1000));
const RUNTIME_KEEP_DAYS = 14;     // simpan riwayat durasi harian 14 hari
const SESSION_HEALTHY_MS = 10 * 60 * 1000; // sesi >10 menit = reset hitungan gagal

interface Progress {
  accountId: string;
  batch: number;
  groupIdx: number;
  timestamp: string;
}

interface Config {
  id?: string;
  name?: string;
  totalBatches?: number;
}

interface DailyStat {
  total: number;
  direct: number;
  pending: number;
  error: number;
  limited: number;
  unknown: number;
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
  daily?: Record<string, DailyStat>;
}

interface RuntimeState {
  lastStartedAt: number | null;       // epoch ms sesi berjalan, null = tidak berjalan
  daily: Record<string, number>;      // tanggal "YYYY-MM-DD" → durasi run (ms)
}

// Marker istirahat yang ditulis worker sebelum exit (accounts/<id>/break.json).
interface BreakInfo {
  until: string;
  batch: number;
  groupIdx: number;
  startedAt: string;
}

function breakFile(id: string): string {
  return path.join(ACCOUNTS_DIR, id, "break.json");
}

async function readBreak(id: string): Promise<BreakInfo | null> {
  return readJson<BreakInfo>(breakFile(id));
}

function breakUntilMs(info: BreakInfo | null): number {
  const ms = info ? Date.parse(info.until) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

async function clearBreak(id: string): Promise<void> {
  await fs.rm(breakFile(id), { force: true }).catch(() => {});
}

function fmtClock(ms: number): string {
  return new Date(ms).toLocaleTimeString("id-ID", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Jadwalkan wake dari istirahat; beri tahu admin bila start-nya gagal.
function scheduleBreakWake(id: string, until: number): void {
  restartTimers.set(
    id,
    setTimeout(() => {
      restartTimers.delete(id);
      void (async () => {
        const msg = await startWorker(id, false, "", true);
        console.log(msg);
        if (!workers.has(id) && !starting.has(id) && !restartTimers.has(id)) {
          await sendToAdmins(
            `<b>${esc(id)}</b> gagal lanjut setelah istirahat: ${esc(msg)}`
          );
        }
      })();
    }, Math.max(0, until - Date.now()))
  );
}

function isAdmin(id: number): boolean {
  return ADMIN_IDS.has(String(id));
}

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function stripEmoji(text: string): string {
  return text.replace(/\p{Extended_Pictographic}|\uFE0F|\u200D/gu, "");
}

function breakdownText(d: DailyStat | null | undefined): string {
  if (!d) return "";
  return [
    d.direct ? `ok ${d.direct}` : "",
    d.pending ? `pending ${d.pending}` : "",
    d.limited ? `limit ${d.limited}` : "",
    d.error ? `error ${d.error}` : "",
    d.unknown ? `unknown ${d.unknown}` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw.replace(/^\uFEFF/, "")) as T;
  } catch {
    return null;
  }
}

// ─── Waktu & durasi ──────────────────────────────────────────────────────────
// Tanggal lokal hari ini "YYYY-MM-DD" (mengikuti zona waktu komputer).
function todayKey(): string {
  return new Date().toLocaleDateString("sv-SE");
}

function fmtDuration(ms: number): string {
  const minutes = Math.floor(ms / 60000);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}j ${m}m` : `${m}m`;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─── Runtime per akun (accounts/<id>/runtime.json) ───────────────────────────
// File ini hanya ditulis dashboard (single writer). Mencatat kapan sesi terakhir
// dimulai + durasi run per hari, untuk tampilan "⏱" dan ringkasan harian.
function runtimeFile(id: string): string {
  return path.join(ACCOUNTS_DIR, id, "runtime.json");
}

async function readRuntime(id: string): Promise<RuntimeState> {
  const data = await readJson<RuntimeState>(runtimeFile(id));
  return {
    lastStartedAt: data?.lastStartedAt ?? null,
    daily: data?.daily ?? {},
  };
}

async function writeRuntime(id: string, rt: RuntimeState): Promise<void> {
  await fs.writeFile(runtimeFile(id), JSON.stringify(rt, null, 2)).catch(() => {});
}

function pruneDaily(map: Record<string, number>, keep: number): void {
  const keys = Object.keys(map).sort();
  while (keys.length > keep) delete map[keys.shift() as string];
}

// Dashboard bisa mati mendadak sehingga sesi lama tidak sempat di-flush. Tutup
// sesi itu memakai waktu tulis log terakhir sebagai perkiraan akhir sesi —
// jangan pakai "sekarang", karena downtime bisa berhari-hari dan durasi
// "hari ini" akan membengkak. Aman dipanggil saat tidak ada sisa sesi.
async function closeStaleSession(id: string): Promise<RuntimeState> {
  const rt = await readRuntime(id);
  if (rt.lastStartedAt === null) return rt;

  let end = rt.lastStartedAt;
  try {
    const stat = await fs.stat(path.join(ACCOUNTS_DIR, id, "log.txt"));
    end = Math.max(end, Math.min(Date.now(), stat.mtimeMs));
  } catch {}

  const day = new Date(end).toLocaleDateString("sv-SE");
  rt.daily[day] = (rt.daily[day] ?? 0) + Math.max(0, end - rt.lastStartedAt);
  rt.lastStartedAt = null;
  pruneDaily(rt.daily, RUNTIME_KEEP_DAYS);
  await writeRuntime(id, rt);
  return rt;
}

async function closeStaleSessions(): Promise<void> {
  const ids = await accounts();
  await Promise.all(ids.map((id) => closeStaleSession(id).catch(() => null)));
}

async function markWorkerStarted(id: string): Promise<void> {
  const rt = await closeStaleSession(id);
  rt.lastStartedAt = Date.now();
  pruneDaily(rt.daily, RUNTIME_KEEP_DAYS);
  await writeRuntime(id, rt);
}

// Dijalankan sekali saat dashboard hidup, sebelum worker/status apa pun.
const staleSessionsReady = closeStaleSessions().catch(() => {});

async function flushRuntime(id: string, nowMs: number): Promise<void> {
  // Kredit durasi sesi berjalan ke bucket hari ini lalu tutup sesi.
  const rt = await readRuntime(id);
  if (rt.lastStartedAt === null) return;
  const delta = Math.max(0, nowMs - rt.lastStartedAt);
  rt.daily[todayKey()] = (rt.daily[todayKey()] ?? 0) + delta;
  rt.lastStartedAt = null;
  pruneDaily(rt.daily, RUNTIME_KEEP_DAYS);
  await writeRuntime(id, rt);
}

// Durasi run hari ini: bucket hari ini + sesi berjalan prorata hanya bagian
// yang jatuh hari ini (sesi menyeberang tengah malam dihitung sejak 00:00).
function runtimeTodayMs(rt: RuntimeState, nowMs = Date.now()): number {
  let ms = rt.daily[todayKey()] ?? 0;
  if (rt.lastStartedAt !== null) {
    const midnight = new Date();
    midnight.setHours(0, 0, 0, 0);
    ms += Math.max(0, nowMs - Math.max(rt.lastStartedAt, midnight.getTime()));
  }
  return ms;
}

// ─── Auto-restart helpers ────────────────────────────────────────────────────
function cancelScheduledRestart(id: string, clearFailures = true): void {
  const timer = restartTimers.get(id);
  if (timer) {
    clearTimeout(timer);
    restartTimers.delete(id);
  }
  if (clearFailures) failCount.delete(id);
}

// Backoff auto-restart: 1m, 2m, 4m, 8m, 15m (cap).
function backoffDelayMs(fails: number): number {
  return Math.min(15 * 60 * 1000, 60 * 1000 * 2 ** (fails - 1));
}

async function accounts(): Promise<string[]> {
  try {
    const entries = await fs.readdir(ACCOUNTS_DIR, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((id) => /^[A-Za-z0-9_-]+$/.test(id))
      .sort();
  } catch {
    return [];
  }
}

async function joinPoolTotal(): Promise<number> {
  try {
    const raw = await fs.readFile(path.join(ROOT_DIR, "groups-pool.txt"), "utf8");
    return raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean).length;
  } catch {
    return 0;
  }
}

// ─── Konten batch (accounts/<id>/content/<n>) ────────────────────────────────
// Satu batch = satu folder konten. Fitur tambah/hapus menulis atau menghapus
// folder yang sama di SEMUA akun, jadi satu gambar + caption dipakai bersama.
async function batchNumbersOf(id: string): Promise<number[]> {
  try {
    const entries = await fs.readdir(path.join(ACCOUNTS_DIR, id, "content"), {
      withFileTypes: true,
    });
    return entries
      .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
      .map((e) => Number(e.name))
      .filter((n) => Number.isInteger(n) && n > 0);
  } catch {
    return [];
  }
}

async function allBatchNumbers(): Promise<number[]> {
  const set = new Set<number>();
  for (const id of await accounts()) {
    for (const n of await batchNumbersOf(id)) set.add(n);
  }
  return [...set].sort((a, b) => a - b);
}

async function nextBatchNumber(): Promise<number> {
  // Nomor batch selalu mengikuti isi folder (1..N), bukan progress. Progress
  // lama tidak boleh membuat batch baru mulai dari nomor tinggi setelah batch
  // lama dihapus.
  const nums = await allBatchNumbers();
  return (nums.length ? nums[nums.length - 1] : 0) + 1;
}

interface BatchSummary {
  n: number;
  accounts: number;
  images: number;
  caption: string;
}

async function batchSummary(n: number): Promise<BatchSummary> {
  let accountCount = 0;
  let images = 0;
  let caption = "";
  for (const id of await accounts()) {
    const dir = path.join(ACCOUNTS_DIR, id, "content", String(n));
    try {
      await fs.access(dir);
    } catch {
      continue;
    }
    accountCount++;
    if (!caption) {
      caption = await fs.readFile(path.join(dir, "text.txt"), "utf8").catch(() => "");
    }
    if (!images) {
      const files = await fs.readdir(path.join(dir, "images")).catch(() => [] as string[]);
      images = files.filter((f) =>
        IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase())
      ).length;
    }
  }
  return { n, accounts: accountCount, images, caption };
}

// config.totalBatches = folder tertinggi akun itu, supaya worker tidak
// mencoba batch yang sudah dihapus. Field lain (id/name) dipertahankan.
async function syncAccountTotalBatches(id: string): Promise<void> {
  const nums = await batchNumbersOf(id);
  const highest = nums.length ? Math.max(...nums) : 0;
  const file = path.join(ACCOUNTS_DIR, id, "config.json");
  const config = await readJson<Config & Record<string, unknown>>(file);
  if (!config || config.totalBatches === highest) return;
  config.totalBatches = highest;
  await fs.writeFile(file, JSON.stringify(config)).catch(() => {});
}

// Akun lama yang sudah menyelesaikan semua batch (progress dihapus versi lama)
// langsung diarahkan ke batch baru supaya tidak mengulang konten dari batch 1.
async function seedCompletedProgress(id: string, batch: number): Promise<void> {
  if (workers.has(id) || starting.has(id)) return;
  const progress = await readJson<Progress>(path.join(ACCOUNTS_DIR, id, "progress.json"));
  if (progress?.accountId === id && progress.batch > 0) return;
  const stats = await readJson<PostingStats>(path.join(ACCOUNTS_DIR, id, "posting-stats.json"));
  if ((stats?.total ?? 0) <= 0) return;
  await fs
    .writeFile(
      path.join(ACCOUNTS_DIR, id, "progress.json"),
      JSON.stringify(
        {
          accountId: id,
          batch,
          groupIdx: 0,
          timestamp: new Date().toISOString(),
        },
        null,
        2
      )
    )
    .catch(() => {});
}

// Saat nomor batch dipakai ulang (sentinel / bekas batch yang dihapus), mulai
// dari grup 1 supaya konten baru tidak mewarisi posisi grup batch lama.
async function resetProgressGroup(id: string, batch: number): Promise<void> {
  const file = path.join(ACCOUNTS_DIR, id, "progress.json");
  const progress = await readJson<Progress>(file);
  if (!progress || progress.accountId !== id || progress.batch !== batch) return;
  if (progress.groupIdx === 0) return;
  progress.groupIdx = 0;
  progress.timestamp = new Date().toISOString();
  await fs.writeFile(file, JSON.stringify(progress, null, 2)).catch(() => {});
}

// Rapikan nomor batch jadi 1..N di semua akun. Dipakai saat start dashboard
// (memperbaiki data lama) dan setelah hapus batch. Rename dilakukan dari nomor
// kecil ke besar supaya target selalu kosong.
async function normalizeBatchNumbers(): Promise<{ changed: boolean; failed: string[] }> {
  const nums = await allBatchNumbers();
  const map = new Map<number, number>();
  nums.forEach((n, i) => map.set(n, i + 1));
  const maxOld = nums.length ? nums[nums.length - 1] : 0;
  const newTotal = nums.length;
  const failed: string[] = [];
  const failedAccounts = new Set<string>();
  let changed = false;

  for (const id of await accounts()) {
    const accountNums = (await batchNumbersOf(id)).sort((a, b) => a - b);
    for (const old of accountNums) {
      const next = map.get(old);
      if (next === undefined || next === old) continue;
      try {
        await fs.rename(
          path.join(ACCOUNTS_DIR, id, "content", String(old)),
          path.join(ACCOUNTS_DIR, id, "content", String(next))
        );
        changed = true;
      } catch {
        failed.push(`${id} B${old}→B${next}`);
        failedAccounts.add(id);
      }
    }

    await syncAccountTotalBatches(id);
    if (failedAccounts.has(id)) continue;

    const file = path.join(ACCOUNTS_DIR, id, "progress.json");
    const progress = await readJson<Progress>(file);
    if (!progress) continue;
    const before = JSON.stringify(progress);
    const invalid = !!progress.accountId && progress.accountId !== id;
    progress.accountId = id;
    if (invalid) {
      progress.batch = 1;
      progress.groupIdx = 0;
    } else if (progress.batch > maxOld) {
      // Sentinel (total lama + 1) → sentinel baru.
      progress.batch = newTotal + 1;
      progress.groupIdx = 0;
    } else if (map.has(progress.batch)) {
      // Batch masih ada → ikut nomor baru, posisi grup dipertahankan.
      progress.batch = map.get(progress.batch)!;
    } else {
      // Batch yang ditunjuk sudah dihapus → lanjut ke batch berikutnya.
      const nextOld = nums.find((n) => n > progress.batch);
      progress.batch = nextOld !== undefined ? map.get(nextOld)! : newTotal + 1;
      progress.groupIdx = 0;
    }
    if (JSON.stringify(progress) !== before) {
      progress.timestamp = new Date().toISOString();
      await fs.writeFile(file, JSON.stringify(progress, null, 2)).catch(() => {});
    }
  }

  return { changed, failed };
}

async function saveBatchToAll(
  n: number,
  caption: string,
  stagedFile: string,
  ext: string
): Promise<{ ok: string[]; failed: string[] }> {
  const ok: string[] = [];
  const failed: string[] = [];
  for (const id of await accounts()) {
    const dir = path.join(ACCOUNTS_DIR, id, "content", String(n));
    try {
      const imagesDir = path.join(dir, "images");
      await fs.mkdir(imagesDir, { recursive: true });
      // Gambar dulu, text.txt terakhir: text.txt adalah penanda batch siap.
      await fs.copyFile(stagedFile, path.join(imagesDir, `image${ext}`));
      await fs.writeFile(path.join(dir, "text.txt"), caption);
      await syncAccountTotalBatches(id);
      await resetProgressGroup(id, n);
      await seedCompletedProgress(id, n);
      ok.push(id);
    } catch {
      // Nomor ini baru, jadi folder sisa (kalau ada) aman dibersihkan.
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
      failed.push(id);
    }
  }
  return { ok, failed };
}

async function deleteBatchFromAll(
  n: number
): Promise<{ ok: string[]; failed: string[] }> {
  const ok: string[] = [];
  const failed: string[] = [];
  for (const id of await accounts()) {
    const dir = path.join(ACCOUNTS_DIR, id, "content", String(n));
    let hasBatch = true;
    try {
      await fs.access(dir);
    } catch {
      hasBatch = false; // akun ini memang tidak punya batch tersebut
    }

    try {
      if (hasBatch) {
        await fs.rm(dir, { recursive: true, force: true });
        ok.push(id);
      }
    } catch {
      failed.push(id);
    }
  }

  // Kalau semua akun berhasil, nomor langsung dirapikan 1..N.
  // Kalau ada yang gagal, jangan geser nomor: batch n masih ada di akun itu.
  if (!failed.length) {
    await normalizeBatchNumbers();
  } else {
    for (const id of await accounts()) await syncAccountTotalBatches(id);
  }
  return { ok, failed };
}

function activeWorkerIds(): string[] {
  return [...new Set([...workers.keys(), ...starting.keys(), ...restartTimers.keys()])];
}

async function downloadBatchImage(
  ctx: Context,
  fileId: string,
  suggestedExt: string
): Promise<{ file: string; ext: string }> {
  const link = await ctx.telegram.getFileLink(fileId);
  const res = await fetch(link);
  if (!res.ok) throw new Error(`gagal unduh gambar (HTTP ${res.status})`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const ext = IMAGE_EXTENSIONS.has(suggestedExt.toLowerCase())
    ? suggestedExt.toLowerCase()
    : ".jpg";
  await fs.mkdir(BATCH_STAGING_DIR, { recursive: true });
  const file = path.join(
    BATCH_STAGING_DIR,
    `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`
  );
  await fs.writeFile(file, buffer);
  return { file, ext };
}

function batchPageCount(total: number): number {
  return Math.max(1, Math.ceil(total / BATCH_PAGE_SIZE));
}

function normalizeBatchPage(page: number, total: number): number {
  return Math.min(Math.max(0, page), batchPageCount(total) - 1);
}

async function batchManagerText(page: number): Promise<string> {
  const nums = await allBatchNumbers();
  if (!nums.length) {
    return "<b>BATCH KONTEN</b>\n\nBelum ada batch. Tekan Tambah Batch untuk mengisi konten pertama.";
  }

  const safe = normalizeBatchPage(page, nums.length);
  const visible = nums.slice(safe * BATCH_PAGE_SIZE, safe * BATCH_PAGE_SIZE + BATCH_PAGE_SIZE);
  const summaries = await Promise.all(visible.map(batchSummary));

  const lines = [
    "<b>BATCH KONTEN</b>",
    `Halaman <b>${safe + 1}/${batchPageCount(nums.length)}</b> • ${nums.length} batch`,
    "━━━━━━━━━━━━━━━━━━━━",
  ];
  for (const b of summaries) {
    const flat = b.caption.replace(/\s+/g, " ").trim();
    const preview = flat ? `${flat.slice(0, 70)}${flat.length > 70 ? "…" : ""}` : "(caption kosong)";
    lines.push(
      `<b>B${b.n}</b> • ${b.accounts} akun • ${b.images} gambar`,
      `   ${esc(preview)}`
    );
  }
  lines.push("", "Batch baru otomatis diterapkan ke semua akun.");
  return lines.join("\n");
}

async function batchManagerKeyboard(page: number) {
  const nums = await allBatchNumbers();
  const safe = normalizeBatchPage(page, nums.length);
  const visible = nums.slice(safe * BATCH_PAGE_SIZE, safe * BATCH_PAGE_SIZE + BATCH_PAGE_SIZE);

  const rows: ReturnType<typeof Markup.button.callback>[][] = [];
  for (let i = 0; i < visible.length; i += 5) {
    rows.push(
      visible
        .slice(i, i + 5)
        .map((n) => Markup.button.callback(`Hapus B${n}`, `batchdel:${n}`))
    );
  }

  const nav = [];
  if (safe > 0) nav.push(Markup.button.callback("Prev", `batchpage:${safe - 1}`));
  if (nums.length) nav.push(Markup.button.callback(`${safe + 1}/${batchPageCount(nums.length)}`, "noop"));
  if (safe < batchPageCount(nums.length) - 1) {
    nav.push(Markup.button.callback("Next", `batchpage:${safe + 1}`));
  }
  if (nav.length) rows.push(nav);

  rows.push([Markup.button.callback("Tambah Batch", "batchadd")]);
  rows.push([Markup.button.callback("Dashboard", "dashboard")]);
  return Markup.inlineKeyboard(rows);
}

async function replyBatchManager(ctx: Context, page = 0): Promise<void> {
  const nums = await allBatchNumbers();
  const safe = normalizeBatchPage(page, nums.length);
  await ctx.replyWithHTML(
    await batchManagerText(safe),
    await batchManagerKeyboard(safe)
  );
}

function batchAddPrompt(): string {
  return [
    "<b>TAMBAH BATCH KONTEN</b>",
    "",
    "Kirim 1 foto atau file gambar + caption dalam satu pesan.",
    "Gambar dan caption akan dipakai semua akun.",
    "",
    "Ketik /batal untuk membatalkan.",
  ].join("\n");
}

async function finalizeBatchDraft(
  ctx: Context,
  chatId: number,
  draft: { file: string; ext: string },
  caption: string
): Promise<void> {
  if (batchMutation) {
    batchDrafts.delete(chatId);
    await fs.rm(draft.file, { force: true }).catch(() => {});
    await ctx.reply("Operasi batch lain sedang berjalan. Coba kirim lagi sebentar.");
    return;
  }

  batchMutation = true;
  batchDrafts.delete(chatId);
  try {
    const n = await nextBatchNumber();
    const result = await saveBatchToAll(n, caption, draft.file, draft.ext);
    if (!result.ok.length) {
      throw new Error("tidak ada akun yang berhasil ditulis");
    }
    const lines = [
      `<b>Batch ${n}</b> ditambahkan ke ${result.ok.length}/${result.ok.length + result.failed.length} akun.`,
      `1 gambar • caption ${caption.trim().split(/\r?\n/).length} baris`,
    ];
    if (result.failed.length) {
      lines.push(`Gagal: ${esc(result.failed.join(", "))}`);
    }
    if (workers.size) {
      lines.push(
        "",
        "Worker yang sedang berjalan perlu di-restart agar batch ini ikut diproses sesi ini."
      );
    }
    await ctx.replyWithHTML(
      lines.join("\n"),
      Markup.inlineKeyboard([[Markup.button.callback("Lihat Batch", "batch")]])
    );
  } catch (err) {
    await ctx.reply(
      `Gagal menambah batch: ${String((err as Error)?.message ?? err).slice(0, 200)}`
    );
  } finally {
    batchMutation = false;
    await fs.rm(draft.file, { force: true }).catch(() => {});
  }
}

async function handleBatchImage(
  ctx: Context,
  fileId: string,
  ext: string,
  caption: string
): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const staged = await downloadBatchImage(ctx, fileId, ext);
  if (caption.trim()) {
    await finalizeBatchDraft(ctx, chatId, staged, caption);
    return;
  }
  batchDrafts.set(chatId, { step: "caption", file: staged.file, ext: staged.ext, at: Date.now() });
  await ctx.reply(
    "Gambar diterima. Sekarang kirim teks caption (boleh multi-baris).\nKetik /batal untuk membatalkan."
  );
}

const LIMIT_RE =
  /LIMIT terdeteksi:\s*"([^"]+)"|STOP: Facebook mendeteksi pembatasan posting|akun terdeteksi LIMIT|proses dihentikan karena LIMIT/i;

async function readLogInfo(id: string): Promise<{ last: string; sessionText: string }> {
  try {
    const text = await fs.readFile(path.join(ACCOUNTS_DIR, id, "log.txt"), "utf8");
    const lines = text.trim().split(/\r?\n/);
    let start = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      // Awal sesi baru: "Mulai ... dalam 3 detik" (run normal), "Auto-resume",
      // atau "Belum ada progress". Mencegah LIMIT dari sesi lama terbaca ulang
      // saat sesi baru exit cepat (mis. semua batch sudah selesai).
      if (
        /Mulai\b.*dalam 3 detik/.test(lines[i]) ||
        /Auto-resume:|Belum ada progress/.test(lines[i])
      ) {
        start = i + 1;
        break;
      }
    }
    return {
      last: lines.at(-1) ?? "",
      sessionText: lines.slice(start).join("\n"),
    };
  } catch {
    return { last: "", sessionText: "" };
  }
}

function detectLimit(sessionText: string): string | null {
  const match = sessionText.match(LIMIT_RE);
  if (!match) return null;
  return match[1] ?? "pembatasan posting dari Facebook";
}

interface JoinProgress {
  accountId: string;
  index: number;
  joined: string[];
  failed: string[];
  timestamp: string;
}

async function statusOf(id: string) {
  const running = workers.has(id);
  const [progress, config, logInfo, stats, runtime, joinProgress, breakInfo] =
    await Promise.all([
      readJson<Progress>(path.join(ACCOUNTS_DIR, id, "progress.json")),
      readJson<Config>(path.join(ACCOUNTS_DIR, id, "config.json")),
      readLogInfo(id),
      readJson<PostingStats>(path.join(ACCOUNTS_DIR, id, "posting-stats.json")),
      readRuntime(id),
      readJson<JoinProgress>(path.join(ACCOUNTS_DIR, id, "join-progress.json")),
      readBreak(id),
    ]);
  const log = logInfo.last;
  const limitReason = detectLimit(logInfo.sessionText);
  const mode = workerModes.get(id) ?? "";
  const poolTotal = joinProgress ? await joinPoolTotal() : 0;

  let icon = running ? "🟢" : "🔴";
  let state = running ? "RUNNING" : "STOPPED";
  const breakUntil = breakUntilMs(breakInfo);
  const resting = !running && breakUntil > Date.now();

  if (limitReason) {
    icon = "🚫";
    state = "LIMIT / BLOCKED";
  } else if (running && mode === "join") {
    icon = "➕";
    state = "JOIN GRUP";
  } else if (running && mode === "collect") {
    icon = "🧲";
    state = "COLLECT GRUP";
  } else if (resting) {
    icon = "😴";
    state = `ISTIRAHAT • lanjut ${fmtClock(breakUntil)}`;
  } else if (!running && /semua batch selesai/i.test(log)) {
    icon = "🔵";
    state = "COMPLETED";
  } else if (!running && /tidak ada grup|tidak ada batch/i.test(logInfo.sessionText)) {
    // Keluar sebab setup (grup/konten kosong) — bukan crash, tidak layak auto-restart.
    icon = "⚙️";
    state = "SETUP ERROR";
  }

  const completed =
    !!progress &&
    (config?.totalBatches ?? 0) > 0 &&
    progress.batch > (config?.totalBatches ?? 0);
  const position =
    mode === "join" && joinProgress
      ? `Join ${joinProgress.index}/${poolTotal}`
      : completed
        ? "Selesai"
        : progress
          ? `B${progress.batch} • G${progress.groupIdx + 1}`
          : "B1 • G1";

  // Durasi sesi berjalan (hanya bila worker hidup).
  let sessionMs = 0;
  if (running) {
    const now = Date.now();
    const live = runInfo.get(id);
    sessionMs = live
      ? Math.max(0, now - live.startedAt)
      : runtime.lastStartedAt !== null
        ? Math.max(0, now - runtime.lastStartedAt)
        : 0;
  }

  return {
    id,
    name: config?.name || id,
    icon,
    state,
    position,
    log,
    limitReason,
    running,
    sessionMs,
    breakUntil: resting ? breakUntil : null,
    postsTotal: stats?.total ?? 0,
    postsToday: stats?.daily?.[todayKey()] ?? null,
    joinProgress: joinProgress
      ? {
          index: joinProgress.index,
          total: poolTotal,
          joined: joinProgress.joined?.length ?? 0,
          failed: joinProgress.failed?.length ?? 0,
        }
      : null,
    mode,
    runtime,
  };
}

function pageCount(total: number): number {
  return Math.max(1, Math.ceil(total / PAGE_SIZE));
}

function normalizePage(page: number, total: number): number {
  return Math.min(Math.max(0, page), pageCount(total) - 1);
}

function dashboardKeyboard(ids: string[], page: number) {
  const totalPages = pageCount(ids.length);
  const safePage = normalizePage(page, ids.length);
  const slice = ids.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE);

  const rows: ReturnType<typeof Markup.button.callback>[][] = [];

  for (const id of slice) {
    const label = id.length > 14 ? id.slice(0, 14) : id;
    rows.push([
      Markup.button.callback(label, `view:${id}`),
      Markup.button.callback("Start", `start:${id}`),
      Markup.button.callback("Stop", `stop:${id}`),
    ]);
  }

  const nav = [];
  if (safePage > 0) nav.push(Markup.button.callback("Prev", `page:${safePage - 1}`));
  nav.push(Markup.button.callback(`${safePage + 1}/${totalPages}`, "noop"));
  if (safePage < totalPages - 1) nav.push(Markup.button.callback("Next", `page:${safePage + 1}`));
  rows.push(nav);

  rows.push([
    Markup.button.callback("Start All", "startall"),
    Markup.button.callback("Stop All", "stopall"),
  ]);
  rows.push([Markup.button.callback("Start Non-Limit (serentak)", "startnonlimit")]);
  rows.push([
    Markup.button.callback("Refresh", `page:${safePage}`),
    Markup.button.callback("Ringkasan", "summary"),
  ]);
  rows.push([Markup.button.callback("Batch Konten", "batch")]);

  return Markup.inlineKeyboard(rows);
}

function accountKeyboard(id: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("START / RESUME", `start:${id}`), Markup.button.callback("STOP", `stop:${id}`)],
    [Markup.button.callback("Join Grup", `join:${id}`), Markup.button.callback("Reset Join", `resetjoin:${id}`)],
    [Markup.button.callback("STATUS", `view:${id}`)],
    [Markup.button.callback("Dashboard", "dashboard")],
  ]);
}

async function dashboardText(page: number): Promise<string> {
  const ids = await accounts();
  if (!ids.length) return "<b>FACEBOOK DASHBOARD</b>\n\nTidak ada akun di accounts/.";

  const safe = normalizePage(page, ids.length);
  const visible = ids.slice(safe * PAGE_SIZE, safe * PAGE_SIZE + PAGE_SIZE);
  const data = await Promise.all(visible.map(statusOf));

  const lines = [
    "<b>FACEBOOK DASHBOARD</b>",
    `Halaman <b>${safe + 1}/${pageCount(ids.length)}</b> • ${ids.length} akun`,
    "━━━━━━━━━━━━━━━━━━━━",
  ];

  for (const a of data) {
    lines.push(
      `${a.icon} <b>${esc(a.id)}</b> — ${esc(a.state)}`,
      `   Progress: ${esc(a.position)}`
    );
    const dur = a.running ? `Sesi: ${fmtDuration(a.sessionMs)}` : "Sesi: -";
    const today = a.postsToday ? ` • Hari ini: ${a.postsToday.total}` : "";
    lines.push(`   ${dur} • Total: ${a.postsTotal} post${today}`);
    if (a.limitReason) lines.push(`   Limit: ${esc(a.limitReason)}`);
  }

  lines.push(
    "",
    "Status: 🟢 Running • 🔴 Stopped • 😴 Istirahat • 🚫 Limit • 🔵 Completed",
    "Diperbarui otomatis setiap 15 menit."
  );

  return lines.join("\n");
}

async function replyDashboard(ctx: Context, page = 0) {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    await ctx.reply("Akses ditolak.");
    return;
  }

  const ids = await accounts();
  const safe = normalizePage(page, ids.length);
  if (ctx.chat) periodicPageByChat.set(ctx.chat.id, safe);

  await ctx.replyWithHTML(
    await dashboardText(safe),
    dashboardKeyboard(ids, safe)
  );
}

// Kirim pesan ke semua admin (dengan parse_mode HTML).
async function sendToAdmins(
  text: string,
  markup?: ReturnType<typeof accountKeyboard>
): Promise<void> {
  if (TEST_MODE) {
    testNotifications.push(text);
    console.log("[TEST-NOTIF]", text);
  }
  for (const adminId of ADMIN_IDS) {
    const numId = Number(adminId);
    if (!Number.isFinite(numId)) continue;
    try {
      await bot.telegram.sendMessage(numId, text, {
        parse_mode: "HTML",
        ...(markup ?? {}),
      });
    } catch (err) {
      console.error("Gagal mengirim pesan ke admin:", err);
    }
  }
}

// Dipanggil sekali untuk setiap kejadian worker keluar: mencatat durasi &
// posting sesi ke runtime/stats, memberi tahu admin alasannya (LIMIT /
// COMPLETED / manual / hang / crash), lalu memutuskan auto-restart.
async function handleWorkerExit(id: string, exitInfo: string): Promise<void> {
  if (exitHandled.has(id)) return;
  exitHandled.add(id);

  const now = Date.now();
  const session = runInfo.get(id);
  runInfo.delete(id);
  const sessionMs = session ? Math.max(0, now - session.startedAt) : 0;

  // Kredit durasi sesi terlepas dari status shutdown — data tidak boleh hilang.
  await flushRuntime(id, now);

  // Jeda singkat agar baris log terakhir (mis. status LIMIT/selesai) sempat
  // di-flush ke log.txt sebelum dibaca oleh statusOf().
  await sleep(800);

  const [data, stats, breakInfo] = await Promise.all([
    statusOf(id),
    readJson<PostingStats>(path.join(ACCOUNTS_DIR, id, "posting-stats.json")),
    readBreak(id),
  ]);
  const breakUntil = breakUntilMs(breakInfo);
  const sessionPosts = session
    ? Math.max(0, (stats?.total ?? 0) - session.startTotal)
    : 0;

  // Batalkan timer restart yang mungkin masih menggantung dari siklus sebelumnya.
  cancelScheduledRestart(id, false);

  const wasManual = manualStops.delete(id);
  const wasSupervised = supervisedRestart.delete(id);
  const workerMode = workerModes.get(id) ?? "";
  workerModes.delete(id);
  const onBreak = !wasManual && !wasSupervised && breakUntil > now;

  let reason = `Berhenti tak terduga (${exitInfo}). Cek log untuk detail.`;

  if (workerMode === "join") {
    reason = "Sesi join grup selesai (detail di join-progress.json).";
  } else if (workerMode === "collect") {
    reason = "Sesi kumpul grup selesai (hasil di groups-pool.txt).";
  } else if (data.state === "LIMIT / BLOCKED") {
    reason = "Terkena limit / pembatasan posting dari Facebook.";
  } else if (data.state === "COMPLETED") {
    reason = "Semua batch sudah selesai diproses.";
  } else if (data.state === "SETUP ERROR") {
    reason = "Setup tidak lengkap (grup/konten tidak ditemukan) — perlu diberi konten atau join grup dulu.";
  } else if (wasManual) {
    reason = "Dihentikan manual lewat dashboard/perintah STOP.";
  } else if (wasSupervised) {
    reason = "Log diam terlalu lama (indikasi hang) — dihentikan untuk restart terawasi.";
  } else if (onBreak) {
    reason = `Istirahat manusiawi — lanjut otomatis pukul ${fmtClock(breakUntil)}.`;
  }
  if (wasManual) await clearBreak(id);

  const lines = [
    `${data.icon} <b>${esc(data.name)}</b> ${onBreak ? "istirahat" : "berhenti"}`,
    `Alasan: ${esc(reason)}`,
    `Progress: ${esc(data.position)}`,
  ];
  if (session) {
    lines.push(
      `Durasi: ${fmtDuration(sessionMs)} • Posting sesi ini: ${sessionPosts}`
    );
  }
  if (data.log) {
    lines.push(`Log terakhir: <code>${esc(stripEmoji(data.log.slice(-500)))}</code>`);
  }

  if (!shutdownStarted) {
    await sendToAdmins(lines.join("\n"), accountKeyboard(id));
  }

  // ── Keputusan auto-restart ──────────────────────────────────────────────────
  // Tidak restart bila: shutdown, dihentikan manual, LIMIT, COMPLETED, atau
  // SETUP ERROR (bukan crash — restart tidak akan memperbaiki setup).
  if (shutdownStarted || wasManual) return;
  // collect/join bukan proses posting — jangan pernah auto-restart.
  if (workerMode) return;

  // Istirahat: jadwalkan wake tepat waktu dengan resume progress (bukan backoff).
  if (onBreak) {
    failCount.delete(id);
    scheduleBreakWake(id, breakUntil);
    pumpStartAllQueue();
    return;
  }

  if (
    data.state === "LIMIT / BLOCKED" ||
    data.state === "COMPLETED" ||
    data.state === "SETUP ERROR"
  ) {
    return;
  }

  // Sesi terakhir yang jalan lancar cukup lama → reset hitungan kegagalan.
  if (sessionMs >= SESSION_HEALTHY_MS) failCount.delete(id);

  const fails = (failCount.get(id) ?? 0) + 1;
  if (fails > RESTART_MAX_FAILURES) {
    failCount.delete(id);
    if (!shutdownStarted) {
      await sendToAdmins(
        `<b>${esc(data.name)}</b> tetap bermasalah setelah ${RESTART_MAX_FAILURES} percobaan auto-restart. Tidak di-restart lagi — perlu diperiksa manual.`
      );
    }
    return;
  }
  failCount.set(id, fails);

  const delay = backoffDelayMs(fails);
  if (!shutdownStarted) {
    await sendToAdmins(
      `<b>${esc(data.name)}</b> berhenti tak terduga → auto-restart dalam ${fmtDuration(delay)} (percobaan ${fails}/${RESTART_MAX_FAILURES}).`
    );
  }
  restartTimers.set(
    id,
    setTimeout(() => {
      restartTimers.delete(id);
      void startWorker(id, false);
    }, delay)
  );

  // Worker keluar → buka slot antrean Start All.
  pumpStartAllQueue();
}

async function startWorker(
  id: string,
  resetFailures = true,
  mode = "",
  resumeAfterBreak = false
): Promise<string> {
  // Bagian sinkron sebelum await — menutup race START cepat berulang.
  if (starting.has(id) || workers.has(id)) return `${id} sudah berjalan.`;
  starting.add(id);
  try {
    return await startWorkerInner(id, resetFailures, mode, resumeAfterBreak);
  } finally {
    starting.delete(id);
  }
}

async function startWorkerInner(
  id: string,
  resetFailures: boolean,
  mode = "",
  resumeAfterBreak = false
): Promise<string> {
  await staleSessionsReady; // jangan spawn sebelum sesi lama ditutup
  if (!resumeAfterBreak && !mode) {
    // Jangan spawn dini saat istirahat; timer wake yang ada tetap dipakai.
    const breakUntil = breakUntilMs(await readBreak(id));
    if (breakUntil > Date.now()) {
      if (!restartTimers.has(id)) scheduleBreakWake(id, breakUntil);
      return `😴 ${id} sedang istirahat — lanjut otomatis pukul ${fmtClock(breakUntil)} (sisa ${Math.max(1, Math.ceil((breakUntil - Date.now()) / 60000))} menit). Tekan STOP untuk membatalkan.`;
    }
  }
  cancelScheduledRestart(id, false); // restart terjadwal: hitungan kegagalan tetap
  if (resetFailures) failCount.delete(id); // start manual = siklus baru
  hangAlerted.delete(id);

  try {
    await fs.access(path.join(ACCOUNTS_DIR, id));
    await fs.access(WORKER_SCRIPT);
    await fs.access(TSX_CLI);
  } catch {
    return `Worker/dependency untuk ${id} tidak ditemukan.`;
  }

  const child = spawn(
    process.execPath,
    [TSX_CLI, WORKER_SCRIPT, id, ...(mode ? [mode] : [])],
    {
      cwd: ROOT_DIR,
      env: {
        ...process.env,
        DASHBOARD_MODE: "1",
        WORKER_LAUNCH_AT: String(Date.now()),
        ...(resumeAfterBreak ? { RESUME_AFTER_BREAK: "1" } : {}),
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }
  );

  workers.set(id, child);
  workerModes.set(id, mode);
  exitHandled.delete(id);

  // Catat sesi: waktu mulai + snapshot total posting (untuk hitungan
  // "N posting sesi ini" saat berhenti) + tandai mulai di runtime.json.
  const statsSnapshot = await readJson<PostingStats>(
    path.join(ACCOUNTS_DIR, id, "posting-stats.json")
  );
  runInfo.set(id, {
    startedAt: Date.now(),
    startTotal: statsSnapshot?.total ?? 0,
  });
  await markWorkerStarted(id);

  child.stdout?.on("data", (data: Buffer) => {
    console.log(`[${id}] ${data.toString().trimEnd()}`);
  });
  child.stderr?.on("data", (data: Buffer) => {
    console.error(`[${id}] ${data.toString().trimEnd()}`);
  });
  child.on("error", (error) => {
    workers.delete(id);
    console.error(`[${id}] worker error:`, error);
    void handleWorkerExit(id, `spawn error: ${error.message}`);
  });
  child.on("exit", (code, signal) => {
    workers.delete(id);
    console.log(`[${id}] berhenti. code=${code}, signal=${signal ?? "-"}`);
    void handleWorkerExit(id, `code=${code}, signal=${signal ?? "-"}`);
  });

  if (resumeAfterBreak) {
    const progress = await readJson<Progress>(
      path.join(ACCOUNTS_DIR, id, "progress.json")
    );
    await sendToAdmins(
      `<b>${esc(id)}</b> lanjut setelah istirahat${progress ? ` • B${progress.batch} G${progress.groupIdx + 1}` : ""}.`
    );
  }

  return mode === "join"
    ? `${id}: mulai join grup dari groups-pool.txt (progress tersimpan di join-progress.json).`
    : mode === "collect"
      ? `${id}: mulai kumpulkan grup ke groups-pool.txt.`
      : `${id} dimulai. Resume otomatis dari progress terakhir.`;
}

function isProcessAlive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

// true = child benar-benar keluar sebelum batas waktu, false = masih hidup.
function waitForExit(child: ChildProcess, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (!isProcessAlive(child)) return resolve(true);
    let done = false;
    const onExit = () => finish(true);
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), ms);
    child.once("exit", onExit);
  });
}

async function forceKillWorker(id: string, child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
      });
      killer.once("error", () => resolve());
      killer.once("exit", () => resolve());
    });
  } else {
    try {
      child.kill("SIGTERM");
    } catch {}
  }
}

// Inti pemberhentian: worker memantau file stop.request dan keluar sendiri
// dengan menyimpan progress (graceful). Bila tidak merespon, dipaksa kill.
// manual=true → perintah admin (tidak auto-restart); manual=false → watchdog
// (di-restart terawasi lewat supervisedRestart).
async function stopWorkerInternal(
  id: string,
  manual: boolean
): Promise<{ stopped: boolean; graceful: boolean }> {
  const child = workers.get(id);
  if (!child?.pid) {
    // Tidak ada proses, tapi mungkin masih ada jadwal istirahat/auto-restart.
    if (restartTimers.has(id) || (await readBreak(id))) {
      cancelScheduledRestart(id);
      await clearBreak(id);
      return { stopped: true, graceful: true };
    }
    return { stopped: false, graceful: true };
  }

  if (manual) {
    manualStops.add(id);
    cancelScheduledRestart(id);
    await clearBreak(id);
  } else {
    supervisedRestart.add(id);
  }

  try {
    await fs.writeFile(
      path.join(ACCOUNTS_DIR, id, "stop.request"),
      new Date().toISOString()
    );
  } catch {
    // Gagal menulis file stop → langsung paksa kill.
    await forceKillWorker(id, child);
    return { stopped: true, graceful: false };
  }

  if (await waitForExit(child, GRACEFUL_STOP_TIMEOUT_MS)) {
    return { stopped: true, graceful: true };
  }

  // Tidak merespon stop.request → paksa matikan.
  await forceKillWorker(id, child);
  await waitForExit(child, 5000);
  return { stopped: true, graceful: false };
}

async function stopWorker(id: string): Promise<string> {
  const hadChild = workers.has(id);
  const hadBreak = breakUntilMs(await readBreak(id)) > 0;
  const hadTimer = restartTimers.has(id);
  const result = await stopWorkerInternal(id, true);
  if (!result.stopped) return `${id} tidak sedang berjalan.`;
  if (!hadChild && hadBreak) return `${id}: jadwal istirahat dibatalkan.`;
  if (!hadChild && hadTimer) return `${id}: jadwal auto-restart dibatalkan.`;
  return result.graceful
    ? `${id} dihentikan rapi (progress tersimpan).`
    : `${id} terpaksa dimatikan (tidak merespon stop.request).`;
}

async function stopAll(): Promise<string> {
  const ids = [...new Set([...workers.keys(), ...restartTimers.keys()])];
  if (!ids.length) return "Tidak ada worker aktif.";
  const results = await Promise.all(ids.map((id) => stopWorker(id)));
  return results.join("\n");
}

// Dashboard baru hidup: lanjutkan jadwal istirahat yang tercatat di disk.
async function recoverBreakTimers(): Promise<void> {
  for (const id of await accounts()) {
    if (workers.has(id) || restartTimers.has(id)) continue;
    const until = breakUntilMs(await readBreak(id));
    if (!until) continue;
    if (until <= Date.now()) {
      console.log(`▶️ ${id}: jadwal istirahat sudah lewat — lanjut sekarang.`);
      await startWorker(id, true, "", true);
      continue;
    }
    scheduleBreakWake(id, until);
    console.log(`😴 ${id}: istirahat sampai ${fmtClock(until)} — wake terjadwal.`);
  }
}

function auth(ctx: Context): boolean {
  return !!ctx.from && isAdmin(ctx.from.id);
}

bot.start(async (ctx) => {
  if (!auth(ctx)) return void ctx.reply("Akses ditolak.");
  await replyDashboard(ctx, periodicPageByChat.get(ctx.chat?.id ?? 0) ?? 0);
});

bot.command("status", async (ctx) => {
  if (!auth(ctx)) return;
  await replyDashboard(ctx, periodicPageByChat.get(ctx.chat?.id ?? 0) ?? 0);
});

// Mode grup: /collect <akun> mengumpulkan grup yang sudah di-join akun itu ke
// groups-pool.txt; /join <akun> join grup dari file pool tersebut.
async function startGroupMode(ctx: Context, mode: "collect" | "join"): Promise<void> {
  if (!auth(ctx)) return void ctx.reply("Akses ditolak.");
  const text =
    "text" in (ctx.message ?? {})
      ? String((ctx.message as { text?: string }).text ?? "")
      : "";
  const id = text.trim().split(/\s+/)[1] ?? "";
  if (!id) return void ctx.reply(`Format: /${mode} <akun>\nContoh: /${mode} fb11`);
  const ids = await accounts();
  if (!ids.includes(id)) return void ctx.reply(`Akun ${id} tidak ditemukan di accounts/.`);
  await ctx.reply(await startWorker(id, true, mode));
}

bot.command("collect", (ctx) => startGroupMode(ctx, "collect"));
bot.command("join", (ctx) => startGroupMode(ctx, "join"));

bot.action("noop", async (ctx) => {
  if (!auth(ctx)) return void ctx.answerCbQuery("Akses ditolak", { show_alert: true });
  await ctx.answerCbQuery();
});

bot.action(/^page:(\d+)$/, async (ctx) => {
  if (!auth(ctx)) return void ctx.answerCbQuery("Akses ditolak", { show_alert: true });
  await ctx.answerCbQuery();
  await replyDashboard(ctx, Number(ctx.match[1]));
});

bot.action("dashboard", async (ctx) => {
  if (!auth(ctx)) return void ctx.answerCbQuery("Akses ditolak", { show_alert: true });
  await ctx.answerCbQuery();
  await replyDashboard(ctx, periodicPageByChat.get(ctx.chat?.id ?? 0) ?? 0);
});

bot.action(/^view:(.+)$/, async (ctx) => {
  if (!auth(ctx)) return void ctx.answerCbQuery("Akses ditolak", { show_alert: true });
  const id = String(ctx.match[1]);
  await ctx.answerCbQuery();
  const data = await statusOf(id);
  const d = data.postsToday;
  const todayBreakdown = breakdownText(d);

  const lines = [
    `${data.icon} <b>${esc(data.id)}</b> — ${esc(data.state)}`,
    `Progress: ${esc(data.position)}`,
    data.limitReason
      ? `Limit: YA — "${esc(data.limitReason)}" (sesi terakhir)`
      : `Limit: TIDAK`,
    `Sesi: ${data.running ? `berjalan ${fmtDuration(data.sessionMs)}` : "—"}`,
    `Hari ini: ${d?.total ?? 0} post${
      todayBreakdown ? ` (${todayBreakdown})` : ""
    } • ${fmtDuration(runtimeTodayMs(data.runtime))}`,
    `Total post: ${data.postsTotal}`,
  ];
  if (data.breakUntil) {
    lines.push(
      `Istirahat: sisa ${Math.max(1, Math.ceil((data.breakUntil - Date.now()) / 60000))} menit (lanjut ${fmtClock(data.breakUntil)})`
    );
  }
  if (data.joinProgress) {
    const jp = data.joinProgress;
    lines.push(`Join grup: ${jp.index}/${jp.total} • ${jp.joined} ok • ${jp.failed} gagal`);
  }
  if (data.mode === "join") lines.push("Mode: JOIN GRUP");
  if (data.mode === "collect") lines.push("Mode: COLLECT GRUP");
  if (data.log) {
    lines.push(`Log terakhir: <code>${esc(stripEmoji(data.log.slice(-700)))}</code>`);
  }
  await ctx.replyWithHTML(lines.join("\n"), accountKeyboard(id));
});

bot.action(/^start:(.+)$/, async (ctx) => {
  if (!auth(ctx)) return void ctx.answerCbQuery("Akses ditolak", { show_alert: true });
  const id = String(ctx.match[1]);
  await ctx.answerCbQuery("Starting...");
  await ctx.reply(await startWorker(id));
});

bot.action(/^stop:(.+)$/, async (ctx) => {
  if (!auth(ctx)) return void ctx.answerCbQuery("Akses ditolak", { show_alert: true });
  const id = String(ctx.match[1]);
  await ctx.answerCbQuery("Stopping...");
  await ctx.reply(await stopWorker(id));
});

bot.action(/^join:(.+)$/, async (ctx) => {
  if (!auth(ctx)) return void ctx.answerCbQuery("Akses ditolak", { show_alert: true });
  const id = String(ctx.match[1]);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return void ctx.answerCbQuery("ID tidak valid", { show_alert: true });
  await ctx.answerCbQuery("Join grup...");
  await ctx.reply(await startWorker(id, true, "join"));
});

bot.action(/^resetjoin:(.+)$/, async (ctx) => {
  if (!auth(ctx)) return void ctx.answerCbQuery("Akses ditolak", { show_alert: true });
  const id = String(ctx.match[1]);
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return void ctx.answerCbQuery("ID tidak valid", { show_alert: true });
  await ctx.answerCbQuery();
  if (workers.has(id) || starting.has(id)) {
    return void ctx.reply(`${id} masih berjalan — stop dulu sebelum reset join.`);
  }
  await fs.rm(path.join(ACCOUNTS_DIR, id, "join-progress.json"), { force: true });
  await ctx.reply(`Join progress ${id} direset. Run join berikutnya mulai dari grup 1.`);
});

// ─── Start All queue (human-like scheduling) ─────────────────────────────────
// Akun dimulai dalam urutan acak dengan jeda 2-10 menit, maksimal
// POST_CONCURRENCY akun posting bersamaan. Slot berikutnya dibuka saat
// worker selesai/berhenti. Stop All menghapus antrean.
const POST_CONCURRENCY = Number(process.env.POST_CONCURRENCY || "2");
const START_ALL_STAGGER_MIN_MS = 2 * 60 * 1000;
const START_ALL_STAGGER_MAX_MS = 10 * 60 * 1000;
let startAllQueue: string[] = [];
let startAllGeneration = 0;

function activePostingCount(): number {
  let count = 0;
  for (const [id, mode] of workerModes) {
    if (mode === "" && workers.has(id)) count++;
  }
  return count;
}

function pumpStartAllQueue(): void {
  void (async () => {
    const generation = startAllGeneration;
    while (
      generation === startAllGeneration &&
      startAllQueue.length > 0 &&
      !shutdownStarted
    ) {
      if (activePostingCount() >= POST_CONCURRENCY) {
        await sleep(30_000);
        continue;
      }
      const id = startAllQueue.shift()!;
      const stagger =
        START_ALL_STAGGER_MIN_MS +
        Math.floor(Math.random() * (START_ALL_STAGGER_MAX_MS - START_ALL_STAGGER_MIN_MS));
      await sleep(stagger);
      if (generation !== startAllGeneration || shutdownStarted) break;
      if (workers.has(id)) continue; // sudah jalan (auto-restart/manual)
      try {
        console.log(await startWorker(id));
      } catch (err) {
        console.error(`Gagal start ${id} dari antrean:`, err);
      }
    }
  })();
}

bot.action("startall", async (ctx) => {
  if (!auth(ctx)) return void ctx.answerCbQuery("Akses ditolak", { show_alert: true });
  await ctx.answerCbQuery("Starting all...");
  const ids = await accounts();
  const pending = ids.filter((id) => !workers.has(id) && !startAllQueue.includes(id));
  const chatId = ctx.chat?.id;

  if (!pending.length) {
    await ctx.reply("Semua akun sudah berjalan / dalam antrean.");
    return;
  }

  // Fisher-Yates shuffle supaya urutan akun tidak selalu sama.
  for (let i = pending.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pending[i], pending[j]] = [pending[j], pending[i]];
  }

  startAllQueue.push(...pending);
  startAllGeneration++;
  const gen = startAllGeneration;
  await ctx.reply(
    `${pending.length} akun masuk antrean — urutan acak, jeda 2-10 menit per start, ` +
      `maksimal ${POST_CONCURRENCY} akun posting bersamaan.\n` +
      `Urutan: ${pending.join(", ")}`
  );

  void (async () => {
    const generation = gen;
    while (
      generation === startAllGeneration &&
      startAllQueue.length > 0 &&
      !shutdownStarted
    ) {
      if (activePostingCount() >= POST_CONCURRENCY) {
        await sleep(30_000);
        continue;
      }
      const id = startAllQueue.shift()!;
      const stagger =
        START_ALL_STAGGER_MIN_MS +
        Math.floor(Math.random() * (START_ALL_STAGGER_MAX_MS - START_ALL_STAGGER_MIN_MS));
      await sleep(stagger);
      if (generation !== startAllGeneration || shutdownStarted) break;
      if (workers.has(id)) continue;
      try {
        console.log(await startWorker(id));
      } catch (err) {
        console.error(`Gagal start ${id} dari antrean:`, err);
      }
    }
  })();
});

bot.action("startnonlimit", async (ctx) => {
  if (!auth(ctx)) return void ctx.answerCbQuery("Akses ditolak", { show_alert: true });
  await ctx.answerCbQuery("Starting non-limit...");
  const ids = await accounts();
  const statuses = await Promise.all(ids.map((id) => statusOf(id)));
  const eligible = statuses.filter((s) => !s.running && !s.limitReason).map((s) => s.id);
  const skipped = statuses.filter((s) => s.limitReason).map((s) => s.id);

  if (!eligible.length) {
    await ctx.reply("Tidak ada akun non-limit yang bisa dijalankan.");
    return;
  }

  // Batalkan antrean Start All agar akun limit tidak ikut jalan belakangan.
  startAllQueue = [];
  startAllGeneration++;

  const results = await Promise.all(eligible.map((id) => startWorker(id)));
  const started = results.filter((r) => /dimulai|mulai join|mulai kumpulkan/.test(r));

  await ctx.reply(
    `${started.length}/${eligible.length} akun non-limit dijalankan serentak: ${eligible.join(", ")}` +
      (skipped.length ? `\nDilewati (limit): ${skipped.join(", ")}` : "")
  );
});

// ─── Ringkasan harian ────────────────────────────────────────────────────────
type SummaryFilter = "all" | "run" | "limit" | "stop";
type SummaryCategory = "run" | "rest" | "limit" | "stop";
type AccountStatus = Awaited<ReturnType<typeof statusOf>>;

// Kategori eksklusif (limit menang atas status lain) untuk filter ringkasan.
function summaryCategory(data: AccountStatus): SummaryCategory {
  if (data.state === "LIMIT / BLOCKED") return "limit";
  if (data.running) return "run";
  if (data.breakUntil) return "rest";
  return "stop";
}
async function dailySummary(filter: SummaryFilter = "all") {
  const ids = await accounts();
  if (!ids.length) {
    return {
      text: "Ringkasan harian: tidak ada akun.",
      keyboard: Markup.inlineKeyboard([
        [Markup.button.callback("Dashboard", "dashboard")],
      ]),
    };
  }

  const now = Date.now();
  const all = await Promise.all(ids.map((id) => statusOf(id)));
  const counts = { run: 0, rest: 0, limit: 0, stop: 0 };
  for (const data of all) counts[summaryCategory(data)]++;

  const list = all.filter((data) => {
    const category = summaryCategory(data);
    if (filter === "all") return true;
    if (filter === "run") return category === "run" || category === "rest";
    return category === filter;
  });

  const filterLabels: Record<SummaryFilter, string> = {
    all: "Semua",
    run: "Berjalan + istirahat",
    limit: "Limit",
    stop: "Berhenti",
  };

  const lines = [
    "<b>RINGKASAN HARIAN</b>",
    esc(
      new Date().toLocaleDateString("id-ID", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    ),
    `Filter: ${filterLabels[filter]}`,
    "━━━━━━━━━━━━━━━━━━━━",
  ];

  let totalAll = 0, directAll = 0, pendingAll = 0, limitedAll = 0, errorAll = 0, unknownAll = 0, msAll = 0;

  for (const data of list) {
    const d = data.postsToday;
    const posts = d?.total ?? 0;
    const ms = runtimeTodayMs(data.runtime, now);
    const breakdown = breakdownText(d);

    lines.push(
      `${data.icon} <b>${esc(data.id)}</b> — ${posts} post${breakdown ? ` (${breakdown})` : ""} • ${fmtDuration(ms)}`
    );

    totalAll += posts;
    directAll += d?.direct ?? 0;
    pendingAll += d?.pending ?? 0;
    limitedAll += d?.limited ?? 0;
    errorAll += d?.error ?? 0;
    unknownAll += d?.unknown ?? 0;
    msAll += ms;
  }

  const totals: DailyStat = {
    total: totalAll,
    direct: directAll,
    pending: pendingAll,
    error: errorAll,
    limited: limitedAll,
    unknown: unknownAll,
  };
  const totalBreakdown = breakdownText(totals);

  lines.push(
    "━━━━━━━━━━━━━━━━━━━━",
    `TOTAL: ${totalAll} post${totalBreakdown ? ` (${totalBreakdown})` : ""} • ${fmtDuration(msAll)}`,
    `Berjalan: ${counts.run} • Istirahat: ${counts.rest} • Limit: ${counts.limit} • Berhenti: ${counts.stop} (${all.length} akun)`
  );
  if (!list.length) lines.push("Tidak ada akun pada filter ini.");

  const mark = (key: SummaryFilter) => (filter === key ? "[x] " : "");
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(`${mark("all")}Semua (${all.length})`, "sumf:all"),
      Markup.button.callback(
        `${mark("run")}Berjalan + istirahat (${counts.run + counts.rest})`,
        "sumf:run"
      ),
    ],
    [
      Markup.button.callback(`${mark("limit")}Limit (${counts.limit})`, "sumf:limit"),
      Markup.button.callback(`${mark("stop")}Berhenti (${counts.stop})`, "sumf:stop"),
    ],
    [Markup.button.callback("Dashboard", "dashboard")],
  ]);

  return { text: lines.join("\n"), keyboard };
}

async function sendSummary(
  ctx: Context,
  filter: SummaryFilter,
  edit: boolean
): Promise<void> {
  const { text, keyboard } = await dailySummary(filter);
  if (edit) {
    try {
      await ctx.editMessageText(text, { parse_mode: "HTML", ...keyboard });
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/message is not modified/i.test(message)) return;
    }
  }
  await ctx.replyWithHTML(text, keyboard);
}

bot.command("ringkasan", async (ctx) => {
  if (!auth(ctx)) return void ctx.reply("Akses ditolak.");
  await sendSummary(ctx, "all", false);
});

bot.action("summary", async (ctx) => {
  if (!auth(ctx)) return void ctx.answerCbQuery("Akses ditolak", { show_alert: true });
  await ctx.answerCbQuery();
  await sendSummary(ctx, "all", false);
});

bot.action(/^sumf:(all|run|limit|stop)$/, async (ctx) => {
  if (!auth(ctx)) return void ctx.answerCbQuery("Akses ditolak", { show_alert: true });
  await ctx.answerCbQuery();
  await sendSummary(ctx, ctx.match[1] as SummaryFilter, true);
});

bot.action("stopall", async (ctx) => {
  if (!auth(ctx)) return void ctx.answerCbQuery("Akses ditolak", { show_alert: true });
  await ctx.answerCbQuery("Stopping all...");
  startAllQueue = [];
  startAllGeneration++;
  await ctx.reply(await stopAll());
});

// ─── Batch konten ────────────────────────────────────────────────────────────
async function cancelBatchDraft(ctx: Context): Promise<void> {
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const draft = getBatchDraft(chatId);
  if (!draft) {
    batchDrafts.delete(chatId);
    return void ctx.reply("Tidak ada proses tambah batch yang aktif.");
  }
  batchDrafts.delete(chatId);
  if (draft.step === "caption") {
    await fs.rm(draft.file, { force: true }).catch(() => {});
  }
  await ctx.reply("Tambah batch dibatalkan.");
}

// Draft menua otomatis supaya tidak "nyangkut" kalau admin berhenti di tengah.
function getBatchDraft(chatId: number): BatchDraft | null {
  const draft = batchDrafts.get(chatId);
  if (!draft) return null;
  if (Date.now() - draft.at > BATCH_DRAFT_TTL_MS) {
    batchDrafts.delete(chatId);
    if (draft.step === "caption") void fs.rm(draft.file, { force: true }).catch(() => {});
    return null;
  }
  return draft;
}

bot.command("batch", async (ctx) => {
  if (!auth(ctx)) return void ctx.reply("Akses ditolak.");
  await replyBatchManager(ctx);
});

bot.action("batch", async (ctx) => {
  if (!auth(ctx)) return void ctx.answerCbQuery("Akses ditolak", { show_alert: true });
  await ctx.answerCbQuery();
  await replyBatchManager(ctx);
});

bot.action(/^batchpage:(\d+)$/, async (ctx) => {
  if (!auth(ctx)) return void ctx.answerCbQuery("Akses ditolak", { show_alert: true });
  await ctx.answerCbQuery();
  await replyBatchManager(ctx, Number(ctx.match[1]));
});

bot.action("batchadd", async (ctx) => {
  if (!auth(ctx)) return void ctx.answerCbQuery("Akses ditolak", { show_alert: true });
  const ids = await accounts();
  if (!ids.length) return void ctx.answerCbQuery("Belum ada akun", { show_alert: true });
  if (batchMutation) {
    return void ctx.answerCbQuery("Operasi batch lain sedang berjalan", { show_alert: true });
  }
  await ctx.answerCbQuery();
  const chatId = ctx.chat?.id;
  if (!chatId) return;
  const old = batchDrafts.get(chatId);
  if (old?.step === "caption") await fs.rm(old.file, { force: true }).catch(() => {});
  batchDrafts.set(chatId, { step: "photo", at: Date.now() });
  await ctx.replyWithHTML(
    batchAddPrompt(),
    Markup.inlineKeyboard([[Markup.button.callback("Batal", "batchcancel")]])
  );
});

bot.action("batchcancel", async (ctx) => {
  if (!auth(ctx)) return void ctx.answerCbQuery("Akses ditolak", { show_alert: true });
  await ctx.answerCbQuery();
  await cancelBatchDraft(ctx);
});

bot.command("batal", async (ctx) => {
  if (!auth(ctx)) return void ctx.reply("Akses ditolak.");
  await cancelBatchDraft(ctx);
});

bot.action(/^batchdel:(\d+)$/, async (ctx) => {
  if (!auth(ctx)) return void ctx.answerCbQuery("Akses ditolak", { show_alert: true });
  const n = Number(ctx.match[1]);
  await ctx.answerCbQuery();
  const active = activeWorkerIds();
  if (active.length) {
    return void ctx.reply(
      `Stop dulu semua worker (${active.join(", ")}).\nHapus batch menggeser nomor batch lain, jadi tidak bisa saat worker aktif.`
    );
  }
  await ctx.replyWithHTML(
    [
      `<b>Hapus Batch ${n}?</b>`,
      "",
      "Folder konten batch ini akan dihapus dari semua akun.",
      "Nomor batch setelahnya digeser agar tetap berurutan 1, 2, 3, dst.",
      "Postingan yang sudah tayang di Facebook tidak terhapus.",
    ].join("\n"),
    Markup.inlineKeyboard([
      [
        Markup.button.callback("Ya, hapus", `batchdelok:${n}`),
        Markup.button.callback("Batal", "batch"),
      ],
    ])
  );
});

bot.action(/^batchdelok:(\d+)$/, async (ctx) => {
  if (!auth(ctx)) return void ctx.answerCbQuery("Akses ditolak", { show_alert: true });
  const n = Number(ctx.match[1]);
  await ctx.answerCbQuery("Menghapus...");
  if (batchMutation) {
    return void ctx.reply("Operasi batch lain sedang berjalan. Coba lagi sebentar.");
  }
  const active = activeWorkerIds();
  if (active.length) {
    return void ctx.reply(
      `Stop dulu semua worker (${active.join(", ")}).\nHapus batch menggeser nomor batch lain, jadi tidak bisa saat worker aktif.`
    );
  }

  batchMutation = true;
  try {
    const result = await deleteBatchFromAll(n);
    const lines = [
      `<b>Batch ${n}</b> dihapus dari ${result.ok.length} akun.`,
    ];
    if (result.failed.length) {
      lines.push(`Gagal: ${esc(result.failed.join(", "))}`);
      lines.push("Nomor batch tidak digeser. Ulangi hapus setelah masalahnya beres.");
    } else {
      const total = (await allBatchNumbers()).length;
      lines.push(
        total
          ? `Sisa ${total} batch, nomor dirapikan 1..${total}.`
          : "Semua batch kosong. Batch baru akan mulai dari nomor 1."
      );
    }
    await ctx.replyWithHTML(
      lines.join("\n"),
      Markup.inlineKeyboard([[Markup.button.callback("Lihat Batch", "batch")]])
    );
  } catch (err) {
    await ctx.reply(
      `Gagal menghapus batch: ${String((err as Error)?.message ?? err).slice(0, 200)}`
    );
  } finally {
    batchMutation = false;
  }
});

function extFromMime(mime: string): string | null {
  switch (mime.toLowerCase()) {
    case "image/png":
      return ".png";
    case "image/jpeg":
      return ".jpg";
    case "image/gif":
      return ".gif";
    case "image/webp":
      return ".webp";
    default:
      return null;
  }
}

bot.on(message("photo"), async (ctx) => {
  if (!auth(ctx)) return;
  const draft = getBatchDraft(ctx.chat.id);
  if (draft?.step !== "photo") return;
  const photo = ctx.message.photo.at(-1);
  if (!photo) return;
  if (photo.file_size && photo.file_size > 20 * 1024 * 1024) {
    return void ctx.reply("Ukuran gambar melebihi batas Telegram (20 MB).");
  }
  try {
    await handleBatchImage(ctx, photo.file_id, ".jpg", ctx.message.caption ?? "");
  } catch (err) {
    const reason = String((err as Error)?.message ?? err).slice(0, 200);
    await ctx.reply(`Gagal mengambil gambar: ${reason}\nCoba kirim ulang.`);
  }
});

bot.on(message("document"), async (ctx) => {
  if (!auth(ctx)) return;
  const draft = getBatchDraft(ctx.chat.id);
  if (draft?.step !== "photo") return;
  const doc = ctx.message.document;
  const mime = doc.mime_type ?? "";
  if (!mime.startsWith("image/")) {
    return void ctx.reply("File harus berupa gambar (png/jpg/jpeg/gif/webp).");
  }
  if (doc.file_size && doc.file_size > 20 * 1024 * 1024) {
    return void ctx.reply("Ukuran file melebihi batas Telegram (20 MB).");
  }
  const extFromName = path.extname(doc.file_name ?? "").toLowerCase();
  const ext = IMAGE_EXTENSIONS.has(extFromName) ? extFromName : extFromMime(mime);
  if (!ext) {
    return void ctx.reply("Tipe gambar tidak didukung. Gunakan png/jpg/jpeg/gif/webp.");
  }
  try {
    await handleBatchImage(ctx, doc.file_id, ext, ctx.message.caption ?? "");
  } catch (err) {
    const reason = String((err as Error)?.message ?? err).slice(0, 200);
    await ctx.reply(`Gagal mengambil file: ${reason}\nCoba kirim ulang.`);
  }
});

// Harus didaftarkan setelah semua bot.command agar command tidak tertelan.
bot.on(message("text"), async (ctx) => {
  if (!auth(ctx)) return;
  const draft = getBatchDraft(ctx.chat.id);
  if (draft?.step !== "caption") return;
  const text = ctx.message.text.trim();
  if (!text || text.startsWith("/")) return;
  await finalizeBatchDraft(ctx, ctx.chat.id, draft, text);
});

bot.catch((err) => console.error("Telegram bot error:", err));

async function updatePeriodicMessage() {
  await staleSessionsReady;
  const adminId = Number([...ADMIN_IDS][0]);
  if (!Number.isFinite(adminId)) return;

  const page = periodicPageByChat.get(adminId) ?? 0;
  const ids = await accounts();
  const safe = normalizePage(page, ids.length);
  const text = await dashboardText(safe);
  const markup = dashboardKeyboard(ids, safe);

  try {
    if (periodicMessage && periodicMessage.chatId === adminId) {
      await bot.telegram.editMessageText(
        adminId,
        periodicMessage.messageId,
        undefined,
        text,
        { parse_mode: "HTML", ...markup }
      );
      return;
    }
  } catch (err) {
    // Teks/tombol tidak berubah → Telegram menolak edit dengan pesan ini.
    // Bukan kegagalan; jangan kirim pesan baru (bikin duplikat tiap interval).
    const desc = String(
      (err as { description?: string })?.description ?? (err as Error)?.message ?? err
    );
    if (/message is not modified/i.test(desc)) return;
    periodicMessage = null;
  }

  const sent = await bot.telegram.sendMessage(adminId, text, {
    parse_mode: "HTML",
    ...markup,
  });
  periodicMessage = { chatId: adminId, messageId: sent.message_id };
}

const PERIODIC_MS = 15 * 60 * 1000;
setInterval(
  () =>
    void updatePeriodicMessage().catch((err) =>
      console.error("Gagal update dashboard periodik:", err)
    ),
  PERIODIC_MS
);

// ─── Watchdog: deteksi worker hang ───────────────────────────────────────────
// Worker RUNNING tetapi log.txt tidak pernah ditulis dalam HANG_TOLERANCE_MS →
// sangat mungkin browser macet (hang). Beri tahu admin lalu jalankan stop +
// restart terawasi (lewat jalur auto-restart yang sama).
setInterval(() => void watchdogPass(), WATCHDOG_INTERVAL_MS);

async function watchdogPass(): Promise<void> {
  if (shutdownStarted) return;
  const now = Date.now();
  for (const id of [...workers.keys()]) {
    if (hangAlerted.has(id)) continue;
    try {
      const stat = await fs.stat(path.join(ACCOUNTS_DIR, id, "log.txt"));
      if (now - stat.mtimeMs <= HANG_TOLERANCE_MS) continue;
    } catch {
      // log.txt belum ada. Hanya dianggap hang bila worker sudah lama spawn
      // tapi sampai sekarang belum pernah menulis log apa pun.
      const live = runInfo.get(id);
      if (!live || now - live.startedAt <= HANG_TOLERANCE_MS) continue;
    }

    hangAlerted.add(id);
    await sendToAdmins(
      `<b>${esc(id)}</b> berstatus RUNNING tetapi tidak menulis log selama ${Math.round(HANG_TOLERANCE_MS / 60000)} menit — terindikasi hang. Restart terawasi dijalankan.`
    );
    await stopWorkerInternal(id, false);
  }
}

async function shutdown(signal: "SIGINT" | "SIGTERM") {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`\n🛑 ${signal} diterima. Menghentikan worker...`);
  // Hentikan timer auto-restart biar tidak memunculkan worker baru.
  for (const id of [...restartTimers.keys()]) cancelScheduledRestart(id);
  await stopAll();
  bot.stop(signal);
  process.exit(0);
}

// telegraf 4.x: launch() baru resolve saat polling-loop BERAKHIR (loop = iterator
// tanpa ujung) → code di .then() tidak pernah jalan selama bot sehat. Semua
// "bot siap" logic harus di callback launch() (jalan habis getMe).
let onLaunchLogged = false;
void (async () => {
  const normalized = await normalizeBatchNumbers().catch((err) => {
    console.error("Gagal merapikan nomor batch:", err);
    return { changed: false, failed: [] as string[] };
  });
  if (normalized.changed) {
    const nums = await allBatchNumbers();
    console.log(`📦 Nomor batch dirapikan menjadi 1..${nums.length}.`);
  }
  if (normalized.failed.length) {
    console.error(`⚠️ Sebagian batch gagal dirapikan: ${normalized.failed.join(", ")}`);
  }
  bot.launch(() => {
  if (onLaunchLogged) return;
  onLaunchLogged = true;
  console.log("🤖 Telegram Dashboard v3 aktif.");
  console.log("📊 Pagination: 10 akun per halaman.");
  console.log("⏱️ Status otomatis setiap 15 menit.");
  console.log("📊 Ringkasan harian: /ringkasan atau tombol 📊 Ringkasan.");
  console.log("➕ Join grup: tombol di detail akun atau /join <akun>.");
  console.log(
    `🛟 Watchdog hang aktif (log diam > ${HANG_TOLERANCE_MS / 60000} menit), auto-restart maks ${RESTART_MAX_FAILURES}x dengan backoff.`
  );
  void bot.telegram
    .setMyCommands([
      { command: "start", description: "Buka dashboard" },
      { command: "status", description: "Status semua akun" },
      { command: "join", description: "Join grup: /join fb05" },
      { command: "collect", description: "Kumpulkan grup: /collect fb05" },
      { command: "ringkasan", description: "Ringkasan harian" },
    ])
    .catch((err) => console.error("Gagal set menu command:", err));
  setTimeout(
    () =>
      void updatePeriodicMessage().catch((err) =>
        console.error("Gagal kirim dashboard awal:", err)
      ),
    3000
  );
  // Lanjutkan jadwal istirahat yang tertinggal dari proses dashboard sebelumnya.
  void recoverBreakTimers().catch((err) =>
    console.error("Gagal memulihkan jadwal istirahat:", err)
  );
  // Auto-start akun dari env AUTOSTART (koma-dipisah) dengan stagger
  // START_ALL_STAGGER_MS — untuk menjalankan akun tanpa klik manual.
  const autostartIds = (process.env.AUTOSTART ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[A-Za-z0-9_-]+$/.test(s));
  if (autostartIds.length) {
    void (async () => {
      for (let i = 0; i < autostartIds.length; i++) {
        if (shutdownStarted) break;
        console.log(await startWorker(autostartIds[i], true));
        if (i < autostartIds.length - 1) await sleep(START_ALL_STAGGER_MS);
      }
    })();
  }
  if (TEST_MODE) {
    console.log("[TEST] TEST_MODE aktif — self-test berjalan otomatis.");
    setTimeout(() => void runSelfTest(), 2000);
  }
})
  .catch((err) => {
    // Tanpa catch, kegagalan launch (mis. 409 karena instance lama belum
    // melepas getUpdates) bikin proses hidup zombie tanpa jejak.
    console.error("Telegram launch gagal — dashboard berhenti:", err);
    process.exit(1);
  });
})();
// Rangkaian uji stabilitas yang memakai jalur kode dashboard asli (start/stop/
// auto-restart/watchdog) terhadap akun uji sementara. fbtest = pakai sesi fb01,
// fbtest2 = tanpa sesi (mensimulasikan hang). Hasil ditulis ke test-results.txt.
// Nonaktif tanpa env TEST_MODE=1 — tidak mengubah perilaku produksi.
const TEST_MODE = process.env.TEST_MODE === "1";
const TEST_ACCOUNT = (process.env.TEST_ACCOUNT || "fbtest").trim();
const TEST_ACCOUNT2 = (process.env.TEST_ACCOUNT2 || "fbtest2").trim();
const TEST_RESULTS_FILE = path.join(ROOT_DIR, "test-results.txt");
const testNotifications: string[] = [];

function testMark(ok: boolean, name: string, detail = ""): void {
  const line = `[${new Date().toISOString()}] ${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` | ${detail}` : ""}`;
  console.log(`[TEST] ${line}`);
  void fs.appendFile(TEST_RESULTS_FILE, line + "\n").catch(() => {});
}

// Ambil baris log terakhir yang cocok pola (baca log.txt tiap 1 detik).
async function waitLogLine(
  id: string,
  pattern: RegExp,
  timeoutMs: number
): Promise<string | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const text = await fs.readFile(
        path.join(ACCOUNTS_DIR, id, "log.txt"),
        "utf8"
      );
      const lines = text.trim().split(/\r?\n/);
      for (let i = lines.length - 1; i >= 0; i--) {
        if (pattern.test(lines[i])) return lines[i];
      }
    } catch {}
    await sleep(1000);
  }
  return null;
}

async function waitWorkerGone(id: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!workers.has(id)) return true;
    await sleep(500);
  }
  return !workers.has(id);
}

async function waitWorkerBack(id: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (workers.has(id)) return true;
    await sleep(500);
  }
  return workers.has(id);
}

async function killChild(id: string): Promise<void> {
  const child = workers.get(id);
  if (!child) return;
  await new Promise<void>((resolve) => {
    const killer = spawn(
      "taskkill",
      ["/PID", String(child.pid), "/T", "/F"],
      { windowsHide: true, stdio: ["ignore", "ignore", "ignore"] }
    );
    killer.once("error", () => resolve());
    killer.once("exit", () => resolve());
  });
}

async function runSelfTest(): Promise<void> {
  console.log("[TEST] Self-test A/B/C mulai. Admin menerima notifikasi asli.");
  await fs
    .writeFile(
      TEST_RESULTS_FILE,
      `=== SELF TEST ${new Date().toISOString()} ===\n`
    )
    .catch(() => {});

  // Reset state akun uji: progress/log/stop.request lawas membuat hasil A/B
  // tidak konsisten antar rerun (resume langsung posting → stop kejawab jalur
  // terpaksa; waitLogLine bisa match baris dari run sebelumnya).
  for (const id of [TEST_ACCOUNT, TEST_ACCOUNT2]) {
    await fs
      .rm(path.join(ACCOUNTS_DIR, id, "progress.json"), { force: true })
      .catch(() => {});
    await fs
      .rm(path.join(ACCOUNTS_DIR, id, "stop.request"), { force: true })
      .catch(() => {});
    await fs
      .writeFile(path.join(ACCOUNTS_DIR, id, "log.txt"), "")
      .catch(() => {});
  }

  // ── A: graceful stop via stop.request ──────────────────────────────────────
  try {
    const started = await startWorker(TEST_ACCOUNT);
    testMark(started.includes("dimulai"), "A0 start", started);

    // Tunggu grup terkumpul (poin aman untuk stop tanpa posting).
    const found = await waitLogLine(
      TEST_ACCOUNT,
      /Ditemukan \d+ grup|Tidak ada grup/,
      240000
    );
    if (found?.includes("Tidak ada grup")) {
      testMark(true, "A1 login OK tapi feed grup kosong", found);
    } else {
      testMark(!!found, "A1 grup terkumpul", found ?? "timeout 240s");
    }

    const stopMsg = await stopWorker(TEST_ACCOUNT);
    testMark(stopMsg.includes("rapi"), "A2 graceful stop", stopMsg);
    testMark(
      await waitWorkerGone(TEST_ACCOUNT, 40000),
      "A3 worker exit ≤40s"
    );

    const rt = await readRuntime(TEST_ACCOUNT);
    testMark(rt.lastStartedAt === null, "A4 sesi runtime.json ditutup");
    testMark(
      (rt.daily[todayKey()] ?? 0) > 0,
      "A5 durasi hari ini terkredit",
      JSON.stringify(rt.daily)
    );
  } catch (err) {
    testMark(false, "A exception", String(err));
    await stopWorkerInternal(TEST_ACCOUNT, true).catch(() => {});
    await waitWorkerGone(TEST_ACCOUNT, 40000);
  }

  // Beri jeda 10 detik forestring fresh-log B.
  await sleep(10000);

  // ── B: crash (kill -9) → auto-restart dengan backoff ───────────────────────
  try {
    const started = await startWorker(TEST_ACCOUNT);
    testMark(started.includes("dimulai"), "B0 start ulang", started);

    const attempt = await waitLogLine(
      TEST_ACCOUNT,
      /percobaan 1\/\d+|Tidak ada grup|pembatasan posting/,
      300000
    );
    if (attempt?.includes("Tidak ada grup")) {
      testMark(true, "B1-N/A setup: grup tidak ada — auto-restart tidak diuji", attempt);
    } else if (attempt?.includes("pembatasan")) {
      testMark(
        true,
        "B1-N/A limit terdeteksi dini — auto-restart tidak diuji (sesuai desain)",
        attempt
      );
    } else {
      testMark(!!attempt, "B1 aksi grup dimulai", attempt ?? "timeout 300s");
      await killChild(TEST_ACCOUNT);
      testMark(
        await waitWorkerGone(TEST_ACCOUNT, 15000),
        "B2 child crash terdeteksi"
      );
      const back = await waitWorkerBack(TEST_ACCOUNT, 120000);
      testMark(back, "B3 auto-restart ≤2m");
      if (back) {
        const stopMsg = await stopWorker(TEST_ACCOUNT);
        testMark(
          stopMsg.includes("rapi") || stopMsg.includes("terpaksa"),
          "B4 stop setelah restart",
          stopMsg
        );
        await waitWorkerGone(TEST_ACCOUNT, 40000);
      }
    }
  } catch (err) {
    testMark(false, "B exception", String(err));
    await stopWorkerInternal(TEST_ACCOUNT, true).catch(() => {});
    await waitWorkerGone(TEST_ACCOUNT, 40000);
  }

  await sleep(5000);

  // ── C: watchdog hang (worker bengong di menunggu login) ────────────────────
  // fbtest2 tanpa sesi → login-wait diam. Toleransi hang & interval watchdog
  // sudah diperkecil via env saat peluncuran (60s / 30s), RESTART_MAX_FAILURES=1.
  // Ekspektasi: alert hang → stop (rapi via fix login-loop) → auto-restart →
  // hang lagi → give-up ("tetap bermasalah").
  try {
    await startWorker(TEST_ACCOUNT2, true);
    const deadlineC = Date.now() + 9 * 60 * 1000;
    while (Date.now() < deadlineC) {
      const giveUp = testNotifications.some((t) =>
        t.includes("tetap bermasalah")
      );
      if (giveUp && !workers.has(TEST_ACCOUNT2)) break;
      await sleep(2000);
    }
    const hangAlerts = testNotifications.filter((t) =>
      t.includes("terindikasi hang")
    ).length;
    testMark(hangAlerts >= 1, "C1 watchdog alert hang", `alert=${hangAlerts}`);
    testMark(
      testNotifications.some((t) => t.includes("auto-restart")),
      "C2 auto-restart terjadwal",
      `${testNotifications.length} notifikasi`
    );
    testMark(
      testNotifications.some((t) => t.includes("tetap bermasalah")),
      "C3 berhenti setelah melewati batas restart"
    );
    testMark(
      await waitWorkerGone(TEST_ACCOUNT2, 10000),
      "C4 worker uji mati"
    );
  } catch (err) {
    testMark(false, "C exception", String(err));
    await stopWorkerInternal(TEST_ACCOUNT2, true).catch(() => {});
  }

  console.log("[TEST] Selesai. Cek test-results.txt.");
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));