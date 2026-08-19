/* =============================================================================
 * Suite server — data import (admin only)
 * -----------------------------------------------------------------------------
 * Imports an EXISTING event log (from another game, tool, or study) into the
 * suite's `events` table so the whole game-agnostic dashboard — General,
 * Process, Network (TNA), and clustering — runs on it with no per-game code.
 *
 * The analytics only need three things per row: a CASE id (→ session_id), an
 * ACTIVITY (→ type), and an ORDER (an explicit sequence, or a timestamp we sort
 * by). That is the classic process-mining event-log triple, so most existing
 * data maps straight in. A timestamp also feeds the date filters (→ created_at)
 * and session-duration spans (→ t_ms); an optional actor becomes the player.
 *
 * Two entry points:
 *   analyze(text, filename) → sniff format, parse, propose a column mapping, and
 *                             return a small preview (no writes).
 *   commit({...})           → parse fully with a confirmed mapping and insert,
 *                             all in one transaction. Returns a summary.
 *
 * Ludix's own /export JSON round-trips: its columns (session_id, type, iso, …)
 * are auto-detected, so an export re-imports exactly.
 * ========================================================================== */
"use strict";

const crypto = require("crypto");
const db = require("./db");

const MAX_ROWS = 500000; // hard cap per import, to bound memory + a runaway file

/* ============================================================================
 * CSV parsing (RFC-4180-ish: quoted fields, escaped "" quotes, CR/LF handling)
 * ==========================================================================*/
function parseCsv(text) {
  const rows = [];
  let field = "", row = [], inQuotes = false;
  const s = text.replace(/^﻿/, ""); // strip BOM
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field); field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return { headers: [], rows: [] };
  const headers = rows[0].map((h) => String(h).trim());
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const obj = {};
    for (let c = 0; c < headers.length; c++) obj[headers[c]] = rows[r][c] != null ? rows[r][c] : "";
    out.push(obj);
  }
  return { headers, rows: out };
}

/* ============================================================================
 * Format detection + parsing to { headers, rows:[{}] }
 * ==========================================================================*/
function parseAny(text, filename) {
  const trimmed = String(text || "").replace(/^﻿/, "").trimStart();
  const looksJson = /\.json$/i.test(filename || "") || trimmed[0] === "[" || trimmed[0] === "{";
  if (looksJson) {
    let data;
    try { data = JSON.parse(text); }
    catch (e) { throw new ImportError("Could not parse JSON: " + e.message); }
    let arr = Array.isArray(data) ? data
      : Array.isArray(data && data.events) ? data.events
      : Array.isArray(data && data.rows) ? data.rows
      : null;
    if (!arr) throw new ImportError("JSON must be an array of row objects (or { events: [...] }).");
    arr = arr.filter((r) => r && typeof r === "object" && !Array.isArray(r));
    const headers = unionKeys(arr);
    return { format: "json", headers, rows: arr };
  }
  const parsed = parseCsv(text);
  if (!parsed.headers.length) throw new ImportError("No columns found — is this a CSV with a header row?");
  return { format: "csv", headers: parsed.headers, rows: parsed.rows };
}

function unionKeys(arr) {
  const seen = [], has = new Set();
  for (let i = 0; i < arr.length && i < 200; i++) {
    for (const k of Object.keys(arr[i])) if (!has.has(k)) { has.add(k); seen.push(k); }
  }
  return seen;
}

/* ============================================================================
 * Column-role auto-detection
 * ==========================================================================*/
const norm = (h) => String(h).toLowerCase().replace(/[^a-z0-9]/g, "");

// Ordered hint lists per role; earlier = stronger. Matched against normalised
// header names, so "Case ID", "case_id" and "caseId" all read as "caseid".
const ROLE_HINTS = {
  session: ["caseid", "case", "sessionid", "session", "traceid", "trace", "attemptid", "attempt", "playid", "visitid", "sessionuuid"],
  activity: ["activity", "activityname", "action", "eventtype", "event", "type", "task", "step", "state", "concept:name", "conceptname"],
  timestamp: ["timestamp", "time:timestamp", "timetimestamp", "datetime", "occurredat", "occurred", "eventtime", "recordedat", "loggedat", "logged", "createdat", "completetime", "starttime", "startdate", "iso", "time", "ts", "date", "when"],
  actor: ["userid", "user", "studentid", "student", "playerid", "player", "resource", "actor", "subject", "participant", "learner", "org:resource"],
  seq: ["seq", "sequence", "order", "orderindex", "index", "position", "eventnr", "eventno", "step", "nr"],
  // Per-run OUTCOME columns. These create a `scores` row per session so the
  // Prediction tab (which trains on runs) has something to learn — see commit().
  score: ["score", "points", "grade", "result", "value", "reward", "mark"],
  stars: ["stars", "rating", "star"],
  level: ["level", "difficulty", "stage", "round", "lvl"],
};

// Roles matched, in priority order — required/ordering roles claim columns before
// the optional outcome roles, so a stray "value" never steals the timestamp.
const ROLES = ["session", "activity", "timestamp", "actor", "seq", "score", "stars", "level"];

function guessMapping(headers) {
  const normed = headers.map((h) => ({ raw: h, n: norm(h) }));
  const used = new Set();
  const mapping = { session: null, activity: null, timestamp: null, actor: null, seq: null, score: null, stars: null, level: null };
  for (const role of ROLES) {
    for (const hint of ROLE_HINTS[role]) {
      const hit = normed.find((h) => !used.has(h.raw) && (h.n === norm(hint) || h.n.includes(norm(hint))));
      if (hit) { mapping[role] = hit.raw; used.add(hit.raw); break; }
    }
  }
  return mapping;
}

// Ludix's own export has these columns; detect it so an export round-trips.
function isLudixExport(headers) {
  const s = new Set(headers.map(norm));
  return s.has("sessionid") && s.has("type") && (s.has("seq") || s.has("iso"));
}

/* ============================================================================
 * Timestamp parsing — epoch (s/ms), ISO, and common date strings.
 * Returns { ms, iso } or null when unparseable.
 * ==========================================================================*/
function parseTs(v) {
  if (v == null || v === "") return null;
  if (typeof v === "number" || /^\d+(\.\d+)?$/.test(String(v).trim())) {
    let n = Number(v);
    if (!isFinite(n)) return null;
    if (n < 1e11) n *= 1000;            // seconds → ms (anything before ~2001 in ms is implausibly small here)
    const d = new Date(n);
    return isNaN(d.getTime()) ? null : { ms: n, iso: d.toISOString() };
  }
  const t = Date.parse(String(v));
  if (!isNaN(t)) return { ms: t, iso: new Date(t).toISOString() };
  return null;
}

const sqlTime = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

/* ============================================================================
 * Per-column stats over a bounded sample — feeds the client-side mapping
 * "quality verdict" (whether the chosen columns are good enough), which
 * re-evaluates on every remap without another server round-trip.
 *   fill         fraction of rows with a non-empty value
 *   distinct     distinct non-empty values seen (capped)
 *   distinctRatio distinct / non-empty  (≈1 ⇒ unique per row)
 *   numericRate  fraction of non-empty values that are numbers
 *   tsParseRate  fraction of non-empty values that parse as a timestamp
 * ==========================================================================*/
const STATS_SAMPLE = 2000;
function columnStats(headers, rows) {
  const N = Math.min(rows.length, STATS_SAMPLE);
  const out = {};
  for (const h of headers) {
    const seen = new Set();
    let nonEmpty = 0, numeric = 0, ts = 0;
    for (let i = 0; i < N; i++) {
      let v = rows[i][h];
      if (v && typeof v === "object") v = JSON.stringify(v);
      const s = v == null ? "" : String(v).trim();
      if (s === "") continue;
      nonEmpty++;
      if (seen.size < 5000) seen.add(s);
      if (/^-?\d+(\.\d+)?$/.test(s)) numeric++;
      if (parseTs(s) != null) ts++;
    }
    out[h] = {
      fill: N ? nonEmpty / N : 0,
      distinct: seen.size,
      distinctRatio: nonEmpty ? seen.size / nonEmpty : 0,
      numericRate: nonEmpty ? numeric / nonEmpty : 0,
      tsParseRate: nonEmpty ? ts / nonEmpty : 0,
    };
  }
  return out;
}

/* ============================================================================
 * analyze — sniff, parse, propose mapping + preview (no writes)
 * ==========================================================================*/
function analyze(text, filename) {
  const { format, headers, rows } = parseAny(text, filename);
  if (!rows.length) throw new ImportError("The file has a header but no data rows.");
  const ludix = isLudixExport(headers);
  const mapping = guessMapping(headers);
  const stats = columnStats(headers, rows);

  // Quick timestamp-parse rate on a sample, so the UI can warn early.
  const tsCol = mapping.timestamp;
  const tsRate = tsCol && stats[tsCol] ? stats[tsCol].tsParseRate : null;

  const warnings = [];
  if (!mapping.session) warnings.push("No case/session column detected — pick one, or every row is treated as one session.");
  if (!mapping.activity) warnings.push("No activity/event-type column detected — the analytics need this; pick one.");
  if (tsRate != null && tsRate < 0.5) warnings.push("Most values in the timestamp column did not parse as dates — check the mapping.");

  return {
    format, isLudixExport: ludix, headers, mapping,
    rowCount: rows.length,
    sample: rows.slice(0, 8),
    columnStats: stats,
    timestampParseRate: tsRate,
    warnings,
  };
}

/* ============================================================================
 * commit — parse with a confirmed mapping and insert into `events` (+ one
 * synthetic `scores` run per session, so the Prediction tab has runs to learn).
 *   opts = { text, filename, gameId, mapping, actorMode }
 *   actorMode: "column" (mapping.actor) | "session" (case = player) | "single"
 *   mapping may also carry OUTCOME columns score / stars / level, folded into
 *   each session's run (see below). The whole insert is one transaction, tagged
 *   with an `imports` row so it can later be listed and removed as a unit.
 * ==========================================================================*/
const GAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

// Outcome parsers: one value per run, so tolerate blanks/garbage → null.
const numOr = (v) => { if (v == null || String(v).trim() === "") return null; const n = Number(v); return isFinite(n) ? n : null; };
const intOr = (v) => { const n = numOr(v); return n == null ? null : Math.round(n); };
const strOr = (v) => { if (v == null) return null; const s = String(v).trim(); return s === "" ? null : s.slice(0, 60); };

function commit(opts) {
  opts = opts || {};
  const gameId = String(opts.gameId || "").trim();
  if (!GAME_RE.test(gameId)) throw new ImportError("gameId must be a slug: lowercase letters, numbers, dashes (e.g. my-study).");
  if (gameId === "admin" || gameId === "api") throw new ImportError('"' + gameId + '" is reserved.');

  const { format, headers, rows } = parseAny(opts.text, opts.filename);
  if (!rows.length) throw new ImportError("No data rows to import.");
  if (rows.length > MAX_ROWS) throw new ImportError("Too many rows (" + rows.length + "); the limit per import is " + MAX_ROWS + ".");

  const m = opts.mapping || {};
  if (!m.activity) throw new ImportError("An activity/event-type column is required.");
  const actorMode = opts.actorMode || (m.actor ? "column" : "session");

  const get = (row, col) => (col && row[col] != null ? row[col] : null);

  // 1) Normalise rows into { sid, actor, type, ts, seqHint, outcome, payload, _i }.
  const items = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const type = get(row, m.activity);
    if (type == null || String(type).trim() === "") continue; // no activity → not an event
    const sidRaw = m.session ? get(row, m.session) : null;
    const sid = sidRaw != null && String(sidRaw).trim() !== "" ? String(sidRaw) : "session-1";
    const ts = m.timestamp ? parseTs(get(row, m.timestamp)) : null;
    const seqHint = m.seq != null ? Number(get(row, m.seq)) : NaN;
    let actor;
    if (actorMode === "single") actor = "imported";
    else if (actorMode === "column" && m.actor) actor = sanitizeName(get(row, m.actor)) || "anon";
    else actor = "case-" + sid; // per-case player
    items.push({
      sid: String(sid), actor: sanitizeName(actor), type: String(type), ts, seqHint, payload: row, _i: i,
      score: m.score ? numOr(get(row, m.score)) : null,
      stars: m.stars ? intOr(get(row, m.stars)) : null,
      level: m.level ? strOr(get(row, m.level)) : null,
    });
  }
  if (!items.length) throw new ImportError("Every row was empty in the activity column — nothing to import.");

  // 2) Group by session and order (explicit seq → timestamp → file order).
  const bySession = new Map();
  for (const it of items) { if (!bySession.has(it.sid)) bySession.set(it.sid, []); bySession.get(it.sid).push(it); }
  for (const list of bySession.values()) {
    list.sort((a, b) => {
      if (!isNaN(a.seqHint) && !isNaN(b.seqHint) && a.seqHint !== b.seqHint) return a.seqHint - b.seqHint;
      if (a.ts && b.ts && a.ts.ms !== b.ts.ms) return a.ts.ms - b.ts.ms;
      return a._i - b._i;
    });
  }

  // 3) Insert, all-or-nothing.
  const ins = {
    importRow: db.prepare(`INSERT INTO imports (game_id, filename, format, rows, mapping, actor_mode, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?)`),
    finalizeImport: db.prepare(`UPDATE imports SET events=?, sessions=?, runs=?, players_created=?, activities=?, date_from=?, date_to=? WHERE id=?`),
    player: db.prepare("INSERT INTO players (username, token, created_at, last_seen_at) VALUES (?, ?, ?, ?)"),
    findPlayer: db.prepare("SELECT id FROM players WHERE username=? COLLATE NOCASE"),
    event: db.prepare(`INSERT INTO events (player_id, game_id, session_id, seq, type, t_ms, iso, payload, created_at, import_id)
                       VALUES (@player_id,@game_id,@session_id,@seq,@type,@t_ms,@iso,@payload,@created_at,@import_id)`),
    score: db.prepare(`INSERT INTO scores (player_id, game_id, level, score, stars, session_id, meta, created_at, import_id)
                       VALUES (@player_id,@game_id,@level,@score,@stars,@session_id,@meta,@created_at,@import_id)`),
  };
  const playerCache = new Map();
  const nowSql = sqlTime(Date.now());
  const activities = new Set();
  let unparsedTs = 0, events = 0, runs = 0, playersCreated = 0;
  let minMs = Infinity, maxMs = -Infinity;

  const ensurePlayer = (username, createdSql) => {
    if (playerCache.has(username)) return playerCache.get(username);
    const existing = ins.findPlayer.get(username);
    if (existing) { playerCache.set(username, existing.id); return existing.id; }
    const id = ins.player.run(username, crypto.randomBytes(24).toString("hex"), createdSql, createdSql).lastInsertRowid;
    playersCreated++; playerCache.set(username, id);
    return id;
  };

  const run = db.transaction(() => {
    const importId = ins.importRow.run(gameId, opts.filename || null, format, rows.length,
      JSON.stringify(m), actorMode, nowSql).lastInsertRowid;

    for (const list of bySession.values()) {
      const sessionMs = list.find((x) => x.ts) ? list.find((x) => x.ts).ts.ms : null;
      const createdSql = sessionMs != null ? sqlTime(sessionMs) : nowSql;
      const playerId = ensurePlayer(list[0].actor, createdSql);
      // Fold the session's outcome: last non-empty value wins (the run's result).
      let score = null, stars = null, level = null;
      for (let s = 0; s < list.length; s++) {
        const it = list[s];
        activities.add(it.type);
        if (m.timestamp && !it.ts) unparsedTs++;
        const ms = it.ts ? it.ts.ms : null;
        if (ms != null) { if (ms < minMs) minMs = ms; if (ms > maxMs) maxMs = ms; }
        if (it.score != null) score = it.score;
        if (it.stars != null) stars = it.stars;
        if (it.level != null) level = it.level;
        ins.event.run({
          player_id: playerId, game_id: gameId, session_id: it.sid, seq: s,
          type: it.type,
          t_ms: ms != null ? ms : s * 1000,
          iso: it.ts ? it.ts.iso : null,
          payload: JSON.stringify(it.payload),
          created_at: ms != null ? sqlTime(ms) : nowSql,
          import_id: importId,
        });
        events++;
      }
      // One run per session so /predict has a training row (score defaults to 0
      // when no outcome column is mapped — enough for the sessionLen target).
      ins.score.run({
        player_id: playerId, game_id: gameId, level: level,
        score: score != null ? score : 0, stars: stars,
        session_id: list[0].sid, meta: JSON.stringify({ imported: true, import_id: importId }),
        created_at: createdSql, import_id: importId,
      });
      runs++;
    }

    ins.finalizeImport.run(events, bySession.size, runs, playersCreated, activities.size,
      minMs <= maxMs ? sqlTime(minMs) : null, minMs <= maxMs ? sqlTime(maxMs) : null, importId);
    return importId;
  });
  const importId = run();

  return {
    importId, gameId, events, runs, sessions: bySession.size,
    playersCreated, activities: activities.size,
    activityNames: Array.from(activities).slice(0, 50),
    unparsedTimestamps: unparsedTs,
    dateRange: minMs <= maxMs ? { from: sqlTime(minMs), to: sqlTime(maxMs) } : null,
    actorMode,
    hasOutcome: !!(m.score || m.stars),
  };
}

/* ============================================================================
 * listImports / deleteImport — manage imports as removable batches
 * ==========================================================================*/
function listImports(gameId) {
  const g = gameId != null && String(gameId).trim() !== "" ? String(gameId).trim() : null;
  const sql = `SELECT id, game_id AS gameId, filename, format, rows, events, sessions, runs,
                      players_created AS playersCreated, activities, actor_mode AS actorMode,
                      date_from AS dateFrom, date_to AS dateTo, created_at AS createdAt
                 FROM imports${g ? " WHERE game_id=?" : ""} ORDER BY id DESC`;
  return g ? db.prepare(sql).all(g) : db.prepare(sql).all();
}

function deleteImport(id) {
  const importId = parseInt(id, 10);
  if (!Number.isFinite(importId)) throw new ImportError("Invalid import id.");
  const row = db.prepare("SELECT id, game_id AS gameId FROM imports WHERE id=?").get(importId);
  if (!row) return null;

  const del = db.transaction(() => {
    // Player ids this import touched — candidates for cleanup once its rows are gone.
    const pids = db.prepare(
      "SELECT DISTINCT player_id AS id FROM events WHERE import_id=? UNION SELECT DISTINCT player_id FROM scores WHERE import_id=?"
    ).all(importId, importId).map((r) => r.id);

    const events = db.prepare("DELETE FROM events WHERE import_id=?").run(importId).changes;
    const runs = db.prepare("DELETE FROM scores WHERE import_id=?").run(importId).changes;

    // Remove players left with no events AND no scores anywhere in the suite —
    // scoped to this import's players, so native/other players are never touched.
    let playersRemoved = 0;
    const evCount = db.prepare("SELECT COUNT(*) n FROM events WHERE player_id=?");
    const scCount = db.prepare("SELECT COUNT(*) n FROM scores WHERE player_id=?");
    const delPlayer = db.prepare("DELETE FROM players WHERE id=?");
    for (const pid of pids) {
      if (evCount.get(pid).n === 0 && scCount.get(pid).n === 0) playersRemoved += delPlayer.run(pid).changes;
    }

    db.prepare("DELETE FROM imports WHERE id=?").run(importId);
    return { events, runs, playersRemoved };
  });
  const out = del();
  return Object.assign({ deleted: true, id: importId, gameId: row.gameId }, out);
}

// Count events already stored under a gameId — so the UI can warn before an
// import appends to a game that already has data.
function existingEventCount(gameId) {
  try { return db.prepare("SELECT COUNT(*) n FROM events WHERE game_id=?").get(String(gameId)).n; }
  catch (e) { return 0; }
}

function sanitizeName(v) {
  let s = String(v == null ? "" : v).trim().replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!s) s = "anon";
  return s.slice(0, 40);
}

class ImportError extends Error {}

module.exports = { analyze, commit, existingEventCount, listImports, deleteImport, ImportError, parseCsv, parseTs, guessMapping };
