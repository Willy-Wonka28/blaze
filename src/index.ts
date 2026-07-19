// Blaze-only entry point: boots HTTP API + Telegram bot + Polymarket auto-trader.
//
// Deployment: Render runs one Bun process with:
// - Hono HTTP server (health check + TxLINE proxy)
// - Telegram bot (commands, notifications)
// - TxLINE SSE listener (goal detection → trade execution)

import { Hono } from "hono";
import { cors } from "hono/cors";
import { TxLineClient } from "./txline/index.js";
import { config } from "./config.js";
import { log } from "./logger.js";
import { startBlaze } from "./blaze/index.js";

const app = new Hono();

app.use("*", cors({ origin: "*" }));

app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: Date.now() });
});

// Boot blaze after TxLINE credentials are verified.
const client = new TxLineClient({
  apiOrigin: config.txline.apiOrigin,
  jwt: config.txline.jwt,
  apiToken: config.txline.apiToken,
});

log("Server", "Verifying TxLINE credentials...");
client.getFixtures().then((fixtures) => {
  log("Server", `TxLINE connected. ${fixtures.length} fixtures available.`);
  startBlaze(client);
}).catch((err) => {
  log("Server", `TxLINE connection failed: ${err}`);
});

export default app;
