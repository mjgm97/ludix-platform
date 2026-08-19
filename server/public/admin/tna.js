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
    function ink(hex) { var h = hex.replace("#", ""); if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16); return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.62 ? "#0b1120" : "#fff"; }
    function pretty(t) { return String(t).replace(/[_\-]+/g, " ").replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }
    function chip(id, sm) { var c = colorOf[id] || COL.muted; return '<span class="tna-chip' + (sm ? " sm" : "") + '" style="background:' + c + ';color:' + ink(c) + '">' + esc(pretty(id)) + "</span>"; }

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
    html += '<div class="tna-ctl push"><label>Validation</label><div class="tna-valctl">' +
      '<input type="number" id="tnaIter" min="50" max="2000" step="50" value="' + (st.iter || 300) + '" title="bootstrap iterations">' +
      '<button class="btn sm' + (st.bootstrap ? " ghost" : "") + '" id="tnaBoot">' + (st.bootstrap ? "Re-run bootstrap" : "Run bootstrap") + '</button></div></div>';
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

    // ---- Sequence index plot (paginated) ------------------------------------
    html += '<div class="card"><div class="card-head"><h3>Sequence index plot</h3><span class="pill">' + fmt(data.sequencesTotal) + " sessions</span></div>" +
      '<p class="cap">Each row is one session; each cell is the activity at that ordinal step. Reads left→right in play order (first ' + data.seqLenCap + " steps). Page through every session with the controls below.</p>" +
      '<div id="tnaSeq" class="tna-seq-wrap"></div>' +
      '<div class="tna-seq-pager"><button class="btn sm ghost" id="tnaSeqPrev">← Prev</button>' +
      '<span class="small muted" id="tnaSeqRange"></span>' +
      '<button class="btn sm ghost" id="tnaSeqNext">Next →</button></div></div>';

    // ---- Clustering ---------------------------------------------------------
    var selOpts = function (list, cur) { return list.map(function (o) { return '<option value="' + o[0] + '"' + (o[0] === cur ? " selected" : "") + ">" + esc(o[1]) + "</option>"; }).join(""); };
    var ALGOS = [["kmeans", "k-means"], ["pam", "k-medoids (PAM)"], ["hierarchical", "Hierarchical"]];
    var DISS = [["euclidean", "Euclidean"], ["manhattan", "Manhattan"], ["cosine", "Cosine"], ["jensenshannon", "Jensen–Shannon"], ["sequence", "Sequence (edit distance)"]];
    var LINKS = [["average", "Average"], ["complete", "Complete"], ["ward", "Ward"], ["single", "Single"]];
    html += '<div class="card"><div class="card-head"><h3>Clustering</h3><span class="pill">group sessions</span></div>' +
      '<p class="cap">Group sessions by how students move through the game, then compare each cluster’s transition network and sequences. Pick a dissimilarity (feature-space vectors, or the raw sequence order) and an algorithm. Colours match the legend above.</p>' +
      '<div class="tna-controls" style="padding:2px 0 8px">' +
      '<div class="tna-ctl"><label>Algorithm</label><select id="tnaAlgo">' + selOpts(ALGOS, st.clAlgo || "kmeans") + "</select></div>" +
      '<div class="tna-ctl" id="tnaDissCtl"><label>Dissimilarity</label><select id="tnaDiss">' + selOpts(DISS, st.clDiss || "euclidean") + "</select></div>" +
      '<div class="tna-ctl" id="tnaLinkCtl"><label>Linkage</label><select id="tnaLink">' + selOpts(LINKS, st.clLink || "average") + "</select></div>" +
      '<div class="tna-ctl"><label>Clusters (k)</label><input type="number" id="tnaK" min="2" max="8" step="1" value="' + (st.k || 3) + '" style="width:74px"></div>' +
      '<div class="tna-ctl"><label>&nbsp;</label><button class="btn sm" id="tnaClusterBtn">Run clustering</button></div>' +
      '<div class="tna-ctl push"><label>State labels</label><label class="tna-switch"><input type="checkbox" id="tnaClNodeLbl"' + (st.clNodeLabels !== false ? " checked" : "") + '><span>Show</span></label></div>' +
      '<div class="tna-ctl"><label>Edge labels</label><label class="tna-switch"><input type="checkbox" id="tnaClEdgeLbl"' + (st.clEdgeLabels !== false ? " checked" : "") + '><span>Show</span></label></div>' +
      '</div><div id="tnaClusters"></div></div>';

    // ---- Validation ---------------------------------------------------------
    html += '<div id="tnaValidation">' + validationHTML(data.validation) + "</div>";

    container.innerHTML = html;

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
      var maxW = edges.reduce(function (m, e) { return Math.max(m, e.probability); }, 0) || 1;
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
      var shown = edges.filter(function (e) { return e.probability >= thr; });
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
        // Thin edges (per the reference); width still nudges with weight but
        // stays in a slim range. Opacity carries most of the weight signal.
        var wpx = 0.9 + (e.probability / maxW) * 2.1;
        var op = 0.4 + 0.55 * (e.probability / maxW);
        var path = svgEl("path", { "class": self ? "tna-loop" : "tna-edge", "data-f": e.from, "data-t": e.to, fill: "none", stroke: EDGE_GOLD, "stroke-width": wpx.toFixed(1), "stroke-linecap": "round", opacity: op.toFixed(2) });
        var ttl = svgEl("title"); ttl.textContent = pretty(e.from) + " → " + pretty(e.to) + "  ·  p=" + e.probability.toFixed(3) + "  ·  n=" + e.count; path.appendChild(ttl);
        var arrow = svgEl("path", { "class": "tna-arrow", "data-f": e.from, "data-t": e.to, fill: EDGE_GOLD, opacity: Math.min(1, op + 0.12).toFixed(2) });
        gEdges.appendChild(path); gEdges.appendChild(arrow);
        var o = { e: e, self: self, wpx: wpx, path: path, arrow: arrow, label: null };
        if (showLabels && e.probability / maxW >= labelMin) {
          var lbl = svgEl("text", { "class": "tna-elabel", "data-f": e.from, "data-t": e.to, "text-anchor": "middle" });
          lbl.textContent = edgeLabel(e, weightMode); gLabels.appendChild(lbl); o.label = lbl;
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
    function mountFreq(mount, nodes) {
      var items = nodes.slice().sort(function (a, b) { return b.frequency - a.frequency; });
      if (!items.length) { mount.innerHTML = '<p class="muted small">No activities to chart.</p>'; return; }
      var maxV = items.reduce(function (m, x) { return Math.max(m, x.frequency); }, 1);
      var total = items.reduce(function (t, x) { return t + x.frequency; }, 0) || 1;
      var rows = items.map(function (it) {
        var c = colorOf[it.id] || COL.muted, w = Math.max(2, it.frequency / maxV * 100);
        return '<div class="tna-hbar" data-id="' + esc(it.id) + '" tabindex="0">' +
          '<div class="hb-name" style="color:' + c + '">' + esc(pretty(it.id)) + "</div>" +
          '<div class="hb-track"><i style="width:' + w.toFixed(1) + "%;background:" + c + '"></i></div>' +
          '<div class="hb-val">' + fmt(it.frequency) + "</div></div>";
      }).join("");
      mount.innerHTML = '<div class="tna-hbars">' + rows + '<div class="chart-tip" id="tnaFreqTip" style="display:none"></div></div>';

      var wrap = mount.querySelector(".tna-hbars"), tip = mount.querySelector("#tnaFreqTip");
      [].forEach.call(wrap.querySelectorAll(".tna-hbar"), function (row) {
        var id = row.getAttribute("data-id");
        var it = items.filter(function (x) { return String(x.id) === id; })[0];
        function enter() { if (netApi) netApi.isolate(id, true); }
        function leave() { tip.style.display = "none"; if (netApi) netApi.isolate(id, false); }
        function move(e) {
          tip.innerHTML = '<div class="r"><i style="background:' + (colorOf[id] || COL.muted) + '"></i>' + esc(pretty(id)) + " · <b>" + fmt(it.frequency) + "</b> events · " + pct(it.frequency / total) + "</div>";
          tip.style.display = "block";
          var hr = wrap.getBoundingClientRect();
          var x = e.clientX - hr.left, y = e.clientY - hr.top;
          tip.style.left = Math.min(wrap.clientWidth - tip.offsetWidth - 6, Math.max(6, x + 14)) + "px";
          tip.style.top = Math.max(4, y - tip.offsetHeight - 8) + "px";
        }
        row.addEventListener("mouseenter", enter);
        row.addEventListener("mousemove", move);
        row.addEventListener("mouseleave", leave);
        row.addEventListener("focus", enter);
        row.addEventListener("blur", leave);
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
      // Linkage only applies to hierarchical; k-means is fixed to Euclidean.
      linkCtl.style.display = algoSel.value === "hierarchical" ? "" : "none";
      var isK = algoSel.value === "kmeans";
      dissSel.disabled = isK; dissCtl.style.opacity = isK ? 0.45 : 1;
      dissCtl.title = isK ? "k-means uses Euclidean distance in feature space" : "";
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

    // Keep the last cluster payload + per-cluster drag positions so the label
    // toggles below can re-render locally (no re-fetch, no extra DB load).
    var lastClusterData = null, clusterPos = {};
    function renderClusters(cd) {
      // A fresh result (different object) resets drag positions; a label-toggle
      // re-render passes the same object and keeps whatever's been arranged.
      if (cd && cd.clusters && cd !== lastClusterData) { lastClusterData = cd; clusterPos = {}; }
      if (!cd || cd.error === "not_enough_sequences") {
        clusterMount.innerHTML = '<div class="empty">Not enough sessions to cluster — need at least ' + ((cd && cd.kRequested) || 2) + " sessions with transitions" + (cd ? " (have " + fmt(cd.usableSessions || 0) + ")" : "") + ".<br><span class=\"small\">Widen the date range or clear the player filter.</span></div>";
        return;
      }
      var cls = cd.clusters || [];
      if (!cls.length) { clusterMount.innerHTML = '<p class="muted small">No clusters produced.</p>'; return; }
      var M = cd.method || {}, Q = cd.quality || {};
      var algoName = { kmeans: "k-means", pam: "k-medoids", hierarchical: "hierarchical" }[M.algorithm] || M.algorithm || "";
      var dissName = { euclidean: "Euclidean", manhattan: "Manhattan", cosine: "Cosine", jensenshannon: "Jensen–Shannon", sequence: "edit distance" }[M.dissimilarity] || M.dissimilarity || "";
      var head = '<div class="tna-cluster-head small muted"><b style="color:var(--ink)">' + esc(algoName) + (M.linkage ? " · " + esc(M.linkage) : "") + "</b> · " + esc(dissName) +
        " · " + cd.k + " clusters over " + fmt(cd.n) + " sessions" + (cd.sampledFrom ? " (sampled from " + fmt(cd.sampledFrom) + ")" : "") +
        (Q.silhouette != null ? ' · silhouette <b style="color:var(--ink)">' + dec(Q.silhouette, 3) + "</b>" : "") +
        (Q.sse != null ? " · SSE " + dec(Q.sse, 2) : "") + "</div>";
      var cards = cls.map(function (cl) {
        var top = cl.topStates.map(function (s2) { return chip(s2, 1); }).join(" ");
        return '<div class="card tna-cluster"><div class="card-head"><h3>Cluster ' + cl.label + "</h3>" +
          '<span class="pill go">' + fmt(cl.size) + " · " + pct(cl.share) + "</span><span class=\"spacer\"></span>" +
          '<span class="small muted">' + cl.stats.states + " states · " + cl.stats.distinctTransitions + " edges</span></div>" +
          '<div class="tna-cluster-top">' + top + "</div>" +
          '<div class="tna-cnet" data-net="' + cl.label + '"></div>' +
          '<div class="tna-cseq-label">Sequences</div><div class="tna-seq-wrap tna-cseq" data-seq="' + cl.label + '"></div></div>';
      }).join("");
      clusterMount.innerHTML = head + '<div class="grid2">' + cards + "</div>";
      // Mount each cluster's network + sequence plot (shared colours + helpers).
      cls.forEach(function (cl) {
        var nm = clusterMount.querySelector('[data-net="' + cl.label + '"]');
        if (nm) {
          clusterPos[cl.label] = clusterPos[cl.label] || {};
          buildNetwork(nm, cl.nodes, cl.edges, { W: 520, H: 400, nodeLabels: st.clNodeLabels !== false, edgeLabels: st.clEdgeLabels !== false, edgeLabelMin: 0, weightMode: cd.weightMode, nodeR: 15, ringW: 4, posStore: clusterPos[cl.label] });
        }
        var sm = clusterMount.querySelector('[data-seq="' + cl.label + '"]');
        if (sm) sm.innerHTML = seqSVG(cl.sequences, { total: cl.size, maxRows: 14, rowH: 9 });
      });
    }

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
