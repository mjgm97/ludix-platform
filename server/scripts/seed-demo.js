#!/usr/bin/env node
/* =============================================================================
 * Suite server — demo data seeder
 * -----------------------------------------------------------------------------
 * Generates believable players, runs and analytics events across THREE games and
 * the last ~14 days, so a fresh dashboard has something rich to show (engagement,
 * process mining, transition-network analysis, clustering AND prediction all work
 * off this). Inserts straight into the DB — no running server needed. Add-only;
 * run once on a fresh DB.  Usage:  npm run seed:demo
 *
 * Designed to be ILLUSTRATIVE, not random: every player is assigned ONE stable
 * PROFILE (a set of latent traits — speed, accuracy, persistence, exploration)
 * that shapes ALL their sessions. Because a player behaves consistently, the
 * dashboard's clustering finds clean groups, the transition networks differ
 * between groups, and prediction sees real signal (score is driven by the same
 * behaviour the model gets as features). A gentle practice effect makes later
 * attempts score higher, so the learning curve rises too.
 *
 *   Profiles:  Ace · Speedster · Steady · Struggler · Explorer
 *   Games:     quick-tap        reaction game   (round_start · hit · miss · expire · round_end)
 *              fraction-forest  math adventure  (branching paths, hints, retries)
 *              circuit-smith    physics sandbox (build · simulate · debug · measure)
 * ========================================================================== */
"use strict";

const crypto = require("crypto");
const db = require("./../src/db");

// 20 learners → ~4 per profile, plenty of runs for prediction + clustering.
const NAMES = [
  "ada_lovelace", "grace_hopper", "alan_turing", "katherine_j", "linus_t",
  "margaret_h", "tim_bl", "radia_p", "barbara_l", "dennis_r",
  "hedy_lamarr", "claude_s", "george_b", "mary_j", "john_mc",
  "edsger_d", "donald_k", "frances_a", "karen_s", "vint_c",
];

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const chance = (p) => Math.random() < p;
const iround = (v) => Math.round(v);
const round3 = (v) => Math.round(v * 1000) / 1000;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sqlTime = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex"));

// Approx-normal in [0,1] centred on 0.5 (average of 3 uniforms).
const gauss = () => (Math.random() + Math.random() + Math.random()) / 3;
const clamp01 = (v) => clamp(v, 0.01, 0.99);
// A point clustered toward the centre (hits land here); spread widens the cloud.
const centerXY = (spread) => clamp01(0.5 + (gauss() - 0.5) * 2 * spread);
// A point pushed toward the edges (misses land here — targets are hardest to
// reach near the rim), so the click heatmap tells hits and misses apart.
const edgeXY = () => clamp01(Math.random() < 0.5 ? gauss() * 0.34 : 1 - gauss() * 0.34);

/* ============================================================================
 * Player profiles — latent traits in [0,1]. Ranges are tight and non-overlapping
 * enough that the clustering separates them, but noisy enough to look real.
 * ==========================================================================*/
const PROFILES = {
  ace:       { label: "Ace",       speed: [0.85, 1.0],  accuracy: [0.88, 0.99], persistence: [0.30, 0.50], exploration: [0.20, 0.40] },
  speedster: { label: "Speedster", speed: [0.82, 1.0],  accuracy: [0.50, 0.68], persistence: [0.20, 0.40], exploration: [0.30, 0.55] },
  steady:    { label: "Steady",    speed: [0.50, 0.72], accuracy: [0.78, 0.92], persistence: [0.55, 0.75], exploration: [0.30, 0.50] },
  struggler: { label: "Struggler", speed: [0.25, 0.45], accuracy: [0.45, 0.66], persistence: [0.80, 1.00], exploration: [0.25, 0.50] },
  explorer:  { label: "Explorer",  speed: [0.50, 0.72], accuracy: [0.60, 0.80], persistence: [0.40, 0.60], exploration: [0.82, 1.00] },
};
const PROFILE_KEYS = Object.keys(PROFILES);
const sampleTraits = (key) => {
  const p = PROFILES[key];
  return {
    profile: key,
    speed: rnd(p.speed[0], p.speed[1]),
    accuracy: rnd(p.accuracy[0], p.accuracy[1]),
    persistence: rnd(p.persistence[0], p.persistence[1]),
    exploration: rnd(p.exploration[0], p.exploration[1]),
  };
};
// Coarse archetype label the branching games use, derived from the same traits
// so a player behaves consistently across every game they play.
function archOf(tr) {
  if (tr.exploration > 0.78) return "explorer";
  if (tr.persistence > 0.72) return "persistent";
  if (tr.accuracy > 0.78 && tr.speed > 0.58) return "quick";
  return "average";
}

const ins = {
  player: db.prepare("INSERT INTO players (username, token, created_at, last_seen_at) VALUES (?, ?, ?, ?)"),
  findPlayer: db.prepare("SELECT id FROM players WHERE username=? COLLATE NOCASE"),
  score: db.prepare(`INSERT INTO scores (player_id, game_id, level, score, stars, session_id, meta, created_at)
                     VALUES (@player_id,@game_id,@level,@score,@stars,@session_id,@meta,@created_at)`),
  event: db.prepare(`INSERT INTO events (player_id, game_id, session_id, seq, type, t_ms, iso, payload, created_at)
                     VALUES (@player_id,@game_id,@session_id,@seq,@type,@t_ms,@iso,@payload,@created_at)`),
};

function ensurePlayer(username, createdSql) {
  const existing = ins.findPlayer.get(username);
  if (existing) return existing.id;
  return ins.player.run(username, crypto.randomBytes(24).toString("hex"), createdSql, createdSql).lastInsertRowid;
}

// A session recorder. `dayOffset` places the session that many days in the past
// (older sessions = earlier attempts, so the learning curve reads left→right).
// `step` is the [min,max] ms gap between events — tight for a 20s reaction round,
// looser for the slower puzzle games — so session-duration spans come out right.
function makeSession(playerId, gameId, dayOffset, step) {
  const sessionId = uuid();
  const start = new Date();
  start.setDate(start.getDate() - dayOffset);
  start.setHours(iround(rnd(8, 20)), iround(rnd(0, 59)), iround(rnd(0, 59)), 0);
  let t = start.getTime(), seq = 0;
  const stepMin = step ? step[0] : 3000, stepMax = step ? step[1] : 95000;

  function emit(type, payload) {
    t += iround(rnd(stepMin, stepMax));
    const d = new Date(t);
    ins.event.run({
      player_id: playerId, game_id: gameId, session_id: sessionId, seq,
      type, t_ms: t, iso: d.toISOString(),
      payload: JSON.stringify(Object.assign({ seq, sessionId, type }, payload)),
      created_at: sqlTime(d),
    });
    seq++;
  }
  function submit(run) {
    ins.score.run({
      player_id: playerId, game_id: gameId, level: String(run.level), score: run.score,
      stars: run.stars == null ? null : run.stars, session_id: sessionId,
      meta: JSON.stringify(run.meta || {}), created_at: sqlTime(t),
    });
  }
  return { emit, submit };
}

/* ============================================================================
 * Game scripts — each is driven by the player's traits (+ a small practice
 * boost that grows with attempt number), so behaviour is consistent per player
 * and outcomes are genuinely predictable from the emitted behaviour.
 * ==========================================================================*/
const GAMES = {
  // The reference game: tap targets before a 20s clock runs out. Each session is
  // one round → one run. Emits a spatial position for every tap so the Insights
  // tab can draw a click heatmap, and miss/expire events for accuracy analytics.
  "quick-tap": {
    step: [350, 900],
    play(s, tr, boost) {
      const speed = clamp(tr.speed + boost, 0.05, 1);
      const accuracy = clamp(tr.accuracy + boost, 0.05, 0.99);
      s.emit("round_start", { round_ms: 20000 });
      const targets = iround(10 + speed * 22);       // opportunities within the round
      let hits = 0, miss = 0, expire = 0;
      for (let n = 1; n <= targets; n++) {
        const reaction = Math.max(150, iround(720 - speed * 430 + rnd(-60, 90) + n * 1.5));
        if (chance(accuracy)) {
          hits++;
          s.emit("hit", { x: round3(centerXY(0.26)), y: round3(centerXY(0.24)), reaction_ms: reaction, n: hits });
        } else if (chance(0.62)) {
          miss++;
          s.emit("miss", { x: round3(edgeXY()), y: round3(edgeXY()) });      // tapped, no target there
        } else {
          expire++;
          s.emit("expire", { x: round3(centerXY(0.42)), y: round3(centerXY(0.42)) }); // ran out of time
        }
      }
      s.emit("round_end", { score: hits });
      const acc = hits / Math.max(1, hits + miss + expire);
      s.submit({
        level: "quick-tap", score: hits, stars: hits >= 18 ? 3 : hits >= 11 ? 2 : 1,
        meta: { hits, miss, expire, accuracy: round3(acc), profile: tr.profile },
      });
    },
  },

  // A fractions adventure. Solve rate follows the player's accuracy; persistent
  // learners loop wrong→hint→retry; explorers poke around more before solving.
  "fraction-forest": {
    step: [4000, 90000],
    levels: ["grove-1", "grove-2", "grove-3", "meadow-boss"],
    play(s, tr, boost) {
      const arch = archOf(tr);
      const solveP = clamp(tr.accuracy + boost, 0.1, 0.97);
      const level = pick(this.levels);
      s.emit("enter_grove", { level });
      const puzzles = arch === "explorer" ? iround(rnd(4, 6)) : iround(rnd(2, 4));
      let solved = 0, wrong = 0, hints = 0;
      for (let p = 0; p < puzzles; p++) {
        s.emit("pick_fraction", { level, numerator: iround(rnd(1, 9)), denominator: iround(rnd(2, 12)) });
        if (chance(tr.exploration)) s.emit("compare_fractions", { level });
        if (chance(0.4 + tr.exploration * 0.4)) s.emit("simplify_fraction", { level });
        let attempts = 0, ok = false;
        const maxTries = arch === "persistent" ? 4 : arch === "quick" ? 1 : 2;
        while (!ok && attempts < maxTries) {
          attempts++;
          if (chance(solveP)) { s.emit("solve_puzzle", { level, attempts }); ok = true; solved++; }
          else { s.emit("wrong_answer", { level, attempts }); wrong++; if (chance(tr.persistence)) { s.emit("use_hint", { level }); hints++; } }
        }
      }
      const completed = solved >= Math.max(1, Math.ceil(puzzles * 0.6));
      if (completed) s.emit("unlock_gate", { level, solved });
      const score = Math.round((solved / Math.max(1, puzzles)) * 100);
      s.submit({ level, score, stars: completed ? (wrong <= 1 ? 3 : hints <= 2 ? 2 : 1) : 0, meta: { solved, wrong, hints, archetype: arch, profile: tr.profile } });
    },
  },

  // A circuit-building sandbox. Methodical, accurate players finish clean;
  // low-persistence players bail after a failed simulation.
  "circuit-smith": {
    step: [4000, 90000],
    levels: ["series", "parallel", "bridge", "amplifier"],
    play(s, tr, boost) {
      const arch = archOf(tr);
      const successP = clamp(tr.accuracy * 0.9 + boost, 0.1, 0.95);
      const level = pick(this.levels);
      s.emit("open_bench", { level });
      const parts = iround(rnd(2, 4) + tr.exploration * 3);
      for (let i = 0; i < parts; i++) s.emit("place_component", { level, part: pick(["resistor", "battery", "led", "switch", "capacitor"]), index: i });
      s.emit("wire_nodes", { level, wires: parts + iround(rnd(0, 3)) });
      let runs = 0, shorts = 0, completed = false;
      const maxRuns = tr.persistence < 0.4 ? 1 : tr.persistence > 0.72 ? 3 : 2;
      while (runs < maxRuns && !completed) {
        runs++;
        s.emit("run_simulation", { level, run: runs });
        if (chance(successP)) {
          if (chance(0.8)) s.emit("measure_voltage", { level, volts: Math.round(rnd(1.5, 9) * 10) / 10 });
          s.emit("complete_circuit", { level, runs });
          completed = true;
        } else {
          s.emit("debug_short", { level }); shorts++;
          if (tr.persistence < 0.4) break;
          s.emit("reset_board", { level });
        }
      }
      const score = completed ? iround(rnd(70, 100)) : iround(rnd(10, 55));
      s.submit({ level, score, stars: completed ? (shorts === 0 ? 3 : 2) : 0, meta: { runs, shorts, archetype: arch, profile: tr.profile } });
    },
  },
};

const seed = db.transaction(() => {
  const perGame = { "quick-tap": 0, "fraction-forest": 0, "circuit-smith": 0 };
  const perProfile = {}; PROFILE_KEYS.forEach((k) => (perProfile[k] = 0));
  let totalSessions = 0;

  NAMES.forEach((username, ni) => {
    const profileKey = PROFILE_KEYS[ni % PROFILE_KEYS.length];
    const tr = sampleTraits(profileKey);
    perProfile[profileKey]++;
    const createdSql = sqlTime(Date.now() - (20 - (ni % 14)) * 86400000);
    const playerId = ensurePlayer(username, createdSql);

    // Each learner's session plan: quick-tap is the showcase (several attempts,
    // so the heatmap is rich and the learning curve has depth), plus a couple of
    // sessions in the other games. Older sessions first → attempt order = time.
    const plan = [];
    const qt = iround(rnd(3, 5));
    for (let i = 0; i < qt; i++) plan.push("quick-tap");
    for (let i = 0; i < iround(rnd(1, 2)); i++) plan.push("fraction-forest");
    for (let i = 0; i < iround(rnd(1, 2)); i++) plan.push("circuit-smith");
    // spread across the fortnight, earliest first
    const attemptsByGame = {};
    plan.forEach((gameId, idx) => {
      const dayOffset = clamp(13 - Math.floor((idx / plan.length) * 13) + iround(rnd(-1, 1)), 0, 14);
      const attempt = (attemptsByGame[gameId] = (attemptsByGame[gameId] || 0) + 1) - 1;
      const boost = Math.min(0.16, attempt * 0.04);   // practice effect → learning curve
      const g = GAMES[gameId];
      g.play(makeSession(playerId, gameId, dayOffset, g.step), tr, boost);
      perGame[gameId]++;
      totalSessions++;
    });
  });

  const events = db.prepare("SELECT COUNT(*) n FROM events").get().n;
  const runs = db.prepare("SELECT COUNT(*) n FROM scores").get().n;
  return { players: NAMES.length, sessions: totalSessions, events, runs, perGame, perProfile };
});

const res = seed();
const breakdown = Object.entries(res.perGame).map(([g, n]) => `${g}:${n}`).join(", ");
const profiles = Object.entries(res.perProfile).map(([p, n]) => `${p}:${n}`).join(", ");
console.log(`Seeded ${res.players} players · ${res.sessions} sessions · ${res.events} events · ${res.runs} runs across ${Object.keys(res.perGame).length} games (${breakdown}).`);
console.log(`Player profiles (for clustering/prediction): ${profiles}.`);
process.exit(0);
