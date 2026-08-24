/* =============================================================================
 * Suite server — Transition Network Analysis (game-agnostic), powered by ladyna
 * -----------------------------------------------------------------------------
 * Models each game's session sequences as a first-order Markov *transition
 * network*: activities are nodes, and a directed edge A→B carries the transition
 * probability P(B | A) = count(A→B) / count(A→·). On top of that it derives:
 *   - initial-state probabilities (where sessions begin),
 *   - node centralities (out/in-strength, betweenness, closeness, PageRank, …),
 *   - optional bootstrap validation of each edge,
 *   - behaviour-based clustering of sessions into sub-networks.
 *
 * The heavy library math is delegated to **ladyna** (github:mohsaqr/tna-js), a
 * machine-precision-validated port of the R `tna` package, so the suite does not
 * re-implement TNA from scratch:
 *   - `tna()` / `ftna()`     → probability / frequency transition models,
 *   - `centralities()`       → the full R-TNA centrality set,
 *   - `bootstrapTna()`       → per-edge CIs, p-values and significance,
 *   - `clusterData()`        → validated sequence-dissimilarity clustering,
 *   - `stateCounts()`        → per-activity occurrence frequencies.
 *
 * The public response contract (nodes / edges / initial / centrality / stats /
 * sequences / validation) is unchanged, so the interactive client renderer keeps
 * working — only the underlying math moved to ladyna.
 * ========================================================================== */
"use strict";

const U = require("./analytics-util");
const seq = require("./sequences");
const L = require("ladyna");

// ---- ladyna model helpers ---------------------------------------------------
// Read a ladyna centrality measure (values are keyed by string index) for state i.
function measureAt(measures, name, i) {
  const col = measures[name];
  return col ? +col[i] || 0 : 0;
}

// Build the probability + (mode-appropriate) weighted transition models once.
// `prob` always carries P(B|A) so edges expose a probability regardless of mode;
// `wModel` is what centralities/bootstrap act on (frequency ⇒ raw counts).
function buildModels(sessions, weightMode) {
  const prob = L.tna(sessions);
  const wModel = weightMode === "frequency" ? L.ftna(sessions) : prob;
  return { prob, wModel, labels: prob.labels, counts: prob.counts, probW: prob.weights };
}

// Edge list with probability + chosen weight, straight off the count/weight
// matrices. Only observed transitions (count > 0) become edges.
function edgesFrom(M, weightMode) {
  const { labels, counts, probW } = M;
  const edges = [];
  for (let i = 0; i < labels.length; i++) {
    for (let j = 0; j < labels.length; j++) {
      const count = counts.get(i, j);
      if (count > 0) {
        const probability = probW.get(i, j);
        edges.push({ from: labels[i], to: labels[j], count, probability, weight: weightMode === "frequency" ? count : probability });
      }
    }
  }
  return edges;
}

// Map ladyna's centrality table onto the fields the client table reads, and
// carry the extra validated measures along for future use (they're free).
function centrality(wModel, labels) {
  const c = L.centralities(wModel);
  const m = c.measures;
  return labels.map((st, i) => ({
    state: st,
    outStrength: U.round(measureAt(m, "OutStrength", i), 4),
    inStrength: U.round(measureAt(m, "InStrength", i), 4),
    betweenness: U.round(measureAt(m, "Betweenness", i), 3),
    closeness: U.round(measureAt(m, "Closeness", i), 4),
    pageRank: U.round(measureAt(m, "PageRank", i), 4),
    // Extra ladyna measures (not yet surfaced in the default table).
    closenessIn: U.round(measureAt(m, "ClosenessIn", i), 4),
    closenessOut: U.round(measureAt(m, "ClosenessOut", i), 4),
    betweennessRSP: U.round(measureAt(m, "BetweennessRSP", i), 3),
    diffusion: U.round(measureAt(m, "Diffusion", i), 4),
    clustering: U.round(measureAt(m, "Clustering", i), 4),
  }));
}

// ---- Bootstrap edge validation (ladyna) -------------------------------------
// Resample sessions and report, per observed edge, the stability of its weight:
// bootstrap mean, percentile CI bounds, a p-value (share of resamples where the
// edge vanished) and a significance flag. All computed by ladyna.bootstrapTna.
function bootstrap(wModel, opts) {
  const iter = Math.min(2000, Math.max(50, opts.iter || 300));
  const level = opts.level > 0 && opts.level < 1 ? opts.level : 0.05;
  const seed = Number.isFinite(opts.seed) ? opts.seed : 42;

  const r = L.bootstrapTna(wModel, { iter, level, seed });
  const edges = (r.edges || []).map((e) => ({
    from: e.from, to: e.to,
    weight: U.round(e.weight, 4),
    bootstrapMean: U.round(e.bootstrapMean, 4),
    ciLower: U.round(e.ciLower, 4),
    ciUpper: U.round(e.ciUpper, 4),
    pValue: U.round(e.pValue, 4),
    significant: !!e.significant,
  }));
  const significant = edges.filter((e) => e.significant).length;
  return { iter, level, significant, total: edges.length, edges };
}

// ---- Community detection (ladyna) -------------------------------------------
// Partitions the states into modules — groups of activities more tightly linked
// to each other than to the rest. Cheap, so computed on every load; the state→
// community map is attached to nodes and summarised as groups.
function communitiesOf(model, labels) {
  try {
    const c = L.communities(model);
    const key = Object.keys(c.assignments || {})[0];
    const assign = key ? c.assignments[key] : [];
    const byState = {};
    labels.forEach((st, i) => { byState[st] = assign[i] != null ? assign[i] : 0; });
    const groups = {};
    labels.forEach((st) => { const g = byState[st]; (groups[g] = groups[g] || []).push(st); });
    const summary = Object.keys(groups).map((g) => ({ id: +g, states: groups[g] })).sort((a, b) => a.id - b.id);
    return { byState, summary, method: key || null, count: summary.length };
  } catch (_) {
    return { byState: {}, summary: [], method: null, count: 0 };
  }
}

// ---- Markov order test (ladyna) ---------------------------------------------
// Tests whether the first-order Markov assumption underpinning TNA is justified:
// a within-window permutation likelihood-ratio test across orders, reporting the
// AIC/BIC/permutation-optimal order and the per-order test table.
function markovDiag(sessions, maxOrder) {
  try {
    const mo = L.markovOrderTest(sessions, { maxOrder: maxOrder || 2 });
    return {
      optimalOrder: mo.optimalOrder, aicOrder: mo.aicOrder, bicOrder: mo.bicOrder, maxOrder: mo.maxOrder,
      testTable: (mo.testTable || []).map((r) => ({
        order: r.order, aic: U.round(r.AIC, 1), bic: U.round(r.BIC, 1),
        g2: U.round(r.g2, 2), df: r.df,
        pPermutation: r.pPermutation != null ? U.round(r.pPermutation, 4) : null,
        significant: !!r.significant,
      })),
    };
  } catch (_) {
    return null;
  }
}

// ---- Network stability / case-drop reliability (ladyna) ---------------------
// Correlation-stability (CS) coefficient per centrality measure: the largest
// share of sessions that can be dropped while the measure still correlates
// ≥ threshold with the full-sample ordering (95% of resamples). CS ≥ 0.5 is
// stable, ≥ 0.25 acceptable, below that the measure is fragile.
const STABILITY_MEASURES = ["OutStrength", "InStrength", "Betweenness", "Closeness", "PageRank"];
function stabilityDiag(model, opts) {
  try {
    const cs = L.estimateCS(model, { iter: Math.min(1000, Math.max(100, opts.iter || 300)), measures: STABILITY_MEASURES });
    // Per-measure case-drop curve (mean correlation ± sd at each drop proportion)
    // for the line chart; csCoefficients for the summary table.
    const curve = (cs.summary || []).map((r) => ({
      measure: r.measure, dropProp: U.round(r.dropProp, 3),
      meanCor: U.round(r.meanCor, 4), sdCor: U.round(r.sdCor, 4),
    }));
    return { threshold: cs.threshold, method: cs.method, csCoefficients: cs.csCoefficients, dropProps: cs.dropProps, measures: STABILITY_MEASURES, curve };
  } catch (_) {
    return null;
  }
}

// ---- Descriptives from a set of sessions ------------------------------------
// Node frequencies (total occurrences) come from ladyna.stateCounts; initial
// counts are a trivial first-element tally.
function describe(sessions, labels) {
  const freq = L.stateCounts(sessions);
  const initCount = {}; let initTotal = 0;
  for (const s of sessions) if (s.length) { initCount[s[0]] = (initCount[s[0]] || 0) + 1; initTotal++; }

  const nodes = labels
    .map((st) => ({ id: st, frequency: freq[st] || 0, initial: initTotal ? (initCount[st] || 0) / initTotal : 0 }))
    .sort((a, b) => b.frequency - a.frequency);

  const initial = labels
    .map((st) => ({ state: st, count: initCount[st] || 0, probability: initTotal ? (initCount[st] || 0) / initTotal : 0 }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.probability - a.probability);

  return { nodes, initial };
}

// ---- Clustering (ladyna sequence dissimilarities) ---------------------------
// Groups sessions by *behaviour* and gives each cluster its own transition
// network + sequence sample, so you can compare how sub-groups of students move
// through the game. ladyna's clusterData does the validated work: a sequence
// dissimilarity (Hamming / Levenshtein / OSA / LCS / q-gram / Jaro–Winkler) is
// clustered by PAM (k-medoids) or an agglomerative linkage, with a silhouette.
const CLUSTER_MAX_SEQS = 1500;   // cap for the O(n²) dissimilarity matrix
const SEQ_ROWS = 24, SEQ_LEN = 60;

const DISSIMILARITIES = ["hamming", "lv", "osa", "dl", "lcs", "qgram", "jw"];
const LINKAGES = ["average", "complete", "ward.D2", "single"];

function sampleSessions(usable, cap, seedN) {
  if (usable.length <= cap) return { sessions: usable, sampledFrom: null };
  const rand = U.rng(seedN), picked = new Set();
  while (picked.size < cap) picked.add((rand() * usable.length) | 0);
  return { sessions: Array.from(picked).map((i) => usable[i]), sampledFrom: usable.length };
}

function computeClusters(gameId, query) {
  const weightMode = query.weight === "frequency" ? "frequency" : "probability";
  const { sessions: allSessions } = seq.fetchSequences(gameId, query);
  const usable = allSessions.filter((s) => s.length >= 2);   // need transitions

  let k = parseInt(query.k, 10); if (!Number.isFinite(k)) k = 3;
  k = Math.max(2, Math.min(8, k));

  const algorithm = query.algorithm === "hierarchical" ? "hierarchical" : "pam";
  const dissimilarity = DISSIMILARITIES.indexOf(query.dissimilarity) >= 0 ? query.dissimilarity : "lv";
  const linkage = LINKAGES.indexOf(query.linkage) >= 0 ? query.linkage : "average";
  const method = { algorithm, dissimilarity, linkage: algorithm === "hierarchical" ? linkage : null };

  if (usable.length < k || usable.length < 4) {
    return { gameId, weightMode, method, error: "not_enough_sequences", usableSessions: usable.length, totalSessions: allSessions.length, kRequested: k };
  }

  // clusterData builds an O(n²) dissimilarity matrix — sample hard on big games.
  const sampled = sampleSessions(usable, CLUSTER_MAX_SEQS, 20240816);
  const sessions = sampled.sessions, sampledFrom = sampled.sampledFrom, n = sessions.length;

  // ladyna method string is the linkage itself for hierarchical, or "pam".
  const clMethod = algorithm === "hierarchical" ? linkage : "pam";
  const res = L.clusterData(sessions, k, { dissimilarity, method: clMethod });
  const assign = res.assignments;   // 1-based cluster labels

  const clusters = [];
  for (let c = 1; c <= k; c++) {
    const idx = []; for (let i = 0; i < n; i++) if (assign[i] === c) idx.push(i);
    if (!idx.length) continue;
    const cs = idx.map((i) => sessions[i]);

    const M = buildModels(cs, weightMode);
    const edges = edgesFrom(M, weightMode).sort((a, b) => b.weight - a.weight);
    const { nodes, initial } = describe(cs, M.labels);
    const totalLen = cs.reduce((a, s) => a + s.length, 0);

    clusters.push({
      size: idx.length,
      share: n ? idx.length / n : 0,
      stats: {
        states: M.labels.length,
        distinctTransitions: edges.length,
        transitions: edges.reduce((a, e) => a + e.count, 0),
        avgLen: U.round(totalLen / idx.length, 1),
        selfLoops: edges.filter((e) => e.from === e.to).reduce((a, e) => a + e.count, 0),
      },
      nodes, edges, initial,
      centrality: centrality(M.wModel, M.labels),
      topStates: nodes.slice(0, 4).map((nn) => nn.id),
      sequences: cs.slice(0, SEQ_ROWS).map((s, i) => ({ i, len: s.length, states: s.slice(0, SEQ_LEN) })),
    });
  }
  clusters.sort((a, b) => b.size - a.size).forEach((c, i) => (c.label = i + 1));

  return {
    gameId, weightMode, method,
    k: clusters.length, kRequested: k, n,
    totalSessions: allSessions.length, usableSessions: usable.length, sampledFrom,
    quality: { silhouette: res.silhouette != null ? U.round(res.silhouette, 3) : null, sse: null },
    seqLenCap: SEQ_LEN,
    clusters,
  };
}

// ---- Behaviour patterns → outcome (ladyna) ----------------------------------
// Mines frequent sequential patterns (ladyna.discoverPatterns) and, splitting
// sessions into High vs Low cohorts on a run outcome (median split on score /
// stars, or pass/fail), compares how often each pattern appears in each cohort:
// a 2×2 (pattern present/absent × High/Low) with a standardized residual and a
// chi-square p-value. That drives the diverging "pyramid" of which behaviours
// distinguish successful runs — and the equivalent table.
const OUTCOMES = ["score", "stars", "pass"];

// High/Low cohort per session for the chosen outcome (null when unavailable).
function groupArray(items, target) {
  if (target === "pass") return items.map((it) => (it.score == null ? null : (it.score >= passMedian(items) ? "High" : "Low")));
  const key = target === "stars" ? "stars" : "score";
  const vals = items.map((it) => it[key]).filter((v) => v != null).sort((a, b) => a - b);
  if (!vals.length) return items.map(() => null);
  const med = vals[Math.floor(vals.length / 2)];
  return items.map((it) => (it[key] == null ? null : (it[key] >= med ? "High" : "Low")));
}
function passMedian(items) {
  const vals = items.map((it) => it.score).filter((v) => v != null).sort((a, b) => a - b);
  return vals.length ? vals[Math.floor(vals.length / 2)] : 0;
}

// Contiguous containment: does `seq` contain the token run `toks` back-to-back?
function containsPattern(seq, toks) {
  if (!toks.length || toks.length > seq.length) return false;
  outer: for (let i = 0; i + toks.length <= seq.length; i++) {
    for (let j = 0; j < toks.length; j++) if (seq[i + j] !== toks[j]) continue outer;
    return true;
  }
  return false;
}

function computePatterns(gameId, query) {
  const target = OUTCOMES.indexOf(query.outcome) >= 0 ? query.outcome : "score";
  let minSupport = parseFloat(query.minSupport); if (!Number.isFinite(minSupport)) minSupport = 0.1;
  minSupport = Math.max(0.02, Math.min(0.9, minSupport));

  const { items, truncated } = seq.fetchSequencesWithOutcomes(gameId, query);
  const filtered = items.filter((it) => it.seq.length >= 2);
  const groups = groupArray(filtered, target);
  // Keep only sessions we can place in a cohort.
  const labelled = filtered.filter((_, i) => groups[i] != null);
  const labels = groups.filter((g) => g != null);
  const sessions = labelled.map((it) => it.seq);
  const nHigh = labels.filter((g) => g === "High").length;
  const nLow = labels.length - nHigh;

  if (sessions.length < 6 || nHigh < 3 || nLow < 3) {
    return { gameId, target, minSupport, error: "not_enough_data", usable: sessions.length, groupHigh: nHigh, groupLow: nLow, totalSessions: items.length };
  }

  const pats = L.discoverPatterns(sessions, { minSupport });
  const patList = pats.patterns || pats || [];
  if (!patList.length) {
    return { gameId, target, minSupport, patterns: [], n: sessions.length, groupHigh: nHigh, groupLow: nLow, totalSessions: items.length, truncated };
  }

  const N = nHigh + nLow;
  const rows = patList.map((p) => {
    const toks = String(p.pattern).split("->").map((t) => t.trim());
    let oH = 0, oL = 0;
    for (let i = 0; i < sessions.length; i++) {
      if (containsPattern(sessions[i], toks)) { if (labels[i] === "High") oH++; else oL++; }
    }
    const rowT = oH + oL;
    let stdResid = 0, pGroup = null;
    if (rowT > 0 && rowT < N) {
      // 2×2 chi-square (present/absent × High/Low) + adjusted standardized residual.
      const eH = rowT * nHigh / N, eL = rowT * nLow / N;
      const aH = (N - rowT) * nHigh / N, aL = (N - rowT) * nLow / N;
      const chi = (oH - eH) * (oH - eH) / eH + (oL - eL) * (oL - eL) / eL +
                  ((nHigh - oH) - aH) * ((nHigh - oH) - aH) / aH + ((nLow - oL) - aL) * ((nLow - oL) - aL) / aL;
      try { pGroup = L.chiSqUpperTail(chi, 1); } catch (_) { pGroup = null; }
      const rowProp = rowT / N, colPropH = nHigh / N;
      stdResid = (oH - eH) / Math.sqrt(eH * (1 - rowProp) * (1 - colPropH));
    }
    return {
      pattern: p.pattern,
      support: p.support != null ? U.round(p.support, 3) : null,
      lift: p.lift != null ? U.round(p.lift, 3) : null,
      countHigh: oH, countLow: oL,
      propHigh: nHigh ? U.round(oH / nHigh, 4) : 0,
      propLow: nLow ? U.round(oL / nLow, 4) : 0,
      stdResid: U.round(stdResid, 2),
      p: pGroup != null ? U.round(pGroup, 4) : null,
      significant: pGroup != null && pGroup <= 0.05,
    };
  });

  // Most distinguishing first (largest |standardized residual|).
  rows.sort((a, b) => Math.abs(b.stdResid) - Math.abs(a.stdResid));

  return {
    gameId, target, minSupport,
    n: sessions.length, groupHigh: nHigh, groupLow: nLow, totalSessions: items.length, truncated,
    groupA: { label: "High " + target, size: nHigh },
    groupB: { label: "Low " + target, size: nLow },
    patterns: rows.slice(0, 30),
  };
}

// ---- Cohort comparison (ladyna permutation test) ----------------------------
// Splits sessions into two cohorts by a run outcome (median split on score /
// stars, or pass), builds a probability transition network for each over a
// shared state alphabet, and compares them edge-by-edge with a permutation test
// (permutationTest): which transitions differ significantly between the groups.
const COMPARE_GROUPS = ["score", "stars"];

function computeCompare(gameId, query) {
  const groupBy = COMPARE_GROUPS.indexOf(query.groupBy) >= 0 ? query.groupBy : "score";
  const iter = Math.min(2000, Math.max(100, parseInt(query.iter, 10) || 500));
  const seed = Number.isFinite(parseInt(query.seed, 10)) ? parseInt(query.seed, 10) : 42;

  const { items } = seq.fetchSequencesWithOutcomes(gameId, query);
  const usable = items.filter((it) => it.seq.length >= 2 && it[groupBy] != null);
  if (usable.length < 8) {
    return { gameId, groupBy, error: "not_enough_data", usable: usable.length, totalSessions: items.length };
  }

  // Median split into High (≥ median) and Low (< median) cohorts.
  const vals = usable.map((it) => +it[groupBy]).sort((a, b) => a - b);
  const median = vals[Math.floor(vals.length / 2)];
  const A = [], B = [];
  usable.forEach((it) => { (+it[groupBy] >= median ? A : B).push(it.seq); });
  if (A.length < 3 || B.length < 3) {
    return { gameId, groupBy, error: "degenerate_split", median, groupA: A.length, groupB: B.length, usable: usable.length };
  }

  // Shared alphabet so both models carry identical labels (permutationTest needs it).
  const labelSet = new Set(); usable.forEach((it) => it.seq.forEach((a) => labelSet.add(a)));
  const labels = Array.from(labelSet).sort();
  const mA = L.tna(A, { labels }), mB = L.tna(B, { labels });

  let pt;
  try { pt = L.permutationTest(mA, mB, { iter, seed, level: 0.05 }); }
  catch (e) { return { gameId, groupBy, error: "permutation_failed", detail: String(e.message) }; }

  const level = pt.level != null ? pt.level : 0.05;
  const wA = mA.weights, wB = mB.weights;
  const ix = {}; labels.forEach((l, i) => (ix[l] = i));
  const edges = (pt.edgeStats || [])
    .map((e) => {
      const i = ix[e.from], j = ix[e.to];
      const weightA = i != null && j != null ? wA.get(i, j) : 0;
      const weightB = i != null && j != null ? wB.get(i, j) : 0;
      return {
        from: e.from, to: e.to,
        weightA: U.round(weightA, 4), weightB: U.round(weightB, 4),
        diff: U.round(e.diffTrue, 4),
        effectSize: e.effectSize != null ? U.round(e.effectSize, 3) : null,
        pValue: e.pValue != null ? U.round(e.pValue, 4) : null,
        significant: e.pValue != null && e.pValue <= level && (weightA > 0 || weightB > 0),
      };
    })
    .filter((e) => e.weightA > 0 || e.weightB > 0)
    .sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  const significant = edges.filter((e) => e.significant).length;
  return {
    gameId, groupBy, iter, level, median: U.round(median, 3),
    groupA: { label: "High " + groupBy + " (≥ " + U.round(median, 2) + ")", size: A.length },
    groupB: { label: "Low " + groupBy + " (< " + U.round(median, 2) + ")", size: B.length },
    labels, edges, significant, total: edges.length,
    usable: usable.length, totalSessions: items.length,
  };
}

// ---- Sequence index plot paging ---------------------------------------------
// The index plot can be browsed page-by-page through *every* session. Sessions
// are in session_id order (exactly as fetchSequences returns them), so a given
// offset is stable across the initial /tna load and later /tna/sequences fetches.
const SEQ_PAGE = 28;     // rows per page (matches what the plot shows at once)
const SEQ_LEN_CAP = 60;  // steps rendered per row

function pageSequences(sessions, offset, limit) {
  const total = sessions.length;
  const lim = Math.max(1, Math.min(200, Number.isFinite(limit) ? limit : SEQ_PAGE));
  let off = Number.isFinite(offset) && offset > 0 ? offset : 0;
  if (off >= total) off = Math.max(0, total - lim);   // clamp a past-the-end request onto the last page
  const page = sessions.slice(off, off + lim).map((s, i) => ({
    i: off + i, len: s.length, states: s.slice(0, SEQ_LEN_CAP), clipped: s.length > SEQ_LEN_CAP,
  }));
  return { sequences: page, sequencesTotal: total, sequencesOffset: off, sequencesLimit: lim, seqLenCap: SEQ_LEN_CAP };
}

// Lightweight endpoint backing the plot's Prev/Next — just fetch + slice.
function computeSequences(gameId, query) {
  const { sessions } = seq.fetchSequences(gameId, query);
  return Object.assign({ gameId }, pageSequences(sessions, parseInt(query.offset, 10), parseInt(query.limit, 10)));
}

// ---- Public entry -----------------------------------------------------------
function compute(gameId, query) {
  const weightMode = query.weight === "frequency" ? "frequency" : "probability";
  const { sessions, events, truncated } = seq.fetchSequences(gameId, query);

  if (!sessions.length) {
    return {
      gameId, weightMode,
      stats: { sessions: 0, states: 0, transitions: 0, distinctTransitions: 0, events, selfLoops: 0, truncated },
      nodes: [], edges: [], initial: [], centrality: [], communities: [], communityMethod: null,
      sequences: [], sequencesTotal: 0, sequencesOffset: 0, sequencesLimit: SEQ_PAGE, seqLenCap: SEQ_LEN_CAP,
      validation: null, markov: null, stability: null,
    };
  }

  const M = buildModels(sessions, weightMode);
  const edges = edgesFrom(M, weightMode).sort((a, b) => b.weight - a.weight);
  const cent = centrality(M.wModel, M.labels);
  const { nodes, initial } = describe(sessions, M.labels);

  // Community detection (cheap) — attach each state's module to its node.
  const comm = communitiesOf(M.wModel, M.labels);
  nodes.forEach((n) => { n.community = comm.byState[n.id] != null ? comm.byState[n.id] : 0; });

  // First page of the sequence index plot; the client pages through the rest
  // via /tna/sequences (see pageSequences / computeSequences).
  const seqPage = pageSequences(sessions, 0, SEQ_PAGE);

  // Validation & diagnostics are opt-in (the "Run validation" button) so a plain
  // /tna load stays fast: bootstrap edge stability, Markov-order justification,
  // and case-drop centrality stability are computed together on request.
  let validation = null, markov = null, stability = null;
  if ((query.bootstrap === "1" || query.bootstrap === "true") && edges.length && sessions.length >= 3) {
    const iter = parseInt(query.iter, 10);
    validation = bootstrap(M.wModel, { iter, level: parseFloat(query.level), seed: parseInt(query.seed, 10) });
    markov = markovDiag(sessions, 2);
    stability = stabilityDiag(M.wModel, { iter });
  }

  return {
    gameId, weightMode,
    stats: {
      sessions: sessions.length,
      states: M.labels.length,
      transitions: edges.reduce((a, e) => a + e.count, 0),
      distinctTransitions: edges.length,
      events,
      selfLoops: edges.filter((e) => e.from === e.to).reduce((a, e) => a + e.count, 0),
      truncated,
    },
    nodes, edges, initial, centrality: cent,
    communities: comm.summary, communityMethod: comm.method,
    sequences: seqPage.sequences, sequencesTotal: seqPage.sequencesTotal,
    sequencesOffset: seqPage.sequencesOffset, sequencesLimit: seqPage.sequencesLimit,
    seqLenCap: seqPage.seqLenCap,
    validation, markov, stability,
  };
}

module.exports = { compute, computeClusters, computeSequences, computePatterns, computeCompare };
