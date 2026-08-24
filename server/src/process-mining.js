/* =============================================================================
 * Suite server — Process mining (game-agnostic), powered by ladyna
 * -----------------------------------------------------------------------------
 * Mines the session sequences (from sequences.js, shared with /tna) into the
 * process-map building blocks: activity statistics, a directly-follows graph,
 * trace variants, and start/end activities. The heavy lifting is delegated to
 * **ladyna**'s validated `processmining` module rather than re-implemented:
 *   - `eventLog()` / `activityStats()`      → per-activity frequencies,
 *   - `buildDFGFromSequences()`             → directly-follows graph,
 *   - `traceVariants()`                     → the distinct paths + coverage,
 *   - `startActivities()` / `endActivities()`,
 *   - `traceLengthSummary()`, `rle()`       → length descriptives.
 *
 * The response contract matches what the Process tab renderer expects. NOTE:
 * trace variants are now standard *raw-trace* variants (ladyna) — repeated loops
 * are no longer folded to a single pass, so a loopy game shows more, longer
 * variants than the previous custom collapser did.
 * ========================================================================== */
"use strict";

const U = require("./analytics-util");
const seq = require("./sequences");
const L = require("ladyna");

const DFG_STEPS = [2, 3, 4], DFG_TOP = 14, VARIANTS_TOP = 12, BOUNDARY_TOP = 8;

// n-step directly-follows chains (self-loops included): how often a run of N
// consecutive activities occurs. A lightweight display extra ladyna's DFG (2-step)
// doesn't cover for N > 2; computed over the sequences we already have.
function ngrams(sessions, N) {
  const m = {};
  sessions.forEach((s) => { for (let i = 0; i + N <= s.length; i++) { const k = s.slice(i, i + N).join(U.SEP); m[k] = (m[k] || 0) + 1; } });
  return Object.keys(m).map((k) => ({ seq: k.split(U.SEP), count: m[k] })).sort((a, b) => b.count - a.count).slice(0, DFG_TOP);
}

function compute(gameId, query) {
  const { sessions, events: eventCount, truncated } = seq.fetchSequences(gameId, query);

  if (!sessions.length) {
    return {
      gameId,
      stats: { sessions: 0, events: eventCount, variants: 0, avgSteps: null, avgEvents: null, selfLoopRate: null, distinctActivities: 0, truncated },
      activities: [], variants: [], transitions: [], transitionsByN: { 2: [], 3: [], 4: [] },
      startActivities: [], endActivities: [],
    };
  }

  const el = L.eventLog(sessions);

  // Activity frequencies (across all events).
  const activities = L.activityStats(el)
    .map((a) => ({ type: a.activity, count: a.frequency }))
    .sort((a, b) => b.count - a.count);

  // Directly-follows graph (self-loops included).
  const dfg = L.buildDFGFromSequences(sessions);
  const dfgEdges = dfg.edges.map((e) => ({ from: e.from, to: e.to, count: e.absoluteCount })).sort((a, b) => b.count - a.count);
  let transTotal = 0, selfLoops = 0;
  dfg.edges.forEach((e) => { transTotal += e.absoluteCount; if (e.from === e.to) selfLoops += e.absoluteCount; });

  // Directly-follows chains: 2-step straight off the ladyna DFG, 3/4-step as
  // consecutive n-grams. The frontend switches step length locally.
  const transitionsByN = { 2: dfgEdges.slice(0, DFG_TOP).map((e) => ({ seq: [e.from, e.to], count: e.count })) };
  DFG_STEPS.filter((n) => n > 2).forEach((n) => { transitionsByN[n] = ngrams(sessions, n); });

  // Trace variants (ladyna, raw traces) + coverage.
  const variants = L.traceVariants(el)
    .map((v) => ({ sequence: v.trace, count: v.count, coverage: v.percentage }))
    .sort((a, b) => b.count - a.count);

  // Start / end activities.
  const toBoundary = (list) => list.map((a) => ({ type: a.activity, count: a.count })).sort((a, b) => b.count - a.count);

  // Length descriptives: avg events = mean raw trace length; avg steps = mean
  // length after folding immediate repeats (ladyna rle), a "distinct steps" view.
  const lenSummary = L.traceLengthSummary(el);
  const rleLens = sessions.map((s) => L.rle(s).values.length);
  const avgSteps = rleLens.length ? rleLens.reduce((a, b) => a + b, 0) / rleLens.length : null;

  return {
    gameId,
    stats: {
      sessions: sessions.length,
      events: eventCount,
      variants: variants.length,
      avgSteps: U.round(avgSteps, 1),
      avgEvents: U.round(lenSummary.mean, 1),
      selfLoopRate: transTotal ? U.round(selfLoops / transTotal, 3) : null,
      distinctActivities: activities.length,
      truncated,
    },
    activities,
    variants: variants.slice(0, VARIANTS_TOP),
    transitions: dfgEdges.slice(0, DFG_TOP),
    transitionsByN,
    startActivities: toBoundary(L.startActivities(el)).slice(0, BOUNDARY_TOP),
    endActivities: toBoundary(L.endActivities(el)).slice(0, BOUNDARY_TOP),
  };
}

module.exports = { compute };
