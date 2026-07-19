import type { ScoreEntry } from "./types.js";
import { STAT_KEYS, PERIOD_PREFIX } from "./types.js";

export interface PollingOptions {
  intervalMs: number;
  onScores: (scores: ScoreEntry[]) => void;
  onError?: (error: Error) => void;
}

export function detectNewEvents(
  previousStats: Record<string, number>,
  currentStats: Record<string, number>
): { statKey: number; oldValue: number; newValue: number }[] {
  const events: { statKey: number; oldValue: number; newValue: number }[] = [];

  for (const [key, newValue] of Object.entries(currentStats)) {
    const oldValue = previousStats[key] ?? 0;
    if (newValue > oldValue) {
      events.push({ statKey: Number(key), oldValue, newValue });
    }
  }

  return events;
}

export function statKeyToReadable(statKey: number): string {
  const baseKey = statKey % 1000;
  const period = Math.floor(statKey / 1000) * 1000;

  const statName =
    baseKey === STAT_KEYS.P1_GOALS
      ? "Team 1 Goals"
      : baseKey === STAT_KEYS.P2_GOALS
        ? "Team 2 Goals"
        : baseKey === STAT_KEYS.P1_YELLOW_CARDS
          ? "Team 1 Yellow Cards"
          : baseKey === STAT_KEYS.P2_YELLOW_CARDS
            ? "Team 2 Yellow Cards"
            : baseKey === STAT_KEYS.P1_RED_CARDS
              ? "Team 1 Red Cards"
              : baseKey === STAT_KEYS.P2_RED_CARDS
                ? "Team 2 Red Cards"
                : baseKey === STAT_KEYS.P1_CORNERS
                  ? "Team 1 Corners"
                  : baseKey === STAT_KEYS.P2_CORNERS
                    ? "Team 2 Corners"
                    : `Stat ${baseKey}`;

  const periodName =
    period === PERIOD_PREFIX.H1
      ? " (H1)"
      : period === PERIOD_PREFIX.HT
        ? " (HT)"
        : period === PERIOD_PREFIX.H2
          ? " (H2)"
          : "";

  return `${statName}${periodName}`;
}

export function isGoalEvent(score: ScoreEntry): boolean {
  return score.dataSoccer?.Goal === true;
}

export function isMatchFinal(score: ScoreEntry): boolean {
  // TxLINE may send the gameState as either the key ("F2") or the name ("F").
  // Support both to be safe.
  return score.gameState === "F" || score.gameState === "F2" || score.gameState === "FET" || score.gameState === "FPE";
}

export function getGoalsFromStats(
  stats: Record<string, number> | undefined
): { team1: number; team2: number } {
  if (!stats) return { team1: 0, team2: 0 };
  return {
    team1: stats[String(STAT_KEYS.P1_GOALS)] ?? 0,
    team2: stats[String(STAT_KEYS.P2_GOALS)] ?? 0,
  };
}
