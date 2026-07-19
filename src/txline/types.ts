export interface TxLineConfig {
  apiOrigin: string;
  jwt: string;
  apiToken: string;
}

export interface TokenResponse {
  token: string;
}

export interface Fixture {
  FixtureId: number;
  CompetitionId: number;
  Competition: string;
  Participant1: string;
  Participant1Id: number;
  Participant2: string;
  Participant2Id: number;
  Participant1IsHome: boolean;
  StartTime: number;
  Ts: number;
  GameState?: number;
  FixtureGroupId?: number;
}

export interface OddsEntry {
  FixtureId: number;
  MessageId: string;
  Ts: number;
  Bookmaker: string;
  BookmakerId: number;
  SuperOddsType: string;
  GameState: number | null;
  InRunning: boolean;
  MarketParameters: string | null;
  MarketPeriod: string;
  PriceNames: string[];
  Prices: number[];
  Pct: string[];
}

export interface SoccerData {
  Action?: string;
  Goal?: boolean;
  GoalType?: string;
  Participant?: number;
  PlayerId?: number;
  Minutes?: number;
  StatusId?: number;
  Corner?: boolean;
  Penalty?: boolean;
  RedCard?: boolean;
  YellowCard?: boolean;
  VAR?: boolean;
  Type?: string;
  Outcome?: string;
  FreeKickType?: string;
  ThrowInType?: string;
}

export interface SoccerScore {
  Goals: number;
  YellowCards: number;
  RedCards: number;
  Corners: number;
}

export interface SoccerFixtureScore {
  Participant1?: { Total?: SoccerScore };
  Participant2?: { Total?: SoccerScore };
}

export interface ScoreEntry {
  FixtureId: number;
  GameState: string;
  StartTime: number;
  IsTeam: boolean;
  FixtureGroupId: number;
  CompetitionId: number;
  CountryId: number;
  SportId: number;
  Participant1IsHome: boolean;
  Participant1Id: number;
  Participant2Id: number;
  Action: string;
  Id: number;
  Ts: number;
  ConnectionId: number;
  Seq: number;
  DataSoccer?: SoccerData;
  ScoreSoccer?: SoccerFixtureScore;
  Stats?: Record<string, number>;
  Participant?: number;
}

export interface StatValidation {
  summary: {
    fixtureId: number;
    updateStats: {
      updateCount: number;
      minTimestamp: number;
      maxTimestamp: number;
    };
    eventStatsSubTreeRoot: string | number[];
  };
  subTreeProof: ProofNode[];
  mainTreeProof: ProofNode[];
  statToProve: StatToProve;
  eventStatRoot: string | number[];
  statProof: ProofNode[];
  statToProve2?: StatToProve;
  statProof2?: ProofNode[];
}

export interface StatToProve {
  key: number;
  value: number;
}

export interface ProofNode {
  hash: string | number[];
  isRightSibling: boolean;
}

export interface SseMessage {
  id?: string;
  event?: string;
  data: string;
  retry?: number;
}

export interface TokenCache {
  jwt: string;
  apiToken: string;
  expiresAt: number;
}

export type GamePhase = {
  id: number;
  name: string;
  description: string;
};

export const GAME_PHASES: Record<string, GamePhase> = {
  NS2: { id: 1, name: "NS", description: "Not started" },
  H11: { id: 2, name: "H1", description: "First half in play" },
  HT2: { id: 3, name: "HT", description: "Halftime" },
  H21: { id: 4, name: "H2", description: "Second half in play" },
  F2: { id: 5, name: "F", description: "Ended (finished)" },
  WET: { id: 6, name: "WET", description: "Waiting for Extra Time" },
  ET1: { id: 7, name: "ET1", description: "Extra Time first half" },
  HTET: { id: 8, name: "HTET", description: "Extra Time halftime" },
  ET2: { id: 9, name: "ET2", description: "Extra Time second half" },
  FET: { id: 10, name: "FET", description: "Ended after Extra Time" },
  WPE: { id: 11, name: "WPE", description: "Waiting for Penalty Shootout" },
  PE: { id: 12, name: "PE", description: "Penalty Shootout in progress" },
  FPE: { id: 13, name: "FPE", description: "Ended after Penalty Shootout" },
  I2: { id: 14, name: "I", description: "Interrupted" },
  A2: { id: 15, name: "A", description: "Abandoned" },
  C2: { id: 16, name: "C", description: "Cancelled" },
  TXCC2: { id: 17, name: "TXCC", description: "TX Coverage Cancelled" },
  TXCS2: { id: 18, name: "TXCS", description: "TX Coverage Suspended" },
  P: { id: 19, name: "P", description: "Postponed" },
};

export const STAT_KEYS = {
  P1_GOALS: 1,
  P2_GOALS: 2,
  P1_YELLOW_CARDS: 3,
  P2_YELLOW_CARDS: 4,
  P1_RED_CARDS: 5,
  P2_RED_CARDS: 6,
  P1_CORNERS: 7,
  P2_CORNERS: 8,
} as const;

export const PERIOD_PREFIX = {
  TOTAL: 0,
  H1: 1000,
  HT: 2000,
  H2: 3000,
  ET1: 4000,
  ET2: 5000,
  PE: 6000,
  ET_TOTAL: 7000,
} as const;
