/* =============================================================================
 * Suite server — configuration
 * -----------------------------------------------------------------------------
 * Single source of truth for every tunable. Reads process.env (populated from
 * a local .env file via dotenv, or from real environment variables in prod).
 * Nothing else in the codebase should read process.env directly.
 *
 * This server is game-agnostic: it stores runs keyed by `gameId` and can host
 * many games at once, each at its own URL (see GAMES_DIR below).
 * ========================================================================== */
"use strict";

const path = require("path");
require("dotenv").config();

function bool(v, dflt) {
  if (v == null || v === "") return dflt;
  return /^(1|true|yes|on)$/i.test(String(v).trim());
}
function int(v, dflt) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : dflt;
}
function list(v) {
  return String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

// DB_PATH may be relative — resolve it against the server folder so `npm start`
// works from anywhere. The DB is suite-wide (keyed by game_id), hence the
// game-neutral default name.
const rawDbPath = process.env.DB_PATH || "./data/suite.db";
const dbPath = path.isAbsolute(rawDbPath)
  ? rawDbPath
  : path.resolve(__dirname, "..", rawDbPath);

// Directory of games. Each immediate subfolder that contains an index.html is a
// self-contained game build, served at /<subfolder>/ — so one server hosts many
// games, each at its own URL. Defaults to the repo's dist/ (the build output of
// `npm run build`); game *source* lives in games/ and is bundled into dist/.
const rawGamesDir = process.env.GAMES_DIR || "../dist";
const gamesDir = path.isAbsolute(rawGamesDir)
  ? rawGamesDir
  : path.resolve(__dirname, "..", rawGamesDir);

const config = {
  env: process.env.NODE_ENV || "development",
  host: process.env.HOST || "0.0.0.0",
  port: int(process.env.PORT, 3000),

  dbPath,

  // CORS: array of allowed origins, or the single value "*".
  corsOrigins: (process.env.ALLOWED_ORIGINS || "*").trim() === "*"
    ? "*"
    : list(process.env.ALLOWED_ORIGINS),

  maxEventsPerSubmission: int(process.env.MAX_EVENTS, 5000),
  rateLimitPerMin: int(process.env.RATE_LIMIT_PER_MIN, 120),
  // Max request-body size for admin data-import uploads (a whole event log).
  importLimit: process.env.IMPORT_LIMIT || "32mb",

  serveStatic: bool(process.env.SERVE_STATIC, false),
  gamesDir,

  // Request logging (one line per request in the terminal).
  logRequests: bool(process.env.LOG_REQUESTS, true),   // API + static (see logStatic)
  logStatic: bool(process.env.LOG_STATIC, false),      // also log static-file hits (default off — set true to see asset hits)

  // Username rules (kept here so client and server can agree on them).
  username: { minLen: 3, maxLen: 20, pattern: /^[A-Za-z0-9_.-]+$/ },

  // ---- Analytics performance guards ----
  // Process-mining reads the raw event stream into memory; cap how many events
  // one /process call will pull so a huge game can't OOM the server. Sessions
  // beyond the cap are dropped and the response is flagged `truncated`.
  processMaxEvents: int(process.env.PROCESS_MAX_EVENTS, 100000),
  // Headline overview totals are full-table counts; memoise them briefly so a
  // busy dashboard doesn't re-scan on every poll.
  overviewCacheMs: int(process.env.OVERVIEW_CACHE_MS, 10000),

  // ---- Analytics dashboard (admin) ----
  // How long an admin login stays valid (server-side session).
  sessionDays: int(process.env.SESSION_DAYS, 7),
  // Mark the session cookie Secure (HTTPS-only). Defaults on in production;
  // override with COOKIE_SECURE=false if you terminate TLS elsewhere in dev.
  cookieSecure: bool(process.env.COOKIE_SECURE, (process.env.NODE_ENV || "development") === "production"),
  // Optional first-admin seed: if the admin table is empty on boot and both are
  // set, an admin is created so there's always a way into the dashboard.
  adminSeed: { user: process.env.ADMIN_USER || "", pass: process.env.ADMIN_PASSWORD || "" },
};

module.exports = config;
