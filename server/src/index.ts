/**
 * NullClaw Web Terminal — Backend Server
 *
 * Hono server that manages Deno Sandbox sessions,
 * bridges terminal I/O between browser and NullClaw process,
 * and serves the static frontend in production.
 *
 * Runs on Node.js (not Bun) because the @deno/sandbox SDK
 * uses the `ws` library for WebSocket, which Bun's WS
 * implementation doesn't fully support.
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { config } from "./config";
import { sessions } from "./routes/sessions";
import { sessionManager } from "./services/session-manager";
import type { ErrorResponse, HealthResponse } from "./types";

const app = new Hono();

// ── Middleware ──────────────────────────────────────────────────

// Request logging
app.use("*", logger());

// CORS — in production the frontend is served from the same origin so CORS
// isn't needed. In development, allow the Vite dev server. We also accept
// the CORS_ORIGIN env var for custom deployments.
const allowedOrigins = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(",")
  : ["http://localhost:5173", "http://127.0.0.1:5173"];

app.use(
  "/api/*",
  cors({
    origin: allowedOrigins,
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type"],
    maxAge: 86400,
  })
);

// ── Health Check ───────────────────────────────────────────────

app.get("/health", (c) => {
  const response: HealthResponse = {
    ok: true,
    sessions: sessionManager.activeCount,
    uptime: process.uptime(),
  };
  return c.json(response);
});

// ── API Routes ─────────────────────────────────────────────────

app.route("/api/sessions", sessions);

// ── Static File Serving (production) ───────────────────────────
// In production, serve the built React app from ../client/dist.
// This is a no-op in development where Vite serves the frontend.

app.use(
  "*",
  serveStatic({
    root: "../client/dist",
  })
);

// SPA fallback: serve index.html for non-API, non-file routes
app.use(
  "*",
  serveStatic({
    root: "../client/dist",
    rewriteRequestPath: () => "/index.html",
  })
);

// ── Global Error Handler ───────────────────────────────────────

app.onError((err, c) => {
  console.error("[server] Unhandled error:", err);
  return c.json(
    { error: "Internal server error" } satisfies ErrorResponse,
    500
  );
});

// ── Start Server ───────────────────────────────────────────────

const port = Number(process.env.PORT) || config.PORT;

console.log(`
╔══════════════════════════════════════════╗
║     NullClaw Web Terminal — Server       ║
╠══════════════════════════════════════════╣
║  Port:       ${String(port).padEnd(27)}║
║  Region:     ${config.DENO_REGION.padEnd(27)}║
║  Snapshot:   ${config.NULLCLAW_SNAPSHOT.padEnd(27)}║
║  Max sesns:  ${String(config.MAX_CONCURRENT_SESSIONS).padEnd(27)}║
║  TTL:        ${(config.SESSION_TTL_MINUTES + " min").padEnd(27)}║
╚══════════════════════════════════════════╝
`);

serve(
  {
    fetch: app.fetch,
    port: port,
  },
  (info) => {
    console.log(`Server listening on http://localhost:${info.port}`);
  }
);
