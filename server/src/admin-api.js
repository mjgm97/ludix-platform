/* =============================================================================
 * Suite server — general analytics API (admin only)
 * -----------------------------------------------------------------------------
 * GAME-AGNOSTIC analytics: everything here is derivable from the event envelope
 * (players, sessions, events, timing, event-type counts) and the scores table,
 * so it works for ANY game in the suite. Anything that reads game-specific
 * payload fields or assumes specific event types (e.g. Wild AI's model_trained
 * signals) lives in games-analytics/<game>.js and is served by /specific.
 *
 * All routes here are mounted behind requireAdmin in server.js.
 * ========================================================================== */
"use strict";

const db = require("./db");
const U = require("./analytics-util");
const games = require("./games-analytics");
const config = require("./config");
const seq = require("./sequences");
const tna = require("./tna");
const predict = require("./predict");
const importer = require("./import");

// Bucket labels for the score (%) and session-length (min) histograms. The
// bucket edges live inline in the SQL that fills them (see /summary).
const HIST_SCORE_LABELS = ["0–10%", "10–20%", "20–30%", "30–40%", "40–50%", "50–60%", "60–70%", "70–80%", "80–90%", "90–100%"];
const HIST_DUR_LABELS = ["0–2m", "2–5m", "5–10m", "10–20m", "20–40m", "40m+"];

function mount(router) {
  // ---- Overview: all games with data, plus suite totals ---------------------
  router.get("/overview", (req, res) => {
    const evByGame = db.prepare(
      `SELECT game_id AS gameId, COUNT(*) AS events,
              COUNT(DISTINCT player_id) AS players,
              COUNT(DISTINCT session_id) AS sessions,
              MIN(created_at) AS firstSeen, MAX(created_at) AS lastSeen
         FROM events GROUP BY game_id`
    ).all();
    const runsByGame = db.prepare(`SELECT game_id AS gameId, COUNT(*) AS runs FROM scores GROUP BY game_id`).all();
    const runsMap = {}; runsByGame.forEach((r) => (runsMap[r.gameId] = r.runs));
    const gameList = evByGame.map((g) => Object.assign(g, { runs: runsMap[g.gameId] || 0, hasSpecific: games.has(g.gameId) }))
      .sort((a, b) => b.events - a.events);
    runsByGame.forEach((r) => { if (!gameList.find((g) => g.gameId === r.gameId)) gameList.push({ gameId: r.gameId, events: 0, players: 0, sessions: 0, runs: r.runs, firstSeen: null, lastSeen: null, hasSpecific: games.has(r.gameId) }); });

    // These are unfiltered full-table counts; memoise briefly so repeated
    // dashboard polls don't re-scan the whole DB every time.
    const totals = U.memo("overview:totals", config.overviewCacheMs, () => ({
      games: gameList.length,
      players: db.prepare("SELECT COUNT(*) AS n FROM players").get().n,
      admins: db.prepare("SELECT COUNT(*) AS n FROM admin_users").get().n,
      events: db.prepare("SELECT COUNT(*) AS n FROM events").get().n,
      runs: db.prepare("SELECT COUNT(*) AS n FROM scores").get().n,
    }));
    res.json({ totals, games: gameList });
  });

  // ---- Per-game GENERAL summary (works for any game) ------------------------
  router.get("/games/:gameId/summary", (req, res) => {
    const gameId = String(req.params.gameId);
    const P = Object.assign({ g: gameId }, U.filterParams(req.query));
    const eW = U.whereFor("e", req.query);
    const sW = U.whereFor("s", req.query);
    // Join players only when the user filter needs it (see joinFor).
    const eJ = U.joinFor("e", req.query);
    const sJ = U.joinFor("s", req.query);

    const ev = db.prepare(
      `SELECT COUNT(*) AS events, COUNT(DISTINCT e.player_id) AS players, COUNT(DISTINCT e.session_id) AS sessions
         FROM events e${eJ} WHERE e.game_id=@g${eW}`
    ).get(P);
    const sc = db.prepare(
      `SELECT COUNT(*) AS runs, AVG(s.score) AS avgScore, AVG(s.stars) AS avgStars
         FROM scores s${sJ} WHERE s.game_id=@g${sW}`
    ).get(P);

    // Players with more than one session = "returning".
    const returning = db.prepare(
      `SELECT COUNT(*) AS n FROM (SELECT e.player_id FROM events e${eJ}
         WHERE e.game_id=@g${eW} GROUP BY e.player_id HAVING COUNT(DISTINCT e.session_id) > 1)`
    ).get(P).n;

    // Session durations from the event-time span per session (game-agnostic —
    // no reliance on a session_end payload). Bucketed + averaged entirely in
    // SQL so we never pull one row per session into JS.
    const durAgg = db.prepare(
      `SELECT AVG(m) AS avgMin,
              SUM(m < 2) AS b0, SUM(m >= 2 AND m < 5) AS b1, SUM(m >= 5 AND m < 10) AS b2,
              SUM(m >= 10 AND m < 20) AS b3, SUM(m >= 20 AND m < 40) AS b4, SUM(m >= 40) AS b5
         FROM (SELECT MAX(0, MAX(e.t_ms) - MIN(e.t_ms)) / 60000.0 AS m
                 FROM events e${eJ} WHERE e.game_id=@g${eW} GROUP BY e.session_id)`
    ).get(P);
    const avgSessionMs = durAgg.avgMin != null ? durAgg.avgMin * 60000 : null;
    const sessionLength = HIST_DUR_LABELS.map((bucket, i) => ({ bucket, value: durAgg["b" + i] || 0 }));

    const eventTypes = db.prepare(
      `SELECT e.type AS type, COUNT(*) AS count FROM events e${eJ}
         WHERE e.game_id=@g${eW} GROUP BY e.type ORDER BY count DESC`
    ).all(P);

    // Score distribution bucketed in SQL: score is a 0..1 fraction, so score*10
    // clamped to [0,9] is the 10-wide %-bucket index.
    const scoreAgg = db.prepare(
      `SELECT MIN(9, MAX(0, CAST(s.score * 10 AS INT))) AS b, COUNT(*) AS n
         FROM scores s${sJ} WHERE s.game_id=@g${sW} GROUP BY b`
    ).all(P);
    const scoreBuckets = {}; scoreAgg.forEach((r) => (scoreBuckets[r.b] = r.n));
    const scoreHistogram = HIST_SCORE_LABELS.map((bucket, i) => ({ bucket, value: scoreBuckets[i] || 0 }));

    const hourRows = db.prepare(
      `SELECT CAST(strftime('%H', e.created_at) AS INT) AS h, COUNT(*) AS n
         FROM events e${eJ} WHERE e.game_id=@g${eW} GROUP BY h`
    ).all(P);
    const hourMap = {}; hourRows.forEach((r) => (hourMap[r.h] = r.n));
    const hourly = Array.from({ length: 24 }, (_, h) => ({ hour: h, value: hourMap[h] || 0 }));

    const topPlayers = db.prepare(
      `SELECT p.username AS username, COUNT(*) AS events FROM events e${U.joinFor("e", req.query, { force: true })}
         WHERE e.game_id=@g${eW} GROUP BY p.id ORDER BY events DESC LIMIT 8`
    ).all(P);

    res.json({
      gameId,
      filters: { from: req.query.from || null, to: req.query.to || null, user: req.query.user || null },
      hasSpecific: games.has(gameId),
      specificLabel: games.get(gameId) ? games.get(gameId).label : null,
      tiles: {
        players: ev.players || 0,
        sessions: ev.sessions || 0,
        events: ev.events || 0,
        runs: sc.runs || 0,
        avgScore: U.round(sc.avgScore, 4),
        avgStars: U.round(sc.avgStars, 2),
        avgSessionMin: avgSessionMs != null ? U.round(avgSessionMs / 60000, 1) : null,
        avgEventsPerSession: ev.sessions ? U.round(ev.events / ev.sessions, 1) : null,
        sessionsPerPlayer: ev.players ? U.round(ev.sessions / ev.players, 1) : null,
        returningRate: ev.players ? U.round(returning / ev.players, 3) : null,
      },
      eventTypes, scoreHistogram, sessionLength, hourly, topPlayers,
    });
  });

  // ---- Per-game GENERAL daily time series -----------------------------------
  router.get("/games/:gameId/timeseries", (req, res) => {
    const gameId = String(req.params.gameId);
    const P = Object.assign({ g: gameId }, U.filterParams(req.query));
    const eW = U.whereFor("e", req.query);
    const sW = U.whereFor("s", req.query);
    const eJ = U.joinFor("e", req.query);
    const sJ = U.joinFor("s", req.query);

    const evDaily = db.prepare(
      `SELECT date(e.created_at) AS day, COUNT(*) AS events,
              COUNT(DISTINCT e.session_id) AS sessions, COUNT(DISTINCT e.player_id) AS players
         FROM events e${eJ} WHERE e.game_id=@g${eW} GROUP BY day ORDER BY day`
    ).all(P);
    const scDaily = db.prepare(
      `SELECT date(s.created_at) AS day, COUNT(*) AS runs, AVG(s.score) AS avgScore
         FROM scores s${sJ} WHERE s.game_id=@g${sW} GROUP BY day ORDER BY day`
    ).all(P);
    const scMap = {}; scDaily.forEach((r) => (scMap[r.day] = r));

    // First-seen day per player (for new-vs-returning). Global for the game.
    const firstSeen = db.prepare(
      `SELECT e.player_id AS id, date(MIN(e.created_at)) AS d FROM events e WHERE e.game_id=@g GROUP BY e.player_id`
    ).all({ g: gameId });
    const newByDay = {}; firstSeen.forEach((r) => (newByDay[r.d] = (newByDay[r.d] || 0) + 1));

    let merged = evDaily.map((r) => ({
      day: r.day, events: r.events, sessions: r.sessions, players: r.players,
      newPlayers: newByDay[r.day] || 0,
      runs: (scMap[r.day] && scMap[r.day].runs) || 0,
      avgScore: scMap[r.day] ? U.round(scMap[r.day].avgScore, 4) : null,
    }));
    scDaily.forEach((r) => { if (!merged.find((m) => m.day === r.day)) merged.push({ day: r.day, events: 0, sessions: 0, players: 0, newPlayers: newByDay[r.day] || 0, runs: r.runs, avgScore: U.round(r.avgScore, 4) }); });
    merged.sort((a, b) => (a.day > b.day ? 1 : -1));
    merged = U.fillDays(merged, P.from, P.to, ["events", "sessions", "players", "newPlayers", "runs"]);
    res.json({ gameId, series: merged });
  });

  // ---- Process / sequence mining (game-agnostic) ----------------------------
  // Derives process-mining artefacts from the raw event stream: trace variants
  // (the distinct paths sessions take), a directly-follows graph, start/end
  // activities and summary stats. Everything comes from (session_id, seq, type),
  // so it works for any game in the suite.
  router.get("/games/:gameId/process", (req, res) => {
    const gameId = String(req.params.gameId);
    // One ordered activity sequence per session (bounded read; see sequences.js).
    const { sessions, events: eventCount, truncated } = seq.fetchSequences(gameId, req.query);

    // Activity frequency (across all events).
    const actCount = {};
    sessions.forEach((s) => s.forEach((t) => { actCount[t] = (actCount[t] || 0) + 1; }));
    const activities = Object.keys(actCount).map((t) => ({ type: t, count: actCount[t] })).sort((a, b) => b.count - a.count);

    // Directly-follows graph (self-loops included) + start/end activities.
    // Key on a delimiter that can't occur in an activity name (types come from
    // event.type), so multi-word activities survive. The old `a + "" + b` /
    // split("") scheme mangled "animal_approached"→"identify" into "a"→"n".
    // Shared with /tna via analytics-util so both key transitions identically.
    const SEP = U.SEP;
    const dfg = {}; let transTotal = 0, selfLoops = 0; const starts = {}, ends = {};
    sessions.forEach((s) => {
      starts[s[0]] = (starts[s[0]] || 0) + 1;
      ends[s[s.length - 1]] = (ends[s[s.length - 1]] || 0) + 1;
      for (let i = 1; i < s.length; i++) {
        const k = s[i - 1] + SEP + s[i];
        dfg[k] = (dfg[k] || 0) + 1; transTotal++;
        if (s[i - 1] === s[i]) selfLoops++;
      }
    });
    const transitions = Object.keys(dfg).map((k) => { const p = k.split(SEP); return { from: p[0], to: p[1], count: dfg[k] }; }).sort((a, b) => b.count - a.count);
    const toList = (o) => Object.keys(o).map((k) => ({ type: k, count: o[k] })).sort((a, b) => b.count - a.count);

    // Directly-follows chains of length N (self-loops included): how often a run
    // of N consecutive activities occurs. Computed in-memory over the sequences
    // we already fetched — 3- and 4-step add no DB work — and each list is capped
    // so the response stays small. The frontend switches step length locally.
    const DFG_STEPS = [2, 3, 4], DFG_TOP = 14;
    const ngrams = (N) => {
      const m = {};
      sessions.forEach((s) => { for (let i = 0; i + N <= s.length; i++) { const k = s.slice(i, i + N).join(SEP); m[k] = (m[k] || 0) + 1; } });
      return Object.keys(m).map((k) => ({ seq: k.split(SEP), count: m[k] })).sort((a, b) => b.count - a.count).slice(0, DFG_TOP);
    };
    const transitionsByN = {}; DFG_STEPS.forEach((N) => { transitionsByN[N] = ngrams(N); });

    // Trace variants: fold repeated adjacent blocks (loops) down to a single
    // pass — e.g. "A B C A B C A B C" -> "A B C" — so the loopy game logs
    // collapse into the small set of structural paths sessions actually take.
    const collapse = (s) => {
      const a = s.slice(); let changed = true;
      while (changed) {
        changed = false;
        const maxL = Math.min(6, Math.floor(a.length / 2));
        for (let L = 1; L <= maxL && !changed; L++) {
          for (let i = 0; i + 2 * L <= a.length; i++) {
            let same = true;
            for (let j = 0; j < L; j++) if (a[i + j] !== a[i + L + j]) { same = false; break; }
            if (same) { a.splice(i + L, L); changed = true; break; }
          }
        }
      }
      return a;
    };
    const vmap = {};
    sessions.forEach((s) => { const c = collapse(s); const key = c.join(""); if (!vmap[key]) vmap[key] = { sequence: c, count: 0 }; vmap[key].count++; });
    const variants = Object.keys(vmap).map((k) => vmap[k]).sort((a, b) => b.count - a.count)
      .map((v) => ({ sequence: v.sequence, count: v.count, coverage: sessions.length ? v.count / sessions.length : 0 }));

    const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
    const rawLens = sessions.map((s) => s.length);
    const colLens = sessions.map((s) => collapse(s).length);

    res.json({
      gameId,
      stats: {
        sessions: sessions.length,
        events: eventCount,
        variants: variants.length,
        avgSteps: U.round(avg(colLens), 1),
        avgEvents: U.round(avg(rawLens), 1),
        selfLoopRate: transTotal ? U.round(selfLoops / transTotal, 3) : null,
        distinctActivities: activities.length,
        truncated,
      },
      activities,
      variants: variants.slice(0, 12),
      transitions: transitions.slice(0, 14),
      transitionsByN,
      startActivities: toList(starts).slice(0, 8),
      endActivities: toList(ends).slice(0, 8),
    });
  });

  // ---- Transition Network Analysis (game-agnostic) --------------------------
  // A Markov transition network over the session sequences: nodes = activities,
  // edges = transition probabilities, plus initial probabilities, node/edge
  // centralities and (optional) bootstrap edge validation. See tna.js.
  router.get("/games/:gameId/tna", (req, res) => {
    try {
      res.json(tna.compute(String(req.params.gameId), req.query));
    } catch (e) {
      res.status(500).json({ error: "tna_failed", detail: String(e.message) });
    }
  });

  // Sequence/student clustering: k-means over per-session behaviour vectors,
  // returning one transition network + sequence sample per cluster.
  router.get("/games/:gameId/tna/clusters", (req, res) => {
    try {
      res.json(tna.computeClusters(String(req.params.gameId), req.query));
    } catch (e) {
      res.status(500).json({ error: "clusters_failed", detail: String(e.message) });
    }
  });

  // One page of the sequence index plot (?offset=&limit=), so the client can
  // browse every session without re-running the full network computation.
  router.get("/games/:gameId/tna/sequences", (req, res) => {
    try {
      res.json(tna.computeSequences(String(req.params.gameId), req.query));
    } catch (e) {
      res.status(500).json({ error: "sequences_failed", detail: String(e.message) });
    }
  });

  // ---- Predictive analytics + SHAP (game-agnostic) --------------------------
  // Trains a gradient-boosted tree ensemble to estimate a selectable target
  // (score / stars / session length / pass-fail) from a run's behaviour
  // features, and explains it with exact TreeSHAP (global importance + local
  // per-instance attributions). See predict.js.
  router.get("/games/:gameId/predict", (req, res) => {
    try {
      res.json(predict.compute(String(req.params.gameId), req.query));
    } catch (e) {
      res.status(500).json({ error: "predict_failed", detail: String(e.message) });
    }
  });

  // ---- Per-game player breakdown (general) ----------------------------------
  // ?light=1 returns just the roster (username/sessions/events/lastSeen) and
  // skips the per-player scores aggregation — that's all the filter-bar player
  // dropdown needs, so switching games/date ranges doesn't run the heavier query.
  router.get("/games/:gameId/players", (req, res) => {
    const gameId = String(req.params.gameId);
    const light = req.query.light === "1" || req.query.light === "true";
    const P = Object.assign({ g: gameId }, U.filterParams(req.query));
    const eW = U.whereFor("e", req.query);
    const sW = U.whereFor("s", req.query);

    const players = db.prepare(
      `SELECT p.id AS id, p.username AS username,
              COUNT(DISTINCT e.session_id) AS sessions, COUNT(*) AS events, MAX(e.created_at) AS lastSeen
         FROM events e JOIN players p ON p.id=e.player_id WHERE e.game_id=@g${eW} GROUP BY p.id`
    ).all(P);
    if (light) {
      const roster = players
        .map((pl) => ({ username: pl.username, sessions: pl.sessions, events: pl.events, lastSeen: pl.lastSeen }))
        .sort((a, b) => b.events - a.events);
      return res.json({ gameId, players: roster });
    }
    const runs = db.prepare(
      `SELECT s.player_id AS id, COUNT(*) AS runs, MAX(s.score) AS bestScore, MAX(s.stars) AS bestStars
         FROM scores s JOIN players p ON p.id=s.player_id WHERE s.game_id=@g${sW} GROUP BY s.player_id`
    ).all(P);
    const runMap = {}; runs.forEach((r) => (runMap[r.id] = r));
    const rows = players.map((pl) => {
      const r = runMap[pl.id] || {};
      return {
        username: pl.username, sessions: pl.sessions, events: pl.events, lastSeen: pl.lastSeen,
        runs: r.runs || 0,
        bestScore: r.bestScore != null ? U.round(r.bestScore, 4) : null,
        bestStars: r.bestStars != null ? r.bestStars : null,
      };
    }).sort((a, b) => b.events - a.events);
    res.json({ gameId, players: rows });
  });

  // ---- One player, drilled down ---------------------------------------------
  router.get("/players/:username", (req, res) => {
    const username = String(req.params.username);
    const player = db.prepare("SELECT id, username, created_at, last_seen_at FROM players WHERE username=? COLLATE NOCASE").get(username);
    if (!player) return res.status(404).json({ error: "no_such_player" });
    const gameFilter = req.query.game ? " AND game_id=@game" : "";
    const gp = { id: player.id, game: req.query.game || null };

    const perGame = db.prepare(
      `SELECT game_id AS gameId, COUNT(*) AS events, COUNT(DISTINCT session_id) AS sessions
         FROM events WHERE player_id=@id GROUP BY game_id`
    ).all({ id: player.id });
    const runsPerGame = db.prepare(`SELECT game_id AS gameId, COUNT(*) AS runs, MAX(score) AS best FROM scores WHERE player_id=@id GROUP BY game_id`).all({ id: player.id });
    const rpg = {}; runsPerGame.forEach((r) => (rpg[r.gameId] = r));
    perGame.forEach((g) => { g.runs = (rpg[g.gameId] && rpg[g.gameId].runs) || 0; g.best = rpg[g.gameId] ? U.round(rpg[g.gameId].best, 4) : null; });

    const runs = db.prepare(
      `SELECT game_id AS gameId, level, score, stars, session_id, meta, created_at
         FROM scores WHERE player_id=@id${gameFilter} ORDER BY created_at DESC LIMIT 100`
    ).all(gp).map((r) => Object.assign(r, { meta: r.meta ? JSON.parse(r.meta) : null }));
    const eventTypes = db.prepare(
      `SELECT type, COUNT(*) AS count FROM events WHERE player_id=@id${gameFilter} GROUP BY type ORDER BY count DESC`
    ).all(gp);

    res.json({ player: { username: player.username, created_at: player.created_at, last_seen_at: player.last_seen_at }, perGame, runs, eventTypes });
  });

  // ---- Game-specific analytics (dispatch to games-analytics/<game>.js) ------
  router.get("/games/:gameId/specific", (req, res) => {
    const mod = games.get(req.params.gameId);
    if (!mod) return res.json({ hasModule: false, gameId: req.params.gameId });
    try {
      const data = mod.compute(req.params.gameId, req.query);
      res.json(Object.assign({ hasModule: true, moduleId: mod.id, label: mod.label, gameId: req.params.gameId }, data));
    } catch (e) {
      res.status(500).json({ error: "specific_failed", detail: String(e.message) });
    }
  });

  // ---- Raw event feed (paginated) — "view everything" -----------------------
  router.get("/games/:gameId/events", (req, res) => {
    const gameId = String(req.params.gameId);
    const type = req.query.type ? String(req.query.type) : null;
    const limit = Math.min(500, Math.max(1, U.num(req.query.limit, 100)));
    const offset = Math.max(0, U.num(req.query.offset, 0));
    const P = Object.assign({ g: gameId, limit, offset }, U.filterParams(req.query));
    if (type) P.type = type;
    const eW = U.whereFor("e", req.query, { type });
    // The COUNT is the same for every page of one filter, so let the client
    // carry it forward: only recount on the first page (offset 0) or when no
    // cached total is supplied. The join is only needed under a user filter.
    const cachedTotal = req.query.total != null ? U.num(req.query.total, null) : null;
    const total = (offset > 0 && cachedTotal != null)
      ? cachedTotal
      : db.prepare(`SELECT COUNT(*) AS n FROM events e${U.joinFor("e", req.query)} WHERE e.game_id=@g${eW}`).get(P).n;
    const rows = db.prepare(
      `SELECT e.id, p.username, e.session_id, e.seq, e.type, e.t_ms, e.iso, e.created_at, e.payload
         FROM events e JOIN players p ON p.id=e.player_id WHERE e.game_id=@g${eW} ORDER BY e.id DESC LIMIT @limit OFFSET @offset`
    ).all(P).map((r) => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : null }));
    res.json({ gameId, total, limit, offset, events: rows });
  });

  // ---- Export (CSV / JSON), filtered ----------------------------------------
  router.get("/export", (req, res) => {
    const gameId = req.query.game ? String(req.query.game) : null;
    if (!gameId) return res.status(400).json({ error: "missing_game" });
    const dataset = req.query.dataset === "scores" ? "scores" : "events";
    const format = req.query.format === "json" ? "json" : "csv";
    const type = req.query.type ? String(req.query.type) : null;
    const P = Object.assign({ g: gameId }, U.filterParams(req.query));
    if (type) P.type = type;
    const fnameBase = `${gameId}-${dataset}-${new Date().toISOString().slice(0, 10)}`;

    let rows, cols;
    if (dataset === "scores") {
      const sW = U.whereFor("s", req.query);
      rows = db.prepare(
        `SELECT s.id, s.created_at, p.username, s.game_id, s.level, s.score, s.stars, s.session_id, s.meta
           FROM scores s JOIN players p ON p.id=s.player_id WHERE s.game_id=@g${sW} ORDER BY s.id ASC`
      ).all(P).map((r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null }));
      cols = ["id", "created_at", "username", "game_id", "level", "score", "stars", "session_id", "meta"];
    } else {
      const eW = U.whereFor("e", req.query, { type });
      rows = db.prepare(
        `SELECT e.id, e.created_at, e.iso, p.username, e.game_id, e.session_id, e.seq, e.type, e.t_ms, e.payload
           FROM events e JOIN players p ON p.id=e.player_id WHERE e.game_id=@g${eW} ORDER BY e.id ASC`
      ).all(P).map((r) => ({ ...r, payload: r.payload ? JSON.parse(r.payload) : null }));
      cols = ["id", "created_at", "iso", "username", "game_id", "session_id", "seq", "type", "t_ms", "payload"];
    }

    if (format === "json") {
      res.setHeader("Content-Disposition", `attachment; filename="${fnameBase}.json"`);
      res.setHeader("Content-Type", "application/json");
      return res.send(JSON.stringify(rows, null, 2));
    }
    res.setHeader("Content-Disposition", `attachment; filename="${fnameBase}.csv"`);
    res.setHeader("Content-Type", "text/csv");
    res.send(U.toCsv(rows, cols));
  });

  // ---- Import: bring an existing event log into a game bucket ----------------
  // analyze = sniff + propose a mapping (no writes); commit = insert. Both take
  // the raw file text in the JSON body (see the higher body limit in server.js).
  router.post("/import/analyze", (req, res) => {
    try {
      const text = String((req.body && req.body.text) || "");
      if (!text.trim()) return res.status(400).json({ error: "empty_file", detail: "No file contents received." });
      res.json(importer.analyze(text, (req.body && req.body.filename) || ""));
    } catch (e) { importErr(res, e); }
  });

  router.post("/import/commit", (req, res) => {
    try {
      const b = req.body || {};
      if (!String(b.text || "").trim()) return res.status(400).json({ error: "empty_file", detail: "No file contents received." });
      res.json(importer.commit({ text: String(b.text), filename: b.filename, gameId: b.gameId, mapping: b.mapping, actorMode: b.actorMode }));
    } catch (e) { importErr(res, e); }
  });

  // How many events a target game already has (so the UI can warn before append).
  router.get("/import/existing", (req, res) => {
    res.json({ gameId: req.query.game || null, events: importer.existingEventCount(req.query.game || "") });
  });

  function importErr(res, e) {
    if (e instanceof importer.ImportError) return res.status(400).json({ error: "import_failed", detail: e.message });
    console.error("import error:", e);
    res.status(500).json({ error: "server_error", detail: "Import failed unexpectedly." });
  }
}

module.exports = { mount };
