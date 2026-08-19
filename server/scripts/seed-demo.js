#!/usr/bin/env node
/* =============================================================================
 * Suite server — demo data seeder
 * -----------------------------------------------------------------------------
 * Generates believable players, runs and analytics events for the reference
 * game "quick-tap" across the last ~14 days, so a fresh dashboard has something
 * rich to show (engagement, process mining, transition-network analysis, and
 * clustering all work off this data). Inserts straight into the DB — no running
 * server needed. Add-only; run once on a fresh DB.  Usage:  npm run seed:demo
 *
 * The events mirror exactly what the real game emits (see games/quick-tap):
 *   round_start → hit × N → round_end   (one such sequence per round played),
 * so seeded and live play are indistinguishable in the dashboard.
 * ========================================================================== */
"use strict";

const crypto = require("crypto");
const db = require("./../src/db");

const GAME = "quick-tap";
const ROUND_MS = 20000;
const NAMES = ["ada_lovelace", "grace_hopper", "alan_turing", "katherine_j", "linus_t", "margaret_h", "tim_bl", "radia_p", "barbara_l", "dennis_r"];

const rnd = (a, b) => a + Math.random() * (b - a);
const iround = (v) => Math.round(v);

const ins = {
  player: db.prepare("INSERT INTO players (username, token, created_at, last_seen_at) VALUES (?, ?, ?, ?)"),
  findPlayer: db.prepare("SELECT id FROM players WHERE username=? COLLATE NOCASE"),
  score: db.prepare(`INSERT INTO scores (player_id, game_id, level, score, stars, session_id, meta, created_at)
                     VALUES (@player_id,@game_id,@level,@score,@stars,@session_id,@meta,@created_at)`),
  event: db.prepare(`INSERT INTO events (player_id, game_id, session_id, seq, type, t_ms, iso, payload, created_at)
                     VALUES (@player_id,@game_id,@session_id,@seq,@type,@t_ms,@iso,@payload,@created_at)`),
};

// A timestamp `dayOffset` days ago, `minute` minutes into a ~9am play session.
function tsFor(dayOffset, minute) {
  const d = new Date();
  d.setDate(d.getDate() - dayOffset);
  d.setHours(9 + Math.floor(minute / 60), Math.floor(minute % 60), Math.floor(rnd(0, 59)), 0);
  return { sql: d.toISOString().replace("T", " ").slice(0, 19), iso: d.toISOString(), ms: d.getTime() };
}

function ensurePlayer(username, created) {
  const existing = ins.findPlayer.get(username);
  if (existing) return existing.id;
  const info = ins.player.run(username, crypto.randomBytes(24).toString("hex"), created, created);
  return info.lastInsertRowid;
}

const newSession = () => (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex"));

const seed = db.transaction(() => {
  let totalEvents = 0, totalRuns = 0;

  NAMES.forEach((username, ni) => {
    const created = tsFor(20 - ni, 0).sql;
    const playerId = ensurePlayer(username, created);
    // This player's baseline skill: faster tappers hit more per round.
    const skill = rnd(0.35, 0.95);

    const sessions = iround(rnd(2, 5));
    for (let s = 0; s < sessions; s++) {
      const day = iround(rnd(0, 13));
      const sessionId = newSession();
      let seq = 0, minute = rnd(0, 30);

      const emit = (type, payload) => {
        const t = tsFor(day, minute);
        minute += rnd(0.15, 0.5);
        ins.event.run({
          player_id: playerId, game_id: GAME, session_id: sessionId, seq,
          type, t_ms: iround(seq * 1000 + rnd(0, 900)), iso: t.iso,
          payload: JSON.stringify(Object.assign({ seq, sessionId, student: username, type }, payload)),
          created_at: t.sql,
        });
        seq++;
        totalEvents++;
      };

      // 1–3 rounds per sitting; each is a full round_start → hits → round_end run.
      const rounds = iround(rnd(1, 3));
      for (let r = 0; r < rounds; r++) {
        emit("round_start", { round_ms: ROUND_MS });

        // Hits: skill (+ a little warm-up improvement across the session) sets the count.
        const hits = Math.max(2, iround(rnd(6, 22) * (skill + s * 0.03)));
        for (let n = 1; n <= hits; n++) {
          const reaction = iround(rnd(230, 680) * (1.15 - skill)); // faster players react quicker
          emit("hit", { reaction_ms: Math.max(120, reaction), n });
        }

        emit("round_end", { score: hits });

        // Record the completed run (leaderboard). `level` groups runs; meta is free-form.
        const t = tsFor(day, minute);
        ins.score.run({
          player_id: playerId, game_id: GAME, level: "quick-tap", score: hits,
          stars: hits >= 16 ? 3 : hits >= 10 ? 2 : 1, session_id: sessionId,
          meta: JSON.stringify({ hits, round_ms: ROUND_MS }), created_at: t.sql,
        });
        totalRuns++;
        minute += rnd(0.5, 2); // a short breather before the next round
      }
    }
  });

  return { players: NAMES.length, events: totalEvents, runs: totalRuns };
});

const res = seed();
console.log(`✓ seeded ${res.players} players · ${res.events} events · ${res.runs} runs for ${GAME}`);
process.exit(0);
