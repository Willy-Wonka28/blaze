# Technical Documentation

## Core Idea

Blaze is a Telegram bot that auto-trades Polymarket player goals markets using real-time TxLINE score data. It listens to TxLINE's SSE score stream, detects goal events as they happen, and instantly places Fill-and-Kill (FAK) "Yes" buy orders on Polymarket, before the market can react.

The edge is speed. No AI, no LLM, no complex strategy. Just a fast reaction to verified data.

## Business Highlights

- **Target market**: Polymarket `soccer_player_goals` over/under contracts (e.g., "Ferran Torres: 1+ goals")
- **User flow**: Onboard via Telegram → deposit pUSD on Polygon → configure threshold/bet size/exposure → bot auto-trades on goals
- **Revenue model**: Bot trades on behalf of users; each trade uses per-user wallets and encrypted Polymarket credentials
- **Current scope**: World Cup and international friendlies (limited by Polymarket market availability)
- **Deployment**: Single Bun process on Render

## Technical Highlights

| Component | Detail |
|-----------|--------|
| Runtime | Bun + Hono.js (single process) |
| Hot path latency | <5ms (SSE parse → FAK order submission) |
| Polymarket hold | 1000ms (enforced by Polymarket, not Blaze) |
| Storage | SQLite (player markets, goal counts) + Supabase (users, trades) |
| Encryption | AES-256-GCM for Polymarket credentials at rest |
| Wallet | Polygon (viem), auto-generated per user on `/start` |
| Bot framework | Telegraf (Telegram) |

### Hot Path

```
SSE goal event
  → isGoalEvent() check
  → Dedup (fixtureId:eventId, 60s TTL)
  → Resolve player name from cache (sub-µs)
  → Look up market + goal count (SQLite)
  → For each active user: threshold + exposure check
  → FAK order via Polymarket CLOB API
  → Insert trade (fire-and-forget to Supabase)
  → Telegram notification (3s delayed)
```

### Speed Optimizations

1. **In-memory Map cache**: All hot-path data in JS Maps (~0.0001ms reads vs SQLite ~0.1ms vs Supabase HTTP ~50-200ms)
2. **Credential pre-warm**: AES-256-GCM decryption of all users' Polymarket creds at startup
3. **SSE dedup**: `Set<string>` with 60s TTL prevents duplicate trades on reconnect
4. **Exponential backoff**: Reconnect with `min(5000 * 2^(n-1), 120000)`, max 10 attempts
5. **Non-blocking logger**: `setImmediate()` defers console.log writes
6. **Fire-and-forget writes**: `insertTrade()` without `await`; goal counts via `setImmediate()`
7. **Single network call on hot path**: Only the FAK order itself hits the network

## TxLINE Endpoints Used

Base URL: `https://txline.txodds.com`

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/auth/guest/start` | POST | Create guest session, obtain JWT |
| `/api/fixtures/snapshot` | GET | Fetch all fixtures (filtered by competitionId) |
| `/api/scores/stream` | GET (SSE) | Real-time score stream, **the core data source** |
| `/api/scores/snapshot/{fixtureId}` | GET | Score snapshot for a fixture |
| `/api/scores/updates/{fixtureId}` | GET | Score updates for a fixture |
| `/api/scores/updates/{epochDay}/{hourOfDay}/{interval}` | GET | Time-bucketed score updates |
| `/api/scores/historical/{fixtureId}` | GET | Historical scores for a fixture |
| `/api/scores/stat-validation` | GET | Cryptographic Merkle proof for stat values |
| `/api/odds/snapshot/{fixtureId}` | GET | Odds snapshot for a fixture |
| `/api/odds/updates/{epochDay}/{hourOfDay}/{interval}` | GET | Time-bucketed odds updates |
| `/api/odds/stream` | GET (SSE) | Live odds stream (available, not actively consumed by Blaze) |

### Authentication Headers

```
Authorization: Bearer <jwt>
X-Api-Token: <apiToken>
```

### SSE Stream Usage

The score stream (`/api/scores/stream`) is the only SSE endpoint actively consumed. Blaze connects with:
- `Accept: text/event-stream`
- `Last-Event-ID` for resumption on reconnect
- Heartbeat events are skipped
- Only `Action: "goal"` events are processed
