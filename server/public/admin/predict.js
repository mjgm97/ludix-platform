/* =============================================================================
 * Ludix Analytics — Predictive analytics + SHAP renderer
 * -----------------------------------------------------------------------------
 * Self-contained view for the "Prediction" tab. Trains a gradient-boosted tree
 * model server-side to estimate a selectable target (score / stars / session
 * length / pass-fail) from a run's behaviour features, then EXPLAINS it with
 * SHAP: global importance, a SHAP summary (beeswarm), and a local per-instance
 * waterfall. Plots are hand-rolled inline SVG (no CDN), matching tna.js.
 *
 * app.js fetches /games/:id/predict and calls
 *   window.SuitePredict.render(container, data, ctx)
 *   ctx = { dash: SuiteDash, state: <persisted view state>, reload(patch) }
 *
 * Model/feature/target changes go through `reload` (server retrains); picking a
 * local instance or sorting a table is display-only and redraws in place.
 * ========================================================================== */
(function () {
  "use strict";

  var GROUPS = [
    ["volume", "Volume", "event count & distinct types"],
    ["timing", "Timing", "duration & events/min"],
    ["structure", "Structure", "transitions & self-loops"],
    ["eventmix", "Event mix", "per-type event shares"],
    ["context", "Context", "level & player history"],
  ];
  var TARGETS = [["score", "Score"], ["stars", "Stars"], ["sessionLen", "Session length"], ["pass", "Pass / fail"]];

  // Diverging colour for the beeswarm: low feature value → blue, high → red.
  function lowHigh(t) {
    t = Math.max(0, Math.min(1, t));
    var lo = [90, 169, 255], hi = [255, 107, 107];
    var r = Math.round(lo[0] + (hi[0] - lo[0]) * t), g = Math.round(lo[1] + (hi[1] - lo[1]) * t), b = Math.round(lo[2] + (hi[2] - lo[2]) * t);
    return "rgb(" + r + "," + g + "," + b + ")";
  }

  function render(container, data, ctx) {
    var D = ctx.dash, esc = D.esc, fmt = D.fmt, pct = D.pct, dec = D.dec, COL = D.COL;
    var st = ctx.state;
    if (st.features == null) st.features = ["volume", "timing", "structure", "eventmix", "context"];

    function prettyFeat(name) {
      if (name.indexOf("share:") === 0) return String(name.slice(6)).replace(/[_\-]+/g, " ") + " %";
      var map = { eventCount: "event count", distinctTypes: "distinct types", durationMin: "duration (min)", eventsPerMin: "events / min", selfLoopRate: "self-loop rate", priorRuns: "prior runs", priorAvgScore: "prior avg score", level: "level" };
      return map[name] || String(name).replace(/[_\-]+/g, " ");
    }
    // Target value formatting: pass = probability, sessionLen = minutes, else raw.
    function fmtY(v) {
      if (v == null || isNaN(v)) return "—";
      if (data.classify) return pct(v, 1);
      if (data.target === "score") return pct(v, 1);
      if (data.target === "sessionLen") return dec(v, 1) + "m";
      return dec(v, 2);
    }

    // ---- Controls -----------------------------------------------------------
    var html = "";
    html += '<div class="card tna-controls">';
    html += '<div class="tna-ctl"><label>Target</label><div class="seg sm" id="pTarget">' +
      TARGETS.map(function (t) {
        var ok = data.availableTargets ? data.availableTargets[t[0]] : true;
        return '<button class="chip' + (data.target === t[0] ? " active" : "") + '"' + (ok ? "" : " disabled title=\"no data for this target\"") + ' data-t="' + t[0] + '">' + esc(t[1]) + "</button>";
      }).join("") + "</div></div>";
    html += '<div class="tna-ctl" id="pThrCtl" style="' + (data.classify ? "" : "display:none") + '"><label>Pass threshold <b id="pThrVal">' + pct(data.threshold) + '</b></label>' +
      '<input type="range" id="pThr" min="0.1" max="0.9" step="0.05" value="' + data.threshold + '"></div>';
    html += '<div class="tna-ctl" style="flex:1 1 260px"><label>Feature groups</label><div class="pred-groups" id="pGroups">' +
      GROUPS.map(function (g) {
        var on = st.features.indexOf(g[0]) >= 0;
        var dis = (data.target === "sessionLen" && g[0] === "timing");
        return '<label class="pred-chk' + (dis ? " off" : "") + '" title="' + esc(g[2]) + (dis ? " — excluded (label source)" : "") + '"><input type="checkbox"' + (on && !dis ? " checked" : "") + (dis ? " disabled" : "") + ' data-g="' + g[0] + '"><span>' + esc(g[1]) + "</span></label>";
      }).join("") + "</div></div>";
    html += "</div>";

    // ---- Model hyperparameters + train -------------------------------------
    var mdl = data.model || { estimators: 150, learningRate: 0.1, maxDepth: 3 };
    html += '<div class="card tna-controls" style="margin-top:-6px">' +
      '<div class="tna-ctl"><label>Trees</label><input type="number" id="pEst" min="20" max="400" step="10" value="' + mdl.estimators + '" style="width:84px"></div>' +
      '<div class="tna-ctl"><label>Learning rate</label><input type="number" id="pLr" min="0.01" max="1" step="0.01" value="' + mdl.learningRate + '" style="width:84px"></div>' +
      '<div class="tna-ctl"><label>Max depth</label><input type="number" id="pDepth" min="1" max="6" step="1" value="' + mdl.maxDepth + '" style="width:84px"></div>' +
      '<div class="tna-ctl push"><label>&nbsp;</label><button class="btn sm" id="pTrain">Retrain</button></div>' +
      "</div>";

    // Large-event-volume warning: the events read was capped, so some runs lost
    // their behaviour features and the model saw only a (session-id-ordered)
    // slice. Mirrors the /tna banner. Shown on both the error and success paths.
    var truncWarn = (data.truncated || (data.meta && data.meta.truncated))
      ? '<div class="card" style="padding:12px 16px;border-color:#5c4a2b;background:#2a230f"><span class="small" style="color:#e6c98e">⚠ Large event volume — the model was trained from the most recent slice of events, so some runs were dropped or partially featured. Narrow the date range for a complete, unbiased fit.</span></div>'
      : "";

    if (data.error === "not_enough_data") {
      var haveTxt = data.totalRuns ? " (have " + fmt(data.totalRuns) + " runs" + (data.usableRuns != null ? ", " + fmt(data.usableRuns) + " with behaviour features" : "") + "; need ≥ 12)" : "";
      container.innerHTML = html + truncWarn + '<div class="empty">Not enough runs to train a model' + haveTxt + '.<br><span class="small">Widen the date range, clear the player filter, or enable more feature groups.</span></div>';
      wireControls(container, data, ctx, st);
      return;
    }

    var M = data.metrics || {}, B = data.baseline || {}, meta = data.meta || {};

    // ---- Tiles --------------------------------------------------------------
    html += '<div class="tiles">';
    if (data.classify) {
      html += D.tile("Accuracy", M.accuracy == null ? "—" : pct(M.accuracy, 1)) +
        D.tile("AUC", M.auc == null ? "—" : dec(M.auc, 3)) +
        D.tile("Log-loss", M.logLoss == null ? "—" : dec(M.logLoss, 3)) +
        D.tile("Base rate", meta.posRate == null ? "—" : pct(meta.posRate, 0)) +
        D.tile("Runs", fmt(meta.n)) + D.tile("Features", fmt(meta.features));
    } else {
      html += D.tile("R²", M.r2 == null ? "—" : dec(M.r2, 3)) +
        D.tile("RMSE", M.rmse == null ? "—" : fmtY(M.rmse)) +
        D.tile("MAE", M.mae == null ? "—" : fmtY(M.mae)) +
        D.tile("Baseline R²", B.r2 == null ? "0.000" : dec(B.r2, 3)) +
        D.tile("Runs", fmt(meta.n)) + D.tile("Features", fmt(meta.features));
    }
    html += "</div>";

    html += '<div class="card" style="padding:11px 16px"><span class="small muted">' +
      'Gradient-boosted trees · ' + fmt(mdl.estimators) + ' trees · depth ' + mdl.maxDepth + ' · lr ' + mdl.learningRate +
      ' · trained on ' + fmt(meta.trainN) + ', tested on ' + fmt(meta.testN) + (meta.sampledFrom ? " (sampled from " + fmt(meta.sampledFrom) + ")" : "") +
      ' · explaining ' + fmt(data.instances.length) + ' runs with SHAP.</span></div>';

    html += truncWarn;

    // Degenerate single-class classification (nothing to learn).
    var flat = data.importance.every(function (f) { return f.meanAbsShap === 0; });
    if (flat) html += '<div class="card" style="padding:12px 16px;border-color:#5c4a2b;background:#2a230f"><span class="small" style="color:#e6c98e">⚠ The model found no usable signal in range — often one outcome dominates (base rate near 0% or 100%) or the runs are too few/uniform. SHAP values are all zero. Try a wider range, a different threshold, or more feature groups.</span></div>';

    // ---- Global SHAP importance --------------------------------------------
    html += '<div class="card"><div class="card-head"><h3>Global feature importance</h3><span class="pill">SHAP</span></div>' +
      '<p class="cap">Mean absolute SHAP value per feature — how much each moves the ' + esc(targetLabel(data.target)) + ' prediction on average. Colour shows the average <em>direction</em> (blue lowers, red raises the prediction). This is model-explaining, not raw correlation.</p>' +
      '<div id="pImp"></div></div>';

    // ---- SHAP summary (beeswarm) -------------------------------------------
    html += '<div class="card"><div class="card-head"><h3>SHAP summary</h3><span class="pill">' + fmt(data.instances.length) + ' runs</span></div>' +
      '<p class="cap">Each dot is one run. Position is that feature’s SHAP value (left = pushes the prediction down, right = up); colour is the feature value (low → high). Spread shows how strongly and in which direction a feature acts across runs.</p>' +
      '<div id="pBees"></div></div>';

    // ---- Local explanation --------------------------------------------------
    html += '<div class="grid2">';
    html += '<div class="card"><div class="card-head"><h3>Local explanation</h3><div class="seg sm" id="pExemplars">' +
      '<button class="chip" data-ex="highest">Highest</button><button class="chip" data-ex="typical">Typical</button><button class="chip" data-ex="lowest">Lowest</button></div></div>' +
      '<p class="cap">Why one run got its prediction. Bars add to the base value; red pushes up, blue pushes down. Pick a run on the right, or an exemplar above.</p>' +
      '<div id="pWaterfall"></div></div>';
    html += '<div class="card"><div class="card-head"><h3>Explained runs</h3><span class="pill">click a row</span></div>' +
      '<p class="cap">Predicted vs actual for each explained run. Click to see its breakdown.</p>' +
      '<div class="tbl-wrap" id="pInstances"></div></div>';
    html += "</div>";

    // ---- Diagnostics --------------------------------------------------------
    html += '<div class="card"><div class="card-head"><h3>Model diagnostics</h3><span class="pill">holdout</span></div>' +
      '<p class="cap">' + (data.classify ? "ROC curve and confusion matrix on the held-out runs the model never saw in training." : "Predicted vs actual on the held-out runs. Points on the dashed line are perfect; tighter to the line is better.") + '</p>' +
      '<div id="pDiag"></div></div>';

    container.innerHTML = html;

    // =======================================================================
    // PLOTS
    // =======================================================================
    var SVGNS = "http://www.w3.org/2000/svg";
    function targetLabel(t) { for (var i = 0; i < TARGETS.length; i++) if (TARGETS[i][0] === t) return TARGETS[i][1].toLowerCase(); return t; }

    // ---- Global importance (signed horizontal bars) ------------------------
    (function drawImportance() {
      var mount = container.querySelector("#pImp");
      var items = data.importance.slice(0, 14).filter(function (f) { return f.meanAbsShap > 0; });
      if (!items.length) { mount.innerHTML = '<p class="muted small">No non-zero importances.</p>'; return; }
      var max = items[0].meanAbsShap || 1;
      mount.innerHTML = '<div class="pred-hbars">' + items.map(function (f) {
        var col = f.meanSignedShap >= 0 ? COL.red : COL.blue, w = Math.max(2, f.meanAbsShap / max * 100);
        return '<div class="tna-hbar" title="' + esc(prettyFeat(f.feature)) + ' · mean|SHAP| ' + dec(f.meanAbsShap, 4) + ' · direction ' + (f.meanSignedShap >= 0 ? "+" : "") + dec(f.meanSignedShap, 4) + '">' +
          '<div class="hb-name" style="color:' + col + '">' + esc(prettyFeat(f.feature)) + "</div>" +
          '<div class="hb-track"><i style="width:' + w.toFixed(1) + "%;background:" + col + '"></i></div>' +
          '<div class="hb-val">' + dec(f.meanAbsShap, 4) + "</div></div>";
      }).join("") + "</div>";
    })();

    // ---- Beeswarm ----------------------------------------------------------
    (function drawBeeswarm() {
      var mount = container.querySelector("#pBees");
      var order = data.importance.slice(0, 12).filter(function (f) { return f.meanAbsShap > 0; });
      if (!order.length) { mount.innerHTML = '<p class="muted small">No SHAP spread to show.</p>'; return; }
      var nameIx = {}; data.featNames.forEach(function (n, i) { nameIx[n] = i; });
      var maxAbs = 0;
      order.forEach(function (f) { (data.beeswarm[nameIx[f.feature]] || []).forEach(function (p) { if (Math.abs(p.shap) > maxAbs) maxAbs = Math.abs(p.shap); }); });
      maxAbs = maxAbs || 1;
      var W = 760, rowH = 30, padL = 140, padR = 46, padT = 8, padB = 22, H = padT + order.length * rowH + padB;
      var cx = padL + (W - padL - padR) / 2, halfW = (W - padL - padR) / 2;
      var s = '<svg viewBox="0 0 ' + W + " " + H + '" class="tna-seqsvg" preserveAspectRatio="xMinYMin meet">';
      s += '<line x1="' + cx + '" y1="' + padT + '" x2="' + cx + '" y2="' + (H - padB) + '" stroke="' + COL.line + '"/>';
      order.forEach(function (f, ri) {
        var y0 = padT + ri * rowH, yc = y0 + rowH / 2;
        var pts = data.beeswarm[nameIx[f.feature]] || [];
        s += '<text x="' + (padL - 8) + '" y="' + (yc + 3) + '" text-anchor="end" class="tna-elabel" style="fill:var(--muted)">' + esc(prettyFeat(f.feature)) + "</text>";
        // Vertical jitter buckets so overlapping dots fan out (deterministic).
        var buckets = {};
        pts.forEach(function (p) {
          var x = cx + (p.shap / maxAbs) * halfW;
          var key = Math.round(x / 5);
          var k = (buckets[key] = (buckets[key] || 0) + 1);
          var jitter = ((k % 7) - 3) * 2.2;
          s += '<circle cx="' + x.toFixed(1) + '" cy="' + (yc + jitter).toFixed(1) + '" r="2.7" fill="' + lowHigh(p.valueNorm) + '" opacity="0.82"><title>SHAP ' + dec(p.shap, 4) + "</title></circle>";
        });
      });
      s += '<text x="' + padL + '" y="' + (H - 6) + '" class="tna-elabel" style="fill:var(--muted)">−' + dec(maxAbs, 3) + "</text>";
      s += '<text x="' + (W - padR) + '" y="' + (H - 6) + '" text-anchor="end" class="tna-elabel" style="fill:var(--muted)">+' + dec(maxAbs, 3) + "</text>";
      s += '<text x="' + cx + '" y="' + (H - 6) + '" text-anchor="middle" class="tna-elabel" style="fill:var(--muted)">SHAP value →</text>';
      s += "</svg>";
      s += '<div class="pred-legend small muted"><span><i style="background:' + lowHigh(0) + '"></i>low value</span><span><i style="background:' + lowHigh(1) + '"></i>high value</span></div>';
      mount.innerHTML = s;
    })();

    // ---- Local waterfall (redrawable) --------------------------------------
    var selected = data.exemplars ? data.exemplars.typical : 0;
    function drawWaterfall(ix) {
      var mount = container.querySelector("#pWaterfall");
      var inst = data.instances[ix];
      if (!inst) { mount.innerHTML = '<p class="muted small">No run selected.</p>'; return; }
      // Top contributions by |φ|; the rest fold into "other features".
      var contrib = inst.phi.map(function (p, j) { return { name: data.featNames[j], phi: p, value: inst.values[j] }; })
        .sort(function (a, b) { return Math.abs(b.phi) - Math.abs(a.phi); });
      var TOP = 9, shown = contrib.slice(0, TOP), rest = contrib.slice(TOP);
      var otherPhi = rest.reduce(function (a, c) { return a + c.phi; }, 0);
      if (rest.length) shown.push({ name: "+ " + rest.length + " other features", phi: otherPhi, value: null, other: true });

      var base = data.baseValue, run = base;
      var steps = shown.map(function (c) { var from = run; run += c.phi; return { c: c, from: from, to: run }; });
      var lo = base, hi = base; steps.forEach(function (s2) { lo = Math.min(lo, s2.from, s2.to); hi = Math.max(hi, s2.from, s2.to); });
      var span = (hi - lo) || 1;
      var W = 520, rowH = 26, padL = 150, padR = 60, padT = 30, padB = 26, H = padT + (steps.length + 1) * rowH + padB;
      var X = function (v) { return padL + (v - lo) / span * (W - padL - padR); };
      var s = '<svg viewBox="0 0 ' + W + " " + H + '" class="tna-seqsvg" preserveAspectRatio="xMinYMin meet">';
      s += '<text x="' + padL + '" y="16" class="tna-elabel" style="fill:var(--muted)">base ' + fmtVal(base) + '</text>';
      s += '<line x1="' + X(base).toFixed(1) + '" y1="' + padT + '" x2="' + X(base).toFixed(1) + '" y2="' + (H - padB) + '" stroke="' + COL.muted + '" stroke-dasharray="3 3" opacity="0.5"/>';
      steps.forEach(function (s2, i) {
        var y = padT + i * rowH + 4, up = s2.c.phi >= 0, col = up ? COL.red : COL.blue;
        var x1 = X(s2.from), x2 = X(s2.to), x = Math.min(x1, x2), w = Math.max(1.5, Math.abs(x2 - x1));
        s += '<rect x="' + x.toFixed(1) + '" y="' + y + '" width="' + w.toFixed(1) + '" height="' + (rowH - 9) + '" fill="' + col + '" rx="2" opacity="0.9"><title>' + esc(prettyFeat(s2.c.name)) + " " + (up ? "+" : "") + dec(s2.c.phi, 4) + "</title></rect>";
        var lab = prettyFeat(s2.c.name) + (s2.c.other ? "" : " = " + fmtFeatVal(s2.c.value));
        s += '<text x="' + (padL - 8) + '" y="' + (y + rowH - 12) + '" text-anchor="end" class="tna-elabel" style="fill:var(--muted)">' + esc(lab) + "</text>";
        s += '<text x="' + (X(Math.max(s2.from, s2.to)) + 5).toFixed(1) + '" y="' + (y + rowH - 12) + '" class="tna-elabel" style="fill:' + col + '">' + (up ? "+" : "") + dec(s2.c.phi, 3) + "</text>";
      });
      var yf = padT + steps.length * rowH + 4;
      s += '<line x1="' + X(inst.margin).toFixed(1) + '" y1="' + padT + '" x2="' + X(inst.margin).toFixed(1) + '" y2="' + (yf + rowH - 6) + '" stroke="' + COL.gold + '" stroke-width="1.5"/>';
      s += '<text x="' + (padL - 8) + '" y="' + (yf + rowH - 12) + '" text-anchor="end" class="tna-elabel" style="fill:var(--ink)">prediction</text>';
      s += '<text x="' + (X(inst.margin) + 5).toFixed(1) + '" y="' + (yf + rowH - 12) + '" class="tna-elabel" style="fill:var(--gold)">' + fmtVal(inst.margin) + "</text>";
      s += "</svg>";
      var err = inst.predicted - inst.actual;
      s += '<div class="pred-wf-foot small"><b>' + esc(inst.username) + "</b>" + (inst.level != null && inst.level !== "" ? " · level " + esc(String(inst.level)) : "") +
        ' · predicted <b>' + fmtY(inst.predicted) + "</b> · actual <b>" + fmtY(inst.actual) + "</b> · error " + (err >= 0 ? "+" : "") + fmtY(Math.abs(err)) + "</div>";
      mount.innerHTML = s;
      // Reflect selection in the table.
      [].forEach.call(container.querySelectorAll("#pInstances tr[data-i]"), function (tr) { tr.classList.toggle("sel", +tr.getAttribute("data-i") === ix); });
    }
    // In classification the waterfall runs in log-odds (margin) space; show the
    // margin numerically but keep the header in probability via fmtY.
    function fmtVal(v) { return data.classify ? dec(v, 2) : fmtY(v); }
    function fmtFeatVal(v) { if (v == null) return ""; return Math.abs(v) >= 100 || v === Math.round(v) ? fmt(v) : dec(v, 3); }

    // ---- Instance table (sortable, clickable) ------------------------------
    var instSort = { key: "predicted", dir: -1 };
    function drawInstances() {
      var mount = container.querySelector("#pInstances");
      var rows = data.instances.map(function (r, i) { return { i: i, username: r.username, actual: r.actual, predicted: r.predicted, err: Math.abs(r.predicted - r.actual) }; });
      rows.sort(function (a, b) { var k = instSort.key, x = a[k], y = b[k]; if (k === "username") { x = String(x); y = String(y); return (x < y ? -1 : x > y ? 1 : 0) * instSort.dir; } return ((x || 0) - (y || 0)) * instSort.dir; });
      var cols = [["username", "Run", 0], ["actual", "Actual", 1], ["predicted", "Predicted", 1], ["err", "|err|", 1]];
      var h = "<table><thead><tr>" + cols.map(function (c) { return '<th class="' + (c[2] ? "num " : "") + '" data-k="' + c[0] + '">' + c[1] + (instSort.key === c[0] ? (instSort.dir < 0 ? " ▾" : " ▴") : "") + "</th>"; }).join("") + "</tr></thead><tbody>" +
        rows.map(function (r) { return '<tr class="clickable" data-i="' + r.i + '"><td>' + esc(r.username) + '</td><td class="num">' + fmtY(r.actual) + '</td><td class="num">' + fmtY(r.predicted) + '</td><td class="num">' + fmtY(r.err) + "</td></tr>"; }).join("") +
        "</tbody></table>";
      mount.innerHTML = h;
      [].forEach.call(mount.querySelectorAll("th[data-k]"), function (th) {
        th.addEventListener("click", function () { var k = th.getAttribute("data-k"); if (instSort.key === k) instSort.dir *= -1; else { instSort.key = k; instSort.dir = k === "username" ? 1 : -1; } drawInstances(); });
      });
      [].forEach.call(mount.querySelectorAll("tr[data-i]"), function (tr) {
        tr.addEventListener("click", function () { selected = +tr.getAttribute("data-i"); drawWaterfall(selected); });
      });
      [].forEach.call(mount.querySelectorAll("tr[data-i]"), function (tr) { tr.classList.toggle("sel", +tr.getAttribute("data-i") === selected); });
    }

    // ---- Diagnostics -------------------------------------------------------
    (function drawDiagnostics() {
      var mount = container.querySelector("#pDiag");
      if (data.classify) {
        var roc = M.roc || [], cm = M.confusion || { tp: 0, tn: 0, fp: 0, fn: 0 };
        var S = 260, pad = 34;
        var s = '<div class="grid2"><div><svg viewBox="0 0 ' + S + " " + S + '" class="tna-seqsvg" preserveAspectRatio="xMidYMid meet">';
        s += '<line x1="' + pad + '" y1="' + (S - pad) + '" x2="' + (S - 8) + '" y2="' + (S - pad) + '" stroke="' + COL.line + '"/><line x1="' + pad + '" y1="' + (S - pad) + '" x2="' + pad + '" y2="8" stroke="' + COL.line + '"/>';
        s += '<line x1="' + pad + '" y1="' + (S - pad) + '" x2="' + (S - 8) + '" y2="8" stroke="' + COL.muted + '" stroke-dasharray="3 3" opacity="0.5"/>';
        var PX = function (v) { return pad + v * (S - pad - 8); }, PY = function (v) { return (S - pad) - v * (S - pad - 8); };
        var d = roc.map(function (p, i) { return (i ? "L" : "M") + PX(p.fpr).toFixed(1) + " " + PY(p.tpr).toFixed(1); }).join(" ");
        s += '<path d="' + d + '" fill="none" stroke="' + COL.gold + '" stroke-width="2"/>';
        s += '<text x="' + (S / 2) + '" y="' + (S - 6) + '" text-anchor="middle" class="tna-elabel" style="fill:var(--muted)">FPR</text>';
        s += '<text x="10" y="' + (S / 2) + '" text-anchor="middle" class="tna-elabel" style="fill:var(--muted)" transform="rotate(-90 10 ' + (S / 2) + ')">TPR</text>';
        s += '<text x="' + (S - 10) + '" y="18" text-anchor="end" class="tna-elabel" style="fill:var(--ink)">AUC ' + (M.auc == null ? "—" : dec(M.auc, 3)) + "</text></svg></div>";
        var cell = function (label, v, col) { return '<div class="pred-cm-cell" style="border-color:' + col + '"><div class="small muted">' + label + '</div><div class="pred-cm-v">' + fmt(v) + "</div></div>"; };
        s += '<div><div class="pred-cm">' + cell("True +", cm.tp, COL.green) + cell("False +", cm.fp, COL.red) + cell("False −", cm.fn, COL.red) + cell("True −", cm.tn, COL.green) + "</div></div>";
        s += "</div>";
        mount.innerHTML = s;
      } else {
        var pts = M.scatter || [];
        if (!pts.length) { mount.innerHTML = '<p class="muted small">No holdout points to plot.</p>'; return; }
        var lo = Infinity, hi = -Infinity; pts.forEach(function (p) { lo = Math.min(lo, p.actual, p.predicted); hi = Math.max(hi, p.actual, p.predicted); });
        if (!(hi > lo)) { hi = lo + 1; }
        var W = 420, H = 300, pad2 = 40, span = hi - lo;
        var X = function (v) { return pad2 + (v - lo) / span * (W - pad2 - 12); }, Y = function (v) { return (H - pad2) - (v - lo) / span * (H - pad2 - 12); };
        var s2 = '<svg viewBox="0 0 ' + W + " " + H + '" class="tna-seqsvg" preserveAspectRatio="xMidYMid meet">';
        s2 += '<line x1="' + X(lo) + '" y1="' + Y(lo) + '" x2="' + X(hi) + '" y2="' + Y(hi) + '" stroke="' + COL.muted + '" stroke-dasharray="4 4" opacity="0.6"/>';
        s2 += '<line x1="' + pad2 + '" y1="' + (H - pad2) + '" x2="' + (W - 12) + '" y2="' + (H - pad2) + '" stroke="' + COL.line + '"/><line x1="' + pad2 + '" y1="' + (H - pad2) + '" x2="' + pad2 + '" y2="12" stroke="' + COL.line + '"/>';
        pts.forEach(function (p) { s2 += '<circle cx="' + X(p.predicted).toFixed(1) + '" cy="' + Y(p.actual).toFixed(1) + '" r="3.2" fill="' + COL.blue + '" opacity="0.7"><title>pred ' + fmtY(p.predicted) + " · actual " + fmtY(p.actual) + "</title></circle>"; });
        s2 += '<text x="' + (W / 2) + '" y="' + (H - 6) + '" text-anchor="middle" class="tna-elabel" style="fill:var(--muted)">predicted →</text>';
        s2 += '<text x="12" y="' + (H / 2) + '" text-anchor="middle" class="tna-elabel" style="fill:var(--muted)" transform="rotate(-90 12 ' + (H / 2) + ')">actual →</text>';
        s2 += "</svg>";
        mount.innerHTML = s2;
      }
    })();

    // Initial local views.
    drawInstances();
    drawWaterfall(selected);

    // ---- Exemplar buttons ---------------------------------------------------
    [].forEach.call(container.querySelectorAll("#pExemplars [data-ex]"), function (b) {
      b.addEventListener("click", function () {
        if (!data.exemplars) return;
        selected = data.exemplars[b.getAttribute("data-ex")];
        drawWaterfall(selected);
        var row = container.querySelector('#pInstances tr[data-i="' + selected + '"]'); if (row) row.scrollIntoView({ block: "nearest" });
      });
    });

    wireControls(container, data, ctx, st);
  }

  // Controls that retrain the model go through ctx.reload (server recompute).
  function wireControls(container, data, ctx, st) {
    var tSeg = container.querySelector("#pTarget");
    if (tSeg) [].forEach.call(tSeg.querySelectorAll("[data-t]"), function (b) {
      b.addEventListener("click", function () { if (b.disabled || b.getAttribute("data-t") === data.target) return; ctx.reload({ target: b.getAttribute("data-t") }); });
    });
    var thr = container.querySelector("#pThr");
    if (thr) thr.addEventListener("change", function () { ctx.reload({ threshold: parseFloat(thr.value) }); });
    var grp = container.querySelector("#pGroups");
    if (grp) [].forEach.call(grp.querySelectorAll("[data-g]"), function (chk) {
      chk.addEventListener("change", function () {
        var g = chk.getAttribute("data-g"), cur = st.features.slice(), i = cur.indexOf(g);
        if (chk.checked && i < 0) cur.push(g); else if (!chk.checked && i >= 0) cur.splice(i, 1);
        if (!cur.length) { chk.checked = true; return; }        // keep at least one group
        st.features = cur; ctx.reload({ features: cur });
      });
    });
    var train = container.querySelector("#pTrain");
    if (train) train.addEventListener("click", function () {
      ctx.reload({
        estimators: parseInt(container.querySelector("#pEst").value, 10) || 150,
        learningRate: parseFloat(container.querySelector("#pLr").value) || 0.1,
        maxDepth: parseInt(container.querySelector("#pDepth").value, 10) || 3,
      });
    });
  }

  window.SuitePredict = { render: render };
})();
