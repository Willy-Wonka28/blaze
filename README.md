# TxODDS Blaze

> A Telegram bot that auto-trades Polymarket over/under goals markets using real-time TxLINE data.

[▶️ **Watch Demo**](https://drive.google.com/file/d/1zKTwluycIhENR2ppCDvg7BUpzvTEiyyc/view?usp=sharing)

[🤖 **Try the Bot**](https://t.me/blaze_sport_bot)

## What It Does

Blaze listens to TxLINE's live score stream. When a goal is scored in a World Cup match, it instantly buys "Yes" contracts on Polymarket's over/under goals markets — before the market reacts. The edge is **speed**.

**No AI. No LLM. No complex strategy.** Just a fast reaction to verified data.

## How It Works

```
1. Pre-match: Search Polymarket Gamma API for O/U totals markets → cache in SQLite
2. Match starts: Listener connects to TxLINE SSE score stream
3. Goal detected: Identify scored player, look up market in DB
4. Trade: If price < threshold → buy YES via Polymarket CLOB API (FAK order)
5. Telegram: Notify user of trade placement, missed opportunities, etc.
```

## How to Test (for TxODDS Hackathon Judges)

Blaze is currently in a **live-data gap**: the World Cup is over and Polymarket hasn't yet listed `soccer_player_goals` markets for the next season. However, every subsystem can be verified:

### 1. `/test` (Paper Trade Mode)
Send `/test` to the Telegram bot. Blaze injects a demo user into the in-memory cache and prints active markets. When a goal event arrives, paper trade notifications fire instead of real FAK orders (no wallet or funding needed). If no markets are present yet (scraper still warming up), Blaze tells you.

### 2. Speed Optimizations
See [`SPEED.md`](./SPEED.md) for the full breakdown of sub-5ms hot path techniques — in-memory cache, pre-warmed credentials, deferred SQLite writes, SSE dedup, non-blocking logger, and more.

## Architecture

```
┌─────────────────────────────────────────────────┐
│              TxLINE Score Stream                 │
│  /api/scores/stream → SSE (real-time)           │
│  Goal events: action, player, minute, fixture   │
└──────────────────────┬──────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────┐
│              Bot Core (Bun + Hono)               │
│  ┌──────────────────────────────────────────┐   │
│  │  Telegram Bot                             │   │
│  │  - /start → create wallet                 │   │
│  │  - /settings → threshold, bet size, etc.  │   │
│  │  - Notifies on trades, discoveries, etc.  │   │
│  └──────────────────────────────────────────┘   │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │  Polymarket Scraper                       │   │
│  │  - Fetches O/U totals markets (Gamma API) │   │
│  │  - Maps team names → TxLINE fixture IDs   │   │
│  │  - Caches in SQLite, refreshes every 30m  │   │
│  └──────────────────────────────────────────┘   │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │  TxLINE Listener                         │   │
│  │  - SSE connection with backoff            │   │
│  │  - Filters for goal events only           │   │
│  │  - Extracts player name from action       │   │
│  └──────────────────────────────────────────┘   │
│                                                  │
│  ┌──────────────────────────────────────────┐   │
│  │  Trade Executor                          │   │
│  │  - Look up player's market in SQLite      │   │
│  │  - Check yes_price < threshold            │   │
│  │  - Execute FAK order via CLOB API         │   │
│  │  - Per-user encrypted Polymarket creds    │   │
│  └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

## Settings

Users configure the bot via Telegram's `/settings` command:
- **Threshold**: Max yes_price to buy at (default: 0.99)
- **Bet Size**: Fixed USDC amount per trade (default: $10)
- **Max Exposure**: Total daily spend cap (default: $100)

## Project Structure

```
tx0dds/
├── packages/
│   ├── txline-client/          # Shared TxLINE API client
│   │   └── src/
│   │       ├── client.ts       # REST API client
│   │       ├── stream.ts       # SSE parser + reader
│   │       ├── helpers.ts      # isGoalEvent, isMatchFinal, etc.
│   │       ├── token-manager.ts
│   │       └── types.ts        # Shared types
│   └── backend/
│       └── src/
│           ├── index.ts        # Entry point (Hono + blaze boot)
│           ├── config.ts       # Env var validation
│           ├── logger.ts       # Async logger with pipeline timing
│           ├── serve.ts        # HTTP server bootstrap
│           └── blaze/
│               ├── index.ts    # Blaze subsystem orchestrator
│               ├── db.ts       # SQLite schema (markets, trades, users)
│               ├── bot/
│               │   └── telegram.ts   # Bot commands + notifications
│               ├── scraper/
│               │   └── polymarket.ts # Gamma API O/U market scraper
│               ├── listener/
│               │   └── txline.ts     # Goal event detection
│               ├── executor/
│               │   ├── clob.ts       # Polymarket CLOB FAK orders
│               │   └── trader.ts     # Goal → trade pipeline
│               └── crypto/
│                   ├── aes.ts        # AES-256-GCM encryption
│                   └── polymarket.ts # CLOB credential derivation
├── data/blaze.db               # SQLite database (runtime)
├── package.json
├── tsconfig.base.json
└── pnpm-workspace.yaml
```

## Tech Stack

- **Runtime**: Bun + Hono.js
- **TxLINE**: SSE streaming via `@txodds/txline-client`
- **Polymarket**: Gamma API (scraper) + CLOB API (trades) via `@polymarket/clob-client`
- **Telegram**: `telegraf` bot framework
- **Polygon Wallet**: `viem` (auto-created per user on `/start`)
- **Storage**: SQLite (`better-sqlite3`) for player markets + goal tracking; Supabase for users, trades, and settings persistence
- **Encryption**: AES-256-GCM for Polymarket credentials

## Performance

The internal pipeline (SSE event → FAK order submission) runs in **sub-5ms**. Polymarket enforces a 1-second hold on live sports markets before matching.

| Metric | Value |
|--------|-------|
| Internal processing (SSE parse → FAK order) | <5ms |
| Polymarket sports/game delay | 1000ms |
| Total time from goal to order matching | ~1005ms |

For a detailed breakdown of every speed optimization — in-memory cache, pre-warmed credentials, deferred SQLite writes, SSE dedup, non-blocking logger, and more — see [`SPEED.md`](./SPEED.md).

## Live Testing

A live end-to-end test was conducted and captured in the demo video submitted. The EIP-712 signing pipeline, SSE listener, scraper, and Telegram onboarding all work as designed.

However, after the **2026 World Cup Final** (Spain vs Argentina, July 19), Polymarket's Gamma API no longer lists any `soccer_player_goals` markets that overlap with fixtures TxLINE is streaming. TxLINE's upcoming fixtures are international friendlies (Australia vs Brazil, New Zealand vs India, etc.) — none of which have corresponding player goals markets on Polymarket.

This means **Blaze cannot be tested live** until Polymarket lists player goals markets for a competition that TxLINE is also streaming (e.g., Premier League, La Liga, or the next World Cup qualifiers).

## Notes

- Blaze uses Polygon (not Solana) for Polymarket trading.
- Each user gets their own Polygon wallet, created on first `/start`.
- Polymarket credentials are derived via CLOB API and encrypted at rest.
