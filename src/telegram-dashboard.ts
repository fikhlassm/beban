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
const PAGE_SIZE = 10;
const periodicPageByChat = new Map<number, number>();
let shutdownStarted = false;
let periodicMessage: { chatId: number; messageId: number } | null = null;

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
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return null;
  }
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
  const progress = await readJson<Progress>(path.join(ACCOUNTS_DIR, id, "progress.json"));
  const config = await readJson<Config>(path.join(ACCOUNTS_DIR, id, "config.json"));
  const log = await lastLog(id);
  const running = workers.has(id);

  let icon = running ? "🟢" : "🔴";
  let state = running ? "RUNNING" : "STOPPED";

  if (!running && /temporarily blocked|restricted|action blocked|posting limit|limit posting|dibatasi|diblokir/i.test(log)) {
    state = "LIMIT / BLOCKED";
  } else if (!running && /semua batch selesai/i.test(log)) {
    icon = "🔵";
    state = "COMPLETED";
  }

  const position = progress
    ? `B${progress.batch} • G${progress.groupIdx + 1}`
    : "B1 • G1";

  return {
    id,
    name: config?.name || id,
    icon,
    state,
    position,
    log,
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
  }

  lines.push(
    "",
    "🟢 Running  •  🔴 Stopped/Limit  •  🔵 Completed",
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

async function startWorker(id: string): Promise<string> {
  if (workers.has(id)) return `⚠️ ${id} sudah berjalan.`;

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

  child.stdout?.on("data", (data: Buffer) => {
    console.log(`[${id}] ${data.toString().trimEnd()}`);
  });
  child.stderr?.on("data", (data: Buffer) => {
    console.error(`[${id}] ${data.toString().trimEnd()}`);
  });
  child.on("error", (error) => {
    workers.delete(id);
    console.error(`[${id}] worker error:`, error);
  });
  child.on("exit", (code, signal) => {
    workers.delete(id);
    if (!shutdownStarted) {
      console.log(`[${id}] berhenti. code=${code}, signal=${signal ?? "-"}`);
    }
  });

  return `▶️ ${id} dimulai. Resume otomatis dari progress terakhir.`;
}

async function stopWorker(id: string): Promise<string> {
  const child = workers.get(id);
  if (!child?.pid) return `⚠️ ${id} tidak sedang berjalan.`;

  const pid = child.pid;

  try {
    if (process.platform === "win32") {
      await new Promise<void>((resolve, reject) => {
        const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
          stdio: ["ignore", "ignore", "pipe"],
        });
        let stderr = "";
        killer.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
        killer.once("error", reject);
        killer.once("exit", (code) => {
          if (code === 0 || code === 128) resolve();
          else reject(new Error(stderr.trim() || `taskkill exit ${code}`));
        });
      });
    } else {
      child.kill("SIGTERM");
    }
    return `⏹ ${id} dihentikan.`;
  } catch (error) {
    return `❌ Gagal menghentikan ${id}: ${String(error)}`;
  }
}

async function stopAll(): Promise<string> {
  const ids = [...workers.keys()];
  if (!ids.length) return "⚠️ Tidak ada worker aktif.";
  const out: string[] = [];
  for (const id of ids) out.push(await stopWorker(id));
  return out.join("\n");
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
  await ctx.replyWithHTML(
    `📱 <b>${esc(data.id)}</b>\nStatus: ${data.icon} ${esc(data.state)}\nProgress: ${esc(data.position)}\n${data.log ? `Log: <code>${esc(data.log.slice(-700))}</code>` : ""}`,
    accountKeyboard(id)
  );
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
  const out: string[] = [];
  for (const id of ids) out.push(await startWorker(id));
  await ctx.reply(out.join("\n"));
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

async function shutdown(signal: "SIGINT" | "SIGTERM") {
  if (shutdownStarted) return;
  shutdownStarted = true;
  console.log(`\n🛑 ${signal} diterima. Menghentikan worker...`);
  await stopAll();
  bot.stop(signal);
  process.exit(0);
}

bot.launch().then(() => {
  console.log("🤖 Telegram Dashboard v2 aktif.");
  console.log("📊 Pagination: 10 akun per halaman.");
  console.log("⏱️ Status otomatis setiap 15 menit.");
  setTimeout(() => void updatePeriodicMessage(), 3000);
});

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
