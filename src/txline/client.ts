import type {
  TxLineConfig,
  TokenResponse,
  Fixture,
  OddsEntry,
  ScoreEntry,
  StatValidation,
} from "./types.js";

export class TxLineClient {
  private config: TxLineConfig;

  constructor(config: TxLineConfig) {
    this.config = config;
  }

  private get headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      Authorization: `Bearer ${this.config.jwt}`,
      "X-Api-Token": this.config.apiToken,
    };
  }

  private get base(): string {
    return this.config.apiOrigin;
  }

  private async get<T>(path: string, params?: Record<string, string | number>): Promise<T> {
    const url = new URL(path, this.base);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, String(value));
      }
    }
    const response = await fetch(url.toString(), { headers: this.headers });
    if (!response.ok) {
      throw new Error(`TxLINE API error: ${response.status} ${response.statusText}`);
    }
    return response.json() as Promise<T>;
  }

  static async createGuestSession(apiOrigin: string): Promise<string> {
    const response = await fetch(`${apiOrigin}/auth/guest/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Failed to create guest session: ${response.status}`);
    }
    const data = (await response.json()) as TokenResponse;
    return data.token;
  }

  async getFixtures(competitionId?: number): Promise<Fixture[]> {
    const params: Record<string, string | number> = {};
    if (competitionId !== undefined) {
      params.competitionId = competitionId;
    }
    return this.get<Fixture[]>("/api/fixtures/snapshot", params);
  }

  async getOddsSnapshot(fixtureId: number): Promise<OddsEntry[]> {
    return this.get<OddsEntry[]>(`/api/odds/snapshot/${fixtureId}`);
  }

  async getOddsUpdates(epochDay: number, hourOfDay: number, interval: number): Promise<OddsEntry[]> {
    return this.get<OddsEntry[]>(`/api/odds/updates/${epochDay}/${hourOfDay}/${interval}`);
  }

  async getScoresSnapshot(fixtureId: number): Promise<ScoreEntry[]> {
    return this.get<ScoreEntry[]>(`/api/scores/snapshot/${fixtureId}`);
  }

  async getScoresUpdates(
    fixtureIdOrEpochDay: number,
    hourOfDay?: number,
    interval?: number
  ): Promise<ScoreEntry[]> {
    if (hourOfDay !== undefined && interval !== undefined) {
      return this.get<ScoreEntry[]>(
        `/api/scores/updates/${fixtureIdOrEpochDay}/${hourOfDay}/${interval}`
      );
    }
    return this.get<ScoreEntry[]>(`/api/scores/updates/${fixtureIdOrEpochDay}`);
  }

  async getHistoricalScores(fixtureId: number): Promise<ScoreEntry[]> {
    return this.get<ScoreEntry[]>(`/api/scores/historical/${fixtureId}`);
  }

  async getStatValidation(params: {
    fixtureId: number;
    seq: number;
    statKey?: number;
    statKey2?: number;
    statKeys?: string;
  }): Promise<StatValidation> {
    const queryParams: Record<string, string | number> = {
      fixtureId: params.fixtureId,
      seq: params.seq,
    };
    if (params.statKey !== undefined) queryParams.statKey = params.statKey;
    if (params.statKey2 !== undefined) queryParams.statKey2 = params.statKey2;
    if (params.statKeys !== undefined) queryParams.statKeys = params.statKeys;
    return this.get<StatValidation>("/api/scores/stat-validation", queryParams);
  }

  updateCredentials(jwt: string, apiToken: string): void {
    this.config.jwt = jwt;
    this.config.apiToken = apiToken;
  }
}
