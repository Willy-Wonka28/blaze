// SQLite for fast local reads on the hot path.
// Users and trades live in Supabase (survives Render restarts).
// This DB stores:
// 1. Player markets (token IDs, prices) — scraped from Polymarket
// 2. Player ID map (TxLINE PlayerId → player name) — built from Polymarket metadata
// 3. Player goal counts (per fixture, per player) — incremented on goal events
//
// Uses sql.js (SQLite compiled to WASM) — no native binaries, runs anywhere.

import initSqlJs from "sql.js";
import type { Database as SqlJsDatabase } from "sql.js";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import { config } from "../config.js";

let db: SqlJsDatabase;
let dbPath: string;

// ── Persistence helpers ──────────────────────────────────────────

function persistDb(): void {
  const data = db.export();
  writeFileSync(dbPath, Buffer.from(data));
}

// ── Initialise ───────────────────────────────────────────────────

export async function initDb(): Promise<void> {
  dbPath = config.blaze.dbPath;

  // Ensure the directory exists
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const SQL = await initSqlJs();

  if (existsSync(dbPath)) {
    const fileBuffer = readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  initSchema();
  persistDb();
}

// ── Compatibility shim ───────────────────────────────────────────
// Wraps sql.js to expose the same .prepare().get() / .run() / .all() API
// as better-sqlite3, so no other files need to change.

type Row = Record<string, unknown>;

interface PreparedStatement {
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  run(...params: unknown[]): void;
}

function sqliteQuery(sql: string): PreparedStatement {
  return {
    get(...params: unknown[]) {
      const stmt = db.prepare(sql);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stmt.bind(params as any[]);
      const hasRow = stmt.step();
      if (!hasRow) { stmt.free(); return undefined; }
      const row = stmt.getAsObject() as Row;
      stmt.free();
      return row;
    },
    all(...params: unknown[]) {
      const stmt = db.prepare(sql);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stmt.bind(params as any[]);
      const rows: Row[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject() as Row);
      }
      stmt.free();
      return rows;
    },
    run(...params: unknown[]) {
      const stmt = db.prepare(sql);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stmt.bind(params as any[]);
      stmt.step();
      stmt.free();
      persistDb();
    },
  };
}

// ── Public DB handle ─────────────────────────────────────────────

export interface DbHandle {
  prepare(sql: string): PreparedStatement;
  exec(sql: string): void;
}

export function getDb(): DbHandle {
  if (!db) throw new Error("DB not initialised — call initDb() first");
  return {
    prepare: sqliteQuery,
    exec(sql: string) {
      db.run(sql);
      persistDb();
    },
  };
}

// ── Schema ───────────────────────────────────────────────────────

function initSchema() {
  db.run(`
    CREATE TABLE IF NOT EXISTS player_markets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fixture_id INTEGER NOT NULL,
      player_name TEXT NOT NULL,
      line REAL NOT NULL,
      market_id TEXT NOT NULL,
      condition_id TEXT,
      token_yes TEXT,
      token_no TEXT,
      optic_odds_player_id TEXT,
      yes_price REAL DEFAULT 0,
      tick_size REAL DEFAULT 0.01,
      neg_risk INTEGER DEFAULT 0,
      accepting_orders INTEGER DEFAULT 1,
      last_updated INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s','now')),
      UNIQUE(fixture_id, player_name, line)
    );

    CREATE TABLE IF NOT EXISTS player_id_map (
      fixture_id INTEGER NOT NULL,
      external_id TEXT NOT NULL,
      player_name TEXT NOT NULL,
      PRIMARY KEY(fixture_id, external_id)
    );

    CREATE TABLE IF NOT EXISTS player_goals (
      fixture_id INTEGER NOT NULL,
      player_name TEXT NOT NULL,
      goals INTEGER DEFAULT 0,
      last_seq INTEGER DEFAULT 0,
      PRIMARY KEY(fixture_id, player_name)
    );

    CREATE INDEX IF NOT EXISTS idx_pm_fixture ON player_markets(fixture_id);
    CREATE INDEX IF NOT EXISTS idx_pm_player ON player_markets(player_name);
    CREATE INDEX IF NOT EXISTS idx_pim_fixture ON player_id_map(fixture_id);
  `);
}

export interface PlayerMarketRow {
  id: number;
  fixture_id: number;
  player_name: string;
  line: number;
  market_id: string;
  condition_id: string | null;
  token_yes: string | null;
  token_no: string | null;
  optic_odds_player_id: string | null;
  yes_price: number;
  tick_size: number;
  neg_risk: number;
  accepting_orders: number;
  last_updated: number;
}

export interface PlayerGoalRow {
  fixture_id: number;
  player_name: string;
  goals: number;
  last_seq: number;
}

// Resolves a TxLINE PlayerId (integer) to a player name using the mapping built
// from Polymarket's opticOddsPlayerId metadata.
// Tries both decimal and hex representations of the ID.
export function resolvePlayerName(fixtureId: number, txlinePlayerId: number): string | null {
  const d = getDb();
  const decimalId = String(txlinePlayerId);
  const hexId = "0x" + txlinePlayerId.toString(16);

  const row = d.prepare(
    "SELECT player_name FROM player_id_map WHERE fixture_id = ? AND (external_id = ? OR external_id = ?)"
  ).get(fixtureId, decimalId, hexId) as { player_name: string } | undefined;

  return row?.player_name ?? null;
}

export function upsertPlayerIdMap(fixtureId: number, externalId: string, playerName: string): void {
  const d = getDb();
  d.prepare(
    "INSERT OR REPLACE INTO player_id_map (fixture_id, external_id, player_name) VALUES (?, ?, ?)"
  ).run(fixtureId, externalId, playerName);
}

