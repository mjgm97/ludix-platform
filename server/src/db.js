/* =============================================================================
 * Suite server — database
 * -----------------------------------------------------------------------------
 * One SQLite file, opened with better-sqlite3 (synchronous — no callback/async
 * ceremony, which keeps the route handlers tiny). The schema is created on
 * boot if missing, so there is no separate migration step to run.
 *
 * Design for a SUITE of games: everything is keyed by `game_id`, so one server
 * and one DB back any number of games. A player (unique username) is shared
 * across the whole suite.
 * ========================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const config = require("./config");

// Make sure the folder for the DB file exists.
fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma("journal_mode = WAL"); // better concurrency for a small web server
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS players (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    username     TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    token        TEXT    NOT NULL,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    last_seen_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );

  -- One row per completed run. Powers leaderboards and per-player history.
  CREATE TABLE IF NOT EXISTS scores (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    game_id    TEXT    NOT NULL,
    level      TEXT,
    score      REAL    NOT NULL DEFAULT 0,
    stars      INTEGER,
    session_id TEXT,
    meta       TEXT,   -- arbitrary JSON blob describing the run
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_scores_leaderboard ON scores(game_id, score DESC);
  CREATE INDEX IF NOT EXISTS idx_scores_player       ON scores(player_id);

  -- The full analytics event log. One row per event streamed from the game.
  CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
    game_id    TEXT    NOT NULL,
    session_id TEXT,
    seq        INTEGER,
    type       TEXT,
    t_ms       INTEGER,
    iso        TEXT,
    payload    TEXT,   -- the raw event object as JSON
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_events_player  ON events(player_id, game_id);
  CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id);
  -- Analytics dashboard reads slice events by game + type over a date range and
  -- group by day; these keep those aggregations fast as the log grows.
  CREATE INDEX IF NOT EXISTS idx_events_game_time ON events(game_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_events_game_type ON events(game_id, type, created_at);
  CREATE INDEX IF NOT EXISTS idx_scores_game_time ON scores(game_id, created_at);
  -- Sequence-based analytics (/process, /tna, /tna/clusters, /predict) read the
  -- game's events ordered by (session_id, seq, id). This covering-order index
  -- lets that read walk the index directly instead of filesorting the whole
  -- game into a temp B-tree, and lets the LIMIT cap terminate early.
  CREATE INDEX IF NOT EXISTS idx_events_game_session ON events(game_id, session_id, seq, id);

  -- Dashboard admins (teachers/researchers). Separate from players entirely:
  -- players are password-free game accounts; admins log in to view analytics.
  CREATE TABLE IF NOT EXISTS admin_users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
    pass_hash     TEXT    NOT NULL,   -- scrypt(password, salt) hex
    pass_salt     TEXT    NOT NULL,   -- per-user random salt hex
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    last_login_at TEXT
  );

  -- Server-side sessions for logged-in admins (opaque cookie token → admin).
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token      TEXT    PRIMARY KEY,
    admin_id   INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin ON admin_sessions(admin_id);

  -- One row per data import (Import tab). Lets an import be listed and removed as
  -- a single unit: its events + synthetic runs carry this row's id in import_id.
  CREATE TABLE IF NOT EXISTS imports (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    game_id         TEXT    NOT NULL,
    filename        TEXT,
    format          TEXT,
    rows            INTEGER,
    events          INTEGER,
    sessions        INTEGER,
    runs            INTEGER,
    players_created INTEGER,
    activities      INTEGER,
    mapping         TEXT,   -- the confirmed column mapping, as JSON
    actor_mode      TEXT,
    date_from       TEXT,
    date_to         TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_imports_game ON imports(game_id);
`);

// Migration: existing DBs pre-date the import-batch columns. The tables above are
// only created IF NOT EXISTS, so add the columns in place when they're missing
// (idempotent, runs on every boot). Native game rows keep import_id = NULL.
function ensureColumn(table, col, decl) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
}
ensureColumn("events", "import_id", "INTEGER");
ensureColumn("scores", "import_id", "INTEGER");
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_events_import ON events(import_id);
  CREATE INDEX IF NOT EXISTS idx_scores_import ON scores(import_id);
`);

module.exports = db;
