import "dotenv/config";
import { serve } from "@hono/node-server";
import app from "./index.js";
import { stopBot } from "./blaze/bot/telegram.js";

const port = Number(process.env.PORT || 3001);

serve({ fetch: app.fetch, port }, () => {
  console.log(`[Server] Listening on http://localhost:${port}`);
});

function gracefulShutdown(signal: string) {
  console.log(`\n[Server] Received ${signal}. Shutting down gracefully...`);
  stopBot(signal);
  // Optional: Add logic to wait for server close if needed
  // server.close(() => { ... })
  process.exit(0);
}

process.once("SIGINT", () => gracefulShutdown("SIGINT"));
process.once("SIGTERM", () => gracefulShutdown("SIGTERM"));
