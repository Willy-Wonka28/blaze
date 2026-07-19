# Blaze Speed Optimizations

Every technique Blaze uses to achieve sub-5ms hot path latency
from SSE goal event to FAK order submission.

## 1. In-Memory Cache (cache.ts)

All data needed on the hot path is loaded into JavaScript `Map`s on startup:

- **Active users** (threshold, bet_size, max_exposure, credentials) — no Supabase call during trades
- **Player ID mappings** (TxLINE PlayerId → Polymarket player name) — no SQLite lookup during trades
- **Player markets** (token IDs, prices, tick_size, neg_risk) — no SQLite lookup during trades
- **Fixture names** (fixtureId → "TeamA vs TeamB") — for market discovery broadcasts, cached from scrape
- **Daily spend counters** — tracked in memory, no Supabase query per trade
- **Pre-warmed credentials** — decrypted once at startup, reused on every trade

Memory reads: ~0.0001ms. SQLite reads: ~0.1ms. Supabase HTTP calls: ~50-200ms.

## 2. Credential Pre-Warm (cache.ts + crypto/polymarket.ts)

Each trade needs 4 decrypted values: privateKey, apiKey, apiSecret, passphrase.
Decrypting 4 values with AES-256-GCM costs ~2-5ms per trade.

**Solution**: `warmCreds()` runs after cache init and decrypts ALL users' credentials
into the `warmCredsCache` Map. The hot path reads from the cache — zero decrypt calls.

Fallback: if pre-warm hasn't completed yet (rare, at startup), the trade does
on-demand decrypt and falls through to the slow path. This only happens once.

## 3. SSE Dedup + Exponential Backoff (listener/txline.ts)

**Dedup**: A `Set<string>` tracks `"fixtureId:eventId"` pairs with a 60-second TTL.
Key uses `message.id ?? score.id` — never falls back to `scorerPlayerId`.
If both IDs are absent the event is processed without dedup (logs a warning).
This avoids false dedup when the same player scores multiple times.

**Backoff**: Reconnect delay grows exponentially: `min(5000 × 2^(attempt-1), 120000)`.
Max 10 attempts before broadcasting a Telegram alert to all users.

## 4. Non-Blocking Logger (logger.ts)

`console.log` is synchronous and blocks the event loop waiting for stdout.
Blaze uses `setImmediate()` to defer log writes to the next tick.

The hot path continues unblocked while logs are written asynchronously.
Pipeline timer (`createTimer()`) records checkpoints at call time, emits the
full breakdown asynchronously.

## 5. Fire-and-Forget Writes

- **Trade logging**: `insertTrade()` is called without `await` — errors caught via `.catch()`, never blocks
- **Telegram notifications**: `notifyUserDelayed()` uses `setTimeout(3000)` — decoupled from hot path
- **Goal count tracking**: SQLite write is deferred via `setImmediate()` — trade fires before the write hits disk. Only the SELECT (read) stays on the hot path.

## 6. Only One Network Call on Hot Path

The ONLY network call between goal detection and order placement is the FAK order to Polymarket.
Everything else is in-memory:

```
SSE goal event
  → in-memory player_id_map lookup      (~0µs)
  → SQLite goal count SELECT            (~0.1ms, local read only)
  → in-memory market lookup             (~0µs)
  → in-memory user iteration            (~0µs)
  → in-memory dailySpend check          (~0µs)
  → in-memory credential read           (~0µs, pre-warmed)
  → FAK order to Polymarket             (~100ms, unavoidable)
  → setImmediate: SQLite goal write     (deferred, after trade)
  → fire-and-forget: Supabase + Telegram
```

## 7. Startup Pre-Warm

Before the listener starts, `initCache()` blocks until:

1. All active users loaded from Supabase
2. Today's trade costs fetched for daily exposure counters
3. All player_id_map entries loaded from SQLite
4. All player_markets loaded from SQLite
5. All user credentials pre-warmed (background, non-blocking)

Then the initial Polymarket scrape runs before the SSE stream connects.
This ensures every lookup is in-memory before the first goal event arrives.

## 8. Midnight Cron (No Runtime Surprises)

- Settings changes (threshold, bet_size, max_exposure) are queued as "pending"
- At midnight UTC, pending values become active in Supabase AND the in-memory cache
- Daily spend counters reset to 0
- One-time initial delay, then 24h `setInterval` — no cron daemon needed

## 9. Immediate Onboard to Cache

Newly onboarded users (step 6 done) are inserted into the in-memory cache and their
credentials are pre-warmed immediately — no need to wait for midnight rollover or a
process restart. Their first trade uses warm credentials and the cached user object
instead of paying 4× decrypt + Supabase fetch.

Existing users' settings changes still defer to midnight rollover.

## 10. Scraper Cache Sync

When the scraper runs every 30 minutes:

- Writes to SQLite (persistent storage)
- **AND** updates the in-memory cache maps via `syncPlayerIdToCache()` / `syncMarketsToCache()`
- New markets are immediately available on the hot path without restart

## 11. Market Discovery Broadcast — Change-Only

The scraper tracks previously announced fixture IDs in a module-level `Set<number>`.
Broadcasts fixture list only when new matchups are detected — no spam on every 30-min cycle.

## 12. Broadcast via Cache

`broadcast()` in telegram.ts reads from the in-memory user cache instead of querying Supabase.
No network call to list active users when sending messages.

## 13. Pipeline Timer (logger.ts)

Every goal event traces through `createTimer()` checkpoints:

```
market_lookup → goal_tracking → users_lookup → [per-user] fak_order
```

At pipeline end, `finish()` emits per-stage breakdown:
`Pipeline done in 0.832ms | market_lookup: 0.001ms → goal_tracking: 0.125ms → users_lookup: 0.002ms`

This makes performance regressions immediately visible in logs.

## 14. FAK Order Design

FAK (Fill-and-Kill) means the order fills what's available at best ask and cancels
the remainder. The `price` field acts as a slippage ceiling, not a target.

Polymarket enforces a 1-second hold on live sports markets before matching.
Orders placed during the hold window are queued and matched after the delay.
Blaze's sub-5ms reaction time means it is always first in the queue.

## 15. Test Mode — Zero Setup

`/test` command injects a demo user directly into the in-memory cache.
No Supabase writes, no wallet generation, no credential derivation.

Goal events trigger the full pipeline (market lookup, threshold check, exposure check)
but short-circuit before the FAK order, emitting "Paper Trade" notifications instead.
Market discovery broadcasts work identically.
