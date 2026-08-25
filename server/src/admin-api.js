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
const pm = require("./process-mining");
const predict = require("./predict");
const importer = require("./import");
const reports = require("./reports");

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

  // ---- Research analytics (game-agnostic, learning-analytics oriented) -------
  // Four metrics serious-games research cares about, all derived from the generic
  // event+score envelope: a LEARNING CURVE (do players improve with practice), an
  // EFFORT–PERFORMANCE relationship (does time-on-task relate to achievement), a
  // RETENTION survival curve, and an ENGAGEMENT distribution (Gini + Lorenz).
  router.get("/games/:gameId/research", (req, res) => {
    const gameId = String(req.params.gameId);
    const P = Object.assign({ g: gameId }, U.filterParams(req.query));
    const eW = U.whereFor("e", req.query);
    const sW = U.whereFor("s", req.query);
    const eJ = U.joinFor("e", req.query);
    const sJ = U.joinFor("s", req.query);

    // 1) Learning curve: mean score by per-player attempt index. Only attempts
    // with enough players to be meaningful, capped so the x-axis stays readable.
    const LC_MAX_ATTEMPTS = 20, LC_MIN_N = 3;
    const learningRows = db.prepare(
      `SELECT attempt, AVG(score) AS avg, AVG(stars) AS avgStars, COUNT(*) AS n
         FROM (SELECT s.score AS score, s.stars AS stars,
                      ROW_NUMBER() OVER (PARTITION BY s.player_id ORDER BY s.created_at, s.id) AS attempt
                 FROM scores s${sJ} WHERE s.game_id=@g AND s.session_id IS NOT NULL${sW})
        WHERE attempt <= @lcMax GROUP BY attempt HAVING n >= @lcMin ORDER BY attempt`
    ).all(Object.assign({ lcMax: LC_MAX_ATTEMPTS, lcMin: LC_MIN_N }, P));
    const learningCurve = learningRows.map((r) => ({
      attempt: r.attempt, avg: U.round(r.avg, 4), avgStars: U.round(r.avgStars, 3), n: r.n,
    }));

    // 2) Effort vs performance: one point per run (session duration + event count
    // vs score). Bounded read; Pearson r computed over what we read.
    const EFFORT_CAP = 4000;
    const effortRows = db.prepare(
      `SELECT s.score AS score, ev.n AS events, ev.dur AS durMin
         FROM scores s${sJ}
         JOIN (SELECT e.session_id AS sid, COUNT(*) AS n,
                      MAX(0, MAX(e.t_ms) - MIN(e.t_ms)) / 60000.0 AS dur
                 FROM events e${eJ} WHERE e.game_id=@g${eW} GROUP BY e.session_id) ev
           ON ev.sid = s.session_id
        WHERE s.game_id=@g AND s.session_id IS NOT NULL${sW}
        LIMIT @cap`
    ).all(Object.assign({ cap: EFFORT_CAP }, P));
    const pearson = (xs, ys) => {
      const n = xs.length; if (n < 3) return null;
      let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
      for (let i = 0; i < n; i++) { const x = xs[i], y = ys[i]; sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; }
      const cov = sxy - sx * sy / n, vx = sxx - sx * sx / n, vy = syy - sy * sy / n;
      return vx > 0 && vy > 0 ? U.round(cov / Math.sqrt(vx * vy), 4) : null;
    };
    const durs = effortRows.map((r) => r.durMin), evs = effortRows.map((r) => r.events), scs = effortRows.map((r) => r.score);
    const effort = {
      n: effortRows.length,
      rDurationScore: pearson(durs, scs),
      rEventsScore: pearson(evs, scs),
      scatter: effortRows.slice(0, 400).map((r) => ({ durMin: U.round(r.durMin, 3), events: r.events, score: U.round(r.score, 4) })),
    };

    // 3) Retention (survival) curve: per player, the max day-offset between first
    // and last active day; R(d) = fraction still returning ≥ d days after first.
    const spanRows = db.prepare(
      `SELECT CAST(julianday(MAX(date(e.created_at))) - julianday(MIN(date(e.created_at))) AS INT) AS maxoff
         FROM events e${eJ} WHERE e.game_id=@g${eW} GROUP BY e.player_id`
    ).all(P);
    const totalPlayers = spanRows.length;
    let maxDay = 0; spanRows.forEach((r) => { if (r.maxoff > maxDay) maxDay = r.maxoff; });
    maxDay = Math.min(maxDay, 60);
    const atLeast = new Array(maxDay + 2).fill(0);
    spanRows.forEach((r) => { const d = Math.max(0, Math.min(maxDay + 1, r.maxoff)); atLeast[d]++; });
    // suffix sum: players with lifespan ≥ d
    for (let d = maxDay; d >= 0; d--) atLeast[d] += atLeast[d + 1];
    const retention = totalPlayers
      ? Array.from({ length: maxDay + 1 }, (_, d) => ({ day: d, retained: U.round(atLeast[d] / totalPlayers, 4) }))
      : [];

    // 4) Engagement distribution: per-player event counts → Gini + Lorenz curve.
    const perPlayer = db.prepare(
      `SELECT COUNT(*) AS n FROM events e${eJ} WHERE e.game_id=@g${eW} GROUP BY e.player_id`
    ).all(P).map((r) => r.n).sort((a, b) => a - b);
    let gini = null, lorenz = [];
    if (perPlayer.length) {
      const N = perPlayer.length, total = perPlayer.reduce((a, v) => a + v, 0);
      if (total > 0) {
        // Gini via the ordered-values formula: (2·Σ i·x_i)/(N·Σx) − (N+1)/N.
        let wsum = 0; for (let i = 0; i < N; i++) wsum += (i + 1) * perPlayer[i];
        gini = U.round((2 * wsum) / (N * total) - (N + 1) / N, 4);
        // Downsampled Lorenz curve: cumulative share of events vs share of players.
        const STEPS = Math.min(100, N);
        lorenz = [{ p: 0, cum: 0 }];
        let cum = 0, idx = 0;
        for (let s = 1; s <= STEPS; s++) {
          const upto = Math.round((s / STEPS) * N);
          while (idx < upto) { cum += perPlayer[idx]; idx++; }
          lorenz.push({ p: U.round(upto / N, 4), cum: U.round(cum / total, 4) });
        }
      }
    }

    res.json({
      gameId,
      meta: {
        hasScores: learningCurve.length > 0 || effort.n > 0,
        players: totalPlayers, runs: effort.n,
      },
      learningCurve, effort, retention,
      engagement: { gini, lorenz, players: perPlayer.length },
    });
  });

  // ---- Process / sequence mining (game-agnostic, ladyna) --------------------
  // Derives process-mining artefacts from the session sequences via ladyna's
  // validated processmining module: trace variants (the distinct paths sessions
  // take), a directly-follows graph, activity stats and start/end activities.
  // See process-mining.js.
  router.get("/games/:gameId/process", (req, res) => {
    try {
      res.json(pm.compute(String(req.params.gameId), req.query));
    } catch (e) {
      res.status(500).json({ error: "process_failed", detail: String(e.message) });
    }
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

  // Behaviour patterns → outcome: frequent sequential patterns screened for
  // association with a run outcome (score / stars / pass). See tna.js.
  router.get("/games/:gameId/tna/patterns", (req, res) => {
    try {
      res.json(tna.computePatterns(String(req.params.gameId), req.query));
    } catch (e) {
      res.status(500).json({ error: "patterns_failed", detail: String(e.message) });
    }
  });

  // Cohort comparison: two transition networks (high vs low on an outcome)
  // compared edge-by-edge with a permutation test. See tna.js.
  router.get("/games/:gameId/tna/compare", (req, res) => {
    try {
      res.json(tna.computeCompare(String(req.params.gameId), req.query));
    } catch (e) {
      res.status(500).json({ error: "compare_failed", detail: String(e.message) });
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

  // ---- Import batches: list + delete ----------------------------------------
  // Each commit registers an `imports` row; its events + synthetic runs carry
  // that id, so an import can be removed as a unit.
  router.get("/imports", (req, res) => {
    try { res.json({ imports: importer.listImports(req.query.game || null) }); }
    catch (e) { importErr(res, e); }
  });

  router.delete("/imports/:id", (req, res) => {
    try {
      const out = importer.deleteImport(req.params.id);
      if (!out) return res.status(404).json({ error: "not_found", detail: "No such import." });
      res.json(out);
    } catch (e) { importErr(res, e); }
  });

  function importErr(res, e) {
    if (e instanceof importer.ImportError) return res.status(400).json({ error: "import_failed", detail: e.message });
    console.error("import error:", e);
    res.status(500).json({ error: "server_error", detail: "Import failed unexpectedly." });
  }

  // ---- Reports: build / list / view / download / delete ---------------------
  // Self-contained HTML reports (printable to PDF) built from the same analytics
  // as the dashboard, scoped by date/time + selected students. See reports.js.
  reports.mount(router);
}

module.exports = { mount };
