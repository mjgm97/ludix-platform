/* =============================================================================
 * Suite server — Transition Network Analysis (game-agnostic)
 * -----------------------------------------------------------------------------
 * Models each game's session sequences as a first-order Markov *transition
 * network*: activities are nodes, and a directed edge A→B carries the
 * transition probability P(B | A) = count(A→B) / count(A→·). On top of that it
 * derives:
 *   - initial-state probabilities (where sessions begin),
 *   - node/edge centralities (out/in-strength, betweenness, closeness, PageRank),
 *   - optional bootstrap validation of each edge (are its weights stable, or an
 *     artefact of a few sessions?).
 *
 * Everything is computed from (session_id, seq, type) via sequences.js, so it
 * works for ANY game in the suite. The heavy library math (d3 etc.) in the
 * reference notebook is replaced with small, dependency-free implementations
 * sized for the modest number of distinct activities a game emits.
 * ========================================================================== */
"use strict";

const U = require("./analytics-util");
const seq = require("./sequences");

// Edge-key delimiter + deterministic RNG (mulberry32, reproducible per seed) are
// shared via analytics-util so /process, /tna and /predict stay in lockstep.
const SEP = U.SEP;
const rng = U.rng;

// ---- Transition model from a set of sequences -------------------------------
// Returns state list + index, per-state frequency & initial counts, edge counts
// keyed "from<SEP>to", and per-state outgoing totals (row sums).
function buildModel(sessions) {
  const stateIndex = {}; const states = [];
  const freq = {}; const initial = {}; let initTotal = 0;
  const edgeCount = {}; const rowSum = {};
  const idx = (t) => (t in stateIndex ? stateIndex[t] : (stateIndex[t] = states.push(t) - 1));

  for (const s of sessions) {
    idx(s[0]); initial[s[0]] = (initial[s[0]] || 0) + 1; initTotal++;
    for (let i = 0; i < s.length; i++) {
      const t = s[i]; idx(t); freq[t] = (freq[t] || 0) + 1;
      if (i > 0) {
        const a = s[i - 1], b = t, k = a + SEP + b;
        edgeCount[k] = (edgeCount[k] || 0) + 1;
        rowSum[a] = (rowSum[a] || 0) + 1;
      }
    }
  }
  return { states, stateIndex, freq, initial, initTotal, edgeCount, rowSum };
}

// Edge list with probability + chosen weight from a model.
function edgesFrom(m, weightMode) {
  return Object.keys(m.edgeCount).map((k) => {
    const p = k.split(SEP), from = p[0], to = p[1], count = m.edgeCount[k];
    const probability = m.rowSum[from] ? count / m.rowSum[from] : 0;
    return { from, to, count, probability, weight: weightMode === "frequency" ? count : probability };
  });
}

// ---- Centrality (small directed weighted graph) -----------------------------
// distance = 1/weight, so heavier transitions are "closer". Node count is the
// number of distinct activities (typically < 30), so plain O(V^2) Dijkstra per
// source inside Brandes' algorithm is more than fast enough.
function centrality(states, edges, weightMode) {
  const n = states.length;
  const ix = {}; states.forEach((s, i) => (ix[s] = i));
  const out = states.map(() => []);          // adjacency: [{v, w}]
  const outStrength = new Array(n).fill(0);
  const inStrength = new Array(n).fill(0);
  // Probability matrix for PageRank (row-stochastic where a row has out-edges).
  const prob = states.map(() => new Array(n).fill(0));

  edges.forEach((e) => {
    const u = ix[e.from], v = ix[e.to];
    if (u == null || v == null) return;
    out[u].push({ v, w: e.weight > 0 ? e.weight : 1e-9 });
    outStrength[u] += e.weight;
    inStrength[v] += e.weight;
    prob[u][v] += e.probability;
  });

  // Betweenness (Brandes, weighted, directed) + harmonic closeness (outward).
  const betweenness = new Array(n).fill(0);
  const closeness = new Array(n).fill(0);
  for (let s = 0; s < n; s++) {
    const dist = new Array(n).fill(Infinity);
    const sigma = new Array(n).fill(0);
    const preds = states.map(() => []);
    const done = new Array(n).fill(false);
    dist[s] = 0; sigma[s] = 1;
    const order = [];
    for (let it = 0; it < n; it++) {
      let u = -1, best = Infinity;
      for (let i = 0; i < n; i++) if (!done[i] && dist[i] < best) { best = dist[i]; u = i; }
      if (u === -1) break;
      done[u] = true; order.push(u);
      for (const { v, w } of out[u]) {
        const alt = dist[u] + 1 / w;
        if (alt < dist[v] - 1e-12) { dist[v] = alt; sigma[v] = sigma[u]; preds[v] = [u]; }
        else if (Math.abs(alt - dist[v]) <= 1e-12) { sigma[v] += sigma[u]; preds[v].push(u); }
      }
    }
    let harm = 0;
    for (let v = 0; v < n; v++) if (v !== s && dist[v] < Infinity) harm += 1 / dist[v];
    closeness[s] = n > 1 ? harm / (n - 1) : 0;
    // Back-propagate dependencies for betweenness.
    const delta = new Array(n).fill(0);
    for (let i = order.length - 1; i >= 0; i--) {
      const w = order[i];
      for (const v of preds[w]) if (sigma[w] > 0) delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w]);
      if (w !== s) betweenness[w] += delta[w];
    }
  }

  // PageRank (power iteration, damping 0.85; dangling mass spread uniformly).
  const d = 0.85; let pr = new Array(n).fill(1 / (n || 1));
  const rowTot = prob.map((r) => r.reduce((a, b) => a + b, 0));
  for (let iter = 0; iter < 100; iter++) {
    const next = new Array(n).fill((1 - d) / (n || 1));
    let dangling = 0;
    for (let u = 0; u < n; u++) if (rowTot[u] === 0) dangling += pr[u];
    for (let u = 0; u < n; u++) {
      if (rowTot[u] === 0) continue;
      for (let v = 0; v < n; v++) if (prob[u][v]) next[v] += d * pr[u] * (prob[u][v] / rowTot[u]);
    }
    if (n) for (let v = 0; v < n; v++) next[v] += d * dangling / n;
    pr = next;
  }

  return states.map((st, i) => ({
    state: st,
    outStrength: U.round(outStrength[i], 4),
    inStrength: U.round(inStrength[i], 4),
    betweenness: U.round(betweenness[i], 3),
    closeness: U.round(closeness[i], 4),
    pageRank: U.round(pr[i], 4),
  }));
}

// ---- Bootstrap edge validation ----------------------------------------------
// Resample sessions with replacement `iter` times; for each observed edge,
// collect the distribution of its weight. An edge is reported "significant"
// when it stays present (weight > 0) in at least (1 - level) of the resamples —
// i.e. it isn't an artefact of one or two sessions. CI bounds are percentiles
// of the resampled weights; p is the share of resamples where the edge vanished.
function bootstrap(sessions, states, edges, weightMode, opts) {
  const iter = Math.min(2000, Math.max(50, opts.iter || 300));
  const level = opts.level > 0 && opts.level < 1 ? opts.level : 0.05;
  const rand = rng(Number.isFinite(opts.seed) ? opts.seed : 42);

  const ix = {}; states.forEach((s, i) => (ix[s] = i));
  const eIndex = {}; edges.forEach((e, i) => (eIndex[e.from + SEP + e.to] = i));
  const E = edges.length, N = sessions.length;

  // Per-session sparse contributions: edge counts + per-from-state row counts.
  const sessEdge = sessions.map((s) => {
    const em = {};
    for (let i = 1; i < s.length; i++) { const k = s[i - 1] + SEP + s[i]; em[k] = (em[k] || 0) + 1; }
    return Object.keys(em).map((k) => [eIndex[k], em[k]]);
  });
  const sessRow = sessions.map((s) => {
    const rm = {};
    for (let i = 1; i < s.length; i++) { const a = ix[s[i - 1]]; rm[a] = (rm[a] || 0) + 1; }
    return Object.keys(rm).map((a) => [+a, rm[a]]);
  });
  const fromIx = edges.map((e) => ix[e.from]);

  const samples = edges.map(() => new Float64Array(iter));
  for (let b = 0; b < iter; b++) {
    const ecnt = new Float64Array(E), rcnt = new Float64Array(states.length);
    for (let p = 0; p < N; p++) {
      const s = (rand() * N) | 0;
      const se = sessEdge[s]; for (let j = 0; j < se.length; j++) ecnt[se[j][0]] += se[j][1];
      const sr = sessRow[s]; for (let j = 0; j < sr.length; j++) rcnt[sr[j][0]] += sr[j][1];
    }
    for (let e = 0; e < E; e++) {
      const c = ecnt[e];
      samples[e][b] = weightMode === "frequency" ? c : (rcnt[fromIx[e]] ? c / rcnt[fromIx[e]] : 0);
    }
  }

  const lo = Math.floor((level / 2) * iter), hi = Math.min(iter - 1, Math.ceil((1 - level / 2) * iter) - 1);
  const outEdges = edges.map((e, i) => {
    const arr = Array.from(samples[i]).sort((a, b) => a - b);
    let sum = 0, zero = 0;
    for (let b = 0; b < iter; b++) { sum += arr[b]; if (arr[b] <= 0) zero++; }
    const pValue = zero / iter;
    return {
      from: e.from, to: e.to,
      weight: U.round(e.weight, 4),
      bootstrapMean: U.round(sum / iter, 4),
      ciLower: U.round(arr[lo], 4),
      ciUpper: U.round(arr[hi], 4),
      pValue: U.round(pValue, 4),
      significant: pValue <= level && arr[lo] > 0,
    };
  });
  const significant = outEdges.filter((e) => e.significant).length;
  return { iter, level, significant, total: outEdges.length, edges: outEdges };
}

// ---- Clustering -------------------------------------------------------------
// Groups sessions by *behaviour* and gives each cluster its own transition
// network + sequence sample, so you can compare how sub-groups of students move
// through the game. Two things are configurable:
//   • dissimilarity — how "different" two sessions are:
//       euclidean / manhattan / cosine / jensenshannon act on a behaviour
//       feature vector (normalised state-visit + transition frequencies);
//       sequence acts on the raw activity order (normalised edit distance).
//   • algorithm — kmeans (feature space, Euclidean), pam (k-medoids, any
//       dissimilarity), or hierarchical (agglomerative, any dissimilarity, with
//       a linkage rule). k-means is fast on large n; the matrix methods (pam,
//       hierarchical) are O(n²) so they use a tighter sample cap.
const CLUSTER_MAX_SEQS = 3000;   // cap for feature-space k-means
const MATRIX_MAX_SEQS = 600;     // cap for O(n²) distance-matrix methods
const SIL_MAX = 1500;            // cap for silhouette (also O(n²))
const SEQDIST_LEN = 150;         // cap tokens compared in the edit distance

const DISSIMILARITIES = ["euclidean", "manhattan", "cosine", "jensenshannon", "sequence"];
const ALGORITHMS = ["kmeans", "pam", "hierarchical"];
const LINKAGES = ["average", "complete", "ward", "single"];

function sessionVectors(sessions, states, edges) {
  const sIx = {}; states.forEach((s, i) => (sIx[s] = i));
  const eIx = {}; edges.forEach((e, i) => (eIx[e.from + SEP + e.to] = i));
  const M = states.length, E = edges.length, dim = M + E;
  const vectors = sessions.map((s) => {
    const v = new Float64Array(dim);
    const total = s.length || 1;
    const sc = {}; s.forEach((t) => (sc[t] = (sc[t] || 0) + 1));
    for (const t in sc) if (sIx[t] != null) v[sIx[t]] = sc[t] / total;
    const ec = {}; let tt = 0;
    for (let i = 1; i < s.length; i++) { const k = s[i - 1] + SEP + s[i]; ec[k] = (ec[k] || 0) + 1; tt++; }
    if (tt) for (const k in ec) if (eIx[k] != null) v[M + eIx[k]] = ec[k] / tt;
    return v;
  });
  return { vectors, dim };
}

// ---- Distance functions (on feature vectors) --------------------------------
function dEuclid(a, b) { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d; } return Math.sqrt(s); }
function dManhattan(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s; }
function dCosine(a, b) { let dot = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } if (!na || !nb) return 1; return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb)); }
function dJSD(a, b) {                       // Jensen–Shannon distance in [0,1]
  let sa = 0, sb = 0; for (let i = 0; i < a.length; i++) { sa += a[i]; sb += b[i]; }
  if (!sa || !sb) return 1;
  let js = 0;
  for (let i = 0; i < a.length; i++) {
    const p = a[i] / sa, q = b[i] / sb, m = (p + q) / 2;
    if (p > 0) js += 0.5 * p * Math.log(p / m);
    if (q > 0) js += 0.5 * q * Math.log(q / m);
  }
  return Math.sqrt(Math.max(0, js) / Math.log(2));
}
// Normalised token edit distance (optimal matching) on the raw activity order.
function dSeq(sa, sb) {
  const A = sa.length > SEQDIST_LEN ? sa.slice(0, SEQDIST_LEN) : sa;
  const B = sb.length > SEQDIST_LEN ? sb.slice(0, SEQDIST_LEN) : sb;
  const n = A.length, m = B.length;
  if (!n && !m) return 0; if (!n || !m) return 1;
  let prev = new Array(m + 1), cur = new Array(m + 1);
  for (let j = 0; j <= m; j++) prev[j] = j;
  for (let i = 1; i <= n; i++) {
    cur[0] = i;
    for (let j = 1; j <= m; j++) {
      const cost = A[i - 1] === B[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    const t = prev; prev = cur; cur = t;
  }
  return prev[m] / Math.max(n, m);
}

// Full n×n dissimilarity matrix for the matrix-based algorithms.
function distanceMatrix(sessions, vectors, dissim) {
  const n = sessions.length, D = Array.from({ length: n }, () => new Float64Array(n));
  const vfn = dissim === "manhattan" ? dManhattan : dissim === "cosine" ? dCosine : dissim === "jensenshannon" ? dJSD : dEuclid;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const d = dissim === "sequence" ? dSeq(sessions[i], sessions[j]) : vfn(vectors[i], vectors[j]);
      D[i][j] = d; D[j][i] = d;
    }
  }
  return D;
}

// ---- Algorithms -------------------------------------------------------------
function kmeans(vectors, k, seed, maxIter) {
  const n = vectors.length, dim = vectors[0].length, rand = rng(seed);
  const d2 = (a, b) => { let s = 0; for (let i = 0; i < dim; i++) { const d = a[i] - b[i]; s += d * d; } return s; };
  const centroids = [Float64Array.from(vectors[(rand() * n) | 0])];
  while (centroids.length < k) {
    const dd = vectors.map((v) => { let m = Infinity; for (const c of centroids) { const d = d2(v, c); if (d < m) m = d; } return m; });
    let sum = 0; for (const d of dd) sum += d;
    let r = rand() * (sum || 1), idx = 0;
    for (; idx < n; idx++) { r -= dd[idx]; if (r <= 0) break; }
    centroids.push(Float64Array.from(vectors[Math.min(idx, n - 1)]));
  }
  const assign = new Array(n).fill(-1);
  for (let iter = 0; iter < maxIter; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) { const d = d2(vectors[i], centroids[c]); if (d < bd) { bd = d; best = c; } }
      if (assign[i] !== best) { assign[i] = best; changed = true; }
    }
    const sums = Array.from({ length: k }, () => new Float64Array(dim)), counts = new Array(k).fill(0);
    for (let i = 0; i < n; i++) { const c = assign[i]; counts[c]++; const v = vectors[i], su = sums[c]; for (let d = 0; d < dim; d++) su[d] += v[d]; }
    for (let c = 0; c < k; c++) if (counts[c]) for (let d = 0; d < dim; d++) centroids[c][d] = sums[c][d] / counts[c];
    if (!changed && iter) break;
  }
  let sse = 0; for (let i = 0; i < n; i++) sse += d2(vectors[i], centroids[assign[i]]);
  return { assign, sse };
}

// k-medoids via Voronoi iteration on a precomputed distance matrix.
function pam(D, k, seed) {
  const n = D.length, rand = rng(seed);
  // k-means++-style medoid seeding on the distance matrix.
  const medoids = [(rand() * n) | 0];
  while (medoids.length < k) {
    const dd = new Array(n).fill(Infinity);
    for (let i = 0; i < n; i++) for (const mMed of medoids) if (D[i][mMed] < dd[i]) dd[i] = D[i][mMed];
    let sum = 0; for (const d of dd) sum += d * d;
    let r = rand() * (sum || 1), idx = 0;
    for (; idx < n; idx++) { r -= dd[idx] * dd[idx]; if (r <= 0) break; }
    medoids.push(Math.min(idx, n - 1));
  }
  const assign = new Array(n).fill(0);
  for (let iter = 0; iter < 50; iter++) {
    let changed = false;
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) { const d = D[i][medoids[c]]; if (d < bd) { bd = d; best = c; } }
      if (assign[i] !== best) { assign[i] = best; changed = true; }
    }
    for (let c = 0; c < k; c++) {
      const members = []; for (let i = 0; i < n; i++) if (assign[i] === c) members.push(i);
      if (!members.length) continue;
      let bestM = medoids[c], bestCost = Infinity;
      for (const cand of members) { let cost = 0; for (const o of members) cost += D[cand][o]; if (cost < bestCost) { bestCost = cost; bestM = cand; } }
      medoids[c] = bestM;
    }
    if (!changed && iter) break;
  }
  return { assign };
}

// Agglomerative clustering via the Lance–Williams update (single / complete /
// average / ward linkage), cut to k clusters.
function agglomerative(D, k, linkage) {
  const n = D.length;
  const cd = D.map((row) => Float64Array.from(row));
  const size = new Array(n).fill(1), active = new Array(n).fill(true);
  const members = Array.from({ length: n }, (_, i) => [i]);
  let count = n;
  while (count > k) {
    let bi = -1, bj = -1, bd = Infinity;
    for (let i = 0; i < n; i++) { if (!active[i]) continue; for (let j = i + 1; j < n; j++) { if (active[j] && cd[i][j] < bd) { bd = cd[i][j]; bi = i; bj = j; } } }
    if (bi < 0) break;
    const si = size[bi], sj = size[bj];
    for (let x = 0; x < n; x++) {
      if (!active[x] || x === bi || x === bj) continue;
      const dix = cd[bi][x], djx = cd[bj][x];
      let nd;
      if (linkage === "single") nd = Math.min(dix, djx);
      else if (linkage === "complete") nd = Math.max(dix, djx);
      else if (linkage === "ward") { const sx = size[x]; nd = Math.sqrt(Math.max(0, ((si + sx) * dix * dix + (sj + sx) * djx * djx - sx * bd * bd) / (si + sj + sx))); }
      else nd = (si * dix + sj * djx) / (si + sj);   // average
      cd[bi][x] = nd; cd[x][bi] = nd;
    }
    members[bi] = members[bi].concat(members[bj]);
    size[bi] = si + sj; active[bj] = false; count--;
  }
  const assign = new Array(n).fill(0); let ci = 0;
  for (let i = 0; i < n; i++) if (active[i]) { members[i].forEach((mm) => (assign[mm] = ci)); ci++; }
  return { assign };
}

// Mean silhouette width from a distance matrix (quality of the partition).
function silhouette(D, assign, k) {
  const n = assign.length, clusters = Array.from({ length: k }, () => []);
  for (let i = 0; i < n; i++) clusters[assign[i]].push(i);
  let sum = 0, cnt = 0;
  for (let i = 0; i < n; i++) {
    const own = clusters[assign[i]];
    if (own.length <= 1) continue;
    let a = 0; for (const j of own) if (j !== i) a += D[i][j]; a /= own.length - 1;
    let b = Infinity;
    for (let c = 0; c < k; c++) { if (c === assign[i] || !clusters[c].length) continue; let d = 0; for (const j of clusters[c]) d += D[i][j]; d /= clusters[c].length; if (d < b) b = d; }
    if (b === Infinity) continue;
    sum += (b - a) / Math.max(a, b); cnt++;
  }
  return cnt ? sum / cnt : null;
}

function sampleSessions(usable, cap, seedN) {
  if (usable.length <= cap) return { sessions: usable, sampledFrom: null };
  const rand = rng(seedN), picked = new Set();
  while (picked.size < cap) picked.add((rand() * usable.length) | 0);
  return { sessions: Array.from(picked).map((i) => usable[i]), sampledFrom: usable.length };
}

function computeClusters(gameId, query) {
  const weightMode = query.weight === "frequency" ? "frequency" : "probability";
  const { sessions: allSessions } = seq.fetchSequences(gameId, query);
  const usable = allSessions.filter((s) => s.length >= 2);   // need transitions

  let k = parseInt(query.k, 10); if (!Number.isFinite(k)) k = 3;
  k = Math.max(2, Math.min(8, k));

  const algorithm = ALGORITHMS.indexOf(query.algorithm) >= 0 ? query.algorithm : "kmeans";
  // k-means is a Euclidean, feature-space method — its dissimilarity is fixed.
  let dissimilarity = DISSIMILARITIES.indexOf(query.dissimilarity) >= 0 ? query.dissimilarity : "euclidean";
  if (algorithm === "kmeans") dissimilarity = "euclidean";
  const linkage = LINKAGES.indexOf(query.linkage) >= 0 ? query.linkage : "average";
  const seed = Number.isFinite(parseInt(query.seed, 10)) ? parseInt(query.seed, 10) : 42;
  const method = { algorithm: algorithm, dissimilarity: dissimilarity, linkage: algorithm === "hierarchical" ? linkage : null };

  if (usable.length < k || usable.length < 4) {
    return { gameId, weightMode, method, error: "not_enough_sequences", usableSessions: usable.length, totalSessions: allSessions.length, kRequested: k };
  }

  // Matrix-based algorithms are O(n²): sample harder than k-means.
  const cap = algorithm === "kmeans" ? CLUSTER_MAX_SEQS : MATRIX_MAX_SEQS;
  const sampled = sampleSessions(usable, cap, 20240816);
  const sessions = sampled.sessions, sampledFrom = sampled.sampledFrom, n = sessions.length;

  // Global vocabulary → feature vectors (needed by k-means and the vector
  // dissimilarities; the sequence dissimilarity works on raw order instead).
  const gm = buildModel(sessions);
  const gEdges = edgesFrom(gm, weightMode);
  const { vectors } = sessionVectors(sessions, gm.states, gEdges);

  // Run the chosen algorithm.
  let assign, sse = null, D = null;
  if (algorithm === "kmeans") {
    let best = null;
    for (let r = 0; r < 4; r++) { const res = kmeans(vectors, k, seed + r * 7919, 40); if (!best || res.sse < best.sse) best = res; }
    assign = best.assign; sse = U.round(best.sse, 3);
    if (n <= SIL_MAX) D = distanceMatrix(sessions, vectors, "euclidean");
  } else {
    D = distanceMatrix(sessions, vectors, dissimilarity);
    assign = (algorithm === "pam" ? pam(D, k, seed) : agglomerative(D, k, linkage)).assign;
  }
  const sil = D ? silhouette(D, assign, k) : null;

  const SEQ_ROWS = 24, SEQ_LEN = 60;
  const clusters = [];
  for (let c = 0; c < k; c++) {
    const idx = []; for (let i = 0; i < n; i++) if (assign[i] === c) idx.push(i);
    if (!idx.length) continue;
    const cs = idx.map((i) => sessions[i]);
    const m = buildModel(cs);
    const edges = edgesFrom(m, weightMode).sort((a, b) => b.weight - a.weight);
    const nodes = m.states.map((st) => ({ id: st, frequency: m.freq[st] || 0, initial: m.initTotal ? (m.initial[st] || 0) / m.initTotal : 0 })).sort((a, b) => b.frequency - a.frequency);
    const initial = m.states.map((st) => ({ state: st, probability: m.initTotal ? (m.initial[st] || 0) / m.initTotal : 0 })).filter((r) => r.probability > 0).sort((a, b) => b.probability - a.probability);
    const totalLen = cs.reduce((a, s) => a + s.length, 0);
    clusters.push({
      size: idx.length,
      share: n ? idx.length / n : 0,
      stats: {
        states: m.states.length,
        distinctTransitions: edges.length,
        transitions: edges.reduce((a, e) => a + e.count, 0),
        avgLen: U.round(totalLen / idx.length, 1),
        selfLoops: edges.filter((e) => e.from === e.to).reduce((a, e) => a + e.count, 0),
      },
      nodes, edges, initial,
      centrality: centrality(m.states, edges, weightMode),
      topStates: nodes.slice(0, 4).map((nn) => nn.id),
      sequences: cs.slice(0, SEQ_ROWS).map((s, i) => ({ i, len: s.length, states: s.slice(0, SEQ_LEN) })),
    });
  }
  clusters.sort((a, b) => b.size - a.size).forEach((c, i) => (c.label = i + 1));

  return {
    gameId, weightMode, method,
    k: clusters.length, kRequested: k, n,
    totalSessions: allSessions.length, usableSessions: usable.length, sampledFrom,
    quality: { silhouette: sil != null ? U.round(sil, 3) : null, sse: sse },
    seqLenCap: SEQ_LEN,
    clusters,
  };
}

// ---- Sequence index plot paging ---------------------------------------------
// The index plot can be browsed page-by-page through *every* session. Sessions
// are in session_id order (exactly as fetchSequences returns them), so a given
// offset is stable across the initial /tna load and later /tna/sequences fetches.
// Each row caps its length at SEQ_LEN_CAP so a marathon session can't bloat the
// payload; the full length is reported as `len` (+ `clipped`).
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

// Lightweight endpoint backing the plot's Prev/Next — just fetch + slice, no
// model/centrality/bootstrap math, so paging is cheap.
function computeSequences(gameId, query) {
  const { sessions } = seq.fetchSequences(gameId, query);
  return Object.assign({ gameId }, pageSequences(sessions, parseInt(query.offset, 10), parseInt(query.limit, 10)));
}

// ---- Public entry -----------------------------------------------------------
function compute(gameId, query) {
  const weightMode = query.weight === "frequency" ? "frequency" : "probability";
  const { sessions, events, truncated } = seq.fetchSequences(gameId, query);

  const m = buildModel(sessions);
  const edges = edgesFrom(m, weightMode).sort((a, b) => b.weight - a.weight);
  const cent = centrality(m.states, edges, weightMode);

  const nodes = m.states.map((st) => ({
    id: st,
    frequency: m.freq[st] || 0,
    initial: m.initTotal ? (m.initial[st] || 0) / m.initTotal : 0,
  })).sort((a, b) => b.frequency - a.frequency);

  const initial = m.states
    .map((st) => ({ state: st, count: m.initial[st] || 0, probability: m.initTotal ? (m.initial[st] || 0) / m.initTotal : 0 }))
    .filter((r) => r.count > 0)
    .sort((a, b) => b.probability - a.probability);

  // First page of the sequence index plot; the client pages through the rest
  // via /tna/sequences (see pageSequences / computeSequences).
  const seqPage = pageSequences(sessions, 0, SEQ_PAGE);

  let validation = null;
  if ((query.bootstrap === "1" || query.bootstrap === "true") && edges.length && sessions.length >= 3) {
    validation = bootstrap(sessions, m.states, edges, weightMode, {
      iter: parseInt(query.iter, 10),
      level: parseFloat(query.level),
      seed: parseInt(query.seed, 10),
    });
  }

  return {
    gameId, weightMode,
    stats: {
      sessions: sessions.length,
      states: m.states.length,
      transitions: edges.reduce((a, e) => a + e.count, 0),
      distinctTransitions: edges.length,
      events,
      selfLoops: edges.filter((e) => e.from === e.to).reduce((a, e) => a + e.count, 0),
      truncated,
    },
    nodes, edges, initial, centrality: cent,
    sequences: seqPage.sequences, sequencesTotal: seqPage.sequencesTotal,
    sequencesOffset: seqPage.sequencesOffset, sequencesLimit: seqPage.sequencesLimit,
    seqLenCap: seqPage.seqLenCap,
    validation,
  };
}

module.exports = { compute, computeClusters, computeSequences };
