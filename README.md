# TxODDS Blaze

> A Telegram bot that auto-trades Polymarket over/under goals markets using real-time TxLINE data.

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
- **Storage**: SQLite (`better-sqlite3`) for markets, trades, users
- **Encryption**: AES-256-GCM for Polymarket credentials

## Environment Variables

| Variable | Description | Where to get it |
|----------|-------------|-----------------|
| `TXLINE_JWT` | TxLINE guest JWT (30-day expiry) | `curl -X POST https://txline.txodds.com/auth/guest/start` |
| `TXLINE_API_TOKEN` | TxLINE API token | https://txline-docs.txodds.com/documentation/quickstart |
| `TXLINE_DATA_BASE` | TxLINE API origin | Default: `https://txline.txodds.com` |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token | https://t.me/BotFather → /newbot |
| `BACKEND_SECRET` | AES-256 encryption key (64 hex chars) | `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

## Getting Started

```bash
# Install
pnpm install

# Set env vars
export TXLINE_JWT="<your-guest-jwt>"
export TXLINE_API_TOKEN="<your-api-token>"
export TELEGRAM_BOT_TOKEN="<your-bot-token>"
export BACKEND_SECRET="<64-char-hex-key>"

# Run
pnpm dev
```

## TxLINE Free Tier

Bundle IDs **1** (60s delay) and **12** (real-time) are **free** for World Cup & International Friendlies. No TxL purchase required for hackathon use.

## Performance

The internal pipeline (SSE event → FAK order submission) runs in **sub-5ms**. Polymarket enforces a 1-second hold on live sports markets before matching.

| Metric | Value |
|--------|-------|
| Internal processing (SSE parse → FAK order) | <5ms |
| Polymarket sports/game delay | 1000ms |
| Total time from goal to order matching | ~1005ms |

For a detailed breakdown of every speed optimization — in-memory cache, pre-warmed credentials, deferred SQLite writes, SSE dedup, non-blocking logger, and more — see [`SPEED.md`](./SPEED.md).

## Live Testing

A live end-to-end test was conducted and captured in the [demo video](). The EIP-712 signing pipeline, SSE listener, scraper, and Telegram onboarding all work as designed.

However, after the **2026 World Cup Final** (Spain vs Argentina, July 19), Polymarket's Gamma API no longer lists any `soccer_player_goals` markets that overlap with fixtures TxLINE is streaming. TxLINE's upcoming fixtures are international friendlies (Australia vs Brazil, New Zealand vs India, etc.) — none of which have corresponding player goals markets on Polymarket.

This means **Blaze cannot be tested live** until Polymarket lists player goals markets for a competition that TxLINE is also streaming (e.g., Premier League, La Liga, or the next World Cup qualifiers).

## Notes

- Toss (prediction market) was extracted to `willy_wonka_28/toss-txodds` — a separate standalone project.
- Blaze uses Polygon (not Solana) for Polymarket trading.
- Each user gets their own Polygon wallet, created on first `/start`.
- Polymarket credentials are derived via CLOB API and encrypted at rest.

## License

MIT
