# TxODDS Blaze

> A Telegram bot that auto-trades Polymarket over/under goals markets using real-time TxLINE data.

[▶️ **Watch Demo**](https://drive.google.com/file/d/1zKTwluycIhENR2ppCDvg7BUpzvTEiyyc/view?usp=sharing)

[🤖 **Try the Bot**](https://t.me/blaze_sport_bot)

## What It Does

Blaze listens to TxLINE's live score stream. When a goal is scored in a World Cup match, it instantly buys "Yes" contracts on Polymarket's over/under goals markets, before the market reacts. The edge is **speed**.

**No AI. No LLM. No complex strategy.** Just a fast reaction to verified data.

## Target Market

1. **Power Traders** — High-frequency prediction market operators who need sub-5ms execution on live events
2. **Sports Bettors** — Live match followers who want automated entry on goals without manual order placement
3. **Scalpers** — Traders who exploit short-lived price windows on Polymarket before liquidity adjusts

## How It Works

> **Note**: Blaze requires both **TxLINE** (real-time score data) and **Polymarket** (trading markets) to cover the same fixture. The scraper fuzzy-matches team names between the two. If a fixture exists on one but not the other, no trade can fire.

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
See [`SPEED.md`](./SPEED.md) for the full breakdown of sub-5ms hot path techniques, including in-memory cache, pre-warmed credentials, deferred SQLite writes, SSE dedup, non-blocking logger, and more.

## Performance

The internal pipeline (SSE event → FAK order submission) runs in **sub-5ms**. Polymarket enforces a 1-second hold on live sports markets before matching.

| Metric | Value |
|--------|-------|
| Internal processing (SSE parse → FAK order) | <5ms |
| Polymarket sports/game delay | 1000ms |
| Total time from goal to order matching | ~1005ms |

For a detailed breakdown of every speed optimization, including in-memory cache, pre-warmed credentials, deferred SQLite writes, SSE dedup, non-blocking logger, and more, see [`SPEED.md`](./SPEED.md).

## Live Testing

A live end-to-end test was conducted and captured in the demo video submitted. The EIP-712 signing pipeline, SSE listener, scraper, and Telegram onboarding all work as designed.

However, after the **2026 World Cup Final** (Spain vs Argentina, July 19), Polymarket's Gamma API no longer lists any `soccer_player_goals` markets that overlap with fixtures TxLINE is streaming. TxLINE's upcoming fixtures are international friendlies (Australia vs Brazil, New Zealand vs India, etc.), none of which have corresponding player goals markets on Polymarket.

This means **Blaze cannot be tested live** until Polymarket lists player goals markets for a competition that TxLINE is also streaming (e.g., Premier League, La Liga, or the next World Cup qualifiers).
