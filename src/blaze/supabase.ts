import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config.js";

let client: SupabaseClient;

export function getSupabase(): SupabaseClient {
  if (!client) {
    client = createClient(config.supabase.url, config.supabase.serviceKey);
  }
  return client;
}

export interface BlazeUser {
  id: number;
  chat_id: number;
  wallet_address: string | null;
  encrypted_private_key: string | null;
  encrypted_api_key: string | null;
  encrypted_api_secret: string | null;
  encrypted_passphrase: string | null;
  funder_address: string | null;
  threshold: number;
  bet_size: number;
  max_exposure: number;
  pending_threshold: number | null;
  pending_bet_size: number | null;
  pending_max_exposure: number | null;
  onboarding_step: number | null;
  is_active: boolean;
  created_at: string;
}

export interface BlazeTrade {
  id: number;
  fixture_id: number;
  player_name: string;
  market_id: string;
  token_id: string | null;
  user_chat_id: number | null;
  action: string;
  price: number;
  size: number;
  cost: number;
  order_id: string | null;
  status: string;
  pnl: number;
  created_at: string;
}

export async function getUserByChatId(chatId: number): Promise<BlazeUser | null> {
  const { data } = await getSupabase()
    .from("blaze_users")
    .select("*")
    .eq("chat_id", chatId)
    .single();
  return data;
}

export async function getAllActiveUsers(): Promise<BlazeUser[]> {
  const { data } = await getSupabase()
    .from("blaze_users")
    .select("*")
    .eq("is_active", true);
  return data ?? [];
}

export async function upsertUser(user: Partial<BlazeUser> & { chat_id: number }): Promise<BlazeUser> {
  const { data, error } = await getSupabase()
    .from("blaze_users")
    .upsert(user, { onConflict: "chat_id" })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateUserByChatId(chatId: number, updates: Partial<BlazeUser>): Promise<void> {
  await getSupabase()
    .from("blaze_users")
    .update(updates)
    .eq("chat_id", chatId);
}

export async function insertTrade(trade: Omit<BlazeTrade, "id" | "created_at">): Promise<BlazeTrade> {
  const { data, error } = await getSupabase()
    .from("blaze_trades")
    .insert(trade)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getUserTradeStats(chatId: number): Promise<{
  totalCount: number;
  totalCost: number;
  totalPnl: number;
  dailyCount: number;
  dailyCost: number;
}> {
  const oneDayAgo = new Date(Date.now() - 86400000).toISOString();
  const [all, daily] = await Promise.all([
    getSupabase()
      .from("blaze_trades")
      .select("cost, pnl")
      .eq("user_chat_id", chatId)
      .eq("status", "completed"),
    getSupabase()
      .from("blaze_trades")
      .select("cost")
      .eq("user_chat_id", chatId)
      .eq("status", "completed")
      .gte("created_at", oneDayAgo),
  ]);
  const allRows = all.data ?? [];
  const dailyRows = daily.data ?? [];
  return {
    totalCount: allRows.length,
    totalCost: allRows.reduce((s: number, t: { cost: number }) => s + t.cost, 0),
    totalPnl: allRows.reduce((s: number, t: { pnl: number }) => s + t.pnl, 0),
    dailyCount: dailyRows.length,
    dailyCost: dailyRows.reduce((s: number, t: { cost: number }) => s + t.cost, 0),
  };
}

export async function getRecentTrades(chatId: number, limit = 5): Promise<BlazeTrade[]> {
  const { data } = await getSupabase()
    .from("blaze_trades")
    .select("*")
    .eq("user_chat_id", chatId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return data ?? [];
}

// Fetch today's completed trade costs per user (for pre-warming the in-memory daily exposure counters)
export async function getTodayTradeCostsByUser(): Promise<Map<number, number>> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const { data } = await getSupabase()
    .from("blaze_trades")
    .select("user_chat_id, cost")
    .eq("status", "completed")
    .gte("created_at", todayStart.toISOString());
  const map = new Map<number, number>();
  for (const row of data ?? []) {
    map.set(row.user_chat_id, (map.get(row.user_chat_id) ?? 0) + row.cost);
  }
  return map;
}

// Rollover: move pending settings to active for all users that have pending values, then clear pending
export async function rolloverPendingSettings(): Promise<number> {
  // Fetch users with pending settings
  const { data: users } = await getSupabase()
    .from("blaze_users")
    .select("chat_id, pending_threshold, pending_bet_size, pending_max_exposure")
    .or("pending_threshold.not.is.null,pending_bet_size.not.is.null,pending_max_exposure.not.is.null");

  if (!users || users.length === 0) return 0;

  for (const u of users) {
    const updates: Record<string, number | null> = {};
    if (u.pending_threshold !== null) {
      updates.threshold = u.pending_threshold;
      updates.pending_threshold = null;
    }
    if (u.pending_bet_size !== null) {
      updates.bet_size = u.pending_bet_size;
      updates.pending_bet_size = null;
    }
    if (u.pending_max_exposure !== null) {
      updates.max_exposure = u.pending_max_exposure;
      updates.pending_max_exposure = null;
    }
    await updateUserByChatId(u.chat_id, updates);
  }
  return users.length;
}
