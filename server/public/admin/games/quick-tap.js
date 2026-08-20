/* =============================================================================
 * Per-game dashboard renderer — Quick Tap (Insights tab)
 * -----------------------------------------------------------------------------
 * Renders the payload from /games/quick-tap/specific (see
 * server/src/games-analytics/quick-tap.js): a click heatmap (where taps land,
 * hits vs misses), an accuracy / error breakdown, a reaction-time distribution
 * and warm-up curve, and a per-player speed-vs-accuracy scatter that visually
 * separates the behaviour profiles the demo data is built around.
 *
 * Charts are self-contained inline SVG with native <title> tooltips (no JS
 * wiring needed after innerHTML); the reaction histogram reuses the shared
 * interactive barChart from the SuiteDash toolkit.
 * ========================================================================== */
(function () {
  "use strict";

  window.SuiteGameRenderers = window.SuiteGameRenderers || {};
  window.SuiteGameRenderers["quick-tap"] = function (data, D) {
    var esc = D.esc, fmt = D.fmt, pct = D.pct, dec = D.dec, COL = D.COL;
    var T = data.totals || {};

    // ---- helpers -----------------------------------------------------------
    function hexRgb(h) { h = String(h).replace("#", ""); if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
    function rgba(hex, a) { var c = hexRgb(hex); return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a.toFixed(3) + ")"; }

    // Heatmap: GX×GY grid, cell opacity ∝ count / shared-max so hits and misses
    // are directly comparable. A dark base rect sits under each coloured cell.
    function heatmap(grid, color, max) {
      var gx = data.heatmap.gx, gy = data.heatmap.gy;
      var cw = 30, ch = 26, W = gx * cw, H = gy * ch;
      var s = '<svg viewBox="0 0 ' + W + " " + H + '" class="tna-seqsvg qt-heat" preserveAspectRatio="xMidYMid meet">';
      s += '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="#0b1120" rx="8"/>';
      for (var cy = 0; cy < gy; cy++) {
        for (var cx = 0; cx < gx; cx++) {
          var v = grid[cy * gx + cx] || 0, t = max ? v / max : 0;
          var x = cx * cw, y = cy * ch;
          s += '<rect x="' + (x + 1) + '" y="' + (y + 1) + '" width="' + (cw - 2) + '" height="' + (ch - 2) + '" rx="3" fill="' + (v ? rgba(color, 0.14 + 0.86 * t) : "rgba(255,255,255,0.02)") + '">' +
            (v ? "<title>" + v + (v === 1 ? " tap" : " taps") + "</title>" : "") + "</rect>";
        }
      }
      s += "</svg>";
      return s;
    }

    // ---- tiles -------------------------------------------------------------
    var html = "";
    html += '<div class="tiles">' +
      D.tile("Taps", fmt(T.taps)) +
      D.tile("Hits", fmt(T.hits)) +
      D.tile("Accuracy", T.accuracy == null ? "—" : pct(T.accuracy, 1)) +
      D.tile("Miss rate", T.missRate == null ? "—" : pct(T.missRate, 1)) +
      D.tile("Avg reaction", T.avgReaction == null ? "—" : fmt(Math.round(T.avgReaction)) + "<small> ms</small>") +
      D.tile("Fastest", T.fastestReaction == null ? "—" : fmt(T.fastestReaction) + "<small> ms</small>") +
      "</div>";

    // ---- click heatmap (hits | misses) ------------------------------------
    var hasSpatial = data.heatmap && (data.heatmap.max > 0);
    var heatBody = hasSpatial
      ? '<div class="qt-heat-wrap">' +
          '<div class="qt-heat-col"><div class="qt-heat-head"><span class="dot" style="background:' + COL.green + '"></span>Hits</div>' + heatmap(data.heatmap.hits, COL.green, data.heatmap.max) + "</div>" +
          '<div class="qt-heat-col"><div class="qt-heat-head"><span class="dot" style="background:' + COL.red + '"></span>Misses</div>' + heatmap(data.heatmap.misses, COL.red, data.heatmap.max) + "</div>" +
        "</div>"
      : '<p class="muted small">No positional data. Play Quick Tap (or reseed the demo) to record where taps land.</p>';
    html += D.card("Click heatmap", "Where taps land on the play area. Hits (green) cluster toward the centre where targets appear; misses (red) scatter to the edges. Both grids share one colour scale.", heatBody);

    // ---- accuracy / errors + reaction distribution ------------------------
    html += '<div class="grid2">';
    var errBody = '<div class="tiles">' +
      D.miniTile("Hits", fmt(T.hits)) + D.miniTile("Misses", fmt(T.misses)) + D.miniTile("Expired", fmt(T.expires)) + "</div>" +
      D.hBars([
        { label: "Hits", value: T.hits || 0, color: COL.green },
        { label: "Misses", value: T.misses || 0, color: COL.red },
        { label: "Expired", value: T.expires || 0, color: COL.orange },
      ], { labelW: 90 });
    html += D.card("Accuracy & errors", "Every target outcome: tapped (hit), tapped-but-off (miss), or timed out (expired).", errBody);

    var rtBody = (data.reactionHistogram && data.reactionHistogram.some(function (b) { return b.value; }))
      ? D.barChart(data.reactionHistogram.map(function (b) { return { label: b.bucket, value: b.value }; }), { color: COL.blue })
      : '<p class="muted small">No reaction-time data.</p>';
    html += D.card("Reaction time (ms)", "Distribution of how quickly targets were tapped, in milliseconds. Faster players sit to the left.", rtBody);
    html += "</div>";

    // ---- warm-up curve + speed vs accuracy --------------------------------
    html += '<div class="grid2">';
    html += D.card("Reaction over a round", "Mean reaction time by the target's position in the round (1st, 2nd, 3rd…). Reveals warm-up early and fatigue late.", warmupSvg(data.warmup, D));
    html += D.card("Speed vs accuracy by player", "One dot per player: reaction time (x) against accuracy (y), dot size ∝ taps. The corners are the behaviour profiles — fast-and-accurate (top-left) through slow-and-inaccurate (bottom-right).", scatterSvg(data.players, D));
    html += "</div>";

    return html;
  };

  // Static SVG line: mean reaction (y) by target ordinal (x).
  function warmupSvg(pts, D) {
    var COL = D.COL, dec = D.dec, esc = D.esc;
    if (!pts || pts.length < 2) return '<p class="muted small">Not enough data for a warm-up curve.</p>';
    var W = 700, H = 220, pad = { l: 48, r: 14, t: 14, b: 30 };
    var xs = pts.map(function (p) { return p.n; }), ys = pts.map(function (p) { return p.reaction; });
    var xmin = Math.min.apply(null, xs), xmax = Math.max.apply(null, xs);
    var ymin = Math.min.apply(null, ys), ymax = Math.max.apply(null, ys);
    ymin = Math.max(0, ymin - 30); ymax = ymax + 30;
    var X = function (v) { return pad.l + (W - pad.l - pad.r) * (xmax === xmin ? 0.5 : (v - xmin) / (xmax - xmin)); };
    var Y = function (v) { return H - pad.b - (H - pad.t - pad.b) * (v - ymin) / (ymax - ymin || 1); };
    var s = '<svg viewBox="0 0 ' + W + " " + H + '" class="tna-seqsvg" preserveAspectRatio="xMidYMin meet">';
    for (var g = 0; g <= 4; g++) { var gv = ymin + (ymax - ymin) * g / 4, gy = Y(gv); s += '<line x1="' + pad.l + '" y1="' + gy.toFixed(1) + '" x2="' + (W - pad.r) + '" y2="' + gy.toFixed(1) + '" stroke="' + COL.line + '" opacity=".5"/><text x="' + (pad.l - 6) + '" y="' + (gy + 3).toFixed(1) + '" fill="' + COL.muted + '" font-size="10" text-anchor="end">' + Math.round(gv) + "</text>"; }
    var d = pts.map(function (p, i) { return (i ? "L" : "M") + X(p.n).toFixed(1) + " " + Y(p.reaction).toFixed(1); }).join(" ");
    s += '<path d="' + d + " L" + X(xmax).toFixed(1) + " " + Y(ymin).toFixed(1) + " L" + X(xmin).toFixed(1) + " " + Y(ymin).toFixed(1) + ' Z" fill="' + COL.gold + '" opacity="0.10"/>';
    s += '<path d="' + d + '" fill="none" stroke="' + COL.gold + '" stroke-width="2.4" stroke-linejoin="round"/>';
    pts.forEach(function (p) { s += '<circle cx="' + X(p.n).toFixed(1) + '" cy="' + Y(p.reaction).toFixed(1) + '" r="3.2" fill="' + COL.gold + '" stroke="#0b1120" stroke-width="1.2"><title>target #' + p.n + " · " + dec(p.reaction, 0) + " ms · " + p.count + " taps</title></circle>"; });
    s += '<text x="' + ((pad.l + W - pad.r) / 2) + '" y="' + (H - 4) + '" fill="' + COL.muted + '" font-size="10" text-anchor="middle">target # within the round →</text>';
    s += '<text x="12" y="' + ((pad.t + H - pad.b) / 2) + '" fill="' + COL.muted + '" font-size="10" text-anchor="middle" transform="rotate(-90 12 ' + ((pad.t + H - pad.b) / 2) + ')">reaction (ms)</text>';
    s += "</svg>";
    return s;
  }

  // Static SVG scatter: reaction (x) vs accuracy (y), one dot per player.
  function scatterSvg(players, D) {
    var COL = D.COL, esc = D.esc, pct = D.pct, fmt = D.fmt;
    players = (players || []).filter(function (p) { return p.avgReaction != null && p.accuracy != null; });
    if (players.length < 2) return '<p class="muted small">Not enough players with reaction data.</p>';
    var W = 700, H = 260, pad = { l: 48, r: 16, t: 14, b: 34 };
    var xs = players.map(function (p) { return p.avgReaction; });
    var xmin = Math.min.apply(null, xs) - 20, xmax = Math.max.apply(null, xs) + 20;
    var ymin = 0, ymax = 1, tmax = Math.max.apply(null, players.map(function (p) { return p.taps; })) || 1;
    var X = function (v) { return pad.l + (W - pad.l - pad.r) * (xmax === xmin ? 0.5 : (v - xmin) / (xmax - xmin)); };
    var Y = function (v) { return H - pad.b - (H - pad.t - pad.b) * (v - ymin) / (ymax - ymin); };
    var s = '<svg viewBox="0 0 ' + W + " " + H + '" class="tna-seqsvg" preserveAspectRatio="xMidYMid meet">';
    for (var g = 0; g <= 4; g++) { var gy = pad.t + (H - pad.t - pad.b) * g / 4, gv = ymax - (ymax - ymin) * g / 4; s += '<line x1="' + pad.l + '" y1="' + gy.toFixed(1) + '" x2="' + (W - pad.r) + '" y2="' + gy.toFixed(1) + '" stroke="' + COL.line + '" opacity=".5"/><text x="' + (pad.l - 6) + '" y="' + (gy + 3).toFixed(1) + '" fill="' + COL.muted + '" font-size="10" text-anchor="end">' + Math.round(gv * 100) + "%</text>"; }
    players.forEach(function (p) {
      var r = 4 + 7 * Math.sqrt(p.taps / tmax);
      s += '<circle cx="' + X(p.avgReaction).toFixed(1) + '" cy="' + Y(p.accuracy).toFixed(1) + '" r="' + r.toFixed(1) + '" fill="' + COL.purple + '" opacity="0.6" stroke="' + COL.purple + '" stroke-width="1"><title>' + esc(p.username) + " · " + Math.round(p.avgReaction) + " ms · acc " + pct(p.accuracy, 0) + " · " + fmt(p.taps) + " taps</title></circle>";
    });
    s += '<text x="' + ((pad.l + W - pad.r) / 2) + '" y="' + (H - 4) + '" fill="' + COL.muted + '" font-size="10" text-anchor="middle">avg reaction (ms) — faster is left →</text>';
    s += '<text x="12" y="' + ((pad.t + H - pad.b) / 2) + '" fill="' + COL.muted + '" font-size="10" text-anchor="middle" transform="rotate(-90 12 ' + ((pad.t + H - pad.b) / 2) + ')">accuracy →</text>';
    s += "</svg>";
    return s;
  }
})();
