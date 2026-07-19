// Blaze entry point — initializes all subsystems in order:
// 1. Telegram bot (sends messages, handles commands)
// 2. Cache warm (load users, markets, ID mappings into memory)
// 3. Polymarket scraper (fetches player goals sub-markets, caches in SQLite + memory)
// 4. TxLINE listener (detects goals, fires trades — all in-memory until FAK order)
// 5. Midnight cron (resets daily exposure, rolls pending settings to active)
//
// Called from index.ts after TxLINE credentials are verified.
// Runs as a background task in the same process as the HTTP API.

import { TxLineClient } from "../txline/index.js";
import { initBot, broadcast } from "./bot/telegram.js";
import { scrapePlayerGoalMarkets } from "./scraper/polymarket.js";
import { startTxLineListener } from "./listener/txline.js";
import { initCache, midnightRollover } from "./cache.js";
import { initDb } from "./db.js";
import { log } from "../logger.js";

const REMINDER_BEFORE_MS = 2 * 3600_000; // 2 hours before midnight

function msUntilMidnight(): number {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setUTCHours(24, 0, 0, 0);
  return midnight.getTime() - now.getTime();
}

export async function startBlaze(client: TxLineClient): Promise<void> {
  log("Blaze", "Starting Blaze...");

  // 0. Initialise SQLite (sql.js — WASM, no native binaries)
  await initDb();

  // 1. Telegram bot
  initBot();

  // 2. Warm cache — load everything into memory before starting the listener
  await initCache();

  // 3. Scrape markets (writes to SQLite + syncs to memory)
  log("Blaze", "Running initial Polymarket player goals scrape...");
  await scrapePlayerGoalMarkets();

  // Re-scrape every 30 minutes
  setInterval(() => {
    log("Blaze", "Scheduled scrape running...");
    scrapePlayerGoalMarkets().catch((err) => log("Blaze", `Scrape error: ${err}`));
  }, 30 * 60 * 1000);

  // 4. Start listener — hot path is now fully in-memory
  log("Blaze", "Starting TxLINE listener...");
  startTxLineListener(client);

  // 5. Midnight cron — rollover pending settings + reset daily exposure
  const delayMs = msUntilMidnight();
  log("Blaze", `Midnight rollover scheduled in ${(delayMs / 3600_000).toFixed(1)}h`);

  // Pre-midnight reminder (~2 hours before rollover)
  if (delayMs > REMINDER_BEFORE_MS) {
    setTimeout(() => {
      broadcast(
        "⏰ Reminder: Any pending settings changes will be applied at midnight UTC (~2 hours).\n" +
        "Place any trades you want under your current settings before the switch."
      );
    }, delayMs - REMINDER_BEFORE_MS);
  }

  setTimeout(() => {
    midnightRollover().catch((err) => log("Blaze", `Midnight rollover error: ${err}`));

    // Then schedule every 24h
    setInterval(() => {
      midnightRollover().catch((err) => log("Blaze", `Midnight rollover error: ${err}`));
    }, 86400_000);
  }, delayMs);

  log("Blaze", "Ready. Listening for goal events...");
}
