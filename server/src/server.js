/* =============================================================================
 * Suite server — HTTP API
 * -----------------------------------------------------------------------------
 * A small, game-agnostic Express app that receives game runs and stores them in
 * SQLite, and can optionally host a directory of games (each at its own URL).
 *
 * Identity model (password-free, but ownership-safe):
 *   - A player claims a UNIQUE username once and receives a random `token`.
 *   - The game stores that token in localStorage and sends it with every
 *     submission. Only the token holder can submit under that username, so
 *     names can't be hijacked — yet there are no passwords to manage.
 *
 * Routes:
 *   GET  /api/health
 *   POST /api/players                              claim a unique username
 *   GET  /api/players/:username                    public profile / availability
 *   POST /api/games/:gameId/scores                 submit a run (+ analytics)
 *   GET  /api/games/:gameId/leaderboard            top runs
 *   GET  /api/games/:gameId/players/:username      that player's runs in a game
 * ========================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const cors = require("cors");

const config = require("./config");
const db = require("./db");
const adminAuth = require("./admin-auth");
const adminApi = require("./admin-api");
const landing = require("./landing");

const app = express();
app.disable("x-powered-by");
// Admin data-import uploads carry a whole event log in the body, so they get a
// larger limit. This runs first for its path; express.json marks the body as
// parsed, so the global 2mb parser below then skips it. Everything else (incl.
// the public game APIs) stays bounded at 2mb.
app.use("/api/admin/import", express.json({ limit: config.importLimit }));
app.use(express.json({ limit: "2mb" })); // bounds the analytics payload size

// ---- CORS -------------------------------------------------------------------
app.use(
  cors({
    origin: config.corsOrigins === "*" ? true : config.corsOrigins,
  })
);

// ---- Request logging --------------------------------------------------------
// One line per request, so you can watch traffic arrive in the terminal running
// `npm run dev` / `npm start`. Set LOG_REQUESTS=false to silence, or LOG_STATIC
// =false to hide static-asset hits and keep only the JSON API (default).
if (config.logRequests) {
  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      const isApi = req.path.startsWith("/api/");
      if (!isApi && !config.logStatic) return;             // skip static noise unless asked
      const ms = Date.now() - start;
      const t = new Date().toTimeString().slice(0, 8);      // HH:MM:SS
      const size = res.getHeader("content-length");
      let extra = "";
      if (isApi && req.method === "POST" && req.body && Array.isArray(req.body.events)) {
        extra = ` events=${req.body.events.length}`;        // handy for the event stream
      }
      console.log(
        `[suite] ${t} ${req.method} ${req.originalUrl} → ${res.statusCode} ${ms}ms` +
          (size ? ` ${size}b` : "") + extra
      );
    });
    next();
  });
}

// ---- Tiny in-memory rate limiter (per IP, per minute) -----------------------
// No external dependency. Good enough to blunt accidental floods; put a real
// proxy/WAF in front for anything serious.
//
// IMPORTANT: only the JSON API is throttled. Static file serving (the game's
// html/js/images/audio) is exempt — otherwise a single page load, which fires
// dozens of asset requests, would trip the limit and the browser would show
// missing images / "reach limit" and fail to load the page.
const hits = new Map();
if (config.rateLimitPerMin > 0) {
  setInterval(() => hits.clear(), 60 * 1000).unref();
  app.use((req, res, next) => {
    if (!req.path.startsWith("/api/")) return next();   // never throttle static assets
    // Admin dashboard calls are auth-gated already; exempt them so a busy
    // dashboard session doesn't trip the limit — but keep /login throttled
    // (its own brute-force guard lives in admin-auth).
    if (req.path.startsWith("/api/admin/") && req.path !== "/api/admin/login") return next();
    const ip = req.ip || "unknown";
    const n = (hits.get(ip) || 0) + 1;
    hits.set(ip, n);
    if (n > config.rateLimitPerMin) {
      res.set("Retry-After", "60");
      return res.status(429).json({ error: "rate_limited" });
    }
    next();
  });
}

// ---- Prepared statements ----------------------------------------------------
const q = {
  insertPlayer: db.prepare(
    "INSERT INTO players (username, token) VALUES (?, ?)"
  ),
  findPlayer: db.prepare(
    "SELECT * FROM players WHERE username = ? COLLATE NOCASE"
  ),
  touchPlayer: db.prepare(
    "UPDATE players SET last_seen_at = datetime('now') WHERE id = ?"
  ),
  insertScore: db.prepare(
    `INSERT INTO scores (player_id, game_id, level, score, stars, session_id, meta)
     VALUES (@player_id, @game_id, @level, @score, @stars, @session_id, @meta)`
  ),
  insertEvent: db.prepare(
    `INSERT INTO events (player_id, game_id, session_id, seq, type, t_ms, iso, payload)
     VALUES (@player_id, @game_id, @session_id, @seq, @type, @t_ms, @iso, @payload)`
  ),
  leaderboard: db.prepare(
    `SELECT p.username AS username, s.score AS score, s.stars AS stars,
            s.level AS level, s.created_at AS created_at
       FROM scores s JOIN players p ON p.id = s.player_id
      WHERE s.game_id = @game_id AND (@level IS NULL OR s.level = @level)
      ORDER BY s.score DESC, s.created_at ASC
      LIMIT @limit`
  ),
  playerRuns: db.prepare(
    `SELECT s.game_id, s.level, s.score, s.stars, s.session_id, s.meta, s.created_at
       FROM scores s
      WHERE s.player_id = @player_id AND s.game_id = @game_id
      ORDER BY s.created_at DESC LIMIT @limit`
  ),
  // Live event feed for a game (newest first), optionally after a cursor id.
  recentEvents: db.prepare(
    `SELECT e.id, p.username, e.session_id, e.seq, e.type, e.t_ms, e.iso, e.payload, e.created_at
       FROM events e JOIN players p ON p.id = e.player_id
      WHERE e.game_id = @game_id
        AND (@since IS NULL OR e.id > @since)
        AND (@username IS NULL OR p.username = @username COLLATE NOCASE)
      ORDER BY e.id DESC LIMIT @limit`
  ),
};

// Insert a score plus its (optional) analytics events atomically.
const saveRun = db.transaction((run, events) => {
  const info = q.insertScore.run(run);
  for (const ev of events) q.insertEvent.run(ev);
  return info.lastInsertRowid;
});

// Bulk-insert analytics events atomically.
const saveEvents = db.transaction((rows) => {
  for (const ev of rows) q.insertEvent.run(ev);
  return rows.length;
});

// Normalise a raw client event object into an events-table row.
function toEventRow(playerId, gameId, sessionId, ev) {
  return {
    player_id: playerId,
    game_id: gameId,
    session_id: sessionId || (ev && ev.sessionId) || null,
    seq: ev && ev.seq != null ? ev.seq : null,
    type: ev && ev.type != null ? String(ev.type) : null,
    t_ms: ev && ev.t != null ? Math.round(Number(ev.t) || 0) : null,
    iso: ev && ev.iso != null ? String(ev.iso) : null,
    payload: JSON.stringify(ev),
  };
}

// ---- Helpers ----------------------------------------------------------------
function validUsername(name) {
  if (typeof name !== "string") return false;
  const u = name.trim();
  const { minLen, maxLen, pattern } = config.username;
  return u.length >= minLen && u.length <= maxLen && pattern.test(u);
}

// Look up a player and verify the caller owns it via the token.
function authPlayer(username, token) {
  const player = q.findPlayer.get(String(username || ""));
  if (!player) return { error: 404, code: "no_such_player" };
  if (!token || token !== player.token) {
    return { error: 401, code: "bad_token" };
  }
  return { player };
}

function num(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

// ---- Routes -----------------------------------------------------------------
app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "suite-server", time: new Date().toISOString() });
});

// Claim a unique username -> returns the player and a private token.
app.post("/api/players", (req, res) => {
  const username = String((req.body && req.body.username) || "").trim();
  if (!validUsername(username)) {
    return res.status(400).json({
      error: "invalid_username",
      rules: `${config.username.minLen}-${config.username.maxLen} chars; letters, numbers, . _ -`,
    });
  }
  const token = crypto.randomBytes(24).toString("hex");
  try {
    const info = q.insertPlayer.run(username, token);
    return res.status(201).json({
      player: { id: info.lastInsertRowid, username },
      token, // shown exactly once; the game stores it in localStorage
    });
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) {
      return res.status(409).json({ error: "username_taken" });
    }
    throw e;
  }
});

// Public profile / availability check (never leaks the token).
app.get("/api/players/:username", (req, res) => {
  const player = q.findPlayer.get(req.params.username);
  if (!player) return res.status(404).json({ error: "no_such_player", available: true });
  res.json({
    available: false,
    player: { username: player.username, created_at: player.created_at },
  });
});

// Submit a completed run: score + (optional) full analytics event log.
app.post("/api/games/:gameId/scores", (req, res) => {
  const gameId = String(req.params.gameId || "").trim();
  if (!gameId) return res.status(400).json({ error: "missing_game_id" });

  const body = req.body || {};
  const auth = authPlayer(body.username, body.token);
  if (auth.error) return res.status(auth.error).json({ error: auth.code });
  const player = auth.player;

  const run = {
    player_id: player.id,
    game_id: gameId,
    level: body.level != null ? String(body.level) : null,
    score: num(body.score, 0),
    stars: body.stars != null ? Math.round(num(body.stars, 0)) : null,
    session_id: body.session_id != null ? String(body.session_id) : null,
    meta: body.meta != null ? JSON.stringify(body.meta) : null,
  };

  // Optional inline events (events are usually streamed via /events instead,
  // so this is normally empty — kept for one-shot submissions). Cap defensively.
  let events = Array.isArray(body.events) ? body.events : [];
  if (events.length > config.maxEventsPerSubmission) {
    events = events.slice(-config.maxEventsPerSubmission);
  }
  const eventRows = events.map((ev) => toEventRow(player.id, gameId, run.session_id, ev));

  const scoreId = saveRun(run, eventRows);
  q.touchPlayer.run(player.id);

  res.status(201).json({ ok: true, scoreId, storedEvents: eventRows.length });
});

// Stream a batch of analytics events (the game flushes these continuously so
// you can watch the data live). Token-authenticated to attribute to a player.
app.post("/api/games/:gameId/events", (req, res) => {
  const gameId = String(req.params.gameId || "").trim();
  if (!gameId) return res.status(400).json({ error: "missing_game_id" });

  const body = req.body || {};
  const auth = authPlayer(body.username, body.token);
  if (auth.error) return res.status(auth.error).json({ error: auth.code });
  const player = auth.player;

  let events = Array.isArray(body.events) ? body.events : [];
  if (!events.length) return res.status(200).json({ ok: true, stored: 0 });
  if (events.length > config.maxEventsPerSubmission) {
    events = events.slice(-config.maxEventsPerSubmission);
  }
  const rows = events.map((ev) => toEventRow(player.id, gameId, body.session_id, ev));
  const stored = saveEvents(rows);
  q.touchPlayer.run(player.id);
  res.status(201).json({ ok: true, stored });
});

// Read the live event feed for a game (newest first). `since` = last id you've
// seen, for cheap polling; `username` filters to one player.
app.get("/api/games/:gameId/events", (req, res) => {
  const gameId = String(req.params.gameId || "").trim();
  const limit = Math.min(500, Math.max(1, num(req.query.limit, 100)));
  const since = req.query.since != null ? Math.max(0, num(req.query.since, 0)) : null;
  const username = req.query.username != null ? String(req.query.username) : null;
  const rows = q.recentEvents.all({ game_id: gameId, since, username, limit }).map((r) => ({
    id: r.id, username: r.username, session_id: r.session_id, seq: r.seq,
    type: r.type, t_ms: r.t_ms, iso: r.iso, created_at: r.created_at,
    payload: r.payload ? JSON.parse(r.payload) : null,
  }));
  res.json({ gameId, count: rows.length, events: rows });
});

// Leaderboard for a game (optionally filtered to one level).
app.get("/api/games/:gameId/leaderboard", (req, res) => {
  const gameId = String(req.params.gameId || "").trim();
  const limit = Math.min(100, Math.max(1, num(req.query.limit, 20)));
  const level = req.query.level != null ? String(req.query.level) : null;
  const entries = q.leaderboard.all({ game_id: gameId, level, limit });
  entries.forEach((e, i) => (e.rank = i + 1));
  res.json({ gameId, level, entries });
});

// A single player's runs within a game (their personal history).
app.get("/api/games/:gameId/players/:username", (req, res) => {
  const gameId = String(req.params.gameId || "").trim();
  const player = q.findPlayer.get(req.params.username);
  if (!player) return res.status(404).json({ error: "no_such_player" });
  const limit = Math.min(200, Math.max(1, num(req.query.limit, 50)));
  const runs = q.playerRuns
    .all({ player_id: player.id, game_id: gameId, limit })
    .map((r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null }));
  res.json({ username: player.username, gameId, runs });
});

// ---- Admin: dashboard auth + analytics API --------------------------------
// /api/admin/login is public (with a brute-force guard); everything else is
// gated by requireAdmin. The read-only analytics endpoints power the dashboard.
const adminRouter = express.Router();
adminAuth.mount(adminRouter);                                  // login / logout / me / accounts
const analyticsRouter = express.Router();
adminApi.mount(analyticsRouter);                               // overview / summaries / export …
adminRouter.use(adminAuth.requireAdmin, analyticsRouter);      // …all behind auth
app.use("/api/admin", adminRouter);

// The dashboard itself (the server's own UI, always available — not a game).
const adminUiDir = path.join(__dirname, "..", "public", "admin");
app.use("/admin", express.static(adminUiDir));

// ---- Optionally host a directory of games, each at its own URL --------------
// GAMES_DIR holds one self-contained folder per game (index.html + assets).
// express.static serves each at /<folder>/, and "/" shows a small index linking
// to them — so adding a game to the suite is just dropping its build folder in.
if (config.serveStatic) {
  const gamesDir = config.gamesDir;
  fs.mkdirSync(gamesDir, { recursive: true });
  maybeBuildLocalGame(gamesDir);   // dev convenience — no-op once any game exists

  app.get("/", (req, res) => res.type("html").send(landing.renderLanding(listGames(gamesDir))));
  app.use(express.static(gamesDir));
}

// ---- Static-hosting helpers -------------------------------------------------
// Hosted games = immediate subfolders of GAMES_DIR that contain an index.html.
function listGames(gamesDir) {
  try {
    return fs.readdirSync(gamesDir, { withFileTypes: true })
      // "_"/"."-prefixed folders are non-games (e.g. a copied _template) — hide them.
      .filter((d) => d.isDirectory() && !/^[_.]/.test(d.name) && fs.existsSync(path.join(gamesDir, d.name, "index.html")))
      .map((d) => d.name)
      .sort();
  } catch (e) { return []; }
}

// Dev convenience: if the serve dir (dist/) is empty AND this repo's game sources
// are next to the server, build every game in games/* into dist/<slug>/ so a
// fresh checkout is instantly playable. A standalone suite server (no games/ dir)
// just skips this — drop pre-built folders into GAMES_DIR instead.
function maybeBuildLocalGame(serveDir) {
  if (listGames(serveDir).length) return;                 // already has built games
  const srcRoot = path.resolve(__dirname, "..", "..", "games");
  let slugs = [];
  try {
    slugs = fs.readdirSync(srcRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !/^[_.]/.test(d.name) && fs.existsSync(path.join(srcRoot, d.name, "build.js")))
      .map((d) => d.name);
  } catch (e) { /* no games/ source dir — standalone server */ }
  if (!slugs.length) {
    console.warn(`[suite] no games in ${serveDir} yet — build them with \`npm run build\`, or drop a built folder in.`);
    return;
  }
  console.log(`[suite] no built games yet — building ${slugs.length} from source into ${serveDir} …`);
  for (const slug of slugs) {
    const out = path.join(serveDir, slug);
    try {
      // API_BASE="" bakes a same-origin API base: a game hosted here reaches the
      // API at /api on whatever host/port served it (no hardcoded localhost:3000).
      require("child_process").execFileSync(process.execPath, ["build.js"], {
        cwd: path.join(srcRoot, slug),
        stdio: "inherit",
        env: Object.assign({}, process.env, { OUT_DIR: out, API_BASE: "" }),
      });
    } catch (e) {
      console.warn(`[suite] build of '${slug}' failed — build it manually.`, e.message);
    }
  }
}

// ---- Error handler ----------------------------------------------------------
app.use((err, req, res, next) => {
  console.error("[suite] error:", err);
  const body = { error: "server_error" };
  if (config.env !== "production") body.detail = String(err.message || err);
  res.status(500).json(body);
});

// Seed the first dashboard admin from env if none exist yet (see admin-auth).
adminAuth.seedFromEnv();

// ---- Start ------------------------------------------------------------------
const server = app.listen(config.port, config.host, () => {
  console.log(
    `[suite] server listening on http://${config.host}:${config.port}` +
      ` (env=${config.env}, db=${config.dbPath})`
  );
  const admins = adminAuth.countAdmins();
  console.log(`[suite] analytics dashboard at /admin` +
    (admins ? ` (${admins} admin${admins === 1 ? "" : "s"})` : " — no admins yet: `npm run admin -- add <user> <pass>`"));
  if (config.serveStatic) {
    const games = listGames(config.gamesDir);
    console.log(`[suite] hosting games from ${config.gamesDir}` +
      (games.length ? ` → ${games.map((g) => "/" + g + "/").join("  ")}` : " (none yet)"));
  }
});

// Graceful shutdown so the DB file is left clean.
function shutdown() {
  console.log("[suite] shutting down…");
  server.close(() => {
    try { db.close(); } catch (e) {}
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

module.exports = app;
