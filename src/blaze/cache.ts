// In-memory cache — the single source of truth on the hot path.
// Loaded on startup, refreshed at midnight.
// Goal: zero network calls between SSE event and FAK order placement.

import { getDb, type PlayerMarketRow } from "./db.js";
import {
  getAllActiveUsers,
  getTodayTradeCostsByUser,
  rolloverPendingSettings,
} from "./supabase.js";
import { setWarmCreds } from "./crypto/polymarket.js";
import { decrypt } from "./crypto/aes.js";
import { config } from "../config.js";
import { log } from "../logger.js";

export interface CachedUser {
  chatId: number;
  threshold: number;
  betSize: number;
  maxExposure: number;
  isActive: boolean;
  isTest?: boolean;
  dailySpend: number;
  encryptedApiKey: string | null;
  encryptedApiSecret: string | null;
  encryptedPassphrase: string | null;
  encryptedPrivateKey: string | null;
}

// In-memory stores
const userCache = new Map<number, CachedUser>();
const playerNameMap = new Map<string, string>(); // "fixtureId:externalId" → playerName
const marketCache = new Map<string, PlayerMarketRow[]>(); // "fixtureId:playerName" → markets
const fixtureNameCache = new Map<number, string>(); // fixtureId → "TeamA vs TeamB"

function marketKey(fixtureId: number, playerName: string): string {
  return `${fixtureId}:${playerName}`;
}

function idMapKey(fixtureId: number, externalId: string): string {
  return `${fixtureId}:${externalId}`;
}

// ── Init ────────────────────────────────────────────────────────

export async function initCache(): Promise<void> {
  const t0 = performance.now();

  // 1. Load active users from Supabase
  const users = await getAllActiveUsers();
  const dailyCosts = await getTodayTradeCostsByUser();

  userCache.clear();
  for (const u of users) {
    userCache.set(u.chat_id, {
      chatId: u.chat_id,
      threshold: u.threshold,
      betSize: u.bet_size,
      maxExposure: u.max_exposure,
      isActive: u.is_active,
      dailySpend: dailyCosts.get(u.chat_id) ?? 0,
      encryptedApiKey: u.encrypted_api_key,
      encryptedApiSecret: u.encrypted_api_secret,
      encryptedPassphrase: u.encrypted_passphrase,
      encryptedPrivateKey: u.encrypted_private_key,
    });
  }

  // 2. Load player_id_map from SQLite
  const db = getDb();
  const idMappings = db.prepare("SELECT * FROM player_id_map").all() as Array<{
    fixture_id: number;
    external_id: string;
    player_name: string;
  }>;
  playerNameMap.clear();
  for (const m of idMappings) {
    playerNameMap.set(idMapKey(m.fixture_id, m.external_id), m.player_name);
  }

  // 3. Load player_markets from SQLite
  const markets = db.prepare("SELECT * FROM player_markets WHERE accepting_orders = 1").all() as PlayerMarketRow[];
  marketCache.clear();
  for (const m of markets) {
    const key = marketKey(m.fixture_id, m.player_name);
    if (!marketCache.has(key)) marketCache.set(key, []);
    marketCache.get(key)!.push(m);
  }

  const elapsed = (performance.now() - t0).toFixed(1);
  log("Blaze", `Cache warm: ${userCache.size} users, ${marketCache.size} player markets, ${playerNameMap.size} ID mappings [${elapsed}ms]`);

  // Pre-warm credential decryption so no trade pays the 4x decrypt cost
  warmCreds().catch((err) => log("Blaze", `Credential pre-warm failed: ${err}`));
}

// ── Hot path reads (zero network) ──────────────────────────────

export function resolvePlayerNameFromCache(fixtureId: number, externalId: string): string | null {
  const decimalId = String(externalId);
  const hexId = "0x" + Number(externalId).toString(16);
  return playerNameMap.get(idMapKey(fixtureId, decimalId))
    ?? playerNameMap.get(idMapKey(fixtureId, hexId))
    ?? null;
}

export function getMarketsFromCache(fixtureId: number, playerName: string): PlayerMarketRow[] {
  return marketCache.get(marketKey(fixtureId, playerName)) ?? [];
}

export function getActiveUsersFromCache(): CachedUser[] {
  const active: CachedUser[] = [];
  for (const u of userCache.values()) {
    if (u.isActive) active.push(u);
  }
  return active;
}

export function getUserFromCache(chatId: number): CachedUser | undefined {
  return userCache.get(chatId);
}

export function incrementDailySpend(chatId: number, amount: number): void {
  const u = userCache.get(chatId);
  if (u) u.dailySpend += amount;
}

export function addTestUser(chatId: number): void {
  userCache.set(chatId, {
    chatId,
    threshold: config.blaze.defaultPrice,
    betSize: 10,
    maxExposure: 100,
    isActive: true,
    isTest: true,
    dailySpend: 0,
    encryptedApiKey: null,
    encryptedApiSecret: null,
    encryptedPassphrase: null,
    encryptedPrivateKey: null,
  });
}

export function removeTestUser(chatId: number): void {
  userCache.delete(chatId);
}

export async function addRealUserToCache(chatId: number): Promise<void> {
  const { getUserByChatId } = await import("./supabase.js");
  const u = await getUserByChatId(chatId);
  if (!u) return;

  userCache.set(chatId, {
    chatId: u.chat_id,
    threshold: u.threshold,
    betSize: u.bet_size,
    maxExposure: u.max_exposure,
    isActive: u.is_active,
    dailySpend: 0,
    encryptedApiKey: u.encrypted_api_key,
    encryptedApiSecret: u.encrypted_api_secret,
    encryptedPassphrase: u.encrypted_passphrase,
    encryptedPrivateKey: u.encrypted_private_key,
  });

  if (u.encrypted_api_key && u.encrypted_api_secret && u.encrypted_passphrase && u.encrypted_private_key) {
    try {
      const [privateKey, apiKey, apiSecret, passphrase] = await Promise.all([
        decrypt(u.encrypted_private_key),
        decrypt(u.encrypted_api_key),
        decrypt(u.encrypted_api_secret),
        decrypt(u.encrypted_passphrase),
      ]);
      setWarmCreds(chatId, { privateKey, apiKey, apiSecret, passphrase });
    } catch (err) {
      log("Blaze", `Failed to warm creds for newly onboarded user ${chatId}: ${err}`);
    }
  }
}

export function syncFixtureNameToCache(fixtureId: number, name: string): void {
  fixtureNameCache.set(fixtureId, name);
}

export function getCachedFixtureSummary(): { fixtureCount: number; marketCount: number; fixtureNames: string[] } {
  const fixtureIds = new Set<number>();
  let marketCount = 0;
  for (const [, markets] of marketCache) {
    for (const m of markets) {
      fixtureIds.add(m.fixture_id);
      marketCount++;
    }
  }
  const fixtureNames = Array.from(fixtureIds)
    .map(id => fixtureNameCache.get(id))
    .filter((n): n is string => !!n);
  return { fixtureCount: fixtureIds.size, marketCount, fixtureNames };
}

// ── Midnight rollover ──────────────────────────────────────────

export async function midnightRollover(): Promise<void> {
  log("Blaze", "Running midnight rollover...");

  // 1. Apply pending settings in Supabase
  const updated = await rolloverPendingSettings();
  log("Blaze", `Rollover: ${updated} users had pending settings applied`);

  // 2. Reset daily spend counters
  for (const u of userCache.values()) {
    u.dailySpend = 0;
  }

  // 3. Re-fetch users to get fresh settings
  const users = await getAllActiveUsers();
  userCache.clear();
  const dailyCosts = await getTodayTradeCostsByUser();

  for (const u of users) {
    userCache.set(u.chat_id, {
      chatId: u.chat_id,
      threshold: u.threshold,
      betSize: u.bet_size,
      maxExposure: u.max_exposure,
      isActive: u.is_active,
      dailySpend: dailyCosts.get(u.chat_id) ?? 0,
      encryptedApiKey: u.encrypted_api_key,
      encryptedApiSecret: u.encrypted_api_secret,
      encryptedPassphrase: u.encrypted_passphrase,
      encryptedPrivateKey: u.encrypted_private_key,
    });
  }

  log("Blaze", `Midnight rollover complete: ${userCache.size} users refreshed, daily exposure reset`);
}

// ── Cache sync (called by scraper after SQLite writes) ─────────

export function syncPlayerIdToCache(fixtureId: number, externalId: string, playerName: string): void {
  playerNameMap.set(idMapKey(fixtureId, externalId), playerName);
}

export function syncMarketsToCache(fixtureId: number, playerName: string, markets: PlayerMarketRow[]): void {
  marketCache.set(marketKey(fixtureId, playerName), markets);
}

// ── Credential pre-warm ─────────────────────────────────────────

async function warmCreds(): Promise<void> {
  const secret = config.blaze.backendSecret;
  if (!secret) return;

  let count = 0;
  for (const [chatId, user] of userCache) {
    if (!user.encryptedPrivateKey || !user.encryptedApiKey || !user.encryptedApiSecret || !user.encryptedPassphrase) continue;
    try {
      const [privateKey, apiKey, apiSecret, passphrase] = await Promise.all([
        decrypt(user.encryptedPrivateKey),
        decrypt(user.encryptedApiKey),
        decrypt(user.encryptedApiSecret),
        decrypt(user.encryptedPassphrase),
      ]);
      setWarmCreds(chatId, { privateKey, apiKey, apiSecret, passphrase });
      count++;
    } catch (err) {
      log("Blaze", `Failed to pre-warm creds for chat ${chatId}: ${err}`);
    }
  }
  log("Blaze", `Pre-warmed credentials for ${count} users`);
}
