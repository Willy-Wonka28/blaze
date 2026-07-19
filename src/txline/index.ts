export { TxLineClient } from "./client.js";
export { TokenManager } from "./token-manager.js";
export {
  parseSseBlock,
  readSseMessages,
  parseSseData,
  connectScoreStream,
  connectOddsStream,
  type StreamOptions,
} from "./stream.js";
export {
  detectNewEvents,
  statKeyToReadable,
  isGoalEvent,
  isMatchFinal,
  getGoalsFromStats,
  type PollingOptions,
} from "./helpers.js";
export type {
  TxLineConfig,
  TokenResponse,
  Fixture,
  OddsEntry,
  ScoreEntry,
  StatValidation,
  StatToProve,
  ProofNode,
  SseMessage,
  TokenCache,
  GamePhase,
} from "./types.js";
export {
  GAME_PHASES,
  STAT_KEYS,
  PERIOD_PREFIX,
} from "./types.js";
