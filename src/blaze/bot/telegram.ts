import { Telegraf, Markup } from "telegraf";
import { config } from "../../config.js";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { createWalletClient, http } from "viem";
import { polygon } from "viem/chains";
import { encrypt, decrypt } from "../crypto/aes.js";
import { deriveAndStoreCredentials } from "../crypto/polymarket.js";
import { log } from "../../logger.js";
import { getDb } from "../db.js";
import { getActiveUsersFromCache, addTestUser, removeTestUser, getCachedFixtureSummary, addRealUserToCache } from "../cache.js";
import {
  getUserByChatId,
  upsertUser,
  updateUserByChatId,
  getUserTradeStats,
  getRecentTrades,
} from "../supabase.js";
import { getBalances, approveExchanges } from "../chain.js";

let bot: Telegraf;
const MIN_PUSD = config.blaze.minPusd;
const MIN_POL = config.blaze.minPol;

function getBot(): Telegraf {
  if (!bot) {
    bot = new Telegraf(config.telegram.botToken);
  }
  return bot;
}

export function broadcast(message: string): void {
  const users = getActiveUsersFromCache();
  for (const user of users) {
    getBot().telegram.sendMessage(user.chatId, message).catch(() => {});
  }
}

export function notifyUser(chatId: number, message: string): void {
  getBot().telegram.sendMessage(chatId, message).catch(() => {});
}

export function notifyUserDelayed(chatId: number, message: string): void {
  setTimeout(() => {
    getBot().telegram.sendMessage(chatId, message).catch((err) => {
      log("Blaze", `Telegram send failed for chat ${chatId}: ${err}`);
    });
  }, 3000);
}

function generateWallet(): { address: string; privateKey: string } {
  const pk = generatePrivateKey();
  const account = privateKeyToAccount(pk);
  return { address: account.address, privateKey: pk };
}

type StepReply = (msg: string, extra?: Record<string, unknown>) => Promise<unknown>;

async function fetchBridgeAddresses(address: string): Promise<{ evm?: string; svm?: string; btc?: string } | null> {
  try {
    const res = await fetch("https://bridge.polymarket.com/deposit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    });
    if (!res.ok) return null;
    const data = await res.json() as { address: { evm?: string; svm?: string; btc?: string } };
    return data.address;
  } catch {
    return null;
  }
}

function stepKeyboard(step: number) {
  if (step === 1) {
    return Markup.inlineKeyboard([
      [Markup.button.callback("✅ I've Sent Funds", "step_1_confirm")],
    ]);
  }
  if (step === 3) {
    return Markup.inlineKeyboard([
      [Markup.button.callback("⏭ Skip \u2192 Step 4", "step_skip_3")],
    ]);
  }
  if (step === 4) {
    return Markup.inlineKeyboard([
      [Markup.button.callback("⏭ Skip \u2192 Step 5", "step_skip_4")],
    ]);
  }
  if (step === 5) {
    return Markup.inlineKeyboard([
      [Markup.button.callback("⏭ Skip \u2192 Step 6", "step_skip_5")],
    ]);
  }
  if (step === 6) {
    return Markup.inlineKeyboard([
      [Markup.button.callback("✅ Start Trading", "step_6_done")],
    ]);
  }
  return Markup.inlineKeyboard([]);
}

function mainKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("📋 Copy Address", "copy_address"), Markup.button.callback("💰 Check Balance", "check_balance")],
    [Markup.button.callback("⚙️ Settings", "settings")],
  ]);
}

const HELP_TEXT =
  "📋 Commands:\n" +
  "📊 /status \u2014 Positions, settings, and wallet\n" +
  "📈 /pnl \u2014 Trade history and profit/loss\n" +
  "🎯 /threshold <value> \u2014 Set max price to trade at\n" +
  "💵 /bet_size <amount> \u2014 Set spend per trade\n" +
  "🛡️ /max_exposure <amount> \u2014 Set daily spending limit\n" +
  "👛 /wallet \u2014 Show your wallet address\n" +
  "💰 /check_balance \u2014 Query pUSD and POL balance\n" +
  "🔄 /withdraw <address> \u2014 Withdraw pUSD to a wallet\n" +
  "⏸️ /stop \u2014 Disable notifications\n" +
  "🔥 /start \u2014 Re-enable bot\n\n" +
  "⚠️ /threshold, /bet_size, and /max_exposure changes take effect at midnight.";

function formatSettings(user: { threshold: number; bet_size: number; max_exposure: number; pending_threshold: number | null; pending_bet_size: number | null; pending_max_exposure: number | null } | null): string {
  if (!user) {
    return (
      "⚙️ Current settings:\n" +
      `  🎯 Threshold: ${config.blaze.defaultPrice}\n` +
      "  💵 Bet size: $10\n" +
      "  🛡️ Max exposure: $100/day\n\n" +
      SETTINGS_TEXT
    );
  }

  const thresholdStr = user.pending_threshold !== null
    ? `${user.threshold} ⏳ \u2192 ${user.pending_threshold} at midnight`
    : `${user.threshold}`;
  const betSizeStr = user.pending_bet_size !== null
    ? `$${user.bet_size} ⏳ \u2192 $${user.pending_bet_size} at midnight`
    : `$${user.bet_size}`;
  const maxExposureStr = user.pending_max_exposure !== null
    ? `$${user.max_exposure}/day ⏳ \u2192 $${user.pending_max_exposure}/day at midnight`
    : `$${user.max_exposure}/day`;

  return (
    "⚙️ Current settings:\n" +
    `  🎯 Threshold: ${thresholdStr}\n` +
    `  💵 Bet size: ${betSizeStr}\n` +
    `  🛡️ Max exposure: ${maxExposureStr}\n` +
    "  ⏰ Changes apply at 12:00 AM UTC\n\n" +
    SETTINGS_TEXT
  );
}

const SETTINGS_TEXT =
  "⚙️ Quick commands:\n" +
  "  🎯 /threshold <value>\n" +
  "  💵 /bet_size <amount>\n" +
  "  🛡️ /max_exposure <amount>";

async function handleCheckBalance(chatId: number, reply: (msg: string, extra?: Record<string, unknown>) => Promise<unknown>): Promise<void> {
  const user = await getUserByChatId(chatId);

  if (!user?.wallet_address) {
    await reply("❌ No wallet found. Use /start to create one.");
    return;
  }

  const balances = await getBalances(user.wallet_address);
  const msg =
    `💰 Balances for <code>${user.wallet_address}</code>\n\n` +
    `💵 pUSD: $${balances.pusd}\n` +
    `⛽ POL: ${balances.pol}\n\n`;

  const buttons = Markup.inlineKeyboard([
    [Markup.button.callback("✅ I've Sent Funds", "step_1_confirm")],
    [Markup.button.callback("💰 Check Balance", "check_balance")],
  ]);
  await reply(msg, { parse_mode: "HTML" as const, ...buttons });
}

async function handleStep1Confirm(chatId: number, reply: StepReply): Promise<void> {
  const user = await getUserByChatId(chatId);
  if (!user?.wallet_address || !user.encrypted_private_key) {
    await reply("❌ No wallet found. Use /start to create one.");
    return;
  }

  const balances = await getBalances(user.wallet_address);
  const pusdNum = parseFloat(balances.pusd);
  const polNum = parseFloat(balances.pol);

  if (pusdNum < MIN_PUSD && polNum < MIN_POL) {
    await reply(
      "❌ Insufficient funds.\n\n" +
      `Need <b>$${MIN_PUSD} pUSD</b> and <b>${MIN_POL} POL</b> (for gas).\n` +
      `Current: $${balances.pusd} pUSD, ${balances.pol} POL\n\n` +
      `Send both to:\n<code>${user.wallet_address}</code>\n\n` +
      "Then tap confirm again.",
      { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("🔄 Check Again", "step_1_confirm")]]) }
    );
    return;
  }

  if (pusdNum < MIN_PUSD) {
    await reply(
      `❌ Insufficient pUSD.\n\n` +
      `Need <b>$${MIN_PUSD} pUSD</b>. Current: $${balances.pusd}\n` +
      `POL is fine (${balances.pol}).\n\n` +
      `Send pUSD to:\n<code>${user.wallet_address}</code>\n\n` +
      "Then tap confirm again.",
      { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("🔄 Check Again", "step_1_confirm")]]) }
    );
    return;
  }

  if (polNum < MIN_POL) {
    await reply(
      `❌ Insufficient POL for gas.\n\n` +
      `Need <b>${MIN_POL} POL</b>. Current: ${balances.pol}\n` +
      `pUSD is fine ($${balances.pusd}).\n\n` +
      `Send POL to:\n<code>${user.wallet_address}</code>\n\n` +
      "Then tap confirm again.",
      { parse_mode: "HTML", ...Markup.inlineKeyboard([[Markup.button.callback("🔄 Check Again", "step_1_confirm")]]) }
    );
    return;
  }

  await reply(
    "✅ Funds confirmed!\n\n" +
    `💵 pUSD: $${balances.pusd}\n` +
    `⛽ POL: ${balances.pol}\n\n` +
    "⚡ Approving pUSD spending on Exchange contracts...",
    { ...Markup.inlineKeyboard([[Markup.button.callback("🔄 Retry", "step_1_confirm")]]) }
  );

  try {
    const privateKey = config.blaze.backendSecret
      ? await decrypt(user.encrypted_private_key)
      : user.encrypted_private_key;

    const txs = await approveExchanges(privateKey);
    await updateUserByChatId(chatId, { onboarding_step: 3 });

    await reply(
      "✅ Funds confirmed! Approvals submitted.\n" +
      `🔗 Exchange V3: <code>${txs.exchange}</code>\n` +
      `🔗 NegRisk V2: <code>${txs.negRisk}</code>\n\n`,
      { parse_mode: "HTML" }
    );

    await showStep3(chatId, reply);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log("Blaze", `Approve failed for chat ${chatId}: ${msg}`);
    await reply(
      `❌ Approval failed: ${msg}\n\nMake sure you have enough POL for gas and try again.`,
      { ...Markup.inlineKeyboard([[Markup.button.callback("🔄 Retry", "step_1_confirm")]]) }
    );
  }
}

async function showStep3(chatId: number, reply: StepReply): Promise<void> {
  const user = await getUserByChatId(chatId);
  const current = user?.threshold ?? config.blaze.defaultPrice;
  await reply(
    "⬇️ <b>Step 3 of 6 \u2014 Price Threshold</b>\n\n" +
    "Max price you're willing to pay per share.\n" +
    "Bot only trades when market price is below this.\n\n" +
    `Current: ${current}\n` +
    'To set, type: <code>/threshold 0.85</code>\n\n' +
    `Or tap Skip to use default (${config.blaze.defaultPrice}).`,
    { parse_mode: "HTML", ...stepKeyboard(3) }
  );
}

async function showStep4(chatId: number, reply: StepReply): Promise<void> {
  const user = await getUserByChatId(chatId);
  const current = user?.bet_size ?? 10;
  await reply(
    "⬇️ <b>Step 4 of 6 \u2014 Bet Size</b>\n\n" +
    "How much pUSD to spend per trade.\n\n" +
    `Current: $${current}\n` +
    'To set, type: <code>/bet_size 10</code>\n\n' +
    "Or tap Skip to use current value.",
    { parse_mode: "HTML", ...stepKeyboard(4) }
  );
}

async function showStep5(chatId: number, reply: StepReply): Promise<void> {
  const user = await getUserByChatId(chatId);
  const current = user?.max_exposure ?? 50;
  await reply(
    "⬇️ <b>Step 5 of 6 \u2014 Daily Limit</b>\n\n" +
    "Max pUSD you're willing to lose per day.\n\n" +
    `Current: $${current}/day\n` +
    'To set, type: <code>/max_exposure 50</code>\n\n' +
    "Or tap Skip to use current value.",
    { parse_mode: "HTML", ...stepKeyboard(5) }
  );
}

async function showStep6(chatId: number, reply: StepReply): Promise<void> {
  const user = await getUserByChatId(chatId);
  await reply(
    "⬇️ <b>Step 6 of 6 \u2014 Review</b>\n\n" +
    `\u2022 🎯 Threshold: ${user?.threshold ?? config.blaze.defaultPrice}\n` +
    `\u2022 💵 Bet size: $${user?.bet_size ?? 10}\n` +
    `\u2022 🛡️ Max exposure: $${user?.max_exposure ?? 50}/day\n\n` +
    "Tap <b>Start Trading</b> to go live!",
    { parse_mode: "HTML", ...stepKeyboard(6) }
  );
}

async function handleStepSkip(chatId: number, fromStep: number): Promise<void> {
  const nextStep = fromStep + 1;
  await updateUserByChatId(chatId, { onboarding_step: nextStep });

  const reply = (msg: string, extra?: Record<string, unknown>) =>
    getBot().telegram.sendMessage(chatId, msg, extra as any);

  if (nextStep === 4) await showStep4(chatId, reply);
  else if (nextStep === 5) await showStep5(chatId, reply);
  else if (nextStep === 6) await showStep6(chatId, reply);
}

async function handleStep6Done(chatId: number): Promise<void> {
  await updateUserByChatId(chatId, { is_active: true, onboarding_step: null });
  addRealUserToCache(chatId).catch((err) => log("Blaze", `Failed to add user to cache after onboarding: ${err}`));
  const reply = (msg: string, extra?: Record<string, unknown>) =>
    getBot().telegram.sendMessage(chatId, msg, extra as any);
  await reply(
    "✅ <b>You're all set!</b>\n\n" +
    "Blaze is now watching for goal events.\n\n" +
    "📊 /status \u2014 Check your config\n" +
    "📖 /help \u2014 All commands",
    { parse_mode: "HTML", ...mainKeyboard() }
  );
}

async function handleStartNewUser(chatId: number): Promise<void> {
  const wallet = generateWallet();

  const encPrivateKey = config.blaze.backendSecret
    ? await encrypt(wallet.privateKey)
    : wallet.privateKey;

  await upsertUser({
    chat_id: chatId,
    wallet_address: wallet.address,
    encrypted_private_key: encPrivateKey,
    threshold: config.blaze.defaultPrice,
    bet_size: 10,
    max_exposure: 50,
    onboarding_step: 1,
  });

  deriveAndStoreCredentials(chatId).catch((err) => {
    log("Blaze", `Credential derivation failed for chat ${chatId}: ${err}`);
  });

  const bridge = await fetchBridgeAddresses(wallet.address);

  let depositInfo = `<code>${wallet.address}</code> (Polygon)\n`;
  if (bridge) {
    if (bridge.evm) {
      depositInfo += "\n\nEVM chains (min vary):\n<code>" + bridge.evm + "</code>";
      depositInfo += "\n  \u2022 Ethereum (min $7)";
      depositInfo += "\n  \u2022 Base / Polygon / Arbitrum (min $2)";
    }
    if (bridge.svm) {
      depositInfo += "\n\nSolana (min $2):\n<code>" + bridge.svm + "</code>";
    }
    if (bridge.btc) {
      depositInfo += "\n\nBitcoin (min $9):\n<code>" + bridge.btc + "</code>";
    }
  }

  const reply = (msg: string, extra?: Record<string, unknown>) =>
    getBot().telegram.sendMessage(chatId, msg, extra as any);

  await reply(
    "🔥 <b>Welcome to Blaze! Step 1 of 6</b>\n\n" +
    "I auto-trade Polymarket player goals markets.\n\n" +
    "👛 <b>Your wallet:</b>\n" + depositInfo + "\n\n" +
    "📥 Send <b>pUSD</b> (for trading) + a tiny amount of <b>POL</b> (for gas \u2248" + String(MIN_POL) + ") to any address above.\n\n" +
    'When done, tap <b>"I\'ve Sent Funds"</b> and I\'ll check the chain.',
    { parse_mode: "HTML", ...stepKeyboard(1) }
  );
}

async function handleStartExistingUser(chatId: number, user: Awaited<ReturnType<typeof getUserByChatId>>): Promise<void> {
  const reply = (msg: string, extra?: Record<string, unknown>) =>
    getBot().telegram.sendMessage(chatId, msg, extra as any);

  if (!user) return;

  const step = user.onboarding_step;

  if (step === null || step === undefined || step >= 6) {
    await updateUserByChatId(chatId, { is_active: true });
    await reply(
      "🔥 Welcome back!\n\n" +
      `👛 Wallet: <code>${user.wallet_address || "Not set"}</code>\n\n` +
      "Use the buttons below or type /help to see commands.",
      { parse_mode: "HTML", ...mainKeyboard() }
    );
    return;
  }

  if (step === 2) {
    await updateUserByChatId(chatId, { onboarding_step: 2 });
    await reply("⬇️ <b>Step 2 of 6 \u2014 Confirm Deposit</b>\n\nTap \"I've Sent Funds\" to check.", { parse_mode: "HTML", ...stepKeyboard(1) });
    return;
  }

  if (step === 3) {
    await showStep3(chatId, reply);
    return;
  }

  if (step === 4) {
    await showStep4(chatId, reply);
    return;
  }

  if (step === 5) {
    await showStep5(chatId, reply);
    return;
  }

  if (step === 1) {
    await reply(
      "⬇️ <b>Step 1 of 6 \u2014 Deposit Funds</b>\n\n" +
      `Send pUSD + POL to:\n<code>${user.wallet_address}</code>\n\n` +
      "Then tap confirm.",
      { parse_mode: "HTML", ...stepKeyboard(1) }
    );
  }
}

export function initBot(): void {
  const b = getBot();

  b.start(async (ctx) => {
    const chatId = ctx.chat.id;
    removeTestUser(chatId);
    const existing = await getUserByChatId(chatId);

    if (!existing) {
      await handleStartNewUser(chatId);
    } else {
      await handleStartExistingUser(chatId, existing);
    }
  });

  b.command("test", async (ctx) => {
    const chatId = ctx.chat.id;
    const summary = getCachedFixtureSummary();

    if (summary.marketCount === 0) {
      await ctx.reply("⏳ Scraper still initializing... markets will appear shortly.");
      return;
    }

    addTestUser(chatId);

    await ctx.reply(
      "⚡ Test Mode Engaged\n\n" +
      `📡 Watching ${summary.marketCount} markets across ${summary.fixtureCount} fixtures\n` +
      summary.fixtureNames.map(n => `  ⚽ ${n}`).join("\n") +
      "\n\nNo wallet or funding needed. Goal events will show paper trades."
    );
  });

  b.action("step_1_confirm", async (ctx) => {
    await ctx.answerCbQuery("Checking funds...");
    await updateUserByChatId(ctx.chat!.id, { onboarding_step: 2 });
    await handleStep1Confirm(ctx.chat!.id, (msg, extra) => ctx.reply(msg, extra ?? {}));
  });

  b.action("step_skip_3", async (ctx) => {
    await ctx.answerCbQuery("Skipping to Step 4...");
    await handleStepSkip(ctx.chat!.id, 3);
  });

  b.action("step_skip_4", async (ctx) => {
    await ctx.answerCbQuery("Skipping to Step 5...");
    await handleStepSkip(ctx.chat!.id, 4);
  });

  b.action("step_skip_5", async (ctx) => {
    await ctx.answerCbQuery("Skipping to Step 6...");
    await handleStepSkip(ctx.chat!.id, 5);
  });

  b.action("step_6_done", async (ctx) => {
    await ctx.answerCbQuery("Starting Blaze...");
    await handleStep6Done(ctx.chat!.id);
  });

  b.action("copy_address", async (ctx) => {
    await ctx.answerCbQuery();
    const user = await getUserByChatId(ctx.chat!.id);
    if (user?.wallet_address) {
      await ctx.reply("👛 Your wallet:\n<code>" + user.wallet_address + "</code>", { parse_mode: "HTML" });
    }
  });

  b.action("check_balance", async (ctx) => {
    await ctx.answerCbQuery("Checking balance...");
    const buttons = Markup.inlineKeyboard([
      [Markup.button.callback("✅ I've Sent Funds", "step_1_confirm")],
      [Markup.button.callback("💰 Check Balance", "check_balance")],
    ]);
    await handleCheckBalance(ctx.chat!.id, (msg) => ctx.reply(msg, { parse_mode: "HTML", ...buttons }));
  });

  b.action("settings", async (ctx) => {
    await ctx.answerCbQuery();
    const user = await getUserByChatId(ctx.chat!.id);
    await ctx.reply(formatSettings(user));
  });

  b.command("stop", async (ctx) => {
    await updateUserByChatId(ctx.chat.id, { is_active: false });
    await ctx.reply("⏸️ Bot deactivated. Use /start to re-enable.");
  });

  b.command("status", async (ctx) => {
    const chatId = ctx.chat.id;
    const user = await getUserByChatId(chatId);
    const stats = await getUserTradeStats(chatId);

    const db = getDb();
    const markets = db.prepare(
      "SELECT COUNT(*) as count FROM player_markets WHERE accepting_orders = 1"
    ).get() as { count: number };

    const thresholdStr = user?.pending_threshold !== null && user?.pending_threshold !== undefined
      ? `${user?.threshold ?? config.blaze.defaultPrice} ⏳ \u2192 ${user.pending_threshold}`
      : `${user?.threshold ?? config.blaze.defaultPrice}`;
    const betSizeStr = user?.pending_bet_size !== null && user?.pending_bet_size !== undefined
      ? `$${user?.bet_size ?? 10} ⏳ \u2192 $${user.pending_bet_size}`
      : `$${user?.bet_size ?? 10}`;
    const maxExposureStr = user?.pending_max_exposure !== null && user?.pending_max_exposure !== undefined
      ? `$${user?.max_exposure ?? 50}/day ⏳ \u2192 $${user.pending_max_exposure}/day`
      : `$${user?.max_exposure ?? 50}/day`;

    const status = [
      `📊 Trades today: ${stats.dailyCount} ($${stats.dailyCost.toFixed(2)} spent)`,
      `📈 Active player goal markets: ${markets.count}`,
      "",
      "⚙️ Settings:",
      `  🎯 Threshold: ${thresholdStr}`,
      `  💵 Bet size: ${betSizeStr}`,
      `  🛡️ Max exposure: ${maxExposureStr}`,
      `  ⚡ Status: ${user?.is_active ? "Active" : "Inactive"}`,
      "  ⏰ Changes apply at 12:00 AM UTC",
      "",
      `👛 Wallet: ${user?.wallet_address || "Not set"}`,
    ].join("\n");

    await ctx.reply(status);
  });

  b.command("threshold", async (ctx) => {
    const chatId = ctx.chat.id;
    const arg = ctx.message.text.split(" ")[1];
    const value = arg ? parseFloat(arg) : undefined;

    if (value === undefined || isNaN(value)) {
      const user = await getUserByChatId(chatId);
      await ctx.reply("🎯 Current threshold: " + (user?.threshold ?? config.blaze.defaultPrice) + "\n\nUsage: /threshold <0.01-1.00>\nBot only trades when market price is below this value.\n\n⚠️ Changes take effect at midnight.");
      return;
    }

    if (value < 0.01 || value > 1) {
      await ctx.reply("❌ Threshold must be between 0.01 and 1.00.");
      return;
    }

    const current = await getUserByChatId(chatId);
    await updateUserByChatId(chatId, { pending_threshold: value });

    if (current && current.onboarding_step === 3) {
      await updateUserByChatId(chatId, { onboarding_step: 4 });
      await ctx.reply("✅ Threshold set to " + value.toFixed(2));
      const reply = (msg: string, extra?: Record<string, unknown>) => ctx.reply(msg, extra ?? {});
      await showStep4(chatId, reply);
    } else {
      await ctx.reply("✅ Threshold updated to " + value.toFixed(2) + "\n⏰ Takes effect at midnight.\nCurrently active: " + (current?.threshold ?? config.blaze.defaultPrice));
    }
  });

  b.command("bet_size", async (ctx) => {
    const chatId = ctx.chat.id;
    const arg = ctx.message.text.split(" ")[1];
    const value = arg ? parseFloat(arg) : undefined;

    if (value === undefined || isNaN(value)) {
      const user = await getUserByChatId(chatId);
      await ctx.reply("💵 Current bet size: $" + (user?.bet_size ?? 10) + "\n\nUsage: /bet_size <amount>\nAmount spent per trade.\n\n⚠️ Changes take effect at midnight.");
      return;
    }

    if (value <= 0) {
      await ctx.reply("❌ Bet size must be greater than 0.");
      return;
    }

    const current = await getUserByChatId(chatId);
    await updateUserByChatId(chatId, { pending_bet_size: value });

    if (current && current.onboarding_step === 4) {
      await updateUserByChatId(chatId, { onboarding_step: 5 });
      await ctx.reply("✅ Bet size set to $" + value.toFixed(2));
      const reply = (msg: string, extra?: Record<string, unknown>) => ctx.reply(msg, extra ?? {});
      await showStep5(chatId, reply);
    } else {
      await ctx.reply("✅ Bet size updated to $" + value.toFixed(2) + "\n⏰ Takes effect at midnight.\nCurrently active: $" + (current?.bet_size ?? 10));
    }
  });

  b.command("max_exposure", async (ctx) => {
    const chatId = ctx.chat.id;
    const arg = ctx.message.text.split(" ")[1];
    const value = arg ? parseFloat(arg) : undefined;

    if (value === undefined || isNaN(value)) {
      const user = await getUserByChatId(chatId);
      await ctx.reply("🛡️ Current max exposure: $" + (user?.max_exposure ?? 50) + "/day\n\nUsage: /max_exposure <amount>\nDaily spending limit.\n\n⚠️ Changes take effect at midnight.");
      return;
    }

    if (value <= 0) {
      await ctx.reply("❌ Max exposure must be greater than 0.");
      return;
    }

    const current = await getUserByChatId(chatId);
    await updateUserByChatId(chatId, { pending_max_exposure: value });

    if (current && current.onboarding_step === 5) {
      await updateUserByChatId(chatId, { onboarding_step: 6 });
      await ctx.reply("✅ Max exposure set to $" + value.toFixed(2) + "/day");
      const reply = (msg: string, extra?: Record<string, unknown>) => ctx.reply(msg, extra ?? {});
      await showStep6(chatId, reply);
    } else {
      await ctx.reply("✅ Max exposure updated to $" + value.toFixed(2) + "/day\n⏰ Takes effect at midnight.\nCurrently active: $" + (current?.max_exposure ?? 50) + "/day");
    }
  });

  b.command("wallet", async (ctx) => {
    const user = await getUserByChatId(ctx.chat.id);

    if (!user?.wallet_address) {
      await ctx.reply("❌ No wallet found. Use /start to create one.");
      return;
    }

    await ctx.reply(
      "👛 Your Polygon wallet:\n<code>" + user.wallet_address + "</code>\n\n" +
      "💰 Send pUSD + POL to this address to start trading.\n" +
      "Tap /check_balance after funding.",
      { parse_mode: "HTML" }
    );
  });

  b.command("pnl", async (ctx) => {
    const chatId = ctx.chat.id;
    const stats = await getUserTradeStats(chatId);
    const recent = await getRecentTrades(chatId, 5);

    const lines = [
      "📈 All-time: " + stats.totalCount + " trades · $" + stats.totalCost.toFixed(2) + " spent · PnL: $" + stats.totalPnl.toFixed(2),
      "📊 Today: " + stats.dailyCount + " trades · $" + stats.dailyCost.toFixed(2) + " spent",
      "",
      recent.length > 0 ? "🕐 Recent trades:" : "No trades yet.",
    ];

    for (const t of recent) {
      const time = new Date(t.created_at).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
      lines.push("  " + time + " · " + t.action + " · $" + t.cost.toFixed(2) + " · " + t.market_id.slice(0, 12) + "...");
    }

    await ctx.reply(lines.join("\n"));
  });

  b.command("check_balance", async (ctx) => {
    const buttons = Markup.inlineKeyboard([
      [Markup.button.callback("✅ I've Sent Funds", "step_1_confirm")],
      [Markup.button.callback("💰 Check Balance", "check_balance")],
    ]);
    await handleCheckBalance(ctx.chat.id, (msg) => ctx.reply(msg, { parse_mode: "HTML", ...buttons }));
  });

  b.command("withdraw", async (ctx) => {
    const chatId = ctx.chat.id;
    const destination = ctx.message.text.split(" ")[1];

    if (!destination) {
      await ctx.reply("📝 Usage: /withdraw <polygon_address>");
      return;
    }

    if (!destination.startsWith("0x") || destination.length !== 42) {
      await ctx.reply("❌ Invalid Polygon address. Must start with 0x and be 42 characters.");
      return;
    }

    const user = await getUserByChatId(chatId);
    if (!user?.encrypted_private_key) {
      await ctx.reply("❌ No wallet found. Use /start to create one.");
      return;
    }

    try {
      const privateKey = config.blaze.backendSecret
        ? await decrypt(user.encrypted_private_key)
        : user.encrypted_private_key;

      const balances = await getBalances(user.wallet_address!);
      const balanceNum = parseFloat(balances.pusd);

      if (balanceNum <= 0) {
        await ctx.reply("💸 No pUSD to withdraw. Fund your wallet first.");
        return;
      }

      await ctx.reply("🔄 Withdrawing $" + balanceNum.toFixed(2) + " pUSD to " + destination + "...");

      const walletClient = createWalletClient({
        account: privateKeyToAccount(privateKey as `0x${string}`),
        chain: polygon,
        transport: http(config.blockchain.rpcUrl),
      });

      const hash = await walletClient.writeContract({
        address: config.polymarket.collateral,
        abi: [
          {
            type: "function",
            name: "transfer",
            inputs: [
              { name: "to", type: "address" },
              { name: "amount", type: "uint256" },
            ],
            outputs: [{ name: "", type: "bool" }],
            stateMutability: "nonpayable",
          },
        ],
        functionName: "transfer",
        args: [destination as `0x${string}`, BigInt(Math.floor(balanceNum * 1e6))],
      });

      await ctx.reply(
        "✅ Withdrawal submitted!\n" +
        "💵 Amount: $" + balanceNum.toFixed(2) + " pUSD\n" +
        "📍 To: " + destination + "\n" +
        "🔗 Tx: " + hash
      );
    } catch (err) {
      log("Blaze", `Withdrawal failed for chat ${chatId}: ${err}`);
      await ctx.reply("❌ Withdrawal failed: " + (err instanceof Error ? err.message : "unknown error"));
    }
  });

  b.command("help", async (ctx) => {
    await ctx.reply(HELP_TEXT, { parse_mode: "HTML" });
  });

  b.catch((err, ctx) => {
    log("Blaze", `Bot error for ${ctx.updateType}: ${err instanceof Error ? err.message : String(err)}`);
  });

  b.telegram.setMyCommands([
    { command: "start", description: "Create wallet / re-enable bot" },
    { command: "stop", description: "Disable notifications" },
    { command: "status", description: "Positions, settings, and wallet" },
    { command: "pnl", description: "Trade history and profit/loss" },
    { command: "threshold", description: "Set max price to trade at" },
    { command: "bet_size", description: "Set spend per trade" },
    { command: "max_exposure", description: "Set daily spending limit" },
    { command: "wallet", description: "Show your wallet address" },
    { command: "check_balance", description: "Query pUSD and POL balance" },
    { command: "withdraw", description: "Withdraw pUSD to a wallet" },
    { command: "help", description: "Show commands" },
  ]);

  b.launch();
  log("Blaze", "Bot initialized");
}
