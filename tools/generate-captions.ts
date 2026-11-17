import fs from "fs/promises";
import path from "path";
import { generateCaption } from "../src/caption-generator";

const ACCOUNTS_DIR = path.resolve("accounts");
const MAX_TRIES = 5;

async function accountIds(): Promise<string[]> {
  try {
    const entries = await fs.readdir(ACCOUNTS_DIR, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

async function batchNumbers(accountId: string): Promise<number[]> {
  try {
    const entries = await fs.readdir(
      path.join(ACCOUNTS_DIR, accountId, "content"),
      { withFileTypes: true }
    );
    return entries
      .filter((e) => e.isDirectory() && /^\d+$/.test(e.name))
      .map((e) => Number(e.name))
      .sort((a, b) => a - b);
  } catch {
    return [];
  }
}

async function baseCaption(batchDir: string): Promise<string | null> {
  const backup = path.join(batchDir, "text-original.txt");
  try {
    return await fs.readFile(backup, "utf-8");
  } catch {}

  try {
    const current = await fs.readFile(path.join(batchDir, "text.txt"), "utf-8");
    await fs.writeFile(backup, current, "utf-8");
    return current;
  } catch {
    return null;
  }
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

async function main(): Promise<void> {
  for (const accountId of await accountIds()) {
    for (const batch of await batchNumbers(accountId)) {
      const batchDir = path.join(ACCOUNTS_DIR, accountId, "content", String(batch));
      const current = await fs
        .readFile(path.join(batchDir, "text.txt"), "utf-8")
        .catch(() => null);
      if (current === null) continue;

      const base = await baseCaption(batchDir);
      if (!base) continue;

      let next = current;
      for (let i = 0; i < MAX_TRIES; i++) {
        const gen = await generateCaption(base, { accountId, batch, groupIndex: 0 });
        next = gen.text;
        if (next !== current) break;
      }

      if (next === current) {
        console.log(`SKIP ${accountId} B${batch} (caption tidak berubah)`);
        continue;
      }

      await fs.writeFile(path.join(batchDir, "text.txt"), next, "utf-8");
      console.log(`OK ${accountId} B${batch}: ${oneLine(next).slice(0, 90)}`);
    }
  }
}

void main();
