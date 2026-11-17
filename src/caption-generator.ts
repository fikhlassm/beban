/**
 * Template-only caption generator (no LLM).
 * Generates a new caption for each post from the account's base caption,
 * preserving the original URL and claims. Casual Indonesian, no emoji.
 */
import { createHash } from "crypto";
import fs from "fs/promises";
import path from "path";

export interface CaptionContext {
  accountId: string;
  batch: number;
  groupIndex: number;
}

interface CaptionHistoryEntry {
  hash: string;
  text: string;
  groupIndex: number;
  batch: number;
  timestamp: string;
}

const HISTORY_LIMIT = 200;
const MAX_CAPTION_CHARS = 300;
const MIN_CAPTION_CHARS = 20;
const MAX_ATTEMPTS = 6;

const PREFIXES = [
  "",
  "Ready stock! ",
  "Satset ya, ",
  "Murah banget, ",
  "Cek dulu, ",
  "Barangkali masih ada, ",
  "Jangan lewatkan, ",
  "Stok terbatas, ",
];

const SUFFIXES = [
  "",
  " Minat? Chat ya.",
  " Buruan sebelum habis.",
  " Cek sekarang.",
  " Yang butuh, gaskeun.",
  " Link di bawah.",
  " Yang minat langsung aja.",
];

const SYNONYMS: Record<string, string[]> = {
  "murah banget": ["harga miring", "murah parah", "murah bgt"],
  "murah bgt": ["murah parah", "harga miring", "murah banget"],
  "murah parah": ["harga miring", "murah banget", "murah bgt"],
  "siapa tau": ["barangkali", "mungkin", "siapa tahu"],
  "mana tau": ["barangkali", "siapa tau", "mungkin"],
  "kalo masih": ["kalau masih", "jika masih", "kalo masih ada"],
  "kalau masih": ["kalo masih", "jika masih", "kalau masih ada"],
  "jika masih": ["kalau masih", "kalo masih", "jika masih ada"],
  under: ["di bawah", "kisaran"],
  "harga miring": ["murah banget", "murah parah", "murah bgt"],
};

// Kelaim baru tidak boleh muncul kalau tidak ada di base.
const FORBIDDEN_CLAIMS = [
  "garansi",
  "100%",
  "gratis",
  "original",
  "resmi",
  "bonus",
];

const URL_RE = /https?:\/\/\S+/;

function extractUrl(text: string): string | null {
  const m = text.match(URL_RE);
  return m ? m[0].trim() : null;
}

function extractNumbers(text: string): string[] {
  return (text.match(/\d+/g) ?? []).sort();
}

function applySynonyms(text: string, rng: () => number): string {
  let lower = text.toLowerCase();
  for (const [source, targets] of Object.entries(SYNONYMS)) {
    if (lower.includes(source)) {
      const replacement = targets[Math.floor(rng() * targets.length)];
      if (replacement.toLowerCase() === source) continue;
      const re = new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      text = text.replace(re, replacement);
      lower = text.toLowerCase();
    }
  }
  return text;
}

function hashCaption(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

interface HistoryFile {
  entries: CaptionHistoryEntry[];
}

async function historyPath(accountId: string): Promise<string> {
  const accountsDir = path.resolve("accounts");
  return path.join(accountsDir, accountId, "caption-history.json");
}

async function loadHistory(accountId: string): Promise<HistoryFile> {
  try {
    const raw = await fs.readFile(await historyPath(accountId), "utf-8");
    const parsed = JSON.parse(raw) as HistoryFile;
    return { entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch {
    return { entries: [] };
  }
}

async function saveHistory(accountId: string, history: HistoryFile): Promise<void> {
  const trimmed = { entries: history.entries.slice(-HISTORY_LIMIT) };
  await fs.writeFile(await historyPath(accountId), JSON.stringify(trimmed, null, 2));
}

// Base dari humanize-assets.py sudah membawa prefix/suffix; lepas dulu supaya
// variasi baru tidak menumpuk ("Buruan sebelum habis. Buruan sebelum habis.").
function stripKnownAffixes(text: string): string {
  let out = text.trim();
  for (const prefix of PREFIXES) {
    if (prefix && out.toLowerCase().startsWith(prefix.toLowerCase())) {
      out = out.slice(prefix.length).trimStart();
      break;
    }
  }
  for (const suffix of SUFFIXES) {
    if (suffix && out.toLowerCase().endsWith(suffix.toLowerCase())) {
      out = out.slice(0, out.length - suffix.length).trimEnd();
      break;
    }
  }
  return out;
}

function containsPhrase(text: string, phrase: string): boolean {
  const core = phrase.toLowerCase().replace(/[!?.,]+$/g, "").replace(/\s+/g, " ").trim();
  if (!core) return false;
  return text.toLowerCase().replace(/\s+/g, " ").includes(core);
}

function templateCaption(base: string, rng: () => number): string {
  const url = extractUrl(base);
  if (!url) return base;

  let caption = stripKnownAffixes(base.replace(url, "").trim());
  caption = applySynonyms(caption, rng);

  let prefix = PREFIXES[Math.floor(rng() * PREFIXES.length)];
  let suffix = SUFFIXES[Math.floor(rng() * SUFFIXES.length)];
  // Jangan ulang frasa yang sudah ada di caption ("Barangkali masih ada,
  // barangkali masih ada, ...").
  if (containsPhrase(caption, prefix)) prefix = "";
  if (/^Barangkali masih ada/i.test(prefix) && /^(siapa tau|siapa tahu|mana tau|mungkin|barangkali)\b/i.test(caption)) {
    prefix = "";
  }
  if (containsPhrase(caption, suffix)) suffix = "";
  const candidate = `${prefix}${caption}${suffix}`.trim();

  const layouts = [
    `${candidate}\n${url}`,
    `${candidate} ${url}`,
    `${candidate}\n\n${url}`,
  ];
  return layouts[Math.floor(rng() * layouts.length)];
}

function validateCaption(
  generated: string,
  base: string
): { ok: boolean; reason?: string } {
  const url = extractUrl(base);
  if (!url) return { ok: false, reason: "base tanpa URL" };

  const urls = generated.match(new RegExp(URL_RE.source, "g")) ?? [];
  if (urls.length !== 1 || urls[0].trim() !== url) {
    return { ok: false, reason: "URL hilang/berubah" };
  }
  if (generated.length > MAX_CAPTION_CHARS) {
    return { ok: false, reason: "terlalu panjang" };
  }
  if (generated.length < MIN_CAPTION_CHARS && base.length >= MIN_CAPTION_CHARS) {
    return { ok: false, reason: "terlalu pendek" };
  }
  // Emoji check (common ranges).
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(generated)) {
    return { ok: false, reason: "mengandung emoji" };
  }
  // No new numeric claims. URL dibuang di kedua sisi: digit di dalam link
  // (mis. .../2LZeX3ctFf) bukan klaim angka.
  const baseNums = extractNumbers(base.replace(url, "")).join(",");
  const genNums = extractNumbers(generated.replace(url, "")).join(",");
  if (baseNums !== genNums) {
    return { ok: false, reason: "angka berubah" };
  }
  const lower = generated.toLowerCase();
  for (const claim of FORBIDDEN_CLAIMS) {
    if (lower.includes(claim) && !base.toLowerCase().includes(claim)) {
      return { ok: false, reason: `klaim baru: ${claim}` };
    }
  }
  return { ok: true };
}

/**
 * Generate a new caption for this post. Never throws — returns base caption
 * if every attempt fails, so posting always has something to work with.
 */
export async function generateCaption(
  base: string,
  ctx: CaptionContext
): Promise<{ text: string; source: "template" | "base" }> {
  const history = await loadHistory(ctx.accountId);
  const seen = new Set(history.entries.map((e) => e.hash));
  const baseHash = hashCaption(base);

  // Deterministic seed so retries of the same group produce the same caption.
  const seedBase = `${ctx.accountId}:${ctx.batch}:${ctx.groupIndex}`;
  let seedNum = 0;
  for (let i = 0; i < seedBase.length; i++) {
    seedNum = (seedNum * 31 + seedBase.charCodeAt(i)) >>> 0;
  }

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let seed = seedNum + attempt * 7919;
    const rng = () => {
      // xorshift-like PRNG for reproducibility.
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      seed >>>= 0;
      return seed / 0x100000000;
    };

    const candidate = templateCaption(base, rng);
    const check = validateCaption(candidate, base);
    if (!check.ok) continue;
    const hash = hashCaption(candidate);
    if (seen.has(hash)) continue;
    if (hash === baseHash && attempt < MAX_ATTEMPTS - 1) continue;

    history.entries.push({
      hash,
      text: candidate,
      groupIndex: ctx.groupIndex,
      batch: ctx.batch,
      timestamp: new Date().toISOString(),
    });
    await saveHistory(ctx.accountId, history);
    return { text: candidate, source: "template" };
  }

  // All attempts failed — use base as-is (still unique per account thanks to
  // humanize-assets.py) and record it so we can see repeats in history.
  if (!seen.has(baseHash)) {
    history.entries.push({
      hash: baseHash,
      text: base,
      groupIndex: ctx.groupIndex,
      batch: ctx.batch,
      timestamp: new Date().toISOString(),
    });
    await saveHistory(ctx.accountId, history);
  }
  return { text: base, source: "base" };
}
