#!/usr/bin/env node
/* =============================================================================
 * Suite server — demo data seeder
 * -----------------------------------------------------------------------------
 * Generates believable players, runs and analytics events across THREE games and
 * the last ~14 days, so a fresh dashboard has something rich to show (engagement,
 * process mining, transition-network analysis, and clustering all work off this).
 * Inserts straight into the DB — no running server needed. Add-only; run once on
 * a fresh DB.  Usage:  npm run seed:demo
 *
 * The games are game-agnostic to the backend (nothing here is special-cased): a
 * game is just a `gameId` plus the activity vocabulary its sessions emit. Two of
 * them are invented to show the dashboard across different shapes of play; the
 * third is the real reference game, Quick Tap.
 *   - quick-tap        reaction game    (round_start · hit · round_end)
 *   - fraction-forest  math adventure   (8 activities, branching paths)
 *   - circuit-smith    physics sandbox  (8 activities, branching paths)
 * Each game mixes a few player "archetypes" so sessions differ enough for
 * clustering to find groups.
 * ========================================================================== */
"use strict";

const crypto = require("crypto");
const db = require("./../src/db");

const NAMES = ["ada_lovelace", "grace_hopper", "alan_turing", "katherine_j", "linus_t", "margaret_h", "tim_bl", "radia_p", "barbara_l", "dennis_r"];

const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
const chance = (p) => Math.random() < p;
const iround = (v) => Math.round(v);
const sqlTime = (ms) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex"));

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

// A session recorder: emit(type, payload) streams an ordered event; submit(run)
// records a completed run. Time advances a few seconds to minutes per event, so
// session-duration spans (MAX−MIN t_ms) come out realistic.
function makeSession(playerId, gameId) {
  const sessionId = uuid();
  const day = iround(rnd(0, 13));
  const start = new Date();
  start.setDate(start.getDate() - day);
  start.setHours(iround(rnd(8, 20)), iround(rnd(0, 59)), iround(rnd(0, 59)), 0);
  let t = start.getTime(), seq = 0;

  function emit(type, payload) {
    t += iround(rnd(3, 95)) * 1000;
    const d = new Date(t);
    ins.event.run({
      player_id: playerId, game_id: gameId, session_id: sessionId, seq,
      type, t_ms: t, iso: d.toISOString(),
      payload: JSON.stringify(Object.assign({ seq, sessionId, student: null, type }, payload)),
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
 * Game scripts — each emits its own activities and records a run.
 * ==========================================================================*/
const GAMES = {
  // The real reference game: tap targets before a 20s clock runs out.
  "quick-tap": {
    weight: 3,
    play(s) {
      const rounds = iround(rnd(1, 3));
      for (let r = 0; r < rounds; r++) {
        s.emit("round_start", { round_ms: 20000 });
        const hits = iround(rnd(4, 22));
        for (let n = 1; n <= hits; n++) s.emit("hit", { reaction_ms: iround(rnd(220, 700)), n });
        s.emit("round_end", { score: hits });
        s.submit({ level: "quick-tap", score: hits, stars: hits >= 16 ? 3 : hits >= 10 ? 2 : 1, meta: { hits, round_ms: 20000 } });
      }
    },
  },

  // Invented — a fractions adventure. Learners wander a grove, compare/simplify
  // fractions, hit puzzle gates, sometimes err and take hints. Diverse paths:
  // "quick" learners breeze through; "persistent" ones loop wrong→hint→retry;
  // "explorers" poke around a lot and sometimes abandon.
  "fraction-forest": {
    weight: 2,
    levels: ["grove-1", "grove-2", "grove-3", "meadow-boss"],
    play(s) {
      const arch = pick(["quick", "quick", "persistent", "explorer"]);
      const level = pick(this.levels);
      s.emit("enter_grove", { level });
      const puzzles = arch === "explorer" ? iround(rnd(3, 6)) : iround(rnd(2, 4));
      let solved = 0, wrong = 0, hints = 0;
      for (let p = 0; p < puzzles; p++) {
        s.emit("pick_fraction", { level, numerator: iround(rnd(1, 9)), denominator: iround(rnd(2, 12)) });
        if (chance(arch === "explorer" ? 0.85 : 0.5)) s.emit("compare_fractions", { level });
        if (chance(0.55)) s.emit("simplify_fraction", { level });
        let attempts = 0, ok = false;
        const maxTries = arch === "persistent" ? 4 : arch === "quick" ? 1 : 2;
        while (!ok && attempts < maxTries) {
          attempts++;
          if (chance(arch === "quick" ? 0.85 : 0.5)) { s.emit("solve_puzzle", { level, attempts }); ok = true; solved++; }
          else { s.emit("wrong_answer", { level, attempts }); wrong++; if (chance(0.7)) { s.emit("use_hint", { level }); hints++; } }
        }
      }
      const completed = solved >= Math.max(1, Math.ceil(puzzles * 0.6));
      if (completed) s.emit("unlock_gate", { level, solved });
      const score = Math.round((solved / Math.max(1, puzzles)) * 100);
      s.submit({ level, score, stars: completed ? (wrong <= 1 ? 3 : hints <= 2 ? 2 : 1) : 0, meta: { solved, wrong, hints, archetype: arch } });
    },
  },

  // Invented — a circuit-building sandbox. Learners drop components, wire nodes,
  // simulate, and measure. "methodical" builders finish clean; "debuggers" hit a
  // short, reset, and retry; "quitters" bail after a failed sim.
  "circuit-smith": {
    weight: 2,
    levels: ["series", "parallel", "bridge", "amplifier"],
    play(s) {
      const arch = pick(["methodical", "methodical", "debugger", "quitter"]);
      const level = pick(this.levels);
      s.emit("open_bench", { level });
      const parts = iround(rnd(2, 6));
      for (let i = 0; i < parts; i++) s.emit("place_component", { level, part: pick(["resistor", "battery", "led", "switch", "capacitor"]), index: i });
      s.emit("wire_nodes", { level, wires: parts + iround(rnd(0, 3)) });
      let runs = 0, shorts = 0, completed = false;
      const maxRuns = arch === "quitter" ? 1 : arch === "debugger" ? 3 : 2;
      while (runs < maxRuns && !completed) {
        runs++;
        s.emit("run_simulation", { level, run: runs });
        if (chance(arch === "methodical" ? 0.75 : 0.4)) {
          if (chance(0.8)) s.emit("measure_voltage", { level, volts: Math.round(rnd(1.5, 9) * 10) / 10 });
          s.emit("complete_circuit", { level, runs });
          completed = true;
        } else {
          s.emit("debug_short", { level }); shorts++;
          if (arch === "quitter") break;
          s.emit("reset_board", { level });
        }
      }
      const score = completed ? iround(rnd(70, 100)) : iround(rnd(10, 55));
      s.submit({ level, score, stars: completed ? (shorts === 0 ? 3 : 2) : 0, meta: { runs, shorts, archetype: arch } });
    },
  },
};

// Weighted game picker (so quick-tap stays the most-played).
const GAME_BAG = Object.entries(GAMES).flatMap(([id, g]) => Array(g.weight).fill(id));

const seed = db.transaction(() => {
  const perGame = {};
  let totalSessions = 0;
  Object.keys(GAMES).forEach((g) => (perGame[g] = 0));

  NAMES.forEach((username, ni) => {
    const createdSql = sqlTime(Date.now() - (20 - ni) * 86400000);
    const playerId = ensurePlayer(username, createdSql);
    const sessions = iround(rnd(2, 5));
    for (let i = 0; i < sessions; i++) {
      const gameId = pick(GAME_BAG);
      GAMES[gameId].play(makeSession(playerId, gameId));
      perGame[gameId]++;
      totalSessions++;
    }
  });

  const events = db.prepare("SELECT COUNT(*) n FROM events").get().n;
  const runs = db.prepare("SELECT COUNT(*) n FROM scores").get().n;
  return { players: NAMES.length, sessions: totalSessions, events, runs, perGame };
});

const res = seed();
const breakdown = Object.entries(res.perGame).map(([g, n]) => `${g}:${n}`).join(", ");
console.log(`Seeded ${res.players} players · ${res.sessions} sessions · ${res.events} events · ${res.runs} runs across ${Object.keys(res.perGame).length} games (${breakdown}).`);
process.exit(0);
