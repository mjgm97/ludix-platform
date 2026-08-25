/* =============================================================================
 * Ludix Analytics — Transition Network Analysis (TNA) renderer
 * -----------------------------------------------------------------------------
 * Self-contained view for the "Network" tab. Draws the transition network as an
 * interactive circular node-link graph (hand-rolled inline SVG, no CDN), plus
 * node/edge centralities, initial-state probabilities, a sequence index plot,
 * and bootstrap edge validation. app.js fetches /games/:id/tna and calls
 * window.SuiteTNA.render(container, data, ctx).
 *
 *   ctx = { dash: SuiteDash, state: <persisted view state>, reload(patch) }
 *
 * `reload` re-fetches from the server (weight mode / validation change what the
 * server computes); display-only tweaks (edge threshold, labels, table sort)
 * redraw locally without a round-trip.
 * ========================================================================== */
(function () {
  "use strict";

  var PALETTE = ["#ff6b6b", "#5aa9ff", "#4ad6a0", "#b18aff", "#ff9f43", "#f78fb3", "#ffd54a", "#63d3c4", "#8ad36b", "#e779c1", "#7c9cff", "#ffa8a8", "#9d7bff", "#ff7eb6"];

  function render(container, data, ctx) {
    var D = ctx.dash, esc = D.esc, fmt = D.fmt, pct = D.pct, dec = D.dec, COL = D.COL;
    var st = ctx.state;
    if (st.labels == null) st.labels = true;   // show edge weights by default (matches the reference style)

    // Stable colour per state, assigned by frequency (most frequent first) so
    // the same activity keeps its colour across the graph, legend and index plot.
    var order = data.nodes.map(function (n) { return n.id; });
    var colorOf = {}; order.forEach(function (id, i) { colorOf[id] = PALETTE[i % PALETTE.length]; });
    var nodeById = {}; data.nodes.forEach(function (n) { nodeById[n.id] = n; });
    function ink(hex) { var h = hex.replace("#", ""); if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16); return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62 ? "#0b1120" : "#fff"; }
    function pretty(t) { return String(t).replace(/[_\-]+/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }
    function chip(id, sm) { var c = colorOf[id] || COL.muted; return '<span class="tna-chip' + (sm ? " sm" : "") + '" style="background:' + c + ';color:' + ink(c) + '">' + esc(pretty(id)) + "</span>"; }

    // Shared bits for the graph/table views below.
    var EDGE_POS = "#3fa86a", EDGE_NEG = "#d0544e";   // signed diff edge colours (over/under in cohort A)
    var CLIQUE_TOP = 10;   // how many top cliques (per size) to surface
    var STAB_COLORS = ["#5aa9ff", "#ff6b6b", "#4ad6a0", "#ffd54a", "#b18aff"];   // stability line per measure
    function stabColor(measures, m) { var i = measures.indexOf(m); return STAB_COLORS[(i < 0 ? 0 : i) % STAB_COLORS.length]; }
    function starOf(p) { return p == null ? "" : (p <= 0.001 ? "***" : p <= 0.01 ? "**" : p <= 0.05 ? "*" : ""); }
    function fmtSigned(v, d) { var neg = v < 0; return (neg ? "-" : "") + Math.abs(v).toFixed(d).replace(/^0(?=\.)/, ""); }
    // A little Graph|Table segmented control (wired by wireViewToggle).
    function viewSeg(active) { return '<div class="seg sm tna-viewseg"><button class="chip' + (active !== "table" ? " active" : "") + '" data-view="graph">Graph</button><button class="chip' + (active === "table" ? " active" : "") + '" data-view="table">Table</button></div>'; }
    function wireViewToggle(root, cur, onChange) {
      var seg = root.querySelector(".tna-viewseg"); if (!seg) return;
      [].forEach.call(seg.querySelectorAll("[data-view]"), function (b) {
        b.addEventListener("click", function () {
          var v = b.getAttribute("data-view"); if (v === cur()) return;
          [].forEach.call(seg.querySelectorAll("[data-view]"), function (x) { x.classList.toggle("active", x === b); });
          onChange(v);
        });
      });
    }

    if (!data.stats.sessions || !data.nodes.length) {
      container.innerHTML = '<div class="empty">No sessions in this range to build a transition network.<br><span class="small">TNA needs event sequences — widen the date range or clear the player filter.</span></div>';
      return;
    }

    var S = data.stats;
    var html = "";

    // ---- Controls -----------------------------------------------------------
    html += '<div class="card tna-controls">';
    html += '<div class="tna-ctl"><label>Edge weight</label><div class="seg sm" id="tnaWeight">' +
      '<button class="chip' + (data.weightMode === "probability" ? " active" : "") + '" data-w="probability">Probability</button>' +
      '<button class="chip' + (data.weightMode === "frequency" ? " active" : "") + '" data-w="frequency">Frequency</button></div></div>';
    html += '<div class="tna-ctl"><label>Min transition probability <b id="tnaThrVal">' + pct(st.minWeight || 0) + '</b></label>' +
      '<input type="range" id="tnaThr" min="0" max="0.9" step="0.02" value="' + (st.minWeight || 0) + '"></div>';
    html += '<div class="tna-ctl"><label>Edge labels</label><label class="tna-switch"><input type="checkbox" id="tnaLabels"' + (st.labels ? " checked" : "") + '><span>Show</span></label></div>';
    html += '<div class="tna-ctl push"><label>Validation &amp; diagnostics</label><div class="tna-valctl">' +
      '<input type="number" id="tnaIter" min="50" max="2000" step="50" value="' + (st.iter || 300) + '" title="resampling iterations">' +
      '<button class="btn sm' + (st.bootstrap ? " ghost" : "") + '" id="tnaBoot" title="Bootstrap edge stability + Markov-order test + case-drop centrality stability">' + (st.bootstrap ? "Re-run" : "Run validation") + '</button></div></div>';
    html += "</div>";

    // ---- Tiles --------------------------------------------------------------
    html += '<div class="tiles">' +
      D.tile("Sessions", fmt(S.sessions)) +
      D.tile("States", fmt(S.states)) +
      D.tile("Transitions", fmt(S.transitions)) +
      D.tile("Distinct edges", fmt(S.distinctTransitions)) +
      D.tile("Self-loops", S.transitions ? pct(S.selfLoops / S.transitions) : "—") +
      D.tile("Density", S.states > 1 ? pct(S.distinctTransitions / (S.states * S.states)) : "—") + "</div>";

    if (S.truncated) html += '<div class="card" style="padding:12px 16px;border-color:#5c4a2b;background:#2a230f"><span class="small" style="color:#e6c98e">⚠ Large event volume — the network was built from the most recent slice. Narrow the date range for exact results.</span></div>';

    // ---- Network graph ------------------------------------------------------
    html += '<div class="card"><h3>Transition network</h3><p class="cap">Nodes are activities; the ring around a node is the share of sessions that <em>start</em> there. A directed edge A→B is the probability of going to B right after A (thickness ∝ weight). Drag nodes to rearrange; hover one to isolate its transitions.</p>' +
      '<div id="tnaNet"></div></div>';

    // ---- Validation & diagnostics (bootstrap · Markov order · stability) -----
    // Sits directly under the network it validates.
    html += '<div id="tnaValidation">' + diagnosticsHTML(data) + "</div>";

    // ---- Activity frequency (descriptives) ---------------------------------
    html += '<div class="card"><div class="card-head"><h3>Activity frequency</h3><span class="pill">' + data.nodes.length + ' activities</span></div>' +
      '<p class="cap">How often each activity occurs across every session in range. Colours match the network nodes.</p>' +
      '<div id="tnaFreq"></div></div>';

    // ---- Centrality + initial ----------------------------------------------
    html += '<div class="grid2">';
    html += '<div class="card"><div class="card-head"><h3>Centrality</h3><span class="pill">' + data.centrality.length + ' states</span></div>' +
      '<p class="cap">How central each activity is in the transition structure. Click a column to sort.</p>' +
      '<div class="tbl-wrap" id="tnaCent"></div></div>';
    html += D.card("Initial probabilities", "Where sessions begin — the share of sessions whose first activity is each state.",
      D.hBars(data.initial.map(function (r) { return { label: pretty(r.state), value: Math.round(r.probability * 1000) / 10, color: colorOf[r.state] }; }), { labelW: 150 }));
    html += "</div>";

    // ---- Centrality comparison (bar chart, one measure at a time) ------------
    // Complements the table: pick a single ladyna centrality measure and compare
    // it across every state as ranked bars (colours match the network).
    var CENT_MEASURES = [
      ["outStrength", "Out-strength", 2], ["inStrength", "In-strength", 2],
      ["betweenness", "Betweenness", 2], ["betweennessRSP", "Betweenness (RSP)", 2],
      ["closeness", "Closeness", 3], ["closenessIn", "Closeness (in)", 3], ["closenessOut", "Closeness (out)", 3],
      ["pageRank", "PageRank", 3], ["diffusion", "Diffusion", 2], ["clustering", "Clustering", 3],
    ];
    var centMeasureOpts = CENT_MEASURES.map(function (m) { return '<option value="' + m[0] + '"' + (m[0] === (st.centMeasure || "betweenness") ? " selected" : "") + ">" + esc(m[1]) + "</option>"; }).join("");
    html += '<div class="card"><div class="card-head"><h3>Centrality comparison</h3>' +
      '<span class="spacer"></span><label class="small muted" style="display:flex;align-items:center;gap:8px">Measure' +
      '<select class="usel" id="tnaCentMeasure">' + centMeasureOpts + "</select></label></div>" +
      '<p class="cap">The selected centrality measure across every state, ranked — a direct side-by-side comparison to complement the table above. Colours match the network; hover a bar to isolate that activity’s transitions.</p>' +
      '<div id="tnaCentBars"></div></div>';

    // ---- Sequence index plot (paginated) ------------------------------------
    html += '<div class="card"><div class="card-head"><h3>Sequence index plot</h3><span class="pill">' + fmt(data.sequencesTotal) + " sessions</span></div>" +
      '<p class="cap">Each row is one session; each cell is the activity at that ordinal step. Reads left→right in play order (first ' + data.seqLenCap + " steps). Page through every session with the controls below.</p>" +
      '<div id="tnaSeq" class="tna-seq-wrap"></div>' +
      '<div class="tna-seq-pager"><button class="btn sm ghost" id="tnaSeqPrev">← Prev</button>' +
      '<span class="small muted" id="tnaSeqRange"></span>' +
      '<button class="btn sm ghost" id="tnaSeqNext">Next →</button></div></div>';

    // ---- Cliques (shown before clustering) ----------------------------------
    var CLIQUE_SIZES = [[3, "Triangles"], [4, "4-cliques"], [5, "5-cliques"]];
    html += '<div class="card"><div class="card-head"><h3>State cliques</h3><span class="pill">tight routines</span></div>' +
      '<p class="cap">Groups of states that all transition into one another in <b>both</b> directions (mutual edges) — tightly-interlocked routines students loop through. Ranked by internal transition strength; the top ' + CLIQUE_TOP + ' are shown.</p>' +
      '<div class="tna-controls" style="padding:2px 0 10px">' +
      '<div class="tna-ctl"><label>Clique size</label><div class="seg sm" id="tnaCliqueSize">' +
      CLIQUE_SIZES.map(function (o) { return '<button class="chip' + (o[0] === (st.cliqueSize || 3) ? " active" : "") + '" data-size="' + o[0] + '">' + esc(o[1]) + "</button>"; }).join("") +
      "</div></div></div>" +
      '<div class="tna-view-head" id="tnaCliqueHead"><div class="small muted" id="tnaCliqueMeta"></div><div class="tna-view-actions">' + viewSeg(st.cliqueView) + "</div></div>" +
      '<div id="tnaCliques"></div></div>';

    // ---- Clustering ---------------------------------------------------------
    var selOpts = function (list, cur) { return list.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === cur ? " selected" : "") + ">" + esc(o[1]) + "</option>"; }).join(""); };
    var ALGOS = [["pam", "PAM (k-medoids)"], ["hierarchical", "Hierarchical"]];
    var DISS = [["hamming", "Hamming"], ["lv", "Levenshtein"], ["osa", "OSA"], ["dl", "Damerau–Levenshtein"], ["lcs", "LCS"], ["qgram", "q-gram"], ["jw", "Jaro–Winkler"]];
    var LINKS = [["average", "Average"], ["complete", "Complete"], ["ward.D2", "Ward.D2"], ["single", "Single"]];
    html += '<div class="card"><div class="card-head"><h3>Clustering</h3><span class="pill">group sessions</span></div>' +
      '<p class="cap">Group sessions by how students move through the game, then compare each cluster’s transition network and sequences. Clustering is done by <b>ladyna</b> on a validated sequence dissimilarity (edit-distance family) via PAM or an agglomerative linkage. Colours match the legend above.</p>' +
      '<div class="tna-controls" style="padding:2px 0 8px">' +
      '<div class="tna-ctl"><label>Algorithm</label><select class="usel" id="tnaAlgo">' + selOpts(ALGOS, st.clAlgo || "pam") + "</select></div>" +
      '<div class="tna-ctl" id="tnaDissCtl"><label>Dissimilarity</label><select class="usel" id="tnaDiss">' + selOpts(DISS, st.clDiss || "lv") + "</select></div>" +
      '<div class="tna-ctl" id="tnaLinkCtl"><label>Linkage</label><select class="usel" id="tnaLink">' + selOpts(LINKS, st.clLink || "average") + "</select></div>" +
      '<div class="tna-ctl"><label>Clusters (k)</label><input type="number" id="tnaK" min="2" max="8" step="1" value="' + (st.k || 3) + '" style="width:74px"></div>' +
      '<div class="tna-ctl"><label>&nbsp;</label><button class="btn sm" id="tnaClusterBtn">Run clustering</button></div>' +
      '<div class="tna-ctl push"><label>State labels</label><label class="tna-switch"><input type="checkbox" id="tnaClNodeLbl"' + (st.clNodeLabels !== false ? " checked" : "") + '><span>Show</span></label></div>' +
      '<div class="tna-ctl"><label>Edge labels</label><label class="tna-switch"><input type="checkbox" id="tnaClEdgeLbl"' + (st.clEdgeLabels !== false ? " checked" : "") + '><span>Show</span></label></div>' +
      '</div><div id="tnaClusters"></div></div>';

    // ---- Behaviour patterns → outcome --------------------------------------
    var OUTCOMES = [["score", "Score"], ["stars", "Stars"], ["pass", "Pass (median split)"]];
    html += '<div class="card"><div class="card-head"><h3>Behaviour patterns → outcome</h3><span class="pill">what predicts success</span></div>' +
      '<p class="cap">ladyna mines frequent sequential patterns and screens each for association with a run outcome. For Score/Stars the effect is the change in the outcome when the pattern is present (OLS); for Pass it is the log-odds (logistic). Adjusted p-values use Benjamini–Hochberg.</p>' +
      '<div class="tna-controls" style="padding:2px 0 8px">' +
      '<div class="tna-ctl"><label>Outcome</label><select class="usel" id="tnaPatOutcome">' + selOpts(OUTCOMES, st.patOutcome || "score") + "</select></div>" +
      '<div class="tna-ctl"><label>Min support</label><input type="number" id="tnaPatSupport" min="0.02" max="0.9" step="0.02" value="' + (st.patSupport || 0.1) + '" style="width:82px"></div>' +
      '<div class="tna-ctl"><label>&nbsp;</label><button class="btn sm" id="tnaPatBtn">Mine patterns</button></div>' +
      '</div><div id="tnaPatterns"></div></div>';

    // ---- Cohort comparison --------------------------------------------------
    var CMPBY = [["score", "Score"], ["stars", "Stars"]];
    html += '<div class="card"><div class="card-head"><h3>Cohort comparison</h3><span class="pill">high vs low</span></div>' +
      '<p class="cap">Splits sessions into two cohorts by a median split on an outcome, builds a transition network for each over a shared state set, and compares them edge-by-edge with a permutation test (ladyna). A significant edge is one whose transition probability differs between high and low performers.</p>' +
      '<div class="tna-controls" style="padding:2px 0 8px">' +
      '<div class="tna-ctl"><label>Split by</label><select class="usel" id="tnaCmpBy">' + selOpts(CMPBY, st.cmpGroupBy || "score") + "</select></div>" +
      '<div class="tna-ctl"><label>Iterations</label><input type="number" id="tnaCmpIter" min="100" max="2000" step="100" value="' + (st.cmpIter || 500) + '" style="width:90px"></div>' +
      '<div class="tna-ctl"><label>&nbsp;</label><button class="btn sm" id="tnaCmpBtn">Compare cohorts</button></div>' +
      '</div><div id="tnaCompare"></div></div>';

    container.innerHTML = html;
    if (D.flushCharts) D.flushCharts();   // mount any placeholder charts (e.g. Initial probabilities hBars)

    // =======================================================================
    // REUSABLE DRAW HELPERS (shared by the main view and the cluster cards)
    // =======================================================================

    // Warm gold shared by every edge, arrowhead, self-loop and initial-prob
    // arc — matches the reference "tna" look. Node discs keep the per-state
    // colour (colorOf) so an activity is identifiable everywhere.
    var EDGE_GOLD = "#c9a83f", RING_TRACK = "#2e3c5c";
    var SVGNS = "http://www.w3.org/2000/svg";
    function svgEl(name, attrs) { var e = document.createElementNS(SVGNS, name); if (attrs) for (var k in attrs) e.setAttribute(k, attrs[k]); return e; }
    // Edge label: transition count in frequency mode, else probability shown
    // ".63" style (leading zero dropped) like the reference.
    function edgeLabel(e, weightMode) { return weightMode === "frequency" ? String(e.count) : (Math.round(e.probability * 100) / 100).toFixed(2).replace(/^0(?=\.)/, ""); }

    // Build an interactive transition network into `mount` (real SVG DOM, so
    // nodes are draggable and edge geometry recomputes live). Uses the shared
    // colorOf. opts: { W, H, minWeight, edgeLabels, nodeLabels, rMin, rSpan,
    // edgeLabelMin, weightMode, posStore }. `posStore` (optional {id:{x,y}}) is
    // read for initial positions and written on drag, so display-only redraws
    // (threshold/label toggle) keep whatever the user has arranged.
    function buildNetwork(mount, nodes, edges, opts) {
      opts = opts || {};
      var W = opts.W || 820, H = opts.H || 520, M = nodes.length;
      // Uniform node radius (every state the same size, per the reference); it
      // only shrinks as the graph gets busier so labels/rings keep room.
      var big = Math.max(0.42, Math.min(1, 5 / Math.max(1, M)));
      var R = opts.nodeR != null ? opts.nodeR : 14 + 10 * big;
      var ringGap = 0, ringW = opts.ringW != null ? opts.ringW : (3.5 + 2 * big);   // ring hugs the disc — no gap
      // Edge magnitude / colour / label are pluggable so the same renderer draws
      // both the probability network and the signed cohort-difference network.
      var edgeMag = opts.edgeMag || function (e) { return e.probability; };
      var edgeColorFn = opts.edgeColorFn || null;
      var edgeLabelFn = opts.edgeLabelFn || null;
      var edgeTitleFn = opts.edgeTitleFn || null;
      var maxW = edges.reduce(function (m, e) { return Math.max(m, edgeMag(e)); }, 0) || 1;
      var rad = {}, ringR = {};
      nodes.forEach(function (n) { rad[n.id] = R; ringR[n.id] = R + ringGap + ringW / 2; });

      // Circular starting layout; reuse any dragged positions from posStore.
      var store = opts.posStore || {};
      var cx = W / 2, cy = H / 2;
      var maxRing = nodes.reduce(function (m, n) { return Math.max(m, ringR[n.id] + ringW / 2); }, 0);
      var pad = maxRing + (opts.nodeLabels ? 40 : 24);
      var Rx = W / 2 - pad, Ry = H / 2 - pad;
      var pos = {};
      nodes.forEach(function (n, i) {
        if (store[n.id]) { pos[n.id] = { x: store[n.id].x, y: store[n.id].y }; return; }
        var a = -Math.PI / 2 + (M > 1 ? 2 * Math.PI * i / M : 0);
        pos[n.id] = { x: cx + Rx * Math.cos(a), y: cy + Ry * Math.sin(a) };
      });

      var thr = opts.minWeight || 0;
      var shown = edges.filter(function (e) { return edgeMag(e) >= thr; });
      var showLabels = !!opts.edgeLabels;
      var labelMin = opts.edgeLabelMin != null ? opts.edgeLabelMin : 0;
      var weightMode = opts.weightMode;

      var svg = svgEl("svg", { viewBox: "0 0 " + W + " " + H, "class": "tna-svg", preserveAspectRatio: "xMidYMid meet" });
      var gEdges = svgEl("g"), gLabels = svgEl("g"), gNodes = svgEl("g");
      svg.appendChild(gEdges); svg.appendChild(gLabels); svg.appendChild(gNodes);

      // ---- edges (paths + arrowheads + labels; geometry set in tick) --------
      var edgeObjs = shown.map(function (e) {
        if (!pos[e.from] || !pos[e.to]) return null;
        var self = e.from === e.to;
        var mag = edgeMag(e);
        // Thin edges (per the reference); width still nudges with weight but
        // stays in a slim range. Opacity carries most of the weight signal.
        var wpx = 0.9 + (mag / maxW) * 2.1;
        var op = 0.4 + 0.55 * (mag / maxW);
        var stroke = edgeColorFn ? edgeColorFn(e) : EDGE_GOLD;
        var path = svgEl("path", { "class": self ? "tna-loop" : "tna-edge", "data-f": e.from, "data-t": e.to, fill: "none", stroke: stroke, "stroke-width": wpx.toFixed(1), "stroke-linecap": "round", opacity: op.toFixed(2) });
        var ttl = svgEl("title"); ttl.textContent = edgeTitleFn ? edgeTitleFn(e) : (pretty(e.from) + " → " + pretty(e.to) + "  ·  p=" + e.probability.toFixed(3) + "  ·  n=" + e.count); path.appendChild(ttl);
        var arrow = svgEl("path", { "class": "tna-arrow", "data-f": e.from, "data-t": e.to, fill: stroke, opacity: Math.min(1, op + 0.12).toFixed(2) });
        gEdges.appendChild(path); gEdges.appendChild(arrow);
        var o = { e: e, self: self, wpx: wpx, path: path, arrow: arrow, label: null };
        if (showLabels && mag / maxW >= labelMin) {
          var lbl = svgEl("text", { "class": "tna-elabel", "data-f": e.from, "data-t": e.to, "text-anchor": "middle" });
          lbl.textContent = edgeLabelFn ? edgeLabelFn(e) : edgeLabel(e, weightMode); gLabels.appendChild(lbl); o.label = lbl;
        }
        return o;
      }).filter(Boolean);

      // ---- nodes (coloured disc + ring track + initial-prob arc + label) ----
      // Disc is drawn first and tucks a hair under the ring, so the fill runs
      // flush to the gold with no gap or dark seam between them.
      var nodeObjs = nodes.map(function (n) {
        var r = rad[n.id], RR = ringR[n.id], c = colorOf[n.id] || COL.muted;
        var g = svgEl("g", { "class": "tna-node", "data-id": n.id });
        var disk = svgEl("circle", { "class": "disk", r: (r + 1).toFixed(1), fill: c });
        var dttl = svgEl("title"); dttl.textContent = pretty(n.id) + "  ·  " + n.frequency + " events  ·  start " + pct(n.initial); disk.appendChild(dttl);
        g.appendChild(disk);
        g.appendChild(svgEl("circle", { "class": "track", r: RR.toFixed(1), fill: "none", stroke: RING_TRACK, "stroke-width": ringW }));
        var arc = svgEl("path", { "class": "arc", fill: "none", stroke: EDGE_GOLD, "stroke-width": ringW, "stroke-linecap": "round" });
        setArc(arc, RR, n.initial);
        g.appendChild(arc);
        var label = null;
        if (opts.nodeLabels) { label = svgEl("text", { "class": "tna-nlabel", "text-anchor": "middle" }); label.textContent = pretty(n.id); g.appendChild(label); }
        gNodes.appendChild(g);
        return { n: n, g: g, label: label, r: r, RR: RR };
      });

      // Draw the initial-probability arc (from 12 o'clock, clockwise).
      function setArc(arc, RR, frac) {
        frac = Math.max(0, Math.min(1, frac || 0));
        if (frac <= 0.0001) { arc.setAttribute("d", ""); return; }
        if (frac >= 0.9999) { arc.setAttribute("d", "M 0 " + (-RR).toFixed(1) + " A " + RR.toFixed(1) + " " + RR.toFixed(1) + " 0 1 1 0 " + RR.toFixed(1) + " A " + RR.toFixed(1) + " " + RR.toFixed(1) + " 0 1 1 0 " + (-RR).toFixed(1)); return; }
        var a0 = -Math.PI / 2, a1 = a0 + frac * 2 * Math.PI;
        var x0 = RR * Math.cos(a0), y0 = RR * Math.sin(a0), x1 = RR * Math.cos(a1), y1 = RR * Math.sin(a1);
        arc.setAttribute("d", "M " + x0.toFixed(1) + " " + y0.toFixed(1) + " A " + RR.toFixed(1) + " " + RR.toFixed(1) + " 0 " + (frac > 0.5 ? 1 : 0) + " 1 " + x1.toFixed(1) + " " + y1.toFixed(1));
      }

      function arrowAt(arrowEl, x, y, dx, dy, wpx) {
        // Keep a clearly visible head even though the strokes are thin.
        var ah = 5.5 + wpx * 2, bx = x - dx * ah, by = y - dy * ah, nx = -dy, ny = dx, hw = ah * 0.6;
        arrowEl.setAttribute("d", "M " + x.toFixed(1) + " " + y.toFixed(1) + " L " + (bx + nx * hw).toFixed(1) + " " + (by + ny * hw).toFixed(1) + " L " + (bx - nx * hw).toFixed(1) + " " + (by - ny * hw).toFixed(1) + " Z");
      }

      // Recompute every edge/arrow/label and node transform from `pos`.
      function tick() {
        var sx0 = 0, sy0 = 0; nodes.forEach(function (n) { sx0 += pos[n.id].x; sy0 += pos[n.id].y; });
        var Cx = sx0 / M, Cy = sy0 / M;
        edgeObjs.forEach(function (o) {
          var e = o.e;
          if (o.self) {
            var c = pos[e.from], r = rad[e.from];
            var ax = c.x - Cx, ay = c.y - Cy, al = Math.hypot(ax, ay);
            if (al < 1) { ax = 0; ay = -1; } else { ax /= al; ay /= al; }
            var a = Math.atan2(ay, ax), spread = 0.5, L = r + 20 + o.wpx * 1.5;
            var p1x = c.x + r * Math.cos(a - spread), p1y = c.y + r * Math.sin(a - spread);
            var p2x = c.x + r * Math.cos(a + spread), p2y = c.y + r * Math.sin(a + spread);
            var c1x = c.x + L * Math.cos(a - spread * 0.7), c1y = c.y + L * Math.sin(a - spread * 0.7);
            var c2x = c.x + L * Math.cos(a + spread * 0.7), c2y = c.y + L * Math.sin(a + spread * 0.7);
            o.path.setAttribute("d", "M " + p1x.toFixed(1) + " " + p1y.toFixed(1) + " C " + c1x.toFixed(1) + " " + c1y.toFixed(1) + " " + c2x.toFixed(1) + " " + c2y.toFixed(1) + " " + p2x.toFixed(1) + " " + p2y.toFixed(1));
            var tdx = p2x - c2x, tdy = p2y - c2y, tl = Math.hypot(tdx, tdy) || 1;
            arrowAt(o.arrow, p2x, p2y, tdx / tl, tdy / tl, o.wpx);
            if (o.label) { o.label.setAttribute("x", (c.x + (L + 11) * Math.cos(a)).toFixed(1)); o.label.setAttribute("y", (c.y + (L + 11) * Math.sin(a) + 4).toFixed(1)); }
            return;
          }
          var u = pos[e.from], v = pos[e.to], ru = rad[e.from], rv = rad[e.to];
          var dx = v.x - u.x, dy = v.y - u.y, len = Math.hypot(dx, dy) || 1;
          var px = -dy / len, py = dx / len;                 // fixed side → reciprocal edges split apart
          var bend = Math.min(58, len * 0.16);
          var qx = (u.x + v.x) / 2 + px * bend, qy = (u.y + v.y) / 2 + py * bend;
          var s1x = qx - u.x, s1y = qy - u.y, sl = Math.hypot(s1x, s1y) || 1;
          var sx = u.x + s1x / sl * ru, sy = u.y + s1y / sl * ru;
          var e1x = qx - v.x, e1y = qy - v.y, eln = Math.hypot(e1x, e1y) || 1;
          var ex = v.x + e1x / eln * rv, ey = v.y + e1y / eln * rv;
          o.path.setAttribute("d", "M " + sx.toFixed(1) + " " + sy.toFixed(1) + " Q " + qx.toFixed(1) + " " + qy.toFixed(1) + " " + ex.toFixed(1) + " " + ey.toFixed(1));
          var adx = ex - qx, ady = ey - qy, al2 = Math.hypot(adx, ady) || 1;
          arrowAt(o.arrow, ex, ey, adx / al2, ady / al2, o.wpx);
          if (o.label) { o.label.setAttribute("x", (0.25 * u.x + 0.5 * qx + 0.25 * v.x).toFixed(1)); o.label.setAttribute("y", (0.25 * u.y + 0.5 * qy + 0.25 * v.y + 4).toFixed(1)); }
        });
        nodeObjs.forEach(function (o) {
          var p = pos[o.n.id];
          o.g.setAttribute("transform", "translate(" + p.x.toFixed(1) + "," + p.y.toFixed(1) + ")");
          if (o.label) o.label.setAttribute("y", (o.RR + ringW / 2 + 15).toFixed(1));
        });
      }

      // ---- hover / drag: isolate a node's transitions, drag to rearrange ----
      function isolate(id, on) {
        svg.classList.toggle("isolating", on);
        [].forEach.call(svg.querySelectorAll(".tna-edge,.tna-arrow,.tna-loop,.tna-elabel"), function (elm) {
          var hot = elm.getAttribute("data-f") === id || elm.getAttribute("data-t") === id;
          elm.classList.toggle("dim", on && !hot);
        });
      }
      function clientToSvg(evt) { var pt = svg.createSVGPoint(); pt.x = evt.clientX; pt.y = evt.clientY; var m = svg.getScreenCTM(); return m ? pt.matrixTransform(m.inverse()) : { x: evt.clientX, y: evt.clientY }; }
      var dragging = null;
      nodeObjs.forEach(function (o) {
        var g = o.g, id = o.n.id;
        g.addEventListener("mouseenter", function () { if (!dragging) isolate(id, true); });
        g.addEventListener("mouseleave", function () { if (!dragging) isolate(id, false); });
        g.addEventListener("pointerdown", function (evt) {
          evt.preventDefault(); var p = clientToSvg(evt);
          dragging = { id: id, dx: pos[id].x - p.x, dy: pos[id].y - p.y };
          g.classList.add("dragging"); try { g.setPointerCapture(evt.pointerId); } catch (_) {}
          isolate(id, true);
        });
        g.addEventListener("pointermove", function (evt) {
          if (!dragging || dragging.id !== id) return;
          var p = clientToSvg(evt), m = o.RR + ringW;
          pos[id].x = Math.max(m, Math.min(W - m, p.x + dragging.dx));
          pos[id].y = Math.max(m, Math.min(H - m, p.y + dragging.dy));
          if (opts.posStore) opts.posStore[id] = { x: pos[id].x, y: pos[id].y };
          tick();
        });
        g.addEventListener("pointerup", function (evt) { if (dragging && dragging.id === id) { dragging = null; g.classList.remove("dragging"); try { g.releasePointerCapture(evt.pointerId); } catch (_) {} } });
      });

      mount.innerHTML = ""; mount.appendChild(svg);
      tick();
      // Expose isolate so sibling views (e.g. the frequency chart) can light up
      // an activity's transitions on hover.
      return { isolate: isolate };
    }

    // Build the sequence index plot HTML (hardened, fit-to-width). opts:
    // { maxRows, maxCols, rowH, total }.
    function seqSVG(sequences, opts) {
      opts = opts || {};
      var MAX_ROWS = opts.maxRows || 100, MAX_COLS = opts.maxCols || 80, rowH = opts.rowH || 12;
      var all = (sequences || []).filter(function (r) { return r && r.states && r.states.length; });
      if (!all.length) return '<p class="muted small">No sequences to plot.</p>';
      var seqs = all.slice(0, MAX_ROWS);
      var hiddenRows = (opts.total || all.length) - seqs.length;
      var maxLen = 1; seqs.forEach(function (r) { if (r.states.length > maxLen) maxLen = r.states.length; });
      var cols = Math.max(1, Math.min(MAX_COLS, maxLen));
      var W = 760, gap = 2, padL = 8, padR = 10, padT = 6, padB = 20;
      var cw = (W - padL - padR) / cols;              // fit-to-width: never overflows
      var round = cw > 5, H = padT + seqs.length * (rowH + gap) + padB;
      var s = '<svg viewBox="0 0 ' + W + " " + H + '" class="tna-seqsvg" preserveAspectRatio="xMinYMin meet">';
      seqs.forEach(function (row, ri) {
        var y = padT + ri * (rowH + gap), shown = Math.min(row.states.length, cols);
        for (var ci = 0; ci < shown; ci++) {
          var stt = row.states[ci], c = colorOf[stt] || COL.muted;
          s += '<rect x="' + (padL + ci * cw).toFixed(2) + '" y="' + y + '" width="' + Math.max(0.6, cw - (cw > 4 ? 0.6 : 0.15)).toFixed(2) + '" height="' + rowH + '" fill="' + c + '"' + (round ? ' rx="1.5"' : "") + "><title>" + esc(pretty(stt)) + " · step " + (ci + 1) + "</title></rect>";
        }
        var clip = (row.len || row.states.length) - shown;
        if (clip > 0) s += '<text x="' + (W - 4) + '" y="' + (y + rowH - 2) + '" text-anchor="end" class="tna-elabel">+' + clip + "</text>";
      });
      var step = Math.max(1, Math.ceil(cols / 12));
      for (var t = 0; t < cols; t += step) s += '<text x="' + (padL + (t + 0.5) * cw).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle" class="tna-elabel">' + (t + 1) + "</text>";
      s += "</svg>";
      if (hiddenRows > 0) s += '<p class="muted small" style="margin:8px 2px 0">+ ' + fmt(hiddenRows) + " more session" + (hiddenRows === 1 ? "" : "s") + " not shown.</p>";
      return s;
    }

    // Interactive horizontal bar chart of activity frequencies. Bars carry the
    // node colour so the chart reads against the network; hovering a bar shows
    // exact count + share and lights up that activity's transitions in the graph
    // (via the network's isolate handle when present).
    // Activity-frequency bars, as an exportable <svg> (shared with the dashboard's
    // svgHBars). Hovering a bar isolates that state in the network, as before.
    function mountFreq(mount, nodes) {
      var items = nodes.slice().sort(function (a, b) { return b.frequency - a.frequency; })
        .map(function (x) { return { id: x.id, label: pretty(x.id), value: x.frequency, color: colorOf[x.id] || COL.muted }; });
      var total = items.reduce(function (t, x) { return t + x.value; }, 0) || 1;
      D.svgHBars(mount, items, {
        labelColor: "item", fill: "item", empty: "No activities to chart.",
        onEnter: function (id) { if (netApi) netApi.isolate(id, true); },
        onLeave: function (id) { if (netApi) netApi.isolate(id, false); },
        tipHtml: function (it) { return '<div class="r"><i style="background:' + it.color + '"></i>' + esc(it.label) + " · <b>" + fmt(it.value) + "</b> events · " + pct(it.value / total) + "</div>"; },
      });
    }

    // =======================================================================
    // MOUNTING + INTERACTIVITY
    // =======================================================================
    var edges = data.edges.slice();

    // ---- Main network ------------------------------------------------------
    // Positions persist across display-only redraws (threshold / label toggle)
    // so a layout the user has dragged into place isn't lost.
    var netMount = container.querySelector("#tnaNet");
    var netPos = {}, netApi = null;
    function drawNetwork() {
      netApi = buildNetwork(netMount, data.nodes, edges, { W: 750, H: 600, minWeight: st.minWeight || 0, edgeLabels: !!st.labels, nodeLabels: true, weightMode: data.weightMode, posStore: netPos });
    }
    drawNetwork();

    // Activity-frequency bar chart (descriptives) — replaces the old colour
    // legend, whose colours were already visible on the nodes.
    mountFreq(container.querySelector("#tnaFreq"), data.nodes);

    // ---- Centrality table (sortable) ---------------------------------------
    var centSort = { key: "betweenness", dir: -1 };
    var centCols = [["state", "State", 0], ["outStrength", "Out-str", 1], ["inStrength", "In-str", 1], ["betweenness", "Between", 1], ["closeness", "Close", 1], ["pageRank", "PageRank", 1]];
    var centMount = container.querySelector("#tnaCent");
    function drawCent() {
      var rows = data.centrality.slice().sort(function (a, b) {
        var k = centSort.key, x = a[k], y = b[k];
        if (k === "state") { x = String(x); y = String(y); return (x < y ? -1 : x > y ? 1 : 0) * centSort.dir; }
        return ((x || 0) - (y || 0)) * centSort.dir;
      });
      var h = '<table><thead><tr>' + centCols.map(function (c) {
        return '<th class="' + (c[2] ? "num " : "") + '" data-k="' + c[0] + '">' + c[1] + (centSort.key === c[0] ? (centSort.dir < 0 ? " ▾" : " ▴") : "") + "</th>";
      }).join("") + "</tr></thead><tbody>" + rows.map(function (r) {
        return "<tr><td>" + chip(r.state, 1) + '</td><td class="num">' + dec(r.outStrength, 2) + '</td><td class="num">' + dec(r.inStrength, 2) + '</td><td class="num">' + dec(r.betweenness, 1) + '</td><td class="num">' + dec(r.closeness, 3) + '</td><td class="num">' + dec(r.pageRank, 3) + "</td></tr>";
      }).join("") + "</tbody></table>";
      centMount.innerHTML = h;
      [].forEach.call(centMount.querySelectorAll("th[data-k]"), function (th) {
        th.addEventListener("click", function () {
          var k = th.getAttribute("data-k");
          if (centSort.key === k) centSort.dir *= -1; else { centSort.key = k; centSort.dir = k === "state" ? 1 : -1; }
          drawCent();
        });
      });
    }
    drawCent();

    // ---- Centrality comparison bar chart (client-only measure switch) ------
    // Reuses the activity-frequency bar styling (.tna-hbars). Switching the
    // measure re-ranks locally — no server round-trip — and hovering a bar
    // isolates that state's transitions in the network, like the freq chart.
    var centBarsMount = container.querySelector("#tnaCentBars");
    var centMeasureSel = container.querySelector("#tnaCentMeasure");
    function centMeasureMeta(key) { for (var i = 0; i < CENT_MEASURES.length; i++) if (CENT_MEASURES[i][0] === key) return CENT_MEASURES[i]; return CENT_MEASURES[0]; }
    function drawCentBars() {
      var meta = centMeasureMeta(st.centMeasure || "betweenness"), key = meta[0], prec = meta[2];
      var items = data.centrality.map(function (r) { return { id: r.state, label: pretty(r.state), value: +r[key] || 0, color: colorOf[r.state] || COL.muted }; }).sort(function (a, b) { return b.value - a.value; });
      D.svgHBars(centBarsMount, items, {
        labelColor: "item", fill: "item", empty: "No states to chart.",
        valFmt: function (v) { return dec(v, prec); },
        onEnter: function (id) { if (netApi) netApi.isolate(id, true); },
        onLeave: function (id) { if (netApi) netApi.isolate(id, false); },
        tipHtml: function (it) { return '<div class="r"><i style="background:' + it.color + '"></i>' + esc(it.label) + " · " + esc(meta[1]) + " <b>" + dec(it.value, prec) + "</b></div>"; },
      });
    }
    centMeasureSel.addEventListener("change", function () { st.centMeasure = centMeasureSel.value; drawCentBars(); });
    drawCentBars();

    // ---- Sequence index plot (paginated, uses shared hardened seqSVG) ------
    // The initial page ships with the /tna payload; Prev/Next fetch adjacent
    // pages from /tna/sequences (order is stable, so offsets line up). The card
    // shows exactly one page, so seqSVG never has hidden "+N more" rows.
    var seqState = {
      offset: data.sequencesOffset || 0,
      limit: data.sequencesLimit || 28,
      total: data.sequencesTotal || (data.sequences ? data.sequences.length : 0),
      sequences: data.sequences || [],
      loading: false,
    };
    var seqMount = container.querySelector("#tnaSeq");
    var seqRange = container.querySelector("#tnaSeqRange");
    var seqPrev = container.querySelector("#tnaSeqPrev");
    var seqNext = container.querySelector("#tnaSeqNext");
    function drawSeq() {
      seqMount.innerHTML = seqSVG(seqState.sequences, { total: seqState.sequences.length, maxRows: seqState.limit });
      var from = seqState.total ? seqState.offset + 1 : 0;
      var to = Math.min(seqState.total, seqState.offset + seqState.sequences.length);
      seqRange.textContent = seqState.loading ? "Loading…" : (seqState.total ? ("Sessions " + fmt(from) + "–" + fmt(to) + " of " + fmt(seqState.total)) : "No sessions");
      seqPrev.disabled = seqState.loading || seqState.offset <= 0;
      seqNext.disabled = seqState.loading || (seqState.offset + seqState.limit) >= seqState.total;
    }
    function loadSeqPage(offset) {
      if (!ctx.loadSequences || seqState.loading) return;
      seqState.loading = true; drawSeq();
      ctx.loadSequences({ offset: offset, limit: seqState.limit }).then(function (res) {
        seqState.offset = res.sequencesOffset != null ? res.sequencesOffset : offset;
        if (res.sequencesTotal != null) seqState.total = res.sequencesTotal;
        if (res.sequencesLimit) seqState.limit = res.sequencesLimit;
        seqState.sequences = res.sequences || [];
        seqState.loading = false; drawSeq();
      }).catch(function () { seqState.loading = false; drawSeq(); });
    }
    seqPrev.addEventListener("click", function () { if (seqState.offset > 0) loadSeqPage(Math.max(0, seqState.offset - seqState.limit)); });
    seqNext.addEventListener("click", function () { if (seqState.offset + seqState.limit < seqState.total) loadSeqPage(seqState.offset + seqState.limit); });
    drawSeq();

    // ---- Validation rendering ----------------------------------------------
    function validationHTML(val) {
      if (!val) return "";
      var sig = val.significant, tot = val.total;
      var rows = val.edges.slice().sort(function (a, b) { return a.pValue - b.pValue || b.weight - a.weight; });
      var body = '<div class="card"><div class="card-head"><h3>Bootstrap validation</h3><span class="pill go">' + sig + " / " + tot + " stable edges</span></div>" +
        '<p class="cap">Resampled sessions ' + fmt(val.iter) + '× (seed-fixed). An edge is <b>stable</b> when it stays present in ≥ ' + pct(1 - val.level) + ' of resamples (p ≤ ' + val.level + '); CI columns are percentile bounds of its weight. Unstable edges may be artefacts of a few sessions.</p>' +
        '<div class="tbl-wrap"><table><thead><tr><th class="no-sort">From</th><th class="no-sort">To</th><th class="num">Weight</th><th class="num">Boot mean</th><th class="num">CI low</th><th class="num">CI high</th><th class="num">p</th><th class="no-sort">Stable</th></tr></thead><tbody>' +
        rows.map(function (e) {
          return "<tr" + (e.significant ? "" : ' class="tna-unstable"') + ">" + "<td>" + chip(e.from, 1) + "</td><td>" + chip(e.to, 1) + '</td><td class="num">' + dec(e.weight, 3) + '</td><td class="num">' + dec(e.bootstrapMean, 3) + '</td><td class="num">' + dec(e.ciLower, 3) + '</td><td class="num">' + dec(e.ciUpper, 3) + '</td><td class="num">' + dec(e.pValue, 3) + '</td><td>' + (e.significant ? '<span class="tna-sig">✓</span>' : '<span class="muted">·</span>') + "</td></tr>";
        }).join("") + "</tbody></table></div></div>";
      return body;
    }

    // Markov-order test: is a first-order model (the TNA assumption) justified?
    function markovHTML(m) {
      if (!m || !m.testTable || !m.testTable.length) return "";
      var order1 = m.testTable.filter(function (r) { return r.order === 1; })[0];
      var firstOrderOk = order1 && order1.significant;
      var higher = (m.optimalOrder || 1) > 1;
      var verdict = !firstOrderOk
        ? '<span class="pill">no order-1 structure</span>'
        : (higher ? '<span class="pill warn">higher-order structure present</span>' : '<span class="pill go">first-order justified</span>');
      var rows = m.testTable.map(function (r) {
        return '<tr' + (r.order === m.optimalOrder ? ' class="tna-sig-row"' : "") + "><td>" + r.order + '</td><td class="num">' + dec(r.aic, 1) + '</td><td class="num">' + dec(r.bic, 1) + '</td><td class="num">' + (r.g2 != null ? dec(r.g2, 2) : "—") + '</td><td class="num">' + (r.df != null ? r.df : "—") + '</td><td class="num">' + (r.pPermutation != null ? dec(r.pPermutation, 3) : "—") + '</td><td>' + (r.significant ? '<span class="tna-sig">✓</span>' : '<span class="muted">·</span>') + "</td></tr>";
      }).join("");
      return '<div class="card"><div class="card-head"><h3>Markov order test</h3>' + verdict + "</div>" +
        '<p class="cap">A within-window permutation likelihood-ratio test of how much memory the sequences carry. Order 1 significant ⇒ transitions depend on the current state (the TNA premise holds). Optimal order = <b>' + m.optimalOrder + '</b> (AIC ' + m.aicOrder + ' · BIC ' + m.bicOrder + '); an optimal order above 1 means real dependencies reach further back than a first-order network captures.</p>' +
        '<div class="tbl-wrap"><table><thead><tr><th class="no-sort">Order</th><th class="num">AIC</th><th class="num">BIC</th><th class="num">G²</th><th class="num">df</th><th class="num">p</th><th class="no-sort">Sig</th></tr></thead><tbody>' + rows + "</tbody></table></div></div>";
    }

    // Case-drop stability card shell: a Graph|Table toggle, per-measure legend
    // chips (click to add/remove a line), and a body mount wired after injection.
    function stabilityHTML(s) {
      if (!s || !s.csCoefficients) return "";
      var measures = s.measures || Object.keys(s.csCoefficients);
      if (!measures.length) return "";
      var legend = measures.map(function (m) {
        var off = st.stabHidden && st.stabHidden[m];
        return '<button class="tna-legend-chip' + (off ? " off" : "") + '" data-m="' + esc(m) + '"><i style="background:' + stabColor(measures, m) + '"></i>' + esc(m) + "</button>";
      }).join("");
      return '<div class="card" id="tnaStability"><div class="card-head"><h3>Network stability</h3><span class="spacer"></span>' + viewSeg(st.stabView) + "</div>" +
        '<p class="cap">Case-drop reliability: at each drop proportion, sessions are resampled and each centrality measure is re-correlated with the full-sample ordering. A measure is stable if the curve stays high as more cases are dropped; the CS coefficient is the largest drop still above ' + s.threshold + ' (in 95% of resamples). CS ≥ 0.5 stable, ≥ 0.25 acceptable.</p>' +
        '<div class="tna-legend-toggles">' + legend + "</div>" +
        '<div id="tnaStabBody"></div></div>';
    }

    // Wire the stability card (called from the mounting section after injection):
    // legend add/remove, Graph|Table toggle, line-chart / table draw.
    function wireStability(s) {
      var card = container.querySelector("#tnaStability");
      if (!card || !s) return;
      var measures = s.measures || Object.keys(s.csCoefficients || {});
      var bodyMount = card.querySelector("#tnaStabBody");
      function activeMeasures() { return measures.filter(function (m) { return !(st.stabHidden && st.stabHidden[m]); }); }
      function draw() {
        if (st.stabView === "table") bodyMount.innerHTML = stabilityTableHTML(s, measures);
        else bodyMount.innerHTML = stabilityChartSVG(s, activeMeasures());
      }
      wireViewToggle(card, function () { return st.stabView; }, function (v) { st.stabView = v; draw(); });
      [].forEach.call(card.querySelectorAll(".tna-legend-chip"), function (b) {
        b.addEventListener("click", function () {
          var m = b.getAttribute("data-m");
          st.stabHidden = st.stabHidden || {};
          st.stabHidden[m] = !st.stabHidden[m];
          b.classList.toggle("off", !!st.stabHidden[m]);
          if (st.stabView !== "table") draw();   // table shows all rows regardless
        });
      });
      draw();
    }
    function stabilityTableHTML(s, measures) {
      var band = function (v) { return v >= 0.5 ? "go" : v >= 0.25 ? "warn" : "bad"; };
      var bandTxt = function (v) { return v >= 0.5 ? "stable" : v >= 0.25 ? "acceptable" : "fragile"; };
      var rows = measures.map(function (k) {
        var v = s.csCoefficients[k];
        return "<tr><td><span class=\"tna-legend-dot\" style=\"background:" + stabColor(measures, k) + "\"></span>" + esc(k) + '</td><td class="num">' + dec(v, 2) + '</td><td><span class="pill ' + band(v) + '">' + bandTxt(v) + "</span></td></tr>";
      }).join("");
      return '<div class="tbl-wrap"><table><thead><tr><th class="no-sort">Measure</th><th class="num">CS</th><th class="no-sort">Rating</th></tr></thead><tbody>' + rows + "</tbody></table></div>";
    }
    // Line chart: mean correlation vs proportion dropped, one line per active
    // measure, with a ± sd band and the CS threshold marked.
    function stabilityChartSVG(s, active) {
      var measures = s.measures || Object.keys(s.csCoefficients || {});
      var drops = (s.dropProps || []).slice().sort(function (a, b) { return a - b; });
      if (!drops.length || !active.length) return '<p class="muted small">Select at least one measure to plot.</p>';
      var byMeasure = {}; measures.forEach(function (m) { byMeasure[m] = {}; });
      (s.curve || []).forEach(function (r) { if (byMeasure[r.measure]) byMeasure[r.measure][r.dropProp] = r; });
      var W = 960, H = 620, pad = { l: 52, r: 16, t: 14, b: 40 };
      var xmin = drops[0], xmax = drops[drops.length - 1];
      var ymin = 0, ymax = 1;
      var X = function (v) { return pad.l + (W - pad.l - pad.r) * (xmax === xmin ? 0.5 : (v - xmin) / (xmax - xmin)); };
      var Y = function (v) { return H - pad.b - (H - pad.t - pad.b) * ((v - ymin) / (ymax - ymin)); };
      var s2 = '<svg viewBox="0 0 ' + W + " " + H + '" class="ichart" preserveAspectRatio="xMidYMid meet">';
      for (var g = 0; g <= 4; g++) { var gv = ymin + (ymax - ymin) * g / 4, gy = Y(gv); s2 += '<line x1="' + pad.l + '" y1="' + gy.toFixed(1) + '" x2="' + (W - pad.r) + '" y2="' + gy.toFixed(1) + '" stroke="' + COL.line + '" opacity=".5"/><text x="' + (pad.l - 6) + '" y="' + (gy + 3).toFixed(1) + '" fill="' + COL.muted + '" font-size="10" text-anchor="end">' + dec(gv, 2) + "</text>"; }
      // threshold line
      var ty = Y(s.threshold); s2 += '<line x1="' + pad.l + '" y1="' + ty.toFixed(1) + '" x2="' + (W - pad.r) + '" y2="' + ty.toFixed(1) + '" stroke="' + COL.muted + '" stroke-dasharray="5 4" opacity=".7"/><text x="' + (W - pad.r) + '" y="' + (ty - 5).toFixed(1) + '" fill="' + COL.muted + '" font-size="10" text-anchor="end">threshold = ' + s.threshold + "</text>";
      // x ticks
      drops.forEach(function (d0) { s2 += '<text x="' + X(d0).toFixed(1) + '" y="' + (H - 22) + '" fill="' + COL.muted + '" font-size="10" text-anchor="middle">' + d0 + "</text>"; });
      s2 += '<text x="' + ((pad.l + W - pad.r) / 2).toFixed(1) + '" y="' + (H - 6) + '" fill="' + COL.muted + '" font-size="11" text-anchor="middle">Proportion dropped</text>';
      // one line (+ band) per active measure
      active.forEach(function (m) {
        var col = stabColor(measures, m);
        var pts = drops.map(function (d0) { var r = byMeasure[m][d0]; return r ? { x: d0, y: r.meanCor, sd: r.sdCor || 0 } : null; }).filter(Boolean);
        if (pts.length < 1) return;
        var up = pts.map(function (p, i) { return (i ? "L" : "M") + X(p.x).toFixed(1) + " " + Y(Math.min(1, p.y + p.sd)).toFixed(1); }).join(" ");
        var dn = pts.slice().reverse().map(function (p) { return "L" + X(p.x).toFixed(1) + " " + Y(Math.max(0, p.y - p.sd)).toFixed(1); }).join(" ");
        s2 += '<path d="' + up + " " + dn + ' Z" fill="' + col + '" opacity="0.12"/>';
        var line = pts.map(function (p, i) { return (i ? "L" : "M") + X(p.x).toFixed(1) + " " + Y(p.y).toFixed(1); }).join(" ");
        s2 += '<path d="' + line + '" fill="none" stroke="' + col + '" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>';
        pts.forEach(function (p) { s2 += '<circle cx="' + X(p.x).toFixed(1) + '" cy="' + Y(p.y).toFixed(1) + '" r="3.2" fill="' + col + '" stroke="#0b1120" stroke-width="1.2"><title>' + esc(m) + " · drop " + p.x + " · r=" + dec(p.y, 3) + "</title></circle>"; });
      });
      s2 += '<text transform="translate(14,' + ((pad.t + H - pad.b) / 2).toFixed(1) + ') rotate(-90)" fill="' + COL.muted + '" font-size="11" text-anchor="middle">Mean correlation</text>';
      s2 += "</svg>";
      return '<div style="max-width:820px;margin:0 auto">' + s2 + "</div>";
    }

    // Whole validation + diagnostics block (bootstrap · Markov order · stability).
    function diagnosticsHTML(d) {
      return validationHTML(d.validation) + markovHTML(d.markov) + stabilityHTML(d.stability);
    }

    // =======================================================================
    // CONTROL WIRING
    // =======================================================================
    var wSeg = container.querySelector("#tnaWeight");
    [].forEach.call(wSeg.querySelectorAll("[data-w]"), function (b) {
      b.addEventListener("click", function () { if (b.getAttribute("data-w") !== data.weightMode) ctx.reload({ weight: b.getAttribute("data-w") }); });
    });
    var thr = container.querySelector("#tnaThr"), thrVal = container.querySelector("#tnaThrVal");
    thr.addEventListener("input", function () { st.minWeight = parseFloat(thr.value) || 0; thrVal.textContent = pct(st.minWeight); drawNetwork(); });
    container.querySelector("#tnaLabels").addEventListener("change", function () { st.labels = this.checked; drawNetwork(); });
    var iterIn = container.querySelector("#tnaIter");
    container.querySelector("#tnaBoot").addEventListener("click", function () {
      var it = Math.min(2000, Math.max(50, parseInt(iterIn.value, 10) || 300));
      ctx.reload({ bootstrap: true, iter: it, scrollToValidation: true });
    });

    // ---- Clustering --------------------------------------------------------
    var clusterMount = container.querySelector("#tnaClusters");
    var kInput = container.querySelector("#tnaK");
    var algoSel = container.querySelector("#tnaAlgo"), dissSel = container.querySelector("#tnaDiss"), linkSel = container.querySelector("#tnaLink");
    var dissCtl = container.querySelector("#tnaDissCtl"), linkCtl = container.querySelector("#tnaLinkCtl");
    function syncClusterControls() {
      // Linkage only applies to hierarchical; both PAM and hierarchical act on
      // the chosen sequence dissimilarity.
      linkCtl.style.display = algoSel.value === "hierarchical" ? "" : "none";
      dissSel.disabled = false; dissCtl.style.opacity = 1; dissCtl.title = "";
    }
    algoSel.addEventListener("change", function () { st.clAlgo = algoSel.value; syncClusterControls(); });
    dissSel.addEventListener("change", function () { st.clDiss = dissSel.value; });
    linkSel.addEventListener("change", function () { st.clLink = linkSel.value; });
    syncClusterControls();
    container.querySelector("#tnaClusterBtn").addEventListener("click", function () {
      var k = Math.min(8, Math.max(2, parseInt(kInput.value, 10) || 3));
      st.k = k; kInput.value = k; st.clAlgo = algoSel.value; st.clDiss = dissSel.value; st.clLink = linkSel.value;
      clusterMount.innerHTML = '<div class="spin">Clustering ' + fmt(data.stats.sessions) + " sessions…</div>";
      ctx.loadClusters({ k: k, algorithm: st.clAlgo, dissimilarity: st.clDiss, linkage: st.clLink }).then(renderClusters).catch(function (e) {
        clusterMount.innerHTML = '<div class="empty">Clustering failed: ' + esc(e && e.message) + "</div>";
      });
    });
    // Label toggles re-draw the already-loaded cluster networks in place.
    container.querySelector("#tnaClNodeLbl").addEventListener("change", function () { st.clNodeLabels = this.checked; if (lastClusterData) renderClusters(lastClusterData); });
    container.querySelector("#tnaClEdgeLbl").addEventListener("change", function () { st.clEdgeLabels = this.checked; if (lastClusterData) renderClusters(lastClusterData); });

    // ---- Cliques (ships with the /tna payload; no lazy fetch) --------------
    var cliqueMount = container.querySelector("#tnaCliques");
    var cliqueSizeSel = container.querySelector("#tnaCliqueSize");
    var cliqueHead = container.querySelector("#tnaCliqueHead");
    var cliquePos = {};   // drag positions per size/rank, kept across view toggles
    function renderCliques() {
      if (!cliqueMount) return;
      var size = st.cliqueSize || 3;
      var all = (data.cliques && data.cliques[size]) || [];
      var top = all.slice(0, CLIQUE_TOP);
      var meta = container.querySelector("#tnaCliqueMeta");
      if (meta) meta.innerHTML = all.length ? "<b style=\"color:var(--ink)\">" + fmt(all.length) + "</b> clique" + (all.length === 1 ? "" : "s") + " of size " + size + (all.length > top.length ? " · showing top " + top.length : "") : "";
      if (!top.length) {
        cliqueMount.innerHTML = '<p class="muted small">No cliques of size ' + size + " — no group of " + size + " states all transition into one another here. Try a smaller size.</p>";
        return;
      }
      if (st.cliqueView === "table") cliqueMount.innerHTML = cliqueTableHTML(top);
      else drawCliqueGraphs(top, size);
    }
    function cliqueTableHTML(rows) {
      return '<div class="tbl-wrap"><table><thead><tr><th class="no-sort">#</th><th class="no-sort">States (mutually connected)</th><th class="num">Mean prob.</th><th class="num">Strength</th></tr></thead><tbody>' +
        rows.map(function (c, i) {
          return "<tr><td class=\"num\">" + (i + 1) + '</td><td><div class="seqchain">' + c.states.map(function (s2) { return chip(s2, 1); }).join(" ") + "</div></td>" +
            '<td class="num">' + dec(c.meanWeight, 3) + '</td><td class="num">' + dec(c.strength, 3) + "</td></tr>";
        }).join("") + "</tbody></table></div>";
    }
    function drawCliqueGraphs(rows, size) {
      cliquePos[size] = cliquePos[size] || {};
      // One flat tile per clique: just the network + a single caption line. No
      // nested card/header/pill chrome — the size selector already states the size.
      var cards = rows.map(function (c, i) {
        return '<figure class="tna-clique"><div class="tna-cq-net" data-cq="' + i + '"></div>' +
          '<figcaption class="tna-cq-cap"><b>#' + (i + 1) + "</b><span>strength " + dec(c.strength, 2) + "</span></figcaption></figure>";
      }).join("");
      // Fixed-track grid so each clique renders at the SAME modest size no matter
      // how many there are (a lone clique no longer stretches to full width).
      cliqueMount.innerHTML = '<div class="tna-clique-grid">' + cards + "</div>";
      rows.forEach(function (c, i) {
        var nm = cliqueMount.querySelector('[data-cq="' + i + '"]');
        if (!nm) return;
        cliquePos[size][i] = cliquePos[size][i] || {};
        var nodes = c.states.map(function (l) { var g = nodeById[l]; return { id: l, frequency: g ? g.frequency : 0, initial: 0 }; });
        buildNetwork(nm, nodes, c.edges, {
          W: 340, H: 300, nodeLabels: true, edgeLabels: true, edgeLabelMin: 0, weightMode: "probability",
          nodeR: 17, ringW: 0, posStore: cliquePos[size][i],
          edgeMag: function (e) { return e.probability; },
          edgeLabelFn: function (e) { return (Math.round(e.probability * 100) / 100).toFixed(2).replace(/^0(?=\.)/, ""); },
          edgeTitleFn: function (e) { return pretty(e.from) + " → " + pretty(e.to) + "  ·  p=" + e.probability.toFixed(3) + "  ·  n=" + e.count; },
        });
      });
    }
    if (cliqueSizeSel) {
      renderCliques();
      [].forEach.call(cliqueSizeSel.querySelectorAll("[data-size]"), function (b) {
        b.addEventListener("click", function () {
          var sz = parseInt(b.getAttribute("data-size"), 10);
          if (sz === st.cliqueSize) return;
          st.cliqueSize = sz;
          [].forEach.call(cliqueSizeSel.querySelectorAll("[data-size]"), function (x) { x.classList.toggle("active", x === b); });
          renderCliques();
        });
      });
      wireViewToggle(cliqueHead, function () { return st.cliqueView; }, function (v) { st.cliqueView = v; renderCliques(); });
    }

    // Keep the last cluster payload + per-cluster drag positions so the label
    // toggles below can re-render locally (no re-fetch, no extra DB load).
    var lastClusterData = null, clusterPos = {}, seqExpanded = {};
    function renderClusters(cd) {
      // A fresh result (different object) resets drag positions; a label-toggle
      // re-render passes the same object and keeps whatever's been arranged.
      if (cd && cd.clusters && cd !== lastClusterData) { lastClusterData = cd; clusterPos = {}; seqExpanded = {}; }
      if (!cd || cd.error === "not_enough_sequences") {
        clusterMount.innerHTML = '<div class="empty">Not enough sessions to cluster — need at least ' + ((cd && cd.kRequested) || 2) + " sessions with transitions" + (cd ? " (have " + fmt(cd.usableSessions || 0) + ")" : "") + ".<br><span class=\"small\">Widen the date range or clear the player filter.</span></div>";
        return;
      }
      var cls = cd.clusters || [];
      if (!cls.length) { clusterMount.innerHTML = '<p class="muted small">No clusters produced.</p>'; return; }
      var M = cd.method || {}, Q = cd.quality || {};
      var algoName = { pam: "PAM (k-medoids)", hierarchical: "hierarchical" }[M.algorithm] || M.algorithm || "";
      var dissName = { hamming: "Hamming", lv: "Levenshtein", osa: "OSA", dl: "Damerau–Levenshtein", lcs: "LCS", qgram: "q-gram", jw: "Jaro–Winkler" }[M.dissimilarity] || M.dissimilarity || "";
      var head = '<div class="tna-cluster-head small muted"><b style="color:var(--ink)">' + esc(algoName) + (M.linkage ? " · " + esc(M.linkage) : "") + "</b> · " + esc(dissName) +
        " · " + cd.k + " clusters over " + fmt(cd.n) + " sessions" + (cd.sampledFrom ? " (sampled from " + fmt(cd.sampledFrom) + ")" : "") +
        (Q.silhouette != null ? ' · silhouette <b style="color:var(--ink)">' + dec(Q.silhouette, 3) + "</b>" : "") +
        (Q.sse != null ? " · SSE " + dec(Q.sse, 2) : "") + "</div>";
      var cards = cls.map(function (cl) {
        var top = cl.topStates.map(function (s2) { return chip(s2, 1); }).join(" ");
        // Flat tile: a single header line, the network on the card itself (no inner
        // bordered box), then the sequences — matching the cliques treatment.
        return '<div class="card tna-cluster"><div class="tna-cl-head"><b>Cluster ' + cl.label + "</b>" +
          '<span class="tna-cl-meta">' + fmt(cl.size) + " runs · " + pct(cl.share) + "</span></div>" +
          '<div class="tna-cluster-top">' + top + "</div>" +
          '<div class="tna-cluster-net" data-net="' + cl.label + '"></div>' +
          '<div class="tna-cseq-head"><span class="tna-cseq-label">Sequences</span>' +
          '<button type="button" class="seqmore tna-seqtog" data-seqtog="' + cl.label + '" hidden></button></div>' +
          '<div class="tna-seq-wrap tna-cseq" data-seq="' + cl.label + '"></div></div>';
      }).join("");
      clusterMount.innerHTML = head + '<div class="grid2">' + cards + "</div>";
      // Collapsed sequence rows per cluster; the toggle expands to show them all.
      var SEQ_COLLAPSED = 14;
      function drawClusterSeq(cl) {
        var sm = clusterMount.querySelector('[data-seq="' + cl.label + '"]');
        if (!sm) return;
        var have = (cl.sequences || []).length, exp = !!seqExpanded[cl.label];
        var rows = exp ? have : Math.min(SEQ_COLLAPSED, have);
        // When expanded we show every session we have, so the "+N more" note is
        // suppressed (total = shown); collapsed keeps the honest cluster total.
        sm.innerHTML = seqSVG(cl.sequences, { total: exp ? have : cl.size, maxRows: rows, rowH: 9 });
        var btn = clusterMount.querySelector('[data-seqtog="' + cl.label + '"]');
        if (btn) {
          if (have <= SEQ_COLLAPSED) { btn.hidden = true; }
          else { btn.hidden = false; btn.textContent = exp ? "Show fewer" : "Show all " + fmt(have); }
        }
      }
      // Mount each cluster's network + sequence plot (shared colours + helpers).
      cls.forEach(function (cl) {
        var nm = clusterMount.querySelector('[data-net="' + cl.label + '"]');
        if (nm) {
          clusterPos[cl.label] = clusterPos[cl.label] || {};
          buildNetwork(nm, cl.nodes, cl.edges, { W: 520, H: 400, nodeLabels: st.clNodeLabels !== false, edgeLabels: st.clEdgeLabels !== false, edgeLabelMin: 0, weightMode: cd.weightMode, nodeR: 15, ringW: 4, posStore: clusterPos[cl.label] });
        }
        drawClusterSeq(cl);
        var tog = clusterMount.querySelector('[data-seqtog="' + cl.label + '"]');
        if (tog) tog.addEventListener("click", function () { seqExpanded[cl.label] = !seqExpanded[cl.label]; drawClusterSeq(cl); });
      });
    }

    // ---- Behaviour patterns → outcome (lazy) -------------------------------
    var patMount = container.querySelector("#tnaPatterns");
    var patOutcomeSel = container.querySelector("#tnaPatOutcome");
    var patSupportIn = container.querySelector("#tnaPatSupport");
    // ladyna pattern names join states with "->"; render as a chip chain.
    function patternChips(patStr) {
      return String(patStr).split("->").map(function (s2, i) { return (i ? '<span class="seqarrow">→</span>' : "") + chip(s2.trim(), 1); }).join("");
    }
    function pTxt(v) { return v == null ? "—" : (v < 0.001 ? "<0.001" : dec(v, 3)); }
    // Diverging colour by standardized residual: blue = over-represented in the
    // High cohort, red = over-represented in the Low cohort (intensity ∝ |resid|).
    function residColor(r) { var mag = Math.min(1, Math.abs(r) / 5); var base = r >= 0 ? "125,192,255" : "255,124,120"; return "rgba(" + base + "," + (0.58 + 0.4 * mag).toFixed(2) + ")"; }

    function renderPatterns(pd) {
      if (!pd || pd.error) {
        var msg = pd && pd.error === "not_enough_data" ? "Not enough sessions with an outcome to compare (need ≥ 6 scored; high " + ((pd && pd.groupHigh) || 0) + ", low " + ((pd && pd.groupLow) || 0) + ")."
          : "Pattern mining failed" + (pd && pd.detail ? ": " + esc(pd.detail) : "") + ".";
        patMount.innerHTML = '<div class="empty">' + msg + "</div>"; return;
      }
      var rows = pd.patterns || [];
      var head = '<div class="small muted"><b style="color:var(--ink)">' + esc(pd.groupA.label) + "</b> (" + fmt(pd.groupA.size) + ') vs <b style="color:var(--ink)">' + esc(pd.groupB.label) + "</b> (" + fmt(pd.groupB.size) + ") · " + rows.length + " patterns · min support " + pct(pd.minSupport) + "</div>";
      patMount.innerHTML = '<div class="tna-view-head">' + head + viewSeg(st.patView) + '</div><div id="tnaPatBody"></div>';
      wireViewToggle(patMount, function () { return st.patView; }, function (v) { st.patView = v; drawPatBody(pd); });
      drawPatBody(pd);
    }
    function drawPatBody(pd) {
      var body = patMount.querySelector("#tnaPatBody");
      var rows = pd.patterns || [];
      if (!rows.length) { body.innerHTML = '<p class="muted small">No patterns at this support threshold — lower Min support.</p>'; return; }
      body.innerHTML = st.patView === "table" ? patternTableHTML(rows) : pyramidSVG(pd, rows);
    }
    function patternTableHTML(rows) {
      return '<div class="tbl-wrap"><table><thead><tr><th class="no-sort">Pattern</th><th class="num">Support</th><th class="num">High n</th><th class="num">Low n</th><th class="num">Std. resid.</th><th class="num">p</th><th class="no-sort">Sig</th></tr></thead><tbody>' +
        rows.map(function (r) {
          return "<tr" + (r.significant ? "" : ' class="tna-unstable"') + '><td><div class="seqchain">' + patternChips(r.pattern) + "</div></td>" +
            '<td class="num">' + (r.support != null ? pct(r.support) : "—") + '</td><td class="num">' + fmt(r.countHigh) + '</td><td class="num">' + fmt(r.countLow) + "</td>" +
            '<td class="num" style="color:' + (r.stdResid >= 0 ? "#a7c8ff" : "#ffb0b0") + '">' + fmtSigned(r.stdResid, 2) + "</td>" +
            '<td class="num">' + pTxt(r.p) + "</td>" +
            "<td>" + (r.significant ? '<span class="tna-sig">✓</span>' : '<span class="muted">·</span>') + "</td></tr>";
        }).join("") + "</tbody></table></div>";
    }
    // Text measurement (offscreen canvas) so SVG chips can be laid out and clipped
    // to a fixed column without ever overflowing.
    var _measCtx = null;
    function textW(str, font) {
      if (!_measCtx) _measCtx = document.createElement("canvas").getContext("2d");
      _measCtx.font = font; return _measCtx.measureText(String(str)).width;
    }
    var CHIP_FONT = "800 11px Nunito, system-ui, sans-serif";
    var CHIP_PADX = 8, CHIP_ARROW = 13, CHIP_GAP = 4;
    // Width a full (untruncated) chip row needs — used to size the label column.
    function chipRowWidth(pattern) {
      var evs = String(pattern).split("->"), w = 0;
      for (var i = 0; i < evs.length; i++) {
        if (i) w += CHIP_ARROW + CHIP_GAP;
        w += textW(pretty(evs[i].trim()), CHIP_FONT) + CHIP_PADX * 2;
      }
      return w;
    }
    // Render a pattern (state chain) as SVG chips in FULL — nothing is truncated;
    // the column is sized to fit the longest pattern and the whole plot scrolls.
    function patternChipsSVG(pattern, x, cy) {
      var evs = String(pattern).split("->").map(function (e) { return e.trim(); });
      var h = 18, hy = cy - h / 2, ty = cy + 4, out = "", cx = x, i;
      for (i = 0; i < evs.length; i++) {
        if (i) { out += '<text x="' + (cx + CHIP_ARROW / 2).toFixed(1) + '" y="' + ty.toFixed(1) + '" text-anchor="middle" fill="#63718f" font-size="12">→</text>'; cx += CHIP_ARROW; }
        var lbl = pretty(evs[i]), w = textW(lbl, CHIP_FONT) + CHIP_PADX * 2, col = colorOf[evs[i]] || COL.muted;
        out += '<rect x="' + cx.toFixed(1) + '" y="' + hy.toFixed(1) + '" width="' + w.toFixed(1) + '" height="' + h + '" rx="9" fill="' + col + '"/>' +
          '<text x="' + (cx + w / 2).toFixed(1) + '" y="' + ty.toFixed(1) + '" text-anchor="middle" fill="' + ink(col) + '" font-size="11" font-weight="800">' + esc(lbl) + "</text>";
        cx += w + CHIP_GAP;
      }
      return out;
    }
    // Diverging tornado plot as ONE self-contained SVG (exportable). The bar block
    // sits on the LEFT and is always visible (High grows left, Low grows right,
    // scaled to the largest share, coloured by the standardized residual); the full
    // pattern label sits to its RIGHT. The plot renders at natural width and the
    // wrapper scrolls horizontally when a long label makes it wider than the card,
    // so nothing is ever truncated and the bars stay on screen.
    function pyramidSVG(pd, rows) {
      var top = rows.slice(0, 16);
      var maxP = top.reduce(function (m, r) { return Math.max(m, r.propHigh, r.propLow); }, 0.0001);
      var LW = Math.ceil(top.reduce(function (m, r) { return Math.max(m, chipRowWidth(r.pattern)); }, 120)) + 6;
      var rowH = 30, barH = 16, headH = 30, legH = 26, padB = 6, padL = 4, gap = 22, barsW = 470, padR = 14;
      var cx = padL + barsW / 2, labelX = padL + barsW + gap, W = labelX + LW + padR;
      var H = headH + top.length * rowH + legH + padB;
      var midHalf = 15, nGap = 34, maxBar = barsW / 2 - midHalf - nGap;
      var MUT = "#93a4c9";
      var s = '<svg viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H + '" class="tna-pyr-svg" preserveAspectRatio="xMinYMin meet" xmlns="http://www.w3.org/2000/svg" font-family="Nunito, system-ui, sans-serif">';
      s += '<line x1="' + cx + '" y1="' + (headH - 8) + '" x2="' + cx + '" y2="' + (headH + top.length * rowH) + '" stroke="#25324e" stroke-width="1"/>';
      s += '<text x="' + (cx - midHalf - 4) + '" y="18" text-anchor="end" fill="' + MUT + '" font-size="11" font-weight="800">← ' + esc(pd.groupA.label) + "</text>";
      s += '<text x="' + (cx + midHalf + 4) + '" y="18" text-anchor="start" fill="' + MUT + '" font-size="11" font-weight="800">' + esc(pd.groupB.label) + " →</text>";
      s += '<text x="' + labelX + '" y="18" text-anchor="start" fill="' + MUT + '" font-size="10.5" font-weight="800" letter-spacing=".04em">PATTERN</text>';
      top.forEach(function (r, i) {
        var y = headH + i * rowH, by = y + (rowH - barH) / 2, ty = by + barH * 0.72;
        var hw = r.propHigh / maxP * maxBar, lw = r.propLow / maxP * maxBar;
        var star = starOf(r.p) || (r.p != null && r.p <= 0.05 ? "*" : "");
        s += "<g><title>" + esc(r.pattern) + "  ·  " + esc(pd.groupA.label) + " " + fmt(r.countHigh) + " (" + pct(r.propHigh) + ")  ·  " + esc(pd.groupB.label) + " " + fmt(r.countLow) + " (" + pct(r.propLow) + ")  ·  std. resid " + fmtSigned(r.stdResid, 2) + "  ·  p " + pTxt(r.p) + "</title>";
        var hRight = cx - midHalf;
        if (hw > 0.5) s += '<rect x="' + (hRight - hw).toFixed(1) + '" y="' + by + '" width="' + hw.toFixed(1) + '" height="' + barH + '" rx="3" fill="' + residColor(r.stdResid) + '"/>';
        s += '<text x="' + (hRight - hw - 5).toFixed(1) + '" y="' + ty.toFixed(1) + '" text-anchor="end" fill="' + MUT + '" font-size="10.5">' + fmt(r.countHigh) + "</text>";
        var lLeft = cx + midHalf;
        if (lw > 0.5) s += '<rect x="' + lLeft + '" y="' + by + '" width="' + lw.toFixed(1) + '" height="' + barH + '" rx="3" fill="' + residColor(-r.stdResid) + '"/>';
        s += '<text x="' + (lLeft + lw + 5).toFixed(1) + '" y="' + ty.toFixed(1) + '" text-anchor="start" fill="' + MUT + '" font-size="10.5">' + fmt(r.countLow) + "</text>";
        s += '<text x="' + cx + '" y="' + ty.toFixed(1) + '" text-anchor="middle" fill="' + MUT + '" font-size="12" font-weight="800">' + (star || "·") + "</text>";
        s += patternChipsSVG(r.pattern, labelX, y + rowH / 2);
        s += "</g>";
      });
      var ly = headH + top.length * rowH + 17;
      var t1 = "over-represented in " + pd.groupA.label, legFont = "400 11px Nunito, system-ui, sans-serif";
      s += '<rect x="' + padL + '" y="' + (ly - 9) + '" width="11" height="11" rx="2" fill="' + residColor(3) + '"/>' +
        '<text x="' + (padL + 16) + '" y="' + ly + '" fill="' + MUT + '" font-size="11">' + esc(t1) + "</text>";
      var x2 = padL + 16 + textW(t1, legFont) + 26;
      s += '<rect x="' + x2 + '" y="' + (ly - 9) + '" width="11" height="11" rx="2" fill="' + residColor(-3) + '"/>' +
        '<text x="' + (x2 + 16) + '" y="' + ly + '" fill="' + MUT + '" font-size="11">' + esc("over-represented in " + pd.groupB.label) + "</text>";
      s += "</svg>";
      return '<div class="tna-svg-wrap">' + s + "</div>";
    }
    patOutcomeSel.addEventListener("change", function () { st.patOutcome = patOutcomeSel.value; });
    container.querySelector("#tnaPatBtn").addEventListener("click", function () {
      st.patOutcome = patOutcomeSel.value;
      st.patSupport = Math.max(0.02, Math.min(0.9, parseFloat(patSupportIn.value) || 0.1)); patSupportIn.value = st.patSupport;
      patMount.innerHTML = '<div class="spin">Mining patterns…</div>';
      ctx.loadPatterns({ outcome: st.patOutcome, minSupport: st.patSupport }).then(renderPatterns).catch(function (e) { patMount.innerHTML = '<div class="empty">Pattern mining failed: ' + esc(e && e.message) + "</div>"; });
    });

    // ---- Cohort comparison (lazy) ------------------------------------------
    var cmpMount = container.querySelector("#tnaCompare");
    var cmpBySel = container.querySelector("#tnaCmpBy");
    var cmpIterIn = container.querySelector("#tnaCmpIter");
    var cmpPos = {};   // drag positions for the diff network, kept across view toggles
    function renderCompare(cd) {
      if (!cd || cd.error) {
        var msg = cd && cd.error === "not_enough_data" ? "Not enough sessions with this outcome to compare (need ≥ 8)."
          : cd && cd.error === "degenerate_split" ? "The median split is too lopsided to compare (high " + ((cd && cd.groupA) || 0) + ", low " + ((cd && cd.groupB) || 0) + ")."
          : "Comparison failed" + (cd && cd.detail ? ": " + esc(cd.detail) : "") + ".";
        cmpMount.innerHTML = '<div class="empty">' + msg + "</div>"; return;
      }
      cmpPos = {};
      var head = '<div class="small muted"><b style="color:var(--ink)">' + esc(cd.groupA.label) + "</b> (" + fmt(cd.groupA.size) + ') vs <b style="color:var(--ink)">' + esc(cd.groupB.label) + "</b> (" + fmt(cd.groupB.size) + ") · " + cd.significant + " / " + cd.total + " edges differ · " + fmt(cd.iter) + " permutations</div>";
      var actions = '<div class="tna-view-actions">' +
        '<label class="tna-switch"><input type="checkbox" id="tnaCmpSig"' + (st.cmpSigOnly ? " checked" : "") + '><span>Significant only</span></label>' +
        viewSeg(st.cmpView) + '</div>';
      cmpMount.innerHTML = '<div class="tna-view-head">' + head + actions + '</div><div id="tnaCmpBody"></div>';
      wireViewToggle(cmpMount, function () { return st.cmpView; }, function (v) { st.cmpView = v; drawCmpBody(cd); });
      var sigTog = cmpMount.querySelector("#tnaCmpSig");
      if (sigTog) sigTog.addEventListener("change", function () { st.cmpSigOnly = sigTog.checked; drawCmpBody(cd); });
      drawCmpBody(cd);
    }
    function drawCmpBody(cd) {
      var body = cmpMount.querySelector("#tnaCmpBody");
      var rows = cd.edges || [];
      if (st.cmpSigOnly) rows = rows.filter(function (e) { return e.significant; });
      if (!rows.length) {
        body.innerHTML = '<p class="muted small">' + (st.cmpSigOnly && (cd.edges || []).length ? "No significant edges — none of the transitions differ at p ≤ .05." : "No shared transitions to compare.") + "</p>";
        return;
      }
      if (st.cmpView === "table") { body.innerHTML = compareTableHTML(rows); return; }
      drawDiffNetwork(body, cd, rows);
    }
    function compareTableHTML(rows) {
      return '<div class="tbl-wrap"><table><thead><tr><th class="no-sort">From</th><th class="no-sort">To</th><th class="num">High</th><th class="num">Low</th><th class="num">Δ (H−L)</th><th class="num">Effect</th><th class="num">p</th><th class="no-sort">Sig</th></tr></thead><tbody>' +
        rows.map(function (e) {
          return "<tr" + (e.significant ? "" : ' class="tna-unstable"') + ">" + "<td>" + chip(e.from, 1) + "</td><td>" + chip(e.to, 1) + "</td>" +
            '<td class="num">' + dec(e.weightA, 2) + '</td><td class="num">' + dec(e.weightB, 2) + "</td>" +
            '<td class="num" style="color:' + (e.diff >= 0 ? "#a7e9c6" : "#ffb0b0") + '">' + fmtSigned(e.diff, 2) + "</td>" +
            '<td class="num">' + (e.effectSize != null ? dec(e.effectSize, 2) : "—") + '</td><td class="num">' + pTxt(e.pValue) + "</td>" +
            "<td>" + (e.significant ? '<span class="tna-sig">✓</span>' : '<span class="muted">·</span>') + "</td></tr>";
        }).join("") + "</tbody></table></div>";
    }
    // Cohort-difference network: same renderer as the main graph, but edges are
    // coloured by which cohort favours them and labelled with Δ + significance.
    function drawDiffNetwork(mount, cd, edges) {
      edges = edges || cd.edges;
      // Only keep states that still touch a shown edge (avoids stray nodes when
      // the "significant only" filter drops most transitions).
      var used = {}; edges.forEach(function (e) { used[e.from] = used[e.to] = 1; });
      var nodes = cd.labels.filter(function (l) { return used[l]; }).map(function (l) { return { id: l, frequency: 0, initial: 0 }; });
      buildNetwork(mount, nodes, edges, {
        W: 750, H: 600, minWeight: 0, nodeLabels: true, edgeLabels: true, posStore: cmpPos,
        edgeMag: function (e) { return Math.abs(e.diff) || 1e-6; },
        edgeColorFn: function (e) { return e.diff >= 0 ? EDGE_POS : EDGE_NEG; },
        edgeLabelFn: function (e) { return fmtSigned(e.diff, 2) + starOf(e.pValue); },
        edgeTitleFn: function (e) { return pretty(e.from) + " → " + pretty(e.to) + "  ·  High " + e.weightA.toFixed(3) + "  ·  Low " + e.weightB.toFixed(3) + "  ·  Δ " + fmtSigned(e.diff, 3) + "  ·  p=" + (e.pValue == null ? "—" : e.pValue.toFixed(3)); },
      });
      mount.insertAdjacentHTML("beforeend", '<div class="tna-legend small muted"><span><i style="background:' + EDGE_POS + '"></i> higher in ' + esc(cd.groupA.label) + "</span><span><i style=\"background:" + EDGE_NEG + '"></i> higher in ' + esc(cd.groupB.label) + "</span><span>width ∝ |Δ| · * p≤.05 ** ≤.01 *** ≤.001</span></div>");
    }
    cmpBySel.addEventListener("change", function () { st.cmpGroupBy = cmpBySel.value; });
    container.querySelector("#tnaCmpBtn").addEventListener("click", function () {
      st.cmpGroupBy = cmpBySel.value;
      st.cmpIter = Math.max(100, Math.min(2000, parseInt(cmpIterIn.value, 10) || 500)); cmpIterIn.value = st.cmpIter;
      cmpMount.innerHTML = '<div class="spin">Comparing cohorts…</div>';
      ctx.loadCompare({ groupBy: st.cmpGroupBy, iter: st.cmpIter }).then(renderCompare).catch(function (e) { cmpMount.innerHTML = '<div class="empty">Comparison failed: ' + esc(e && e.message) + "</div>"; });
    });

    // Stability card is injected as part of the diagnostics HTML; wire its
    // toggle / legend / chart now that it's in the DOM.
    if (data.stability) wireStability(data.stability);

    // After a bootstrap run the whole view re-renders (scroll resets to top);
    // jump straight to the validation table the user just asked for.
    if (st.scrollToValidation && data.validation) {
      st.scrollToValidation = false;
      setTimeout(function () {
        var el = container.querySelector("#tnaValidation");
        if (el) el.scrollIntoView({ block: "start" });
      }, 60);
    }
  }

  window.SuiteTNA = { render: render };
})();
