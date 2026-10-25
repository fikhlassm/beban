import "dotenv/config";
import { Telegraf, Markup, Context } from "telegraf";
import { spawn, ChildProcess } from "child_process";
import fs from "fs/promises";
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

async function markWorkerStarted(id: string): Promise<void> {
  const rt = await readRuntime(id);
  // Ada sisa sesi sebelumnya yang belum di-flush (dashboard pernah mati paksa)
  // → kreditkan dulu ke bucket hari ini supaya durasi tidak hilang.
  if (rt.lastStartedAt !== null) {
    const leftover = Math.max(0, Date.now() - rt.lastStartedAt);
    rt.daily[todayKey()] = (rt.daily[todayKey()] ?? 0) + leftover;
  }
  rt.lastStartedAt = Date.now();
  pruneDaily(rt.daily, RUNTIME_KEEP_DAYS);
  await writeRuntime(id, rt);
}

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

async function lastLog(id: string): Promise<string> {
  try {
    const text = await fs.readFile(path.join(ACCOUNTS_DIR, id, "log.txt"), "utf8");
    return text.trim().split(/\r?\n/).at(-1) ?? "";
  } catch {
    return "";
  }
}

async function statusOf(id: string) {
  const running = workers.has(id);
  const [progress, config, log, stats, runtime] = await Promise.all([
    readJson<Progress>(path.join(ACCOUNTS_DIR, id, "progress.json")),
    readJson<Config>(path.join(ACCOUNTS_DIR, id, "config.json")),
    lastLog(id),
    readJson<PostingStats>(path.join(ACCOUNTS_DIR, id, "posting-stats.json")),
    readRuntime(id),
  ]);

  let icon = running ? "🟢" : "🔴";
  let state = running ? "RUNNING" : "STOPPED";

  if (!running && /temporarily blocked|restricted|action blocked|posting limit|limit posting|dibatasi|diblokir|pembatasan posting/i.test(log)) {
    icon = "🚫";
    state = "LIMIT / BLOCKED";
  } else if (!running && /semua batch selesai/i.test(log)) {
    icon = "🔵";
    state = "COMPLETED";
  } else if (!running && /tidak ada grup|tidak ada batch/i.test(log)) {
    // Keluar sebab setup (grup/konten kosong) — bukan crash, tidak layak auto-restart.
    icon = "⚙️";
    state = "SETUP ERROR";
  }

  const position = progress
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
    running,
    sessionMs,
    postsTotal: stats?.total ?? 0,
    postsToday: stats?.daily?.[todayKey()] ?? null,
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
      Markup.button.callback(`📱 ${label}`, `view:${id}`),
      Markup.button.callback("▶", `start:${id}`),
      Markup.button.callback("⏹", `stop:${id}`),
    ]);
  }

  const nav = [];
  if (safePage > 0) nav.push(Markup.button.callback("⬅ Prev", `page:${safePage - 1}`));
  nav.push(Markup.button.callback(`${safePage + 1}/${totalPages}`, "noop"));
  if (safePage < totalPages - 1) nav.push(Markup.button.callback("Next ➡", `page:${safePage + 1}`));
  rows.push(nav);

  rows.push([
    Markup.button.callback("▶ Start All", "startall"),
    Markup.button.callback("⏹ Stop All", "stopall"),
  ]);
  rows.push([
    Markup.button.callback("🔄 Refresh", `page:${safePage}`),
    Markup.button.callback("📊 Ringkasan", "summary"),
  ]);

  return Markup.inlineKeyboard(rows);
}

function accountKeyboard(id: string) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("▶ START / RESUME", `start:${id}`), Markup.button.callback("⏹ STOP", `stop:${id}`)],
    [Markup.button.callback("🔄 STATUS", `view:${id}`)],
    [Markup.button.callback("⬅ Dashboard", "dashboard")],
  ]);
}

async function dashboardText(page: number): Promise<string> {
  const ids = await accounts();
  if (!ids.length) return "🤖 <b>FACEBOOK DASHBOARD</b>\n\n❌ Tidak ada akun di accounts/.";

  const safe = normalizePage(page, ids.length);
  const visible = ids.slice(safe * PAGE_SIZE, safe * PAGE_SIZE + PAGE_SIZE);
  const data = await Promise.all(visible.map(statusOf));

  const lines = [
    "🤖 <b>FACEBOOK DASHBOARD</b>",
    `📄 Halaman <b>${safe + 1}/${pageCount(ids.length)}</b> • ${ids.length} akun`,
    "━━━━━━━━━━━━━━━━━━━━",
  ];

  for (const a of data) {
    lines.push(
      `${a.icon} <b>${esc(a.id)}</b> — ${esc(a.state)}`,
      `   📦 ${esc(a.position)}`
    );
    const dur = a.running ? `⏱ ${fmtDuration(a.sessionMs)}` : "⏱ —";
    const today = a.postsToday ? ` • ${a.postsToday.total} hari ini` : "";
    lines.push(`   ${dur} • 📤 ${a.postsTotal} post${today}`);
  }

  lines.push(
    "",
    "🟢 Running  •  🔴 Stopped  •  🚫 Limit/Blocked  •  🔵 Completed",
    "⏱️ Status otomatis diperbarui setiap 15 menit."
  );

  return lines.join("\n");
}

async function replyDashboard(ctx: Context, page = 0) {
  if (!ctx.from || !isAdmin(ctx.from.id)) {
    await ctx.reply("⛔ Akses ditolak.");
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

  const [data, stats] = await Promise.all([
    statusOf(id),
    readJson<PostingStats>(path.join(ACCOUNTS_DIR, id, "posting-stats.json")),
  ]);
  const sessionPosts = session
    ? Math.max(0, (stats?.total ?? 0) - session.startTotal)
    : 0;

  // Batalkan timer restart yang mungkin masih menggantung dari siklus sebelumnya.
  cancelScheduledRestart(id, false);

  const wasManual = manualStops.delete(id);
  const wasSupervised = supervisedRestart.delete(id);

  let icon = "⚠️";
  let reason = `Berhenti tak terduga (${exitInfo}). Cek log untuk detail.`;

  if (data.state === "LIMIT / BLOCKED") {
    icon = "🚫";
    reason = "Terkena limit / pembatasan posting dari Facebook.";
  } else if (data.state === "COMPLETED") {
    icon = "🎉";
    reason = "Semua batch sudah selesai diproses.";
  } else if (data.state === "SETUP ERROR") {
    icon = "⚙️";
    reason = "Setup tidak lengkap (grup/konten tidak ditemukan) — perlu diberi konten atau join grup dulu.";
  } else if (wasManual) {
    icon = "⏹";
    reason = "Dihentikan manual lewat dashboard/perintah STOP.";
  } else if (wasSupervised) {
    icon = "🥴";
    reason = "Log diam terlalu lama (indikasi hang) — dihentikan untuk restart terawasi.";
  }

  const lines = [
    `${icon} <b>${esc(data.name)}</b> berhenti`,
    `Alasan: ${esc(reason)}`,
    `Progress: ${esc(data.position)}`,
  ];
  if (session) {
    lines.push(
      `⏱ Berjalan ${fmtDuration(sessionMs)} • 📤 ${sessionPosts} posting sesi ini`
    );
  }
  if (data.log) {
    lines.push(`Log terakhir: <code>${esc(data.log.slice(-500))}</code>`);
  }

  if (!shutdownStarted) {
    await sendToAdmins(lines.join("\n"), accountKeyboard(id));
  }

  // ── Keputusan auto-restart ──────────────────────────────────────────────────
  // Tidak restart bila: shutdown, dihentikan manual, LIMIT, COMPLETED, atau
  // SETUP ERROR (bukan crash — restart tidak akan memperbaiki setup).
  if (shutdownStarted || wasManual) return;
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
        `🛑 <b>${esc(data.name)}</b> tetap bermasalah setelah ${RESTART_MAX_FAILURES} percobaan auto-restart. Tidak di-restart lagi — perlu diperiksa manual.`
      );
    }
    return;
  }
  failCount.set(id, fails);

  const delay = backoffDelayMs(fails);
  if (!shutdownStarted) {
    await sendToAdmins(
      `🔄 <b>${esc(data.name)}</b> berhenti tak terduga → auto-restart dalam ${fmtDuration(delay)} (percobaan ${fails}/${RESTART_MAX_FAILURES}).`
    );
  }
  restartTimers.set(
    id,
    setTimeout(() => {
      restartTimers.delete(id);
      void startWorker(id, false);
    }, delay)
  );
}

async function startWorker(id: string, resetFailures = true): Promise<string> {
  // Bagian sinkron sebelum await — menutup race START cepat berulang.
  if (starting.has(id) || workers.has(id)) return `⚠️ ${id} sudah berjalan.`;
  starting.add(id);
  try {
    return await startWorkerInner(id, resetFailures);
  } finally {
    starting.delete(id);
  }
}

async function startWorkerInner(
  id: string,
  resetFailures: boolean
): Promise<string> {
  cancelScheduledRestart(id, false); // restart terjadwal: hitungan kegagalan tetap
  if (resetFailures) failCount.delete(id); // start manual = siklus baru
  hangAlerted.delete(id);

  try {
    await fs.access(path.join(ACCOUNTS_DIR, id));
    await fs.access(WORKER_SCRIPT);
    await fs.access(TSX_CLI);
  } catch {
    return `❌ Worker/dependency untuk ${id} tidak ditemukan.`;
  }

  const child = spawn(process.execPath, [TSX_CLI, WORKER_SCRIPT, id], {
    cwd: ROOT_DIR,
    env: { ...process.env, DASHBOARD_MODE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  workers.set(id, child);
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

  return `▶️ ${id} dimulai. Resume otomatis dari progress terakhir.`;
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
  if (!child?.pid) return { stopped: false, graceful: true };

  if (manual) {
    manualStops.add(id);
    cancelScheduledRestart(id);
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
  const result = await stopWorkerInternal(id, true);
  if (!result.stopped) return `⚠️ ${id} tidak sedang berjalan.`;
  return result.graceful
    ? `⏹ ${id} dihentikan rapi (progress tersimpan).`
    : `⏹ ${id} terpaksa dimatikan (tidak merespon stop.request).`;
}

async function stopAll(): Promise<string> {
  const ids = [...workers.keys()];
  if (!ids.length) return "⚠️ Tidak ada worker aktif.";
  const results = await Promise.all(ids.map((id) => stopWorker(id)));
  return results.join("\n");
}

function auth(ctx: Context): boolean {
  return !!ctx.from && isAdmin(ctx.from.id);
}

bot.start(async (ctx) => {
  if (!auth(ctx)) return void ctx.reply("⛔ Akses ditolak.");
  await replyDashboard(ctx, periodicPageByChat.get(ctx.chat?.id ?? 0) ?? 0);
});

bot.command("status", async (ctx) => {
  if (!auth(ctx)) return;
  await replyDashboard(ctx, periodicPageByChat.get(ctx.chat?.id ?? 0) ?? 0);
});

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

  const lines = [
    `📱 <b>${esc(data.id)}</b> — ${esc(data.state)}`,
    `Progress: ${esc(data.position)}`,
    `Sesi: ${data.running ? `▶ berjalan ${fmtDuration(data.sessionMs)}` : "—"}`,
    `Hari ini: 📤 ${
      d ? d.total : 0
    } post${
      d
        ? ` (✅${d.direct}${d.pending ? ` 🟡${d.pending}` : ""}${d.limited ? ` 🚫${d.limited}` : ""}${d.error ? ` ❌${d.error}` : ""}${d.unknown ? ` ❓${d.unknown}` : ""})`
        : ""
    } • ⏱ ${fmtDuration(runtimeTodayMs(data.runtime))}`,
    `Total post: 📤 ${data.postsTotal}`,
  ];
  if (data.log) {
    lines.push(`Log terakhir: <code>${esc(data.log.slice(-700))}</code>`);
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

bot.action("startall", async (ctx) => {
  if (!auth(ctx)) return void ctx.answerCbQuery("Akses ditolak", { show_alert: true });
  await ctx.answerCbQuery("Starting all...");
  const ids = await accounts();
  const pending = ids.filter((id) => !workers.has(id));
  const chatId = ctx.chat?.id;

  if (!pending.length) {
    await ctx.reply("⚠️ Semua akun sudah berjalan.");
    return;
  }

  // Spawn disebar biar 14 Chrome tidak dinyalakan bersamaan (beban + pola bot).
  await ctx.reply(
    `▶️ Memulai ${pending.length} akun dengan jeda ${Math.round(
      START_ALL_STAGGER_MS / 1000
    )} detik per akun...`
  );

  void (async () => {
    const out: string[] = [];
    for (let i = 0; i < pending.length; i++) {
      if (shutdownStarted) break; // dashboard sedang mati → jangan spawn baru
      out.push(await startWorker(pending[i]));
      if (i < pending.length - 1) await sleep(START_ALL_STAGGER_MS);
    }
    if (chatId && out.length && !shutdownStarted) {
      try {
        await bot.telegram.sendMessage(chatId, out.join("\n"));
      } catch {}
    }
  })();
});

// ─── Ringkasan harian ────────────────────────────────────────────────────────
async function dailySummaryText(): Promise<string> {
  const ids = await accounts();
  if (!ids.length) return "📊 Ringkasan harian: tidak ada akun.";

  const now = Date.now();
  const list = await Promise.all(
    ids.map(async (id) => ({
      data: await statusOf(id),
    }))
  );

  const lines = [
    "📊 <b>RINGKASAN HARIAN</b>",
    `📅 ${esc(
      new Date().toLocaleDateString("id-ID", {
        weekday: "long",
        day: "numeric",
        month: "long",
        year: "numeric",
      })
    )}`,
    "━━━━━━━━━━━━━━━━━━━━",
  ];

  let totalAll = 0, directAll = 0, pendingAll = 0, limitedAll = 0, errorAll = 0, unknownAll = 0, msAll = 0;
  let runningCount = 0;

  for (const { data } of list) {
    const d = data.postsToday;
    const posts = d?.total ?? 0;
    const ms = runtimeTodayMs(data.runtime, now);
    if (data.running) runningCount++;

    const breakdown = d
      ? ` (✅${d.direct}${d.pending ? ` 🟡${d.pending}` : ""}${d.limited ? ` 🚫${d.limited}` : ""}${d.error ? ` ❌${d.error}` : ""}${d.unknown ? ` ❓${d.unknown}` : ""})`
      : "";
    lines.push(
      `${data.icon} <b>${esc(data.id)}</b> ⏱ ${fmtDuration(ms)} • 📤 ${posts} post${breakdown}`
    );

    totalAll += posts;
    directAll += d?.direct ?? 0;
    pendingAll += d?.pending ?? 0;
    limitedAll += d?.limited ?? 0;
    errorAll += d?.error ?? 0;
    unknownAll += d?.unknown ?? 0;
    msAll += ms;
  }

  const totalBreakdown = [
    directAll ? `✅${directAll}` : "",
    pendingAll ? `🟡${pendingAll}` : "",
    limitedAll ? `🚫${limitedAll}` : "",
    errorAll ? `❌${errorAll}` : "",
    unknownAll ? `❓${unknownAll}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  lines.push(
    "━━━━━━━━━━━━━━━━━━━━",
    `TOTAL: 📤 ${totalAll} post${totalBreakdown ? ` (${totalBreakdown})` : ""} • ⏱ ${fmtDuration(msAll)}`,
    `🟢 ${runningCount}/${list.length} akun masih berjalan`
  );

  return lines.join("\n");
}

bot.command("ringkasan", async (ctx) => {
  if (!auth(ctx)) return void ctx.reply("⛔ Akses ditolak.");
  await ctx.replyWithHTML(
    await dailySummaryText(),
    Markup.inlineKeyboard([[Markup.button.callback("⬅ Dashboard", "dashboard")]])
  );
});

bot.action("summary", async (ctx) => {
  if (!auth(ctx)) return void ctx.answerCbQuery("Akses ditolak", { show_alert: true });
  await ctx.answerCbQuery();
  await ctx.replyWithHTML(
    await dailySummaryText(),
    Markup.inlineKeyboard([[Markup.button.callback("⬅ Dashboard", "dashboard")]])
  );
});

bot.action("stopall", async (ctx) => {
  if (!auth(ctx)) return void ctx.answerCbQuery("Akses ditolak", { show_alert: true });
  await ctx.answerCbQuery("Stopping all...");
  await ctx.reply(await stopAll());
});

bot.catch((err) => console.error("Telegram bot error:", err));

async function updatePeriodicMessage() {
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
  } catch {
    periodicMessage = null;
  }

  const sent = await bot.telegram.sendMessage(adminId, text, {
    parse_mode: "HTML",
    ...markup,
  });
  periodicMessage = { chatId: adminId, messageId: sent.message_id };
}

const PERIODIC_MS = 15 * 60 * 1000;
setInterval(() => void updatePeriodicMessage(), PERIODIC_MS);

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
      `🥴 <b>${esc(id)}</b> berstatus RUNNING tetapi tidak menulis log selama ${Math.round(HANG_TOLERANCE_MS / 60000)} menit — terindikasi hang. Restart terawasi dijalankan.`
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
bot.launch(() => {
  if (onLaunchLogged) return;
  onLaunchLogged = true;
  console.log("🤖 Telegram Dashboard v3 aktif.");
  console.log("📊 Pagination: 10 akun per halaman.");
  console.log("⏱️ Status otomatis setiap 15 menit.");
  console.log("📊 Ringkasan harian: /ringkasan atau tombol 📊 Ringkasan.");
  console.log(
    `🛟 Watchdog hang aktif (log diam > ${HANG_TOLERANCE_MS / 60000} menit), auto-restart maks ${RESTART_MAX_FAILURES}x dengan backoff.`
  );
  setTimeout(() => void updatePeriodicMessage(), 3000);
  if (TEST_MODE) {
    console.log("[TEST] TEST_MODE aktif — self-test berjalan otomatis.");
    setTimeout(() => void runSelfTest(), 2000);
  }
})
  .catch((err) => {
    // Tanpa catch, kegagalan launch (mis. 409 karena instance lama belum
    // melepas getUpdates) bikin proses hidup zombie tanpa jejak.
    console.error("❌ Telegram launch gagal — dashboard berhenti:", err);
    process.exit(1);
  });
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