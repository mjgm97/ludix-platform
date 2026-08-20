/* =============================================================================
 * Suite server — Predictive analytics + explainable AI (game-agnostic)
 * -----------------------------------------------------------------------------
 * Trains a model to ESTIMATE a target from features we already know, and then
 * EXPLAINS it with SHAP (SHapley Additive exPlanations):
 *   - a hand-rolled gradient-boosted decision-tree ensemble (regression for a
 *     continuous target, logistic for a pass/fail target), and
 *   - exact path-dependent TreeSHAP (Lundberg et al.) for global feature
 *     importance and per-instance local explanations.
 *
 * The unit of prediction is one RUN (a `scores` row with a session), whose
 * behaviour features are folded from that run's event stream. Everything is
 * derivable from the generic event/score envelope, so — like /tna and /process
 * — it works for ANY game in the suite. The heavy ML library math is replaced
 * with small, dependency-free implementations sized for the modest number of
 * rows and features a game produces.
 *
 * SHAP invariant (checked in spirit by the frontend waterfall): for every
 * explained instance, baseValue + Σ φ_i == the model's margin prediction
 * (regression: target units; classification: log-odds, squashed by sigmoid).
 * ========================================================================== */
"use strict";

const db = require("./db");
const U = require("./analytics-util");
const config = require("./config");

// Deterministic RNG (mulberry32) so splits/subsampling reproduce per seed —
// shared via analytics-util (same generator the TNA bootstrap/clustering use).
const rng = U.rng;
function sigmoid(z) { return z >= 0 ? 1 / (1 + Math.exp(-z)) : (function () { const e = Math.exp(z); return e / (1 + e); })(); }

const PREDICT_MAX_ROWS = 4000;   // cap training rows (seeded subsample beyond this)
const SHAP_SAMPLE = 120;         // instances explained locally + summarised (beeswarm)
const TOPK_TYPES = 12;           // event types used for the "event mix" features

// Feature groups double as the UI toggles. `sessionLen` predictions drop the
// whole timing group (it's the label source), handled in buildDesign().
const GROUPS = ["volume", "timing", "structure", "eventmix", "context"];
const TARGETS = ["score", "stars", "sessionLen", "pass"];
// Model families the user can pick. All stay exactly SHAP-explainable: the tree
// families reuse TreeSHAP; the linear family uses exact linear SHAP. Downstream
// (importance / beeswarm / waterfall / diagnostics) is identical for all.
const ALGORITHMS = ["gbtree", "forest", "tree", "linear"];

// ---- Data: one behaviour row per run ----------------------------------------
// Pulls each run (score row with a session) plus a folded summary of its event
// stream. Event features are aggregated from an ordered, bounded read of the
// game's events (same cap/pattern as sequences.js) so a huge game can't pull the
// whole table into memory.
function fetchRuns(gameId, query) {
  const P = Object.assign({ g: gameId }, U.filterParams(query));
  const sW = U.whereFor("s", query);
  const sJ = U.joinFor("s", query);
  const runs = db.prepare(
    `SELECT s.id AS id, p.username AS username, s.score AS score, s.stars AS stars,
            s.level AS level, s.session_id AS sid, s.created_at AS createdAt
       FROM scores s JOIN players p ON p.id=s.player_id
      WHERE s.game_id=@g AND s.session_id IS NOT NULL${sW}
      ORDER BY s.created_at, s.id`
  ).all(P);
  // The join is always needed here (we select username); joinFor is only used to
  // keep the events read consistent with the active user filter below.
  void sJ;
  if (!runs.length) return { runs: [], sessionFeat: {}, topTypes: [], truncated: false };

  const eW = U.whereFor("e", query);
  const eJ = U.joinFor("e", query);
  const cap = Math.max(1000, config.processMaxEvents);
  const rows = db.prepare(
    `SELECT e.session_id AS sid, e.type AS type, e.t_ms AS t
       FROM events e${eJ}
      WHERE e.game_id=@g${eW}
      ORDER BY e.session_id, e.seq, e.id
      LIMIT @cap`
  ).all(Object.assign({ cap: cap + 1 }, P));
  // Cap hit: the tail (arbitrary sessions in session_id order) is dropped, so
  // some runs will silently lose their behaviour features. Flag it like /tna
  // does so the UI can warn instead of quietly training on a biased subset.
  const truncated = rows.length > cap;
  if (truncated) rows.length = cap;

  // Fold the ordered event stream into per-session features + a global type
  // frequency table (for the top-K "event mix" features).
  const feat = {}; const typeTotal = {};
  let cur = null, curSid = null, prevType = null;
  for (const r of rows) {
    const ty = r.type == null ? "?" : String(r.type);
    typeTotal[ty] = (typeTotal[ty] || 0) + 1;
    if (r.sid !== curSid) {
      curSid = r.sid; prevType = null;
      cur = feat[r.sid] = { n: 0, types: {}, distinct: 0, tMin: r.t, tMax: r.t, trans: 0, self: 0 };
    }
    cur.n++;
    if (cur.types[ty] == null) { cur.types[ty] = 0; cur.distinct++; }
    cur.types[ty]++;
    if (r.t != null) { if (cur.tMin == null || r.t < cur.tMin) cur.tMin = r.t; if (cur.tMax == null || r.t > cur.tMax) cur.tMax = r.t; }
    if (prevType != null) { cur.trans++; if (prevType === ty) cur.self++; }
    prevType = ty;
  }
  const topTypes = Object.keys(typeTotal).sort((a, b) => typeTotal[b] - typeTotal[a]).slice(0, TOPK_TYPES);
  return { runs, sessionFeat: feat, topTypes, truncated };
}

// ---- Design matrix ----------------------------------------------------------
// Turns runs + session features into (featNames, X, y, meta) for the chosen
// target and enabled feature groups. Applies the leakage guards. Returns null
// when there aren't enough usable rows.
function buildDesign(data, target, groups, threshold) {
  const { runs, sessionFeat, topTypes } = data;
  const on = {}; groups.forEach((g) => (on[g] = true));
  // sessionLen's label comes from the timing span — drop timing to avoid leakage.
  if (target === "sessionLen") on.timing = false;

  // Ordinal-encode levels (numeric order when they're all numbers, else lexical).
  const levels = Array.from(new Set(runs.map((r) => (r.level == null ? "" : String(r.level))))).sort((a, b) => {
    const na = parseFloat(a), nb = parseFloat(b);
    if (!isNaN(na) && !isNaN(nb)) return na - nb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const levelIx = {}; levels.forEach((l, i) => (levelIx[l] = i));

  // Feature schema (name + group + extractor), filtered by enabled groups.
  const schema = [];
  const add = (group, name, get) => { if (on[group]) schema.push({ group, name, get }); };
  add("volume", "eventCount", (f) => f.n);
  add("volume", "distinctTypes", (f) => f.distinct);
  add("timing", "durationMin", (f) => Math.max(0, (f.tMax - f.tMin)) / 60000);
  add("timing", "eventsPerMin", (f) => { const m = Math.max(0, (f.tMax - f.tMin)) / 60000; return m > 0 ? f.n / m : 0; });
  add("structure", "transitions", (f) => f.trans);
  add("structure", "selfLoopRate", (f) => (f.trans ? f.self / f.trans : 0));
  topTypes.forEach((ty) => add("eventmix", "share:" + ty, (f) => (f.n ? (f.types[ty] || 0) / f.n : 0)));
  add("context", "level", (f, r) => levelIx[r.level == null ? "" : String(r.level)] || 0);
  add("context", "priorRuns", (f, r) => r._priorRuns);
  add("context", "priorAvgScore", (f, r) => r._priorAvg);

  // Player history strictly BEFORE each run (runs are ordered by created_at).
  const hist = {};
  const globalMean = runs.reduce((a, r) => a + (r.score || 0), 0) / (runs.length || 1);
  runs.forEach((r) => {
    const h = hist[r.username] || (hist[r.username] = { c: 0, s: 0 });
    r._priorRuns = h.c;
    r._priorAvg = h.c ? h.s / h.c : globalMean;
    if (r.score != null) { h.c++; h.s += r.score; }
  });

  const yOf = (r, f) => {
    if (target === "stars") return r.stars == null ? null : r.stars;
    if (target === "sessionLen") { const m = Math.max(0, (f.tMax - f.tMin)) / 60000; return m; }
    if (target === "pass") return r.score == null ? null : (r.score >= threshold ? 1 : 0);
    return r.score == null ? null : r.score;             // score (default)
  };

  const featNames = schema.map((s) => s.name);
  const groupOf = {}; schema.forEach((s) => (groupOf[s.name] = s.group));
  const X = [], y = [], meta = [];
  for (const r of runs) {
    const f = sessionFeat[r.sid];
    if (!f) continue;                                    // need behaviour features
    const yv = yOf(r, f);
    if (yv == null || !isFinite(yv)) continue;
    const row = new Float64Array(schema.length);
    for (let j = 0; j < schema.length; j++) { const v = schema[j].get(f, r); row[j] = isFinite(v) ? v : 0; }
    X.push(row); y.push(yv);
    meta.push({ username: r.username, sid: r.sid, level: r.level, actual: yv });
  }
  // Too few usable rows (or no features): report the count we did assemble so
  // the caller can tell the user how close they are to the ≥12 minimum.
  if (X.length < 12 || !featNames.length) return { insufficient: true, usable: X.length };
  return { featNames, groupOf, X, y, meta };
}

// ---- Gradient-boosted trees -------------------------------------------------
// Generic gradient/hessian boosting (XGBoost-style) so one code path covers
// squared-error regression (g=F−y, h=1) and logistic classification
// (g=p−y, h=p(1−p)). Trees are shallow CART; every node stores its training
// `cover` (row count), which path-dependent TreeSHAP needs.
// `feats` optionally restricts which feature columns this tree may split on
// (the random forest passes a per-tree subspace); omit ⇒ all features. Split
// feature indices stay in the FULL feature space, so TreeSHAP over nFeat is
// unaffected (unused features simply get φ = 0).
function buildTree(X, idx, g, h, depth, maxDepth, minLeaf, lambda, feats) {
  let G = 0, H = 0; for (const i of idx) { G += g[i]; H += h[i]; }
  const leafVal = -G / (H + lambda);
  const node = { leaf: true, value: leafVal, cover: idx.length };
  if (depth >= maxDepth || idx.length < 2 * minLeaf) return node;

  const F = feats || null, nFeat = X[0].length, nF = F ? F.length : nFeat;
  let best = null;
  const parentScore = (G * G) / (H + lambda);
  for (let fi = 0; fi < nF; fi++) {
    const f = F ? F[fi] : fi;
    // Sort this node's rows by feature f, sweep split points accumulating G/H.
    const ord = idx.slice().sort((a, b) => X[a][f] - X[b][f]);
    let GL = 0, HL = 0;
    for (let s = 0; s < ord.length - 1; s++) {
      const i = ord[s]; GL += g[i]; HL += h[i];
      const nl = s + 1, nr = ord.length - nl;
      if (nl < minLeaf || nr < minLeaf) continue;
      if (X[ord[s]][f] === X[ord[s + 1]][f]) continue;   // can't split equal values
      const GR = G - GL, HR = H - HL;
      const gain = 0.5 * ((GL * GL) / (HL + lambda) + (GR * GR) / (HR + lambda) - parentScore);
      if (gain > 0 && (!best || gain > best.gain)) {
        best = { gain, feature: f, threshold: (X[ord[s]][f] + X[ord[s + 1]][f]) / 2, ord, split: nl };
      }
    }
  }
  if (!best) return node;

  const leftIdx = best.ord.slice(0, best.split), rightIdx = best.ord.slice(best.split);
  return {
    leaf: false, feature: best.feature, threshold: best.threshold, cover: idx.length,
    left: buildTree(X, leftIdx, g, h, depth + 1, maxDepth, minLeaf, lambda, feats),
    right: buildTree(X, rightIdx, g, h, depth + 1, maxDepth, minLeaf, lambda, feats),
  };
}
function treePredict(node, x) {
  while (!node.leaf) node = x[node.feature] <= node.threshold ? node.left : node.right;
  return node.value;
}

function trainGBM(X, y, opts) {
  const n = X.length, lr = opts.learningRate, lambda = 1.0, minLeaf = Math.max(3, Math.round(n * 0.01));
  const classify = opts.classify;
  let F0, F = new Float64Array(n);
  if (classify) { const pos = y.reduce((a, v) => a + v, 0) / n; F0 = Math.log((pos + 1e-6) / (1 - pos + 1e-6)); }
  else { F0 = y.reduce((a, v) => a + v, 0) / n; }
  F.fill(F0);

  const trees = [], allIdx = Array.from({ length: n }, (_, i) => i);
  const g = new Float64Array(n), h = new Float64Array(n);
  for (let t = 0; t < opts.estimators; t++) {
    if (classify) { for (let i = 0; i < n; i++) { const p = sigmoid(F[i]); g[i] = p - y[i]; h[i] = Math.max(1e-6, p * (1 - p)); } }
    else { for (let i = 0; i < n; i++) { g[i] = F[i] - y[i]; h[i] = 1; } }
    const tree = buildTree(X, allIdx, g, h, 0, opts.maxDepth, minLeaf, lambda);
    for (let i = 0; i < n; i++) F[i] += lr * treePredict(tree, X[i]);
    trees.push(tree);
  }
  return { kind: "gbtree", F0, lr, trees, classify, probSpace: false };
}

// ---- Random forest + single decision tree (reuse buildTree/TreeSHAP) --------
// CART leaves are fit with g=−y, h=1, so leafVal = Σy/(n+λ) ≈ the leaf mean of y
// — a plain regression tree. For a 0/1 label that mean IS the leaf's positive
// RATE, i.e. a probability, so tree/forest classification lives in probability
// space (probSpace: true ⇒ no sigmoid). The additive ensemble F0 + Σ lr·tree
// keeps the TreeSHAP identity (baseValue + Σφ == margin) for free.
function fitCartTree(X, y, idx, maxDepth) {
  const n = idx.length, lambda = 1e-6, minLeaf = Math.max(3, Math.round(n * 0.02));
  const g = new Float64Array(X.length), h = new Float64Array(X.length);
  for (const i of idx) { g[i] = -y[i]; h[i] = 1; }
  const featSub = arguments.length > 4 && arguments[4] ? arguments[4] : null;
  return buildTree(X, idx, g, h, 0, maxDepth, minLeaf, lambda, featSub);
}
function trainForest(X, y, opts) {
  const n = X.length, nFeat = X[0].length, nTrees = opts.estimators;
  const rand = U.rng((opts.seed ^ 0x9e3779b9) >>> 0);
  const k = Math.max(1, Math.round(Math.sqrt(nFeat)));
  const trees = [];
  for (let t = 0; t < nTrees; t++) {
    const idx = new Array(n); for (let i = 0; i < n; i++) idx[i] = (rand() * n) | 0;   // bootstrap
    // per-tree random feature subspace
    const pool = Array.from({ length: nFeat }, (_, i) => i);
    for (let i = pool.length - 1; i > 0; i--) { const j = (rand() * (i + 1)) | 0; const tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp; }
    const feats = pool.slice(0, k);
    trees.push(fitCartTree(X, y, idx, opts.maxDepth, feats));
  }
  return { kind: "forest", F0: 0, lr: 1 / nTrees, trees, classify: opts.classify, probSpace: true };
}
function trainTree(X, y, opts) {
  const idx = Array.from({ length: X.length }, (_, i) => i);
  const tree = fitCartTree(X, y, idx, opts.maxDepth);
  return { kind: "tree", F0: 0, lr: 1, trees: [tree], classify: opts.classify, probSpace: true };
}

// ---- Linear / logistic regression (ridge, exact linear SHAP) ----------------
// Fit on standardized features (mean 0, std 1) by gradient descent. Because the
// training mean of each standardized feature is 0, the exact SHAP decomposition
// is φ_j = w_j·z_j(x) and baseValue = intercept — no sampling needed.
function trainLinear(X, y, opts) {
  const n = X.length, d = X[0].length, classify = opts.classify;
  const mean = new Float64Array(d), std = new Float64Array(d);
  for (let j = 0; j < d; j++) { let s = 0; for (let i = 0; i < n; i++) s += X[i][j]; mean[j] = s / n; }
  for (let j = 0; j < d; j++) { let v = 0; for (let i = 0; i < n; i++) { const e = X[i][j] - mean[j]; v += e * e; } std[j] = Math.sqrt(v / n) || 1; }
  const z = X.map((row) => { const r = new Float64Array(d); for (let j = 0; j < d; j++) r[j] = (row[j] - mean[j]) / std[j]; return r; });
  const w = new Float64Array(d); let b = classify ? 0 : y.reduce((a, v) => a + v, 0) / n;
  const l2 = opts.l2, lr = classify ? 0.5 : 0.1, iters = opts.iters || 400;
  for (let it = 0; it < iters; it++) {
    const gw = new Float64Array(d); let gb = 0;
    for (let i = 0; i < n; i++) {
      let m = b; for (let j = 0; j < d; j++) m += w[j] * z[i][j];
      const pred = classify ? sigmoid(m) : m, err = pred - y[i];
      gb += err; for (let j = 0; j < d; j++) gw[j] += err * z[i][j];
    }
    b -= lr * gb / n;
    for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]);
  }
  return { kind: "linear", w: Array.from(w), b, mean: Array.from(mean), std: Array.from(std), classify, probSpace: false };
}
function linMargin(model, x) { let m = model.b; for (let j = 0; j < model.w.length; j++) m += model.w[j] * (x[j] - model.mean[j]) / model.std[j]; return m; }
function linShap(model, x, nFeat) { const phi = new Float64Array(nFeat); for (let j = 0; j < model.w.length; j++) phi[j] = model.w[j] * (x[j] - model.mean[j]) / model.std[j]; return phi; }

// ---- Uniform model interface (dispatch tree families vs linear) -------------
function trainModel(algorithm, X, y, opts) {
  if (algorithm === "forest") return trainForest(X, y, opts);
  if (algorithm === "tree") return trainTree(X, y, opts);
  if (algorithm === "linear") return trainLinear(X, y, opts);
  return trainGBM(X, y, opts);
}
function marginOf(model, x) {
  if (model.kind === "linear") return linMargin(model, x);
  let m = model.F0; for (const t of model.trees) m += model.lr * treePredict(t, x); return m;
}
function predictOf(model, x) { const m = marginOf(model, x); if (model.probSpace) return m; return model.classify ? sigmoid(m) : m; }

// ---- Exact path-dependent TreeSHAP ------------------------------------------
// Lundberg et al., "Consistent Individualized Feature Attribution for Tree
// Ensembles" (Algorithm 2). Paths are tiny (≤ maxDepth+1), so the extend/unwind
// bookkeeping runs on small arrays and copies are cheap. Returns φ per feature
// for one instance and one tree; the caller scales by lr and sums across trees.
function extend(path, pz, po, pi) {
  const l = path.length;
  const m = path.map((e) => ({ d: e.d, z: e.z, o: e.o, w: e.w }));
  m.push({ d: pi, z: pz, o: po, w: l === 0 ? 1 : 0 });
  for (let i = l - 1; i >= 0; i--) {
    m[i + 1].w += po * m[i].w * (i + 1) / (l + 1);
    m[i].w = pz * m[i].w * (l - i) / (l + 1);
  }
  return m;
}
// Sum of the path weights after unwinding element i (used at a leaf). Does not
// mutate the input path.
function unwoundSum(path, i) {
  const l = path.length - 1;
  const one = path[i].o, zero = path[i].z;
  const w = path.map((e) => e.w);
  let next = w[l], total = 0;
  for (let j = l - 1; j >= 0; j--) {
    if (one !== 0) {
      const tmp = next * (l + 1) / ((j + 1) * one);
      total += tmp;
      next = w[j] - tmp * zero * (l - j) / (l + 1);
    } else {
      total += (w[j] * (l + 1)) / (zero * (l - j));
    }
  }
  return total;
}
// Remove element i from the path (for a repeated split feature on the way down).
function unwind(path, i) {
  const l = path.length - 1;
  const one = path[i].o, zero = path[i].z;
  const m = path.map((e) => ({ d: e.d, z: e.z, o: e.o, w: e.w }));
  let next = m[l].w;
  for (let j = l - 1; j >= 0; j--) {
    if (one !== 0) {
      const tmp = m[j].w;
      m[j].w = next * (l + 1) / ((j + 1) * one);
      next = tmp - m[j].w * zero * (l - j) / (l + 1);
    } else {
      m[j].w = (m[j].w * (l + 1)) / (zero * (l - j));
    }
  }
  for (let j = i; j < l; j++) { m[j].d = m[j + 1].d; m[j].z = m[j + 1].z; m[j].o = m[j + 1].o; }
  m.pop();
  return m;
}
function treeShap(tree, x, phi) {
  function recurse(node, path, pz, po, pi) {
    path = extend(path, pz, po, pi);
    if (node.leaf) {
      for (let i = 1; i < path.length; i++) {
        const w = unwoundSum(path, i);
        phi[path[i].d] += w * (path[i].o - path[i].z) * node.value;
      }
      return;
    }
    const hot = x[node.feature] <= node.threshold ? node.left : node.right;
    const cold = hot === node.left ? node.right : node.left;
    let iz = 1, io = 1;
    let k = -1; for (let j = 1; j < path.length; j++) if (path[j].d === node.feature) { k = j; break; }
    if (k !== -1) { iz = path[k].z; io = path[k].o; path = unwind(path, k); }
    recurse(hot, path, iz * hot.cover / node.cover, io, node.feature);
    recurse(cold, path, iz * cold.cover / node.cover, 0, node.feature);
  }
  recurse(tree, [], 1, 1, -1);
}
// Cover-weighted mean leaf value = the tree's expected output (SHAP base term).
function treeMean(node) {
  if (node.leaf) return node.value;
  return (node.left.cover * treeMean(node.left) + node.right.cover * treeMean(node.right)) / node.cover;
}

// φ for the whole ensemble at one instance (scaled by lr, summed across trees).
// Linear models decompose exactly, without TreeSHAP.
function shapValues(model, x, nFeat) {
  if (model.kind === "linear") return linShap(model, x, nFeat);
  const phi = new Float64Array(nFeat);
  for (const t of model.trees) {
    const p = new Float64Array(nFeat);
    treeShap(t, x, p);
    for (let j = 0; j < nFeat; j++) phi[j] += model.lr * p[j];
  }
  return phi;
}
function shapBase(model) {
  if (model.kind === "linear") return model.b;   // E[margin] at the feature means = intercept
  let b = model.F0; for (const t of model.trees) b += model.lr * treeMean(t); return b;
}

// ---- Metrics ----------------------------------------------------------------
function regressionMetrics(yTrue, yPred) {
  const n = yTrue.length, mean = yTrue.reduce((a, v) => a + v, 0) / n;
  let sse = 0, sst = 0, sae = 0;
  for (let i = 0; i < n; i++) { const e = yTrue[i] - yPred[i]; sse += e * e; sae += Math.abs(e); sst += (yTrue[i] - mean) * (yTrue[i] - mean); }
  return { r2: sst > 0 ? 1 - sse / sst : null, rmse: Math.sqrt(sse / n), mae: sae / n };
}
function auc(yTrue, score) {
  // Rank-based AUC (Mann–Whitney). Ties get averaged ranks.
  const idx = score.map((s, i) => [s, i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(score.length);
  for (let i = 0; i < idx.length;) {
    let j = i; while (j < idx.length && idx[j][0] === idx[i][0]) j++;
    const r = (i + j - 1) / 2 + 1; for (let k = i; k < j; k++) ranks[idx[k][1]] = r; i = j;
  }
  let pos = 0, sumR = 0; for (let i = 0; i < yTrue.length; i++) if (yTrue[i] === 1) { pos++; sumR += ranks[i]; }
  const neg = yTrue.length - pos; if (!pos || !neg) return null;
  return (sumR - pos * (pos + 1) / 2) / (pos * neg);
}
function classMetrics(yTrue, p) {
  const n = yTrue.length; let tp = 0, tn = 0, fp = 0, fn = 0, ll = 0;
  for (let i = 0; i < n; i++) {
    const pred = p[i] >= 0.5 ? 1 : 0, yy = yTrue[i];
    if (pred === 1 && yy === 1) tp++; else if (pred === 0 && yy === 0) tn++; else if (pred === 1) fp++; else fn++;
    const q = Math.min(1 - 1e-9, Math.max(1e-9, p[i])); ll += -(yy * Math.log(q) + (1 - yy) * Math.log(1 - q));
  }
  // ROC sweep (thresholds from the sorted scores), for a small plotted curve.
  const order = p.map((v, i) => [v, yTrue[i]]).sort((a, b) => b[0] - a[0]);
  const P = yTrue.reduce((a, v) => a + v, 0), N = n - P;
  const roc = [{ fpr: 0, tpr: 0 }]; let ctp = 0, cfp = 0;
  for (const [, yy] of order) { if (yy === 1) ctp++; else cfp++; roc.push({ fpr: N ? cfp / N : 0, tpr: P ? ctp / P : 0 }); }
  const step = Math.max(1, Math.floor(roc.length / 40));
  return {
    accuracy: (tp + tn) / n, auc: auc(yTrue, p), logLoss: ll / n,
    confusion: { tp, tn, fp, fn },
    roc: roc.filter((_, i) => i % step === 0 || i === roc.length - 1),
  };
}

// ---- Public entry -----------------------------------------------------------
function compute(gameId, query) {
  const target = TARGETS.indexOf(query.target) >= 0 ? query.target : "score";
  const classify = target === "pass";
  const threshold = (function () { const t = parseFloat(query.threshold); return t > 0 && t < 1 ? t : 0.6; })();
  const groups = (query.features ? String(query.features).split(",") : GROUPS).filter((g) => GROUPS.indexOf(g) >= 0);
  const enabled = groups.length ? groups : GROUPS.slice();
  const seed = Number.isFinite(parseInt(query.seed, 10)) ? parseInt(query.seed, 10) : 42;
  const algorithm = ALGORITHMS.indexOf(query.algorithm) >= 0 ? query.algorithm : "gbtree";
  const estimators = Math.max(20, Math.min(400, parseInt(query.estimators, 10) || 150));
  const learningRate = (function () { const v = parseFloat(query.learningRate); return v > 0 && v <= 1 ? v : 0.1; })();
  // A single tree wants more depth than a boosted stump; forests sit in between.
  const depthCap = algorithm === "tree" ? 10 : 6;
  const depthDefault = algorithm === "tree" ? 6 : algorithm === "forest" ? 5 : 3;
  const maxDepth = Math.max(1, Math.min(depthCap, parseInt(query.maxDepth, 10) || depthDefault));
  const l2 = (function () { const v = parseFloat(query.l2); return v >= 0 && v <= 100 ? v : 0.1; })();

  const availableFrom = (data) => {
    // A target is only trainable if it VARIES (≥2 distinct non-null values).
    // This also correctly hides "score" for imports that created runs with no
    // outcome column (all scores default to 0), and any game with uniform scores.
    const varies = (fn) => { const s = new Set(); for (const r of data.runs) { const v = fn(r); if (v != null) { s.add(v); if (s.size > 1) return true; } } return false; };
    return {
      score: varies((r) => r.score),
      stars: varies((r) => r.stars),
      sessionLen: Object.keys(data.sessionFeat).length > 0,
      pass: varies((r) => r.score),
    };
  };

  const data = fetchRuns(gameId, query);
  const availableTargets = availableFrom(data);
  const design = data.runs.length ? buildDesign(data, target, enabled, threshold) : null;
  if (!design || design.insufficient) {
    return { gameId, target, classify, threshold, availableTargets, features: enabled,
      error: "not_enough_data", usableRuns: design ? design.usable : 0, totalRuns: data.runs.length,
      truncated: data.truncated };
  }

  // Seeded subsample + 80/20 holdout split.
  const rand = rng(seed);
  let order = design.X.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) { const j = (rand() * (i + 1)) | 0; const t = order[i]; order[i] = order[j]; order[j] = t; }
  let sampledFrom = null;
  if (order.length > PREDICT_MAX_ROWS) { sampledFrom = order.length; order = order.slice(0, PREDICT_MAX_ROWS); }
  const cut = Math.max(1, Math.floor(order.length * 0.8));
  const trIdx = order.slice(0, cut), teIdx = order.slice(cut);
  const pick = (ix, arr) => ix.map((i) => arr[i]);
  const Xtr = pick(trIdx, design.X), ytr = pick(trIdx, design.y);
  const Xte = pick(teIdx, design.X), yte = pick(teIdx, design.y);

  const model = trainModel(algorithm, Xtr, ytr, { estimators, learningRate, maxDepth, classify, seed, l2 });

  // Holdout metrics vs a constant baseline (train mean / positive rate).
  let metrics, baseline;
  if (classify) {
    const pTe = Xte.map((x) => predictOf(model, x));
    metrics = classMetrics(yte, pTe);
    const posRate = ytr.reduce((a, v) => a + v, 0) / ytr.length;
    baseline = classMetrics(yte, yte.map(() => posRate));
  } else {
    const pTe = Xte.map((x) => predictOf(model, x));
    metrics = regressionMetrics(yte, pTe);
    const mean = ytr.reduce((a, v) => a + v, 0) / ytr.length;
    baseline = regressionMetrics(yte, yte.map(() => mean));
    // Predicted-vs-actual scatter (capped) for the diagnostics plot.
    metrics.scatter = teIdx.slice(0, 400).map((i, k) => ({ actual: design.y[i], predicted: pTe[k] }));
  }

  // ---- SHAP over a sample drawn from all usable rows --------------------------
  const nFeat = design.featNames.length;
  const baseValue = shapBase(model);
  const sampIdx = order.slice(0, Math.min(SHAP_SAMPLE, order.length));
  const nrm = design.featNames.map((_, j) => {
    const vals = sampIdx.map((i) => design.X[i][j]); const lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    return { lo, span: hi - lo || 1 };
  });
  const meanAbs = new Float64Array(nFeat), meanSigned = new Float64Array(nFeat);
  const beeswarm = design.featNames.map(() => []);
  const instances = sampIdx.map((i) => {
    const x = design.X[i], phi = shapValues(model, x, nFeat);
    const margin = marginOf(model, x);
    for (let j = 0; j < nFeat; j++) {
      meanAbs[j] += Math.abs(phi[j]); meanSigned[j] += phi[j];
      beeswarm[j].push({ shap: U.round(phi[j], 5), valueNorm: U.round((x[j] - nrm[j].lo) / nrm[j].span, 4) });
    }
    return {
      username: design.meta[i].username, level: design.meta[i].level,
      actual: U.round(design.meta[i].actual, 5),
      predicted: U.round(predictOf(model, x), 5),
      margin: U.round(margin, 5),
      values: Array.from(x, (v) => U.round(v, 5)),
      phi: Array.from(phi, (v) => U.round(v, 5)),
    };
  });
  const m = sampIdx.length || 1;
  const importance = design.featNames.map((name, j) => ({
    feature: name, group: design.groupOf[name],
    meanAbsShap: U.round(meanAbs[j] / m, 5), meanSignedShap: U.round(meanSigned[j] / m, 5),
  })).sort((a, b) => b.meanAbsShap - a.meanAbsShap);

  // Exemplars: highest / lowest / most typical prediction (indices into instances).
  const byPred = instances.map((r, i) => [r.predicted, i]).sort((a, b) => a[0] - b[0]);
  const exemplars = byPred.length ? {
    lowest: byPred[0][1], highest: byPred[byPred.length - 1][1], typical: byPred[byPred.length >> 1][1],
  } : null;

  return {
    gameId, target, classify, threshold, availableTargets,
    algorithm, availableAlgorithms: ALGORITHMS.slice(),
    features: enabled, featNames: design.featNames, groupOf: design.groupOf,
    baseValue: U.round(baseValue, 5),
    baseProb: classify ? U.round(model.probSpace ? baseValue : sigmoid(baseValue), 5) : null,
    model: { algorithm, estimators, learningRate, maxDepth, seed, l2 },
    metrics, baseline,
    importance, beeswarm, instances, exemplars,
    meta: {
      n: design.X.length, trainN: Xtr.length, testN: Xte.length,
      sampledFrom, features: nFeat, totalRuns: data.runs.length,
      truncated: data.truncated,
      posRate: classify ? U.round(design.y.reduce((a, v) => a + v, 0) / design.y.length, 4) : null,
    },
  };
}

module.exports = { compute, GROUPS, TARGETS, ALGORITHMS };
