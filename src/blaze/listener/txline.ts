// Blaze's TxLINE SSE listener — the hot path.
// Detects GOAL events and fires trades immediately.
// ALL lookups are in-memory — zero network calls until the FAK order.
// Uses exponential backoff for reconnection — max 10 attempts, then alerts via Telegram.
// Guards against SSE replay on reconnect via dedup set.

import {
  TxLineClient,
  connectScoreStream,
  parseSseData,
  isGoalEvent,
  type ScoreEntry,
} from "../../txline/index.js";
import { config } from "../../config.js";
import { handleGoalEvent } from "../executor/trader.js";
import { resolvePlayerNameFromCache } from "../cache.js";
import { log } from "../../logger.js";
import { broadcast } from "../bot/telegram.js";

let lastEventId: string | undefined;
let abortController: AbortController | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 120_000;

// Dedup set: "fixtureId:eventId" pairs processed recently.
// TTL of 60 seconds — well past any SSE replay window.
const RECENT_GOALS = new Set<string>();
const GOAL_DEDUP_TTL_MS = 60_000;

function markGoalProcessed(fixtureId: number, eventId: string | number): void {
  const key = `${fixtureId}:${eventId}`;
  RECENT_GOALS.add(key);
  setTimeout(() => RECENT_GOALS.delete(key), GOAL_DEDUP_TTL_MS);
}

function wasGoalProcessed(fixtureId: number, eventId: string | number): boolean {
  return RECENT_GOALS.has(`${fixtureId}:${eventId}`);
}

export async function startTxLineListener(client: TxLineClient): Promise<void> {
  log("Blaze", "Connecting to TxLINE score stream...");

  abortController = new AbortController();

  try {
    const { stream } = await connectScoreStream({
      apiOrigin: config.txline.apiOrigin,
      jwt: config.txline.jwt,
      apiToken: config.txline.apiToken,
      lastEventId,
      signal: abortController.signal,
    });

    reconnectAttempts = 0;
    log("Blaze", "Connected to score stream");

    for await (const message of stream) {
      if (message.id) {
        lastEventId = message.id;
      }

      if (message.event === "heartbeat" || !message.data) continue;

      const t0 = performance.now();
      const score = parseSseData<ScoreEntry>(message.data);
      if (!score) continue;

      if (isGoalEvent(score)) {
        const fixtureId = score.fixtureId;
        const scorerPlayerId = score.dataSoccer?.PlayerId ?? 0;

        const dedupId = message.id ?? score.id;
        if (dedupId === undefined) {
          log("Blaze", `Goal event in fixture ${fixtureId} has no message.id or score.id — processing without dedup key`);
        } else if (wasGoalProcessed(fixtureId, dedupId)) {
          log("Blaze", `Dedup: goal in fixture ${fixtureId} already processed, skipping`);
          continue;
        }

        const playerName = resolvePlayerNameFromCache(fixtureId, String(scorerPlayerId));
        if (!playerName) {
          log("Blaze", `Goal by unknown PlayerId ${scorerPlayerId} in fixture ${fixtureId} — no mapping, skipping`);
          continue;
        }

        log("Blaze", `Goal: ${playerName} (fixture ${fixtureId}) [${(performance.now() - t0).toFixed(3)}ms]`);
        if (dedupId !== undefined) markGoalProcessed(fixtureId, dedupId);
        handleGoalEvent(fixtureId, playerName);
      }
    }

    log("Blaze", "Stream ended, reconnecting...");
    await reconnect(client);
  } catch (error) {
    if (abortController?.signal.aborted) {
      log("Blaze", "Stream aborted");
      return;
    }
    log("Blaze", `Stream error: ${error}`);
    await reconnect(client);
  }
}

async function reconnect(client: TxLineClient): Promise<void> {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    log("Blaze", "Max reconnect attempts reached, alerting via Telegram");
    broadcast("⚠️ Blaze listener is down — max reconnect attempts reached. Manual restart required.");
    return;
  }

  reconnectAttempts++;
  const delay = Math.min(BASE_DELAY_MS * Math.pow(2, reconnectAttempts - 1), MAX_DELAY_MS);
  log("Blaze", `Reconnecting in ${delay}ms (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`);

  await new Promise((resolve) => setTimeout(resolve, delay));
  await startTxLineListener(client);
}
