// Blaze-only config: every env var validated at startup.
//
// Why crash on missing vars? Failing fast is better than running half-configured
// and producing confusing errors at runtime. This is a monolith — one bad env var
// means the entire service shouldn't start.

function requireEnv(name: string): string {
  const val = process.env[name];
  if (!val) throw new Error(`${name} is required`);
  return val;
}

function optionalEnv(name: string, fallback: string): string {
  return process.env[name] || fallback;
}

export const config = {
  txline: {
    apiOrigin: optionalEnv("TXLINE_DATA_BASE", "https://txline.txodds.com"),
    jwt: requireEnv("TXLINE_JWT"),
    apiToken: requireEnv("TXLINE_API_TOKEN"),
  },
  telegram: {
    botToken: requireEnv("TELEGRAM_BOT_TOKEN"),
  },
  polymarket: {
    baseUrl: optionalEnv("POLYMARKET_CLOB_URL", "https://clob.polymarket.com"),
    gammaUrl: optionalEnv("POLYMARKET_GAMMA_URL", "https://gamma-api.polymarket.com"),
    collateral: "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB" as const,
    exchangeV3: "0xe3333700cA9d93003F00f0F71f8515005F6c00Aa" as const,
    negRiskExchangeV2: "0xe2222d279d744050d28e00520010520000310F59" as const,
  },
  supabase: {
    url: requireEnv("SUPABASE_URL"),
    serviceKey: requireEnv("SUPABASE_SERVICE_KEY"),
  },
  blaze: {
    defaultPrice: Number(optionalEnv("BLAZE_DEFAULT_PRICE", "0.99")),
    dbPath: optionalEnv("BLAZE_DB_PATH", "./data/blaze.db"),
    backendSecret: requireEnv("BACKEND_SECRET"),
    minPusd: Number(optionalEnv("BLAZE_MIN_PUSD", "3")),
    minPol: Number(optionalEnv("BLAZE_MIN_POL", "0.001")),
  },
  blockchain: {
    rpcUrl: optionalEnv("POLYGON_RPC_URL", "https://polygon-rpc.com"),
    chainId: 137,
  },
};
