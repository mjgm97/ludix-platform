/* =============================================================================
 * Game-specific analytics — Quick Tap
 * -----------------------------------------------------------------------------
 * Unlike the general analytics (which read only the generic event envelope),
 * this module reads Quick Tap's OWN payload fields — tap positions (x, y),
 * reaction times, and the hit / miss / expire outcome of every target — to build
 * a view no other game gets: a click HEATMAP, an accuracy / error breakdown, a
 * reaction-time distribution and warm-up curve, and a per-player speed-vs-
 * accuracy scatter (which mirrors the behaviour clusters the demo data is built
 * around). Everything honours the dashboard's date / player filters.
 *
 * Events it understands (see games/quick-tap/js/game.js + the demo seeder):
 *   round_start {round_ms}
 *   hit    {x, y, reaction_ms, n}   — a target tapped
 *   miss   {x, y}                   — a tap that landed on no target
 *   expire {x, y}                   — a target that timed out unhit
 *   round_end {score}
 * ========================================================================== */
"use strict";

const db = require("./../db");
const U = require("./../analytics-util");
const config = require("./../config");

const GX = 16, GY = 10;                 // heatmap resolution (cols × rows)
// Reaction-time histogram edges (ms) and labels.
const RT_EDGES = [250, 350, 450, 550, 650, 750];
const RT_LABELS = ["<250", "250–350", "350–450", "450–550", "550–650", "650–750", "750+"];

function compute(gameId, query) {
  const P = Object.assign({ g: gameId }, U.filterParams(query));
  const eW = U.whereFor("e", query);   // may reference p.username (user filter)
  const cap = Math.max(1000, config.processMaxEvents);

  // Players are always joined here (we group by username), so whereFor's optional
  // user filter resolves without a separate joinFor.
  const rows = db.prepare(
    `SELECT e.type AS type, e.payload AS payload, p.username AS username
       FROM events e JOIN players p ON p.id=e.player_id
      WHERE e.game_id=@g${eW}
      ORDER BY e.session_id, e.seq, e.id
      LIMIT @cap`
  ).all(Object.assign({ cap: cap + 1 }, P));
  const truncated = rows.length > cap;
  if (truncated) rows.length = cap;

  // Heatmaps as flat GX*GY count grids; separate hits and misses so the UI can
  // toggle. Reaction-time accumulators, warm-up curve, and per-player tallies.
  const hitGrid = new Array(GX * GY).fill(0);
  const missGrid = new Array(GX * GY).fill(0);
  const rtHist = new Array(RT_EDGES.length + 1).fill(0);
  const warmSum = {}, warmN = {};            // avg reaction by target ordinal n
  const perPlayer = {};                       // username → {hit, miss, expire, rtSum, rtN}
  let hits = 0, misses = 0, expires = 0, rtSum = 0, rtN = 0;
  let rtMin = Infinity, rtMax = -Infinity;

  const cell = (x, y) => {
    const cx = Math.min(GX - 1, Math.max(0, Math.floor((Number(x) || 0) * GX)));
    const cy = Math.min(GY - 1, Math.max(0, Math.floor((Number(y) || 0) * GY)));
    return cy * GX + cx;
  };
  const bumpPlayer = (u) => (perPlayer[u] || (perPlayer[u] = { hit: 0, miss: 0, expire: 0, rtSum: 0, rtN: 0 }));

  for (const r of rows) {
    if (r.type !== "hit" && r.type !== "miss" && r.type !== "expire") continue;
    let pl = null;
    try { pl = r.payload ? JSON.parse(r.payload) : null; } catch (e) { pl = null; }
    if (!pl) continue;
    const pp = bumpPlayer(r.username || "?");
    if (r.type === "hit") {
      hits++; pp.hit++;
      if (pl.x != null && pl.y != null) hitGrid[cell(pl.x, pl.y)]++;
      const rt = Number(pl.reaction_ms);
      if (isFinite(rt) && rt > 0) {
        rtSum += rt; rtN++; pp.rtSum += rt; pp.rtN++;
        if (rt < rtMin) rtMin = rt; if (rt > rtMax) rtMax = rt;
        let bi = RT_EDGES.findIndex((e) => rt < e); if (bi === -1) bi = RT_EDGES.length;
        rtHist[bi]++;
        const n = Math.max(1, Math.min(40, Math.round(Number(pl.n) || 1)));
        warmSum[n] = (warmSum[n] || 0) + rt; warmN[n] = (warmN[n] || 0) + 1;
      }
    } else if (r.type === "miss") {
      misses++; pp.miss++;
      if (pl.x != null && pl.y != null) missGrid[cell(pl.x, pl.y)]++;
    } else {
      expires++; pp.expire++;
    }
  }

  const taps = hits + misses + expires;
  const heatMax = Math.max(1, Math.max.apply(null, hitGrid.concat(missGrid)));

  // Warm-up curve: mean reaction by target ordinal, only ordinals with support.
  const warmup = [];
  for (let n = 1; n <= 40; n++) if (warmN[n] >= 3) warmup.push({ n, reaction: U.round(warmSum[n] / warmN[n], 1), count: warmN[n] });

  // Per-player speed vs accuracy (mirrors the demo's behaviour profiles).
  const players = Object.keys(perPlayer).map((u) => {
    const q = perPlayer[u], total = q.hit + q.miss + q.expire;
    return {
      username: u, taps: total, hits: q.hit,
      accuracy: total ? U.round(q.hit / total, 4) : null,
      avgReaction: q.rtN ? U.round(q.rtSum / q.rtN, 1) : null,
    };
  }).filter((p) => p.taps >= 5).sort((a, b) => b.taps - a.taps);

  return {
    truncated,
    totals: {
      hits, misses, expires, taps,
      accuracy: taps ? U.round(hits / taps, 4) : null,
      missRate: taps ? U.round((misses + expires) / taps, 4) : null,
      avgReaction: rtN ? U.round(rtSum / rtN, 1) : null,
      fastestReaction: rtMin === Infinity ? null : rtMin,
      slowestReaction: rtMax === -Infinity ? null : rtMax,
    },
    heatmap: { gx: GX, gy: GY, hits: hitGrid, misses: missGrid, max: heatMax },
    reactionHistogram: RT_LABELS.map((label, i) => ({ bucket: label, value: rtHist[i] })),
    warmup,
    players,
  };
}

module.exports = { id: "quick-tap", label: "Quick Tap insights", compute };
