// Blaze trade executor — player goals hot path.
// When a goal event arrives:
// 1. Look up markets from in-memory cache (sub-microsecond)
// 2. Find next market line to buy
// 3. Iterate cached users (sub-microsecond)
// 4. Fire FAK order (only network call)
// 5. Fire-and-forget: write trade to Supabase, notify Telegram
//
// ZERO network calls except the FAK order itself.

import { getDb, type PlayerMarketRow, type PlayerGoalRow } from "../db.js";
import {
  getMarketsFromCache,
  getActiveUsersFromCache,
  incrementDailySpend,
  type CachedUser,
} from "../cache.js";
import { insertTrade } from "../supabase.js";
import { notifyUserDelayed } from "../bot/telegram.js";
import { config } from "../../config.js";
import { placeFAKOrder } from "./clob.js";
import { decrypt } from "../crypto/aes.js";
import { getWarmCreds } from "../crypto/polymarket.js";
import { log, createTimer } from "../../logger.js";

function utcTimestamp(): string {
  return new Date().toLocaleString("en-US", {
    hour: "numeric", minute: "2-digit", second: "2-digit",
    hour12: true, timeZone: "UTC",
  }) + " UTC";
}

export function handleGoalEvent(
  fixtureId: number,
  playerName: string,
): void {
  const db = getDb();
  const pipelineTimer = createTimer();

  const markets = getMarketsFromCache(fixtureId, playerName);

  pipelineTimer.checkpoint("market_lookup");

  if (markets.length === 0) {
    log("Blaze", `No active markets for ${playerName} in fixture ${fixtureId}`);
    return;
  }

  const goalRow = db.prepare(
    "SELECT * FROM player_goals WHERE fixture_id = ? AND player_name = ?"
  ).get(fixtureId, playerName) as PlayerGoalRow | undefined;

  let previousGoals = goalRow?.goals ?? 0;
  const newGoalCount = previousGoals + 1;

  // Defer the goal-count write — not needed before the FAK order
  setImmediate(() => {
    let gRow = goalRow;
    if (!gRow) {
      db.prepare(
        "INSERT OR IGNORE INTO player_goals (fixture_id, player_name, goals, last_seq) VALUES (?, ?, 0, 0)"
      ).run(fixtureId, playerName);
      gRow = db.prepare(
        "SELECT * FROM player_goals WHERE fixture_id = ? AND player_name = ?"
      ).get(fixtureId, playerName) as PlayerGoalRow;
    }
    db.prepare(
      "UPDATE player_goals SET goals = ? WHERE fixture_id = ? AND player_name = ?"
    ).run(newGoalCount, fixtureId, playerName);
  });

  pipelineTimer.checkpoint("goal_tracking");

  const targetLine = previousGoals + 0.5;
  const targetMarket = markets.find((m) => Math.abs(m.line - targetLine) < 0.01);

  if (!targetMarket) {
    log("Blaze", `No market for line ${targetLine} (${playerName}, fixture ${fixtureId})`);
    return;
  }

  log("Blaze", `${playerName} scored #${newGoalCount} — line ${targetMarket.line} (token: ${targetMarket.token_yes?.slice(0, 12)}...)`);

  const users = getActiveUsersFromCache();
  pipelineTimer.checkpoint("users_lookup");

  let tradesAttempted = 0;

  for (const user of users) {
    const threshold = user.threshold || config.blaze.defaultPrice;
    const betSize = user.betSize || 10;
    const maxExposure = user.maxExposure || 100;

    if (targetMarket.yes_price >= threshold) continue;
    if (user.dailySpend + betSize > maxExposure) continue;

    const shares = Math.floor(betSize / targetMarket.yes_price);
    const ts = utcTimestamp();

    if (!user.isTest) {
      notifyUserDelayed(
        user.chatId,
        `⚽ ${playerName} scored! (goal #${newGoalCount}) — ${ts}\n` +
        `📊 Market: ${playerName} ${targetLine}+ goals\n` +
        `🎯 Price: ${targetMarket.yes_price.toFixed(2)} (threshold: ${threshold.toFixed(2)})`
      );
    }

    if (user.isTest) {
      notifyUserDelayed(
        user.chatId,
        `📝 Paper Trade Placed — ${ts}\n` +
        `Bought ~${shares} shares of ${playerName} O-${targetLine} because he just scored a goal.`
      );
      continue;
    }

    // Fire-and-forget: credential lookup + FAK order
    fireTrade(user, fixtureId, playerName, targetLine, targetMarket, betSize, pipelineTimer)
      .then((orderId) => {
        if (orderId) {
          incrementDailySpend(user.chatId, betSize);
          tradesAttempted++;
        }
      })
      .catch((error) => {
        log("Blaze", `FAK order failed for ${playerName} line ${targetMarket.line}: ${error}`);
        const errorMsg = error instanceof Error ? error.message : "unknown error";
        notifyUserDelayed(user.chatId, `❌ Trade failed for ${playerName} ${targetLine}+: ${errorMsg}`);
      });
  }

  pipelineTimer.finish(`Blaze (${tradesAttempted} trades)`);
}

async function fireTrade(
  user: CachedUser,
  fixtureId: number,
  playerName: string,
  targetLine: number,
  targetMarket: PlayerMarketRow,
  betSize: number,
  _pipelineTimer: ReturnType<typeof createTimer>,
): Promise<string | null> {
  // Pre-warmed creds (set at cache init). Falls back to on-demand decrypt if not cached.
  const warm = getWarmCreds(user.chatId);
  let privateKey: string;
  let apiKey: string;
  let apiSecret: string;
  let passphrase: string;

  if (warm) {
    privateKey = warm.privateKey;
    apiKey = warm.apiKey;
    apiSecret = warm.apiSecret;
    passphrase = warm.passphrase;
  } else {
    if (!user.encryptedPrivateKey) {
      log("Blaze", `No private key for chat ${user.chatId}, skipping`);
      return null;
    }
    if (!user.encryptedApiKey || !user.encryptedApiSecret || !user.encryptedPassphrase) {
      log("Blaze", `No Polymarket credentials for chat ${user.chatId}, skipping`);
      return null;
    }
    const backendSecret = config.blaze.backendSecret;
    [privateKey, apiKey, apiSecret, passphrase] = await Promise.all([
      backendSecret ? decrypt(user.encryptedPrivateKey) : Promise.resolve(user.encryptedPrivateKey),
      backendSecret ? decrypt(user.encryptedApiKey) : Promise.resolve(user.encryptedApiKey),
      backendSecret ? decrypt(user.encryptedApiSecret) : Promise.resolve(user.encryptedApiSecret),
      backendSecret ? decrypt(user.encryptedPassphrase) : Promise.resolve(user.encryptedPassphrase),
    ]);
  }

  const tradeTimer = createTimer();
  const threshold = user.threshold || config.blaze.defaultPrice;

  const orderId = await placeFAKOrder({
    token_id: targetMarket.token_yes || "",
    price: threshold,
    amount: betSize,
    tick_size: targetMarket.tick_size,
    neg_risk: targetMarket.neg_risk === 1,
    apiKey,
    apiSecret,
    passphrase,
    privateKey,
  });
  tradeTimer.checkpoint("fak_order");

  insertTrade({
    fixture_id: fixtureId,
    player_name: playerName,
    market_id: targetMarket.market_id,
    token_id: targetMarket.token_yes,
    user_chat_id: user.chatId,
    action: "buy_yes",
    price: threshold,
    size: betSize,
    cost: betSize,
    order_id: orderId,
    status: "completed",
    pnl: 0,
  }).catch((err) => log("Blaze", `insertTrade failed: ${err}`));

  tradeTimer.finish("Blaze");

  const ts = utcTimestamp();
  const shares = Math.floor(betSize / targetMarket.yes_price);
  notifyUserDelayed(
    user.chatId,
    `⚽ Trade Placed — ${ts}\n` +
    `Bought ~${shares} shares of ${playerName} O-${targetLine} because he just scored a goal.`
  );

  return orderId;
}
