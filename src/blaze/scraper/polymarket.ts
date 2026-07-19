// Polymarket player goals scraper — v3.
// Fetches soccer_player_goals markets directly from the Gamma /markets endpoint.
// Groups by parent event, matches to TxLINE fixtures by fuzzy team name.
// Keeps only 5 upcoming fixtures; drops concluded ones and picks up new ones.
// Writes to SQLite AND updates in-memory cache so new markets are instantly available.
// Re-runs every 30 minutes to discover new markets and update prices.

import { getDb, type PlayerMarketRow, upsertPlayerIdMap } from "../db.js";
import { syncPlayerIdToCache, syncMarketsToCache, syncFixtureNameToCache } from "../cache.js";
import { broadcast } from "../bot/telegram.js";
import { config } from "../../config.js";
import { log } from "../../logger.js";

const MAX_FIXTURES = 5;
let previousFixtureIds = new Set<number>();

// ── Gamma types ─────────────────────────────────────────────────

interface GammaMarket {
  id: string;
  question: string;
  conditionId: string;
  clobTokenIds: string;
  outcomePrices: string;
  active: boolean;
  closed: boolean;
  acceptingOrders: boolean;
  sportsMarketType?: string;
  slug?: string;
  line?: number;
  marketMetadata?: {
    opticOddsFixtureId?: string;
    opticOddsPlayerId?: string;
    opticOddsPoints?: number;
    opticOddsSelection?: string;
    opticOddsSelectionLine?: string;
  };
  events?: Array<{
    id: string;
    slug: string;
    title: string;
    startTime?: string;
  }>;
}

interface GammaEvent {
  id: string;
  slug: string;
  title: string;
  startTime?: string;
  markets: GammaMarket[];
}

// ── TxLINE fixture type (from snapshot) ─────────────────────────

interface TxFixture {
  FixtureId: number;
  Participant1: string;
  Participant2: string;
  StartTime: number;
  GameState?: number;
}

// ── Team name normalisation ─────────────────────────────────────

const TEAM_ALIASES: Record<string, string> = {
  // Club aliases
  "man utd": "manchester united",
  "man city": "manchester city",
  "tottenham": "tottenham hotspur",
  "spurs": "tottenham hotspur",
  "newcastle": "newcastle united",
  "aston villa": "aston villa",
  "west ham": "west ham united",
  "brighton": "brighton & hove albion",
  "brighton & hove": "brighton & hove albion",
  "wolves": "wolverhampton wanderers",
  "wolverhampton": "wolverhampton wanderers",
  "nottm forest": "nottingham forest",
  "nottingham": "nottingham forest",
  "sheff utd": "sheffield united",
  "sheffield": "sheffield united",
  "fc barcelona": "barcelona",
  "real madrid cf": "real madrid",
  "atlético": "atletico madrid",
  "atletico": "atletico madrid",
  "bayern": "bayern munich",
  "bayern munchen": "bayern munich",
  "psg": "paris saint-germain",
  "paris saint germain": "paris saint-germain",
  "inter": "inter milan",
  "ac milan": "milan",
  "juventus": "juventus",
  "juve": "juventus",
  // National team aliases (World Cup 2026)
  "usa": "united states",
  "united states of america": "united states",
  "south korea": "korea republic",
  "korea": "korea republic",
  "iran": "iran",
  "japan": "japan",
  "saudi arabia": "saudi arabia",
  "australia": "australia",
  "qatar": "qatar",
  "united arab emirates": "united arab emirates",
  "uzbekistan": "uzbekistan",
  "iraq": "iraq",
  "oman": "oman",
  "jordan": "jordan",
  "china": "china pr",
  "pr china": "china pr",
  "england": "england",
  "france": "france",
  "germany": "germany",
  "spain": "spain",
  "españa": "spain",
  "portugal": "portugal",
  "netherlands": "netherlands",
  "holland": "netherlands",
  "italy": "italy",
  "belgium": "belgium",
  "croatia": "croatia",
  "switzerland": "switzerland",
  "denmark": "denmark",
  "serbia": "serbia",
  "sweden": "sweden",
  "poland": "poland",
  "ukraine": "ukraine",
  "austria": "austria",
  "hungary": "hungary",
  "greece": "greece",
  "czech republic": "czech republic",
  "czechia": "czech republic",
  "turkey": "turkiye",
  "turkiye": "turkiye",
  "norway": "norway",
  "romania": "romania",
  "scotland": "scotland",
  "slovakia": "slovakia",
  "slovenia": "slovenia",
  "wales": "wales",
  "argentina": "argentina",
  "brazil": "brazil",
  "uruguay": "uruguay",
  "colombia": "colombia",
  "ecuador": "ecuador",
  "peru": "peru",
  "chile": "chile",
  "paraguay": "paraguay",
  "venezuela": "venezuela",
  "bolivia": "bolivia",
  "mexico": "mexico",
  "canada": "canada",
  "costa rica": "costa rica",
  "panama": "panama",
  "jamaica": "jamaica",
  "honduras": "honduras",
  "el salvador": "el salvador",
  "senegal": "senegal",
  "nigeria": "nigeria",
  "egypt": "egypt",
  "morocco": "morocco",
  "algeria": "algeria",
  "tunisia": "tunisia",
  "cameroon": "cameroon",
  "ghana": "ghana",
  "ivory coast": "cote d ivoire",
  "côte d'ivoire": "cote d ivoire",
  "mali": "mali",
  "burkina faso": "burkina faso",
  "south africa": "south africa",
  "congo": "congo dr",
  "dr congo": "congo dr",
  "new zealand": "new zealand",
  "fiji": "fiji",
};

function normalise(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function canonicalTeam(s: string): string {
  const n = normalise(s);
  return TEAM_ALIASES[n] ?? n;
}

function teamsMatch(a: string, b: string): boolean {
  const ca = canonicalTeam(a);
  const cb = canonicalTeam(b);
  if (ca === cb) return true;
  if (ca.includes(cb) || cb.includes(ca)) return true;
  return jaro(ca, cb) > 0.85;
}

function jaro(a: string, b: string): number {
  if (a === b) return 1;
  const al = a.length;
  const bl = b.length;
  if (al === 0 || bl === 0) return 0;

  const matchDist = Math.floor(Math.max(al, bl) / 2) - 1;
  const aMatch = new Array<boolean>(al).fill(false);
  const bMatch = new Array<boolean>(bl).fill(false);

  let matches = 0;
  let transpositions = 0;

  for (let i = 0; i < al; i++) {
    const start = Math.max(0, i - matchDist);
    const end = Math.min(i + matchDist + 1, bl);
    for (let j = start; j < end; j++) {
      if (bMatch[j] || a[i] !== b[j]) continue;
      aMatch[i] = true;
      bMatch[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let k = 0;
  for (let i = 0; i < al; i++) {
    if (!aMatch[i]) continue;
    while (!bMatch[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }

  return (matches / al + matches / bl + (matches - transpositions / 2) / matches) / 3;
}

// ── Extract match info from Polymarket event title ──────────────
// Titles look like: "Spain vs. Argentina - Player Props"

const VS_RE = /\s+(?:vs\.?|[-–—])\s+/i;

function extractTeams(eventTitle: string): [string, string] | null {
  const cleaned = eventTitle
    .replace(/\s*[-–—]\s*(?:player props|player goals|soccer.*|football.*)/i, "")
    .trim();
  const parts = cleaned.split(VS_RE);
  if (parts.length !== 2) return null;
  const t1 = parts[0].trim();
  const t2 = parts[1].trim();
  if (!t1 || !t2) return null;
  return [t1, t2];
}

// ── Gamma API fetcher — uses /markets endpoint directly ─────────

async function fetchSoccerPlayerGoalEvents(): Promise<GammaEvent[]> {
  const url = `${config.polymarket.gammaUrl}/markets`;
  const eventMap = new Map<string, GammaEvent>();
  let offset = 0;
  const limit = 100;

  while (true) {
    const params = new URLSearchParams({
      sports_market_types: "soccer_player_goals",
      limit: String(limit),
      offset: String(offset),
    });

    const res = await fetch(`${url}?${params}`, {
      headers: { "Content-Type": "application/json" },
    });

    if (!res.ok) {
      log("Blaze", `Gamma markets fetch failed: ${res.status} ${res.statusText}`);
      break;
    }

    const markets = (await res.json()) as GammaMarket[];
    if (markets.length === 0) break;

    for (const market of markets) {
      const eventInfo = market.events?.[0];
      if (!eventInfo) continue;

      if (!eventMap.has(eventInfo.id)) {
        eventMap.set(eventInfo.id, {
          id: eventInfo.id,
          slug: eventInfo.slug,
          title: eventInfo.title,
          startTime: eventInfo.startTime,
          markets: [],
        });
      }
      eventMap.get(eventInfo.id)!.markets.push(market);
    }

    if (markets.length < limit) break;
    offset += limit;
  }

  return Array.from(eventMap.values());
}

async function fetchTickSize(tokenId: string): Promise<number> {
  try {
    const res = await fetch(`${config.polymarket.baseUrl}/tick-size?token_id=${tokenId}`);
    if (!res.ok) return 0.01;
    const data = (await res.json()) as { minimum_tick_size?: string };
    return Number(data.minimum_tick_size ?? 0.01);
  } catch {
    return 0.01;
  }
}

async function fetchNegRisk(tokenId: string): Promise<boolean> {
  try {
    const res = await fetch(`${config.polymarket.baseUrl}/neg-risk?token_id=${tokenId}`);
    if (!res.ok) return false;
    const data = (await res.json()) as { neg_risk?: boolean };
    return data.neg_risk ?? false;
  } catch {
    return false;
  }
}

async function fetchTxFixtures(): Promise<TxFixture[]> {
  const res = await fetch(`${config.txline.apiOrigin}/api/fixtures/snapshot`, {
    headers: {
      Authorization: `Bearer ${config.txline.jwt}`,
      "X-Api-Token": config.txline.apiToken,
    },
  });
  if (!res.ok) {
    log("Blaze", `TxLINE fixtures fetch failed: ${res.status}`);
    return [];
  }
  return (await res.json()) as TxFixture[];
}

// ── Core logic ──────────────────────────────────────────────────

interface MatchedFixtures {
  txFixture: TxFixture;
  event: GammaEvent;
}

function matchEventsToFixtures(
  events: GammaEvent[],
  fixtures: TxFixture[],
  now: number
): MatchedFixtures[] {
  const matched: MatchedFixtures[] = [];
  const usedEventIds = new Set<string>();

  const upcoming = fixtures
    .filter((f) => f.StartTime > now)
    .sort((a, b) => a.StartTime - b.StartTime)
    .slice(0, MAX_FIXTURES);

  for (const fixture of upcoming) {
    for (const event of events) {
      if (usedEventIds.has(event.id)) continue;
      const teams = extractTeams(event.title);
      if (!teams) continue;

      const [evT1, evT2] = teams;
      const txP1 = fixture.Participant1;
      const txP2 = fixture.Participant2;

      const direct = teamsMatch(evT1, txP1) && teamsMatch(evT2, txP2);
      const swapped = teamsMatch(evT1, txP2) && teamsMatch(evT2, txP1);

      if (direct || swapped) {
        matched.push({ txFixture: fixture, event });
        usedEventIds.add(event.id);
        break;
      }
    }
  }

  return matched;
}

// ── Scrape entry point ──────────────────────────────────────────

export async function scrapePlayerGoalMarkets(): Promise<void> {
  log("Blaze", "Scraping Polymarket player goals markets (v3)...");

  try {
    const nowSeconds = Math.floor(Date.now() / 1000);

    const [gammaEvents, txFixtures] = await Promise.all([
      fetchSoccerPlayerGoalEvents(),
      fetchTxFixtures(),
    ]);

    log("Blaze", `Gamma returned ${gammaEvents.length} events with player goals; TxLINE has ${txFixtures.length} fixtures`);

    const matched = matchEventsToFixtures(gammaEvents, txFixtures, nowSeconds);

    if (matched.length === 0) {
      log("Blaze", "No matching fixtures found — nothing to scrape");
      return;
    }

    const activeFixtureIds = new Set(matched.map((m) => m.txFixture.FixtureId));

    const db = getDb();
    let totalMarkets = 0;
    let totalPlayers = 0;
    const tickSizeCache = new Map<string, number>();
    const negRiskCache = new Map<string, boolean>();

    for (const { txFixture, event } of matched) {
      syncFixtureNameToCache(txFixture.FixtureId, `${txFixture.Participant1} vs ${txFixture.Participant2}`);
      const playerMarkets = parsePlayerGoalsMarkets(event.markets);
      if (playerMarkets.size === 0) continue;

      for (const [playerName, markets] of playerMarkets) {
        for (const { market } of markets) {
          const externalId = market.marketMetadata?.opticOddsPlayerId;
          if (externalId) {
            upsertPlayerIdMap(txFixture.FixtureId, externalId, playerName);
            syncPlayerIdToCache(txFixture.FixtureId, externalId, playerName);
          }
        }

        const cachedMarkets: PlayerMarketRow[] = [];

        for (const { market, line } of markets) {
          let tokenIds: string[];
          try {
            tokenIds = JSON.parse(market.clobTokenIds);
          } catch {
            continue;
          }
          if (!tokenIds || tokenIds.length < 2) continue;

          let prices: number[];
          try {
            prices = JSON.parse(market.outcomePrices);
          } catch {
            continue;
          }

          const tokenYes = tokenIds[0];
          const tokenNo = tokenIds[1];

          if (!tickSizeCache.has(tokenYes)) {
            const [tick, neg] = await Promise.all([
              fetchTickSize(tokenYes),
              fetchNegRisk(tokenYes),
            ]);
            tickSizeCache.set(tokenYes, tick);
            negRiskCache.set(tokenYes, neg);
          }
          const tickSize = tickSizeCache.get(tokenYes)!;
          const negRisk = negRiskCache.get(tokenYes)!;

          const existing = db.prepare(
            "SELECT * FROM player_markets WHERE fixture_id = ? AND player_name = ? AND line = ?"
          ).get(txFixture.FixtureId, playerName, line) as PlayerMarketRow | undefined;

          if (existing) {
            db.prepare(
              "UPDATE player_markets SET yes_price = ?, tick_size = ?, neg_risk = ?, accepting_orders = ?, optic_odds_player_id = ?, last_updated = unixepoch() WHERE id = ?"
            ).run(prices[0] ?? 0, tickSize, negRisk ? 1 : 0, market.acceptingOrders ? 1 : 0, market.marketMetadata?.opticOddsPlayerId ?? null, existing.id);

            cachedMarkets.push({
              ...existing,
              yes_price: prices[0] ?? 0,
              tick_size: tickSize,
              neg_risk: negRisk ? 1 : 0,
              accepting_orders: market.acceptingOrders ? 1 : 0,
              optic_odds_player_id: market.marketMetadata?.opticOddsPlayerId ?? null,
            });
          } else {
            db.prepare(
              `INSERT OR IGNORE INTO player_markets
               (fixture_id, player_name, line, market_id, condition_id, token_yes, token_no, optic_odds_player_id, yes_price, tick_size, neg_risk, accepting_orders, last_updated)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`
            ).run(
              txFixture.FixtureId,
              playerName,
              line,
              market.id,
              market.conditionId,
              tokenYes,
              tokenNo,
              market.marketMetadata?.opticOddsPlayerId ?? null,
              prices[0] ?? 0,
              tickSize,
              negRisk ? 1 : 0,
              market.acceptingOrders ? 1 : 0
            );

            const row = db.prepare(
              "SELECT * FROM player_markets WHERE fixture_id = ? AND player_name = ? AND line = ?"
            ).get(txFixture.FixtureId, playerName, line) as PlayerMarketRow;
            cachedMarkets.push(row);
          }
          totalMarkets++;
        }

        if (cachedMarkets.length > 0) {
          syncMarketsToCache(txFixture.FixtureId, playerName, cachedMarkets);
        }

        totalPlayers++;
      }
    }

    const activeIds = Array.from(activeFixtureIds);
    if (activeIds.length > 0) {
      const placeholders = activeIds.map(() => "?").join(",");
      db.prepare(`DELETE FROM player_markets WHERE fixture_id NOT IN (${placeholders})`).run(...activeIds);
      db.prepare(`DELETE FROM player_id_map WHERE fixture_id NOT IN (${placeholders})`).run(...activeIds);
    }

    log("Blaze", `Scraped ${totalMarkets} player goal markets for ${totalPlayers} players across ${matched.length} fixtures`);

    const newFixtureIds = new Set(matched.map((m) => m.txFixture.FixtureId));
    const added = matched.filter((m) => !previousFixtureIds.has(m.txFixture.FixtureId));
    previousFixtureIds = newFixtureIds;

    if (added.length > 0) {
      const names = added.map((m) => `${m.txFixture.Participant1} vs ${m.txFixture.Participant2}`);
      broadcast(
        `📋 Now watching ${names.length} new player goal matchup${names.length > 1 ? "s" : ""}:\n` +
        names.map((n) => `  ⚽ ${n}`).join("\n") +
        "\n\nI will trade on your behalf when goals are scored."
      );
    }
  } catch (error) {
    log("Blaze", `Player goals scraper failed: ${error}`);
  }
}

// ── Market parser ───────────────────────────────────────────────

function parsePlayerGoalsMarkets(
  markets: GammaMarket[]
): Map<string, { market: GammaMarket; playerName: string; line: number }[]> {
  const byPlayer = new Map<string, { market: GammaMarket; playerName: string; line: number }[]>();

  for (const market of markets) {
    if (market.sportsMarketType !== "soccer_player_goals") continue;
    if (!market.acceptingOrders) continue;

    const meta = market.marketMetadata;
    const line = meta?.opticOddsPoints ?? market.line ?? 0;
    const playerName = market.question.split(":")[0]?.trim() ?? "";

    if (!playerName || line <= 0) continue;

    if (!byPlayer.has(playerName)) {
      byPlayer.set(playerName, []);
    }
    byPlayer.get(playerName)!.push({ market, playerName, line });
  }

  return byPlayer;
}
