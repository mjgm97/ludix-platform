/* =============================================================================
 * Ludix Analytics — dashboard client (vanilla, no build, no CDN)
 * Charts are hand-rolled inline SVG so the page is fully self-contained.
 * ========================================================================== */
(function () {
  "use strict";

  // ---- tiny helpers ---------------------------------------------------------
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var COL = { gold: "#ffd54a", green: "#4ad6a0", blue: "#5aa9ff", red: "#ff6b6b", orange: "#ff8a5a", purple: "#b18aff", muted: "#93a4c9", line: "#25324e" };
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]; }); }
  function fmt(n) { if (n == null || isNaN(n)) return "—"; return Number(n).toLocaleString(); }
  function pct(x, d) { return x == null || isNaN(x) ? "—" : (x * 100).toFixed(d == null ? 0 : d) + "%"; }
  function dec(x, d) { return x == null || isNaN(x) ? "—" : Number(x).toFixed(d == null ? 2 : d); }
  function shortDay(s) { return s ? String(s).slice(5) : ""; }
  function qs(o) { var p = []; for (var k in o) if (o[k] != null && o[k] !== "") p.push(k + "=" + encodeURIComponent(o[k])); return p.length ? "?" + p.join("&") : ""; }

  // ---- colour + label helpers (games, activities) ---------------------------
  var PALETTE = ["#ff6b6b", "#5aa9ff", "#4ad6a0", "#b18aff", "#ff9f43", "#f78fb3", "#ffd54a", "#63d3c4", "#8ad36b", "#e779c1", "#7c9cff", "#ffa8a8", "#9d7bff", "#ff7eb6"];
  function hashStr(s) { var h = 0; s = String(s); for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
  function gameColor(id) { return PALETTE[hashStr(id) % PALETTE.length]; }
  function hexRgb(h) { h = String(h).replace("#", ""); if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]; }
  function inkOn(h) { var c = hexRgb(h); return (0.299 * c[0] + 0.587 * c[1] + 0.114 * c[2]) / 255 > 0.62 ? "#0b1120" : "#ffffff"; }
  function titleCase(s) { return String(s).replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim().replace(/\b\w/g, function (c) { return c.toUpperCase(); }); }
  function prettyGame(id) { return titleCase(id).replace(/\bAi\b/g, "AI").replace(/\bMl\b/g, "ML").replace(/\bId\b/g, "ID").replace(/\bVr\b/g, "VR").replace(/\bXp\b/g, "XP"); }
  function prettyAct(t) { return titleCase(t); }

  function api(path) {
    return fetch("/api/admin" + path, { credentials: "same-origin" }).then(function (r) {
      if (r.status === 401) { showLogin(); throw new Error("unauthorized"); }
      if (!r.ok) return r.json().catch(function () { return {}; }).then(function (e) { throw new Error(e.error || ("http_" + r.status)); });
      return r.json();
    });
  }
  function post(path, body) {
    return fetch("/api/admin" + path, {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}),
    });
  }
  function del(path) {
    return fetch("/api/admin" + path, { method: "DELETE", credentials: "same-origin" })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.detail || d.error || ("http_" + r.status)); return d; }); });
  }

  // ---- state ----------------------------------------------------------------
  var state = { user: null, games: [], players: [], gameId: null, from: "", to: "", player: "", tab: "overview" };

  // =========================================================================
  // INTERACTIVE CHARTS
  // Charts return a placeholder slot string; after the HTML is inserted,
  // flushCharts() mounts the interactive SVG (hover tooltips, toggle legends,
  // animated draw-in) into each slot.
  // =========================================================================
  function niceMax(m) { if (m <= 1) return 1; var p = Math.pow(10, Math.floor(Math.log10(m))); var f = m / p; var n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10; return n * p; }
  function emptyBox(h) { return '<svg viewBox="0 0 740 ' + h + '"><text x="370" y="' + (h / 2) + '" fill="#5f6d8a" font-size="13" text-anchor="middle">No data in range</text></svg>'; }
  function legendRow(items) { return '<div class="legend">' + items.map(function (i) { return '<span><i style="background:' + i.color + '"></i>' + esc(i.label) + '</span>'; }).join("") + "</div>"; }

  var pendingCharts = [];
  function chart(mountFn) { var id = "ch" + Math.random().toString(36).slice(2, 9); pendingCharts.push({ id: id, fn: mountFn }); return '<div class="chart" id="' + id + '"></div>'; }
  function flushCharts() { var list = pendingCharts; pendingCharts = []; list.forEach(function (c) { var el = document.getElementById(c.id); if (el) try { c.fn(el); } catch (e) { /* chart never breaks the page */ } }); }

  function positionTip(tip, host, e) {
    var hr = host.getBoundingClientRect();
    var x = e.clientX - hr.left, y = e.clientY - hr.top;
    tip.style.left = Math.min(host.clientWidth - tip.offsetWidth - 6, Math.max(6, x + 14)) + "px";
    tip.style.top = Math.max(4, y - tip.offsetHeight - 8) + "px";
  }

  // ---- Interactive line chart (multi-series, hover guideline, toggle legend)
  function lineChart(data, xKey, lines, opts) {
    opts = opts || {};
    return chart(function (host) {
      var W = 740, H = opts.h || 220, pad = { l: 46, r: 14, t: 14, b: 26 };
      var active = {}; lines.forEach(function (l) { active[l.key] = true; });
      var plot = document.createElement("div"); host.appendChild(plot);
      var tip = document.createElement("div"); tip.className = "chart-tip"; tip.style.display = "none"; host.appendChild(tip);
      var leg = document.createElement("div"); leg.className = "legend"; host.appendChild(leg);
      var vfmt = opts.fmt || fmt;

      function redraw() {
        var shown = lines.filter(function (l) { return active[l.key]; });
        if (!data.length) { plot.innerHTML = emptyBox(H); return; }
        var max = 0; shown.forEach(function (l) { data.forEach(function (d) { var v = +d[l.key]; if (!isNaN(v) && v > max) max = v; }); });
        var nm = niceMax(max || 1), n = data.length;
        var X = function (i) { return pad.l + (W - pad.l - pad.r) * (n === 1 ? 0.5 : i / (n - 1)); };
        var Y = function (v) { return H - pad.b - (H - pad.t - pad.b) * ((+v || 0) / nm); };
        var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="ichart">';
        for (var g = 0; g <= 4; g++) { var gv = nm * g / 4, gy = Y(gv); s += '<line x1="' + pad.l + '" y1="' + gy + '" x2="' + (W - pad.r) + '" y2="' + gy + '" stroke="' + COL.line + '" opacity=".5"/><text x="' + (pad.l - 6) + '" y="' + (gy + 3) + '" fill="' + COL.muted + '" font-size="10" text-anchor="end">' + (nm >= 10 ? Math.round(gv) : Math.round(gv * 100) / 100) + '</text>'; }
        shown.forEach(function (l, li) {
          var d = data.map(function (row, i) { return (i ? "L" : "M") + X(i).toFixed(1) + " " + Y(row[l.key]).toFixed(1); }).join(" ");
          s += '<path d="' + d + '" fill="none" stroke="' + l.color + '" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" class="cline" style="animation-delay:' + (li * 0.08) + 's"/>';
        });
        [0, Math.floor((n - 1) / 2), n - 1].filter(function (v, i, a) { return a.indexOf(v) === i; }).forEach(function (i) { s += '<text x="' + X(i) + '" y="' + (H - 8) + '" fill="' + COL.muted + '" font-size="10" text-anchor="middle">' + esc(shortDay(data[i][xKey])) + '</text>'; });
        s += '<line class="fline" x1="0" y1="' + pad.t + '" x2="0" y2="' + (H - pad.b) + '" stroke="' + COL.gold + '" stroke-width="1" opacity="0"/>';
        shown.forEach(function (l) { s += '<circle class="fd fd-' + l.key + '" r="4.5" fill="' + l.color + '" stroke="#0b1120" stroke-width="1.5" opacity="0"/>'; });
        s += "</svg>";
        plot.innerHTML = s;
        var svg = plot.querySelector("svg"), fl = svg.querySelector(".fline"), fds = {};
        shown.forEach(function (l) { fds[l.key] = svg.querySelector(".fd-" + l.key); });
        svg.addEventListener("mousemove", function (e) {
          var r = svg.getBoundingClientRect(), vx = (e.clientX - r.left) / r.width * W;
          var i = Math.max(0, Math.min(n - 1, Math.round((vx - pad.l) / (W - pad.l - pad.r) * (n - 1))));
          var gx = X(i); fl.setAttribute("x1", gx); fl.setAttribute("x2", gx); fl.setAttribute("opacity", ".5");
          var rows = "";
          shown.forEach(function (l) { var val = data[i][l.key], dot = fds[l.key]; dot.setAttribute("cx", gx); dot.setAttribute("cy", Y(val)); dot.setAttribute("opacity", val == null ? "0" : "1"); rows += '<div class="r"><i style="background:' + l.color + '"></i>' + esc(l.label) + ': <b>' + (val == null ? "—" : vfmt(val)) + "</b></div>"; });
          tip.innerHTML = '<div class="small muted">' + esc(String(data[i][xKey])) + "</div>" + rows;
          tip.style.display = "block"; positionTip(tip, host, e);
        });
        svg.addEventListener("mouseleave", function () { tip.style.display = "none"; fl.setAttribute("opacity", "0"); Object.keys(fds).forEach(function (k) { fds[k].setAttribute("opacity", "0"); }); });
      }
      leg.innerHTML = lines.map(function (l) { return '<span class="tog" data-k="' + l.key + '"><i style="background:' + l.color + '"></i>' + esc(l.label) + "</span>"; }).join("");
      [].forEach.call(leg.querySelectorAll(".tog"), function (t) {
        t.addEventListener("click", function () {
          var k = t.getAttribute("data-k"), on = lines.filter(function (l) { return active[l.key]; }).length;
          if (active[k] && on <= 1) return;            // keep at least one series
          active[k] = !active[k]; t.classList.toggle("off", !active[k]); redraw();
        });
      });
      redraw();
    });
  }

  // ---- Interactive completion funnel (hover a level for the breakdown) ------
  function funnelChart(rows) {
    return chart(function (host) {
      var W = 740, H = 240, pad = { l: 40, r: 14, t: 14, b: 34 };
      var plot = document.createElement("div"); host.appendChild(plot);
      var tip = document.createElement("div"); tip.className = "chart-tip"; tip.style.display = "none"; host.appendChild(tip);
      if (!rows.length) { plot.innerHTML = emptyBox(H); return; }
      var max = 0; rows.forEach(function (r) { if (r.started > max) max = r.started; });
      var nm = niceMax(max), n = rows.length, bw = Math.min(70, (W - pad.l - pad.r) / n * 0.6);
      var Y = function (v) { return H - pad.b - (H - pad.t - pad.b) * (v / nm); };
      var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="ichart">';
      for (var g = 0; g <= 4; g++) { var gy = Y(nm * g / 4); s += '<line x1="' + pad.l + '" y1="' + gy + '" x2="' + (W - pad.r) + '" y2="' + gy + '" stroke="' + COL.line + '" opacity=".5"/><text x="' + (pad.l - 6) + '" y="' + (gy + 3) + '" fill="' + COL.muted + '" font-size="10" text-anchor="end">' + Math.round(nm * g / 4) + "</text>"; }
      rows.forEach(function (r, i) {
        var cx = pad.l + (W - pad.l - pad.r) * ((i + 0.5) / n), x = cx - bw / 2;
        var inProg = Math.max(0, r.started - r.completed - r.abandoned);
        var y = H - pad.b, seg = [[r.completed, COL.green], [r.abandoned, COL.red], [inProg, COL.line]];
        seg.forEach(function (p, si) { if (p[0] <= 0) return; var h = (H - pad.t - pad.b) * (p[0] / nm); y -= h; s += '<rect class="cbar" data-lvl="' + i + '" x="' + x + '" y="' + y.toFixed(1) + '" width="' + bw + '" height="' + h.toFixed(1) + '" fill="' + p[1] + '" rx="3" style="animation-delay:' + (i * 0.05 + si * 0.03) + 's"/>'; });
        s += '<text x="' + cx + '" y="' + (H - 18) + '" fill="' + COL.muted + '" font-size="11" text-anchor="middle">Lvl ' + esc(r.level) + "</text>";
        s += '<text x="' + cx + '" y="' + (H - 6) + '" fill="' + COL.muted + '" font-size="10" text-anchor="middle">' + (r.completionRate == null ? "" : pct(r.completionRate)) + "</text>";
      });
      s += "</svg>"; plot.innerHTML = s;
      var svg = plot.querySelector("svg");
      [].forEach.call(svg.querySelectorAll(".cbar"), function (bar) {
        bar.addEventListener("mousemove", function (e) {
          var r = rows[+bar.getAttribute("data-lvl")];
          tip.innerHTML = '<div class="small muted">Level ' + esc(r.level) + '</div><div class="r"><i style="background:' + COL.green + '"></i>Completed: <b>' + r.completed + '</b></div><div class="r"><i style="background:' + COL.red + '"></i>Abandoned: <b>' + r.abandoned + '</b></div><div class="r"><i style="background:' + COL.line + '"></i>Started: <b>' + r.started + '</b></div><div class="small" style="margin-top:3px">Completion <b>' + (r.completionRate == null ? "—" : pct(r.completionRate)) + "</b></div>";
          tip.style.display = "block"; positionTip(tip, host, e);
        });
        bar.addEventListener("mouseleave", function () { tip.style.display = "none"; });
      });
    });
  }

  // ---- Interactive donut (hover a slice to pop it out + tooltip) ------------
  function donutChart(items) {
    return chart(function (host) {
      var S = 160, r = 62, ir = 36, cx = S / 2, cy = S / 2, total = items.reduce(function (a, b) { return a + b.value; }, 0);
      host.style.maxWidth = "190px"; host.style.margin = "0 auto";
      var plot = document.createElement("div"); host.appendChild(plot);
      var tip = document.createElement("div"); tip.className = "chart-tip"; tip.style.display = "none"; host.appendChild(tip);
      if (!total) { plot.innerHTML = emptyBox(150); return; }
      var a0 = -Math.PI / 2, s = '<svg viewBox="0 0 ' + S + ' ' + S + '" class="ichart">';
      items.forEach(function (it, idx) {
        if (it.value <= 0) return;
        var a1 = a0 + Math.PI * 2 * (it.value / total), large = (a1 - a0) > Math.PI ? 1 : 0, mid = (a0 + a1) / 2;
        var x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0), x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
        var dx = Math.cos(mid) * 5, dy = Math.sin(mid) * 5;
        s += '<path class="dseg" data-i="' + idx + '" data-dx="' + dx.toFixed(2) + '" data-dy="' + dy.toFixed(2) + '" d="M ' + cx + ' ' + cy + ' L ' + x0.toFixed(1) + ' ' + y0.toFixed(1) + " A " + r + " " + r + " 0 " + large + " 1 " + x1.toFixed(1) + " " + y1.toFixed(1) + ' Z" fill="' + it.color + '" opacity="0.92"/>';
        a0 = a1;
      });
      s += '<circle cx="' + cx + '" cy="' + cy + '" r="' + ir + '" fill="#0e1626"/><text class="dtot" x="' + cx + '" y="' + (cy + 5) + '" fill="#eef2ff" font-size="18" font-weight="700" text-anchor="middle">' + total + "</text></svg>";
      plot.innerHTML = s;
      var svg = plot.querySelector("svg"), tot = svg.querySelector(".dtot");
      [].forEach.call(svg.querySelectorAll(".dseg"), function (seg) {
        var it = items[+seg.getAttribute("data-i")];
        seg.addEventListener("mousemove", function (e) {
          seg.setAttribute("transform", "translate(" + seg.getAttribute("data-dx") + "," + seg.getAttribute("data-dy") + ")");
          tot.textContent = it.value;
          tip.innerHTML = '<div class="r"><i style="background:' + it.color + '"></i>' + esc(it.label) + ': <b>' + it.value + "</b> (" + pct(it.value / total) + ")</div>";
          tip.style.display = "block"; positionTip(tip, host, e);
        });
        seg.addEventListener("mouseleave", function () { seg.removeAttribute("transform"); tot.textContent = total; tip.style.display = "none"; });
      });
    });
  }

  // ---- Interactive vertical bar chart (histograms, hour-of-day) -------------
  function barChart(items, opts) {
    opts = opts || {};
    return chart(function (host) {
      var W = 740, H = opts.h || 200, pad = { l: 40, r: 12, t: 14, b: 30 };
      var plot = document.createElement("div"); host.appendChild(plot);
      var tip = document.createElement("div"); tip.className = "chart-tip"; tip.style.display = "none"; host.appendChild(tip);
      if (!items.length) { plot.innerHTML = emptyBox(H); return; }
      var color = opts.color || COL.blue, vfmt = opts.fmt || fmt;
      var max = 0; items.forEach(function (it) { if (it.value > max) max = it.value; });
      var nm = niceMax(max || 1), n = items.length, slot = (W - pad.l - pad.r) / n, gap = n > 16 ? 1.5 : 4, bw = Math.max(2, slot - gap);
      var Y = function (v) { return H - pad.b - (H - pad.t - pad.b) * (v / nm); };
      var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="ichart">';
      for (var g = 0; g <= 4; g++) { var gy = Y(nm * g / 4); s += '<line x1="' + pad.l + '" y1="' + gy + '" x2="' + (W - pad.r) + '" y2="' + gy + '" stroke="' + COL.line + '" opacity=".5"/><text x="' + (pad.l - 6) + '" y="' + (gy + 3) + '" fill="' + COL.muted + '" font-size="10" text-anchor="end">' + (nm >= 10 ? Math.round(nm * g / 4) : Math.round(nm * g / 4 * 100) / 100) + "</text>"; }
      items.forEach(function (it, i) {
        var x = pad.l + i * slot + gap / 2, h = (H - pad.t - pad.b) * (it.value / nm), y = H - pad.b - h;
        s += '<rect class="cbar" data-i="' + i + '" x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.max(0, h).toFixed(1) + '" rx="2" fill="' + (it.color || color) + '" style="animation-delay:' + (i * 0.015) + 's"/>';
      });
      var step = Math.max(1, Math.ceil(n / (opts.maxLabels || 12)));
      items.forEach(function (it, i) { if (i % step !== 0 && i !== n - 1) return; var cx = pad.l + i * slot + slot / 2; s += '<text x="' + cx.toFixed(1) + '" y="' + (H - 12) + '" fill="' + COL.muted + '" font-size="10" text-anchor="middle">' + esc(it.label) + "</text>"; });
      s += "</svg>"; plot.innerHTML = s;
      var svg = plot.querySelector("svg");
      [].forEach.call(svg.querySelectorAll(".cbar"), function (bar) {
        var it = items[+bar.getAttribute("data-i")];
        bar.addEventListener("mousemove", function (e) { tip.innerHTML = '<div class="r"><i style="background:' + (it.color || color) + '"></i>' + esc(it.tip || it.label) + ": <b>" + vfmt(it.value) + "</b></div>"; tip.style.display = "block"; positionTip(tip, host, e); });
        bar.addEventListener("mouseleave", function () { tip.style.display = "none"; });
      });
    });
  }

  // ---- Horizontal category bars (HTML, animated fill + hover) ---------------
  function hBars(items, opts) {
    opts = opts || {}; if (!items.length) return '<p class="muted small">No data.</p>';
    var max = Math.max.apply(null, items.map(function (i) { return i.value; })) || 1;
    return '<div>' + items.map(function (it) {
      return '<div title="' + esc(it.label + ": " + it.value) + '" style="display:flex;align-items:center;gap:10px;margin:6px 0">' +
        '<div class="small" style="width:' + (opts.labelW || 120) + 'px;color:var(--muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + esc(it.label) + "</div>" +
        '<div class="bar-mini" style="flex:1"><i style="width:' + (it.value / max * 100) + "%;background:" + (it.color || COL.blue) + '"></i></div>' +
        '<div class="small" style="width:52px;text-align:right;font-variant-numeric:tabular-nums">' + fmt(it.value) + "</div></div>";
    }).join("") + "</div>";
  }

  // ---- Research charts: numeric-axis line + XY scatter + Lorenz curve -------
  // Hand-rolled inline SVG like the charts above; these take numeric x (attempt,
  // day, share) instead of day-strings, and add a mean/reference line.
  function xyLine(points, opts) {
    opts = opts || {};
    return chart(function (host) {
      var W = 740, H = opts.h || 210, pad = { l: 46, r: 14, t: 14, b: 30 };
      var plot = document.createElement("div"); host.appendChild(plot);
      var tip = document.createElement("div"); tip.className = "chart-tip"; tip.style.display = "none"; host.appendChild(tip);
      if (!points.length) { plot.innerHTML = emptyBox(H); return; }
      var col = opts.color || COL.gold, vfmt = opts.yfmt || fmt, xfmt = opts.xfmt || function (v) { return String(v); };
      var xs = points.map(function (p) { return p.x; }), ys = points.map(function (p) { return p.y; });
      var xmin = Math.min.apply(null, xs), xmax = Math.max.apply(null, xs);
      var ymax = opts.ymax != null ? opts.ymax : niceMax(Math.max.apply(null, ys) || 1), ymin = opts.ymin != null ? opts.ymin : 0;
      var n = points.length;
      var X = function (v) { return pad.l + (W - pad.l - pad.r) * (xmax === xmin ? 0.5 : (v - xmin) / (xmax - xmin)); };
      var Y = function (v) { return H - pad.b - (H - pad.t - pad.b) * ((v - ymin) / (ymax - ymin || 1)); };
      var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="ichart">';
      for (var g = 0; g <= 4; g++) { var gv = ymin + (ymax - ymin) * g / 4, gy = Y(gv); s += '<line x1="' + pad.l + '" y1="' + gy + '" x2="' + (W - pad.r) + '" y2="' + gy + '" stroke="' + COL.line + '" opacity=".5"/><text x="' + (pad.l - 6) + '" y="' + (gy + 3) + '" fill="' + COL.muted + '" font-size="10" text-anchor="end">' + esc(vfmt(gv)) + "</text>"; }
      if (opts.mean != null) { var my = Y(opts.mean); s += '<line x1="' + pad.l + '" y1="' + my.toFixed(1) + '" x2="' + (W - pad.r) + '" y2="' + my.toFixed(1) + '" stroke="' + COL.muted + '" stroke-dasharray="4 4" opacity=".6"/>'; }
      var d = points.map(function (p, i) { return (i ? "L" : "M") + X(p.x).toFixed(1) + " " + Y(p.y).toFixed(1); }).join(" ");
      if (opts.area) { s += '<path d="' + d + " L" + X(points[n - 1].x).toFixed(1) + " " + Y(ymin).toFixed(1) + " L" + X(points[0].x).toFixed(1) + " " + Y(ymin).toFixed(1) + ' Z" fill="' + col + '" opacity="0.10"/>'; }
      s += '<path d="' + d + '" fill="none" stroke="' + col + '" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round" class="cline"/>';
      points.forEach(function (p) { s += '<circle class="xyd" data-x="' + p.x + '" cx="' + X(p.x).toFixed(1) + '" cy="' + Y(p.y).toFixed(1) + '" r="3.6" fill="' + col + '" stroke="#0b1120" stroke-width="1.4"/>'; });
      var ticks = points.filter(function (_, i) { return n <= 12 || i % Math.ceil(n / 12) === 0 || i === n - 1; });
      ticks.forEach(function (p) { s += '<text x="' + X(p.x).toFixed(1) + '" y="' + (H - 10) + '" fill="' + COL.muted + '" font-size="10" text-anchor="middle">' + esc(xfmt(p.x)) + "</text>"; });
      if (opts.xlabel) s += '<text x="' + ((pad.l + W - pad.r) / 2) + '" y="' + (H - 0.5) + '" fill="' + COL.muted + '" font-size="10" text-anchor="middle">' + esc(opts.xlabel) + "</text>";
      s += "</svg>"; plot.innerHTML = s;
      var svg = plot.querySelector("svg");
      [].forEach.call(svg.querySelectorAll(".xyd"), function (dot) {
        var p = points[[].indexOf.call(svg.querySelectorAll(".xyd"), dot)];
        dot.addEventListener("mousemove", function (e) { tip.innerHTML = '<div class="small muted">' + esc((opts.xlabel || "x") + " " + xfmt(p.x)) + '</div><div class="r"><i style="background:' + col + '"></i>' + esc(opts.ylabel || "y") + ": <b>" + vfmt(p.y) + "</b>" + (p.n != null ? ' <span class="muted">(n=' + p.n + ")</span>" : "") + "</div>"; tip.style.display = "block"; positionTip(tip, host, e); });
        dot.addEventListener("mouseleave", function () { tip.style.display = "none"; });
      });
    });
  }
  function scatterXY(points, opts) {
    opts = opts || {};
    return chart(function (host) {
      var W = 740, H = opts.h || 260, pad = { l: 48, r: 14, t: 14, b: 34 };
      var plot = document.createElement("div"); host.appendChild(plot);
      var tip = document.createElement("div"); tip.className = "chart-tip"; tip.style.display = "none"; host.appendChild(tip);
      if (!points.length) { plot.innerHTML = emptyBox(H); return; }
      var col = opts.color || COL.blue, xfmt = opts.xfmt || dec, yfmt = opts.yfmt || dec;
      var xs = points.map(function (p) { return p.x; }), ys = points.map(function (p) { return p.y; });
      var xmin = Math.min.apply(null, xs), xmax = Math.max.apply(null, xs), ymin = Math.min.apply(null, ys), ymax = Math.max.apply(null, ys);
      if (xmax === xmin) xmax = xmin + 1; if (ymax === ymin) ymax = ymin + 1;
      var X = function (v) { return pad.l + (W - pad.l - pad.r) * (v - xmin) / (xmax - xmin); };
      var Y = function (v) { return H - pad.b - (H - pad.t - pad.b) * (v - ymin) / (ymax - ymin); };
      var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" class="ichart">';
      for (var g = 0; g <= 4; g++) { var gy = pad.t + (H - pad.t - pad.b) * g / 4, gv = ymax - (ymax - ymin) * g / 4; s += '<line x1="' + pad.l + '" y1="' + gy.toFixed(1) + '" x2="' + (W - pad.r) + '" y2="' + gy.toFixed(1) + '" stroke="' + COL.line + '" opacity=".5"/><text x="' + (pad.l - 6) + '" y="' + (gy + 3).toFixed(1) + '" fill="' + COL.muted + '" font-size="10" text-anchor="end">' + esc(yfmt(gv)) + "</text>"; }
      // least-squares trend line
      if (opts.trend !== false) {
        var n = points.length, sx = 0, sy = 0, sxx = 0, sxy = 0; points.forEach(function (p) { sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; });
        var den = n * sxx - sx * sx; if (den !== 0) { var b1 = (n * sxy - sx * sy) / den, b0 = (sy - b1 * sx) / n; s += '<line x1="' + X(xmin).toFixed(1) + '" y1="' + Y(b0 + b1 * xmin).toFixed(1) + '" x2="' + X(xmax).toFixed(1) + '" y2="' + Y(b0 + b1 * xmax).toFixed(1) + '" stroke="' + COL.gold + '" stroke-width="2" opacity="0.85"/>'; }
      }
      points.forEach(function (p, i) { s += '<circle class="scd" data-i="' + i + '" cx="' + X(p.x).toFixed(1) + '" cy="' + Y(p.y).toFixed(1) + '" r="3.1" fill="' + col + '" opacity="0.62"/>'; });
      s += '<text x="' + ((pad.l + W - pad.r) / 2) + '" y="' + (H - 4) + '" fill="' + COL.muted + '" font-size="10" text-anchor="middle">' + esc(opts.xlabel || "x") + " →</text>";
      s += '<text x="12" y="' + ((pad.t + H - pad.b) / 2) + '" fill="' + COL.muted + '" font-size="10" text-anchor="middle" transform="rotate(-90 12 ' + ((pad.t + H - pad.b) / 2) + ')">' + esc(opts.ylabel || "y") + " →</text>";
      s += "</svg>"; plot.innerHTML = s;
      var svg = plot.querySelector("svg");
      [].forEach.call(svg.querySelectorAll(".scd"), function (dot) {
        var p = points[+dot.getAttribute("data-i")];
        dot.addEventListener("mousemove", function (e) { tip.innerHTML = '<div class="r">' + esc(opts.xlabel || "x") + ": <b>" + xfmt(p.x) + "</b></div><div class=\"r\">" + esc(opts.ylabel || "y") + ": <b>" + yfmt(p.y) + "</b></div>"; tip.style.display = "block"; positionTip(tip, host, e); });
        dot.addEventListener("mouseleave", function () { tip.style.display = "none"; });
      });
    });
  }
  function lorenzChart(lorenz) {
    return chart(function (host) {
      var S = 260, pad = 34;
      var plot = document.createElement("div"); host.appendChild(plot);
      var tip = document.createElement("div"); tip.className = "chart-tip"; tip.style.display = "none"; host.appendChild(tip);
      if (!lorenz || !lorenz.length) { plot.innerHTML = emptyBox(S); return; }
      host.style.maxWidth = "320px";
      var X = function (v) { return pad + v * (S - pad - 10); }, Y = function (v) { return (S - pad) - v * (S - pad - 10); };
      var s = '<svg viewBox="0 0 ' + S + ' ' + S + '" class="ichart">';
      s += '<line x1="' + pad + '" y1="' + (S - pad) + '" x2="' + (S - 10) + '" y2="' + (S - pad) + '" stroke="' + COL.line + '"/><line x1="' + pad + '" y1="' + (S - pad) + '" x2="' + pad + '" y2="10" stroke="' + COL.line + '"/>';
      s += '<line x1="' + X(0) + '" y1="' + Y(0) + '" x2="' + X(1) + '" y2="' + Y(1) + '" stroke="' + COL.muted + '" stroke-dasharray="4 4" opacity=".6"/>';
      var d = lorenz.map(function (p, i) { return (i ? "L" : "M") + X(p.p).toFixed(1) + " " + Y(p.cum).toFixed(1); }).join(" ");
      s += '<path d="' + d + " L" + X(1).toFixed(1) + " " + Y(0).toFixed(1) + ' Z" fill="' + COL.purple + '" opacity="0.12"/>';
      s += '<path d="' + d + '" fill="none" stroke="' + COL.purple + '" stroke-width="2.4"/>';
      s += '<text x="' + (S / 2) + '" y="' + (S - 6) + '" fill="' + COL.muted + '" font-size="10" text-anchor="middle">share of players →</text>';
      s += '<text x="12" y="' + (S / 2) + '" fill="' + COL.muted + '" font-size="10" text-anchor="middle" transform="rotate(-90 12 ' + (S / 2) + ')">share of events →</text>';
      s += "</svg>"; plot.innerHTML = s;
    });
  }

  // =========================================================================
  // AUTH
  // =========================================================================
  function showLogin() { $("#app").classList.add("hidden"); $("#login").classList.remove("hidden"); setTimeout(function () { var e = $("#lu"); if (e) e.focus(); }, 30); }
  function showApp() { $("#login").classList.add("hidden"); $("#app").classList.remove("hidden"); }

  $("#loginForm").addEventListener("submit", function (e) {
    e.preventDefault();
    $("#loginErr").textContent = "";
    post("/login", { username: $("#lu").value.trim(), password: $("#lp").value }).then(function (r) {
      if (r.ok) return r.json().then(function (d) { state.user = d.user; boot(); });
      if (r.status === 429) { $("#loginErr").textContent = "Too many attempts — wait a few minutes."; return; }
      $("#loginErr").textContent = "Invalid username or password.";
    }).catch(function () { $("#loginErr").textContent = "Network error."; });
  });
  $("#logout").addEventListener("click", function () { post("/logout").then(function () { location.reload(); }); });

  // =========================================================================
  // FILTERS
  // =========================================================================
  function readFilters() {
    state.gameId = $("#fGame").value || null;
    state.from = $("#fFrom").value || "";
    state.to = $("#fTo").value || "";
    state.player = $("#fUser").value.trim() || "";
  }
  function filterQS(extra) { return qs(Object.assign({ from: state.from, to: state.to, user: state.player }, extra || {})); }

  // Manual date entry clears the quick-range preset (custom range now active).
  function clearPreset() { [].forEach.call($("#presets").children, function (c) { c.classList.remove("active"); }); }

  function bindFilters() {
    ["change"].forEach(function (ev) {
      $("#fFrom").addEventListener(ev, function () { clearPreset(); readFilters(); render(); });
      $("#fTo").addEventListener(ev, function () { clearPreset(); readFilters(); render(); });
    });

    // Clicking anywhere on a date field opens the native picker (nicer target).
    [].forEach.call(document.querySelectorAll(".datefield"), function (df) {
      df.addEventListener("click", function () { var i = df.querySelector("input"); if (i && i.showPicker) try { i.showPicker(); } catch (e) {} });
    });

    $("#presets").addEventListener("click", function (e) {
      var b = e.target.closest("[data-days]"); if (!b) return;
      [].forEach.call(this.children, function (c) { c.classList.remove("active"); }); b.classList.add("active");
      var days = +b.getAttribute("data-days");
      if (!days) { $("#fFrom").value = ""; $("#fTo").value = ""; }
      else { var to = new Date(), from = new Date(Date.now() - days * 864e5); $("#fTo").value = to.toISOString().slice(0, 10); $("#fFrom").value = from.toISOString().slice(0, 10); }
      readFilters(); render();
    });
  }

  // ---- Custom game dropdown (styled combobox synced to a hidden <select>) ----
  var gameDD = null;
  function initGameDropdown() {
    var btn = $("#gameBtn"), menu = $("#gameMenu"), sel = $("#fGame"), wrap = $("#gameDD");
    var caret = '<svg class="dd-caret" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>';
    function ava(id) { var c = gameColor(id); return '<span class="ava" style="background:' + c + ';color:' + inkOn(c) + '">' + esc(String(id || "?").slice(0, 1).toUpperCase()) + '</span>'; }
    function paint() {
      var id = sel.value;
      if (!id) { btn.innerHTML = '<span class="dd-name muted">No games yet</span>' + caret; return; }
      btn.innerHTML = ava(id) + '<span class="dd-name">' + esc(prettyGame(id)) + '</span>' + caret;
    }
    function buildMenu() {
      var id = sel.value, gs = state.games || [];
      menu.innerHTML = gs.length ? gs.map(function (g) {
        return '<button type="button" class="dd-opt' + (g.gameId === id ? " sel" : "") + '" data-g="' + esc(g.gameId) + '" role="option">' +
          ava(g.gameId) +
          '<span class="dd-opt-main"><span class="dd-opt-name">' + esc(prettyGame(g.gameId)) + '</span></span>' +
          (g.hasSpecific ? '<span class="dd-badge" title="Has game-specific insights">✦</span>' : '') +
          (g.gameId === id ? '<svg class="dd-check" viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>' : '') + '</button>';
      }).join("") : '<div class="dd-empty">No games with data yet.</div>';
      [].forEach.call(menu.querySelectorAll("[data-g]"), function (o) {
        o.addEventListener("click", function () { sel.value = o.getAttribute("data-g"); $("#fUser").value = ""; paint(); close(); readFilters(); loadUsers(); render(); });
      });
    }
    function open() { buildMenu(); menu.classList.add("open"); btn.classList.add("open"); setTimeout(function () { document.addEventListener("click", onDoc); }, 0); }
    function close() { menu.classList.remove("open"); btn.classList.remove("open"); document.removeEventListener("click", onDoc); }
    function onDoc(e) { if (!wrap.contains(e.target)) close(); }
    btn.addEventListener("click", function (e) { e.stopPropagation(); (menu.classList.contains("open") ? close : open)(); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
    return { refresh: paint };
  }

  // Re-fetch the game list and refresh the game selector in place (used after an
  // import/delete so a new or emptied game shows up without a page reload). When
  // `preferGameId` is given and present, it becomes the active game.
  function syncGames(preferGameId, cb) {
    return api("/overview").then(function (d) {
      state.games = d.games || [];
      var sel = $("#fGame");
      if (sel) sel.innerHTML = state.games.length
        ? state.games.map(function (g) { return '<option value="' + esc(g.gameId) + '">' + esc(g.gameId) + "</option>"; }).join("")
        : '<option value="">(no games yet)</option>';
      var has = function (id) { return state.games.some(function (g) { return g.gameId === id; }); };
      if (preferGameId && has(preferGameId)) state.gameId = preferGameId;
      else if (!has(state.gameId)) state.gameId = state.games.length ? state.games[0].gameId : null;
      if (sel && state.gameId) sel.value = state.gameId;
      if (gameDD) gameDD.refresh();
      loadUsers();
      if (cb) cb();
    }).catch(function () {});
  }

  function loadUsers() {
    if (!state.gameId) { state.players = []; if (userDD) userDD.rebuild(); return; }
    // Player roster respects the date range but NOT the player filter itself, so
    // you can always switch to a different player from the dropdown.
    api("/games/" + encodeURIComponent(state.gameId) + "/players" + qs({ from: state.from, to: state.to, light: 1 })).then(function (d) {
      state.players = (d.players || []).slice().sort(function (a, b) { return b.events - a.events; });
      if (userDD) userDD.rebuild();
    }).catch(function () { state.players = []; if (userDD) userDD.rebuild(); });
  }

  // ---- Custom player dropdown (searchable, synced to a hidden input) --------
  var userDD = null;
  function initPlayerDropdown() {
    var btn = $("#userBtn"), menu = $("#userMenu"), wrap = $("#userDD"), hidden = $("#fUser"),
      label = $("#userBtnLabel"), searchIn = $("#userSearchIn"), list = $("#userList");
    // Selection is a comma-joined list of usernames (multi-select). Helpers keep
    // it deduped case-insensitively and in a stable order.
    function selected() { return hidden.value.split(",").map(function (s) { return s.trim(); }).filter(Boolean); }
    function setSelected(arr) {
      var seen = {}, out = [];
      arr.forEach(function (u) { var k = String(u).toLowerCase(); if (u && !seen[k]) { seen[k] = 1; out.push(u); } });
      hidden.value = out.join(",");
    }
    function toggle(u) {
      var cur = selected(), lc = u.toLowerCase(), i = cur.map(function (x) { return x.toLowerCase(); }).indexOf(lc);
      if (i >= 0) cur.splice(i, 1); else cur.push(u);
      setSelected(cur);
    }
    function paint() {
      var sel = selected();
      label.textContent = sel.length === 0 ? "All players" : sel.length === 1 ? sel[0] : sel.length + " players";
      label.classList.toggle("muted", sel.length === 0);
      btn.classList.toggle("picked", sel.length > 0);
    }
    function av(u) { var c = gameColor(u); return '<span class="ava" style="background:' + c + ';color:' + inkOn(c) + '">' + esc(String(u).slice(0, 1).toUpperCase()) + '</span>'; }
    var check = '<svg class="dd-check" viewBox="0 0 24 24"><path d="M5 12l5 5 9-10"/></svg>';
    function paintList(filter) {
      var f = (filter || "").toLowerCase();
      var selSet = {}; selected().forEach(function (u) { selSet[u.toLowerCase()] = 1; });
      var noneSel = !selected().length;
      var ps = (state.players || []).filter(function (p) { return !f || p.username.toLowerCase().indexOf(f) >= 0; });
      var html = '<button type="button" class="dd-opt' + (noneSel ? " sel" : "") + '" data-u="" role="option"><span class="pall">All players</span>' + (noneSel ? check : "") + "</button>";
      html += ps.map(function (p) {
        var on = !!selSet[p.username.toLowerCase()];
        return '<button type="button" class="dd-opt' + (on ? " sel" : "") + '" data-u="' + esc(p.username) + '" role="option">' +
          av(p.username) +
          '<span class="dd-opt-main"><span class="dd-opt-name">' + esc(p.username) + '</span>' +
          '<span class="dd-opt-sub">' + fmt(p.events) + ' events · ' + fmt(p.sessions) + ' sessions</span></span>' +
          (on ? check : "") + "</button>";
      }).join("");
      if (!ps.length) html += '<div class="dd-empty">No players match “' + esc(filter) + '”.</div>';
      list.innerHTML = html;
      [].forEach.call(list.querySelectorAll("[data-u]"), function (o) {
        o.addEventListener("click", function (e) {
          e.stopPropagation();
          var u = o.getAttribute("data-u");
          if (!u) setSelected([]);      // "All players" clears the whole selection
          else toggle(u);               // toggle one player; menu stays open for more
          paint(); readFilters(); render();
          paintList(searchIn.value);    // refresh checkmarks in place
        });
      });
    }
    function open() { paintList(""); searchIn.value = ""; menu.classList.add("open"); btn.classList.add("open"); setTimeout(function () { document.addEventListener("click", onDoc); searchIn.focus(); }, 0); }
    function close() { menu.classList.remove("open"); btn.classList.remove("open"); document.removeEventListener("click", onDoc); }
    function onDoc(e) { if (!wrap.contains(e.target)) close(); }
    btn.addEventListener("click", function (e) { e.stopPropagation(); (menu.classList.contains("open") ? close : open)(); });
    searchIn.addEventListener("click", function (e) { e.stopPropagation(); });
    searchIn.addEventListener("input", function () { paintList(searchIn.value); });
    searchIn.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); var first = list.querySelector("[data-u]"); if (first) first.click(); }
    });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
    return { refresh: paint, rebuild: function () { paint(); if (menu.classList.contains("open")) paintList(searchIn.value); } };
  }

  // =========================================================================
  // TABS + ROUTER
  // =========================================================================
  $("#tabs").addEventListener("click", function (e) {
    var b = e.target.closest("[data-tab]"); if (!b) return;
    [].forEach.call(this.children, function (c) { c.classList.remove("active"); }); b.classList.add("active");
    state.tab = b.getAttribute("data-tab"); render();
  });

  function render() {
    var v = $("#view"); v.innerHTML = '<div class="spin">Loading…</div>';
    pendingCharts = [];                       // drop any slots from a prior render
    var t = state.tab;
    if (t === "overview") return renderOverview(v);
    if (t === "import") return renderImport(v);   // works even with no games (bootstrap)
    if (!state.gameId && t !== "accounts") { v.innerHTML = '<div class="empty">No games with data yet. Once a game submits runs, it appears here.</div>'; return; }
    if (t === "general") return renderGeneral(v);
    if (t === "process") return renderProcess(v);
    if (t === "tna") return renderTNA(v);
    if (t === "predict") return renderPredict(v);
    if (t === "insights") return renderInsights(v);
    if (t === "players") return renderPlayers(v);
    if (t === "events") return renderEvents(v);
    if (t === "export") return renderExport(v);
    if (t === "accounts") return renderAccounts(v);
  }

  // ---- Overview -------------------------------------------------------------
  function renderOverview(v) {
    api("/overview").then(function (d) {
      var t = d.totals;
      var tiles = [["Games", t.games], ["Players", t.players], ["Sessions", d.games.reduce(function (a, g) { return a + (g.sessions || 0); }, 0)], ["Runs", t.runs], ["Events", t.events], ["Admins", t.admins]];
      var html = '<div class="tiles">' + tiles.map(function (x) { return tile(x[0], fmt(x[1])); }).join("") + "</div>";
      html += '<div class="card"><div class="card-head"><h3>Games with data</h3></div><div class="tbl-wrap"><table><thead><tr>' +
        '<th class="no-sort">Game</th><th class="num">Players</th><th class="num">Sessions</th><th class="num">Runs</th><th class="num">Events</th><th class="no-sort">Last activity</th><th class="no-sort"></th></tr></thead><tbody>' +
        (d.games.length ? d.games.map(function (g) {
          return '<tr class="clickable" data-game="' + esc(g.gameId) + '"><td><b>' + esc(g.gameId) + '</b></td><td class="num">' + fmt(g.players) + '</td><td class="num">' + fmt(g.sessions) + '</td><td class="num">' + fmt(g.runs) + '</td><td class="num">' + fmt(g.events) + '</td><td class="muted small">' + esc((g.lastSeen || "").slice(0, 16)) + '</td><td><span class="pill">open →</span></td></tr>';
        }).join("") : '<tr><td colspan="7" class="muted">No games yet.</td></tr>') + "</tbody></table></div></div>";
      v.innerHTML = html;
      [].forEach.call(v.querySelectorAll("[data-game]"), function (row) {
        row.addEventListener("click", function () { $("#fGame").value = row.getAttribute("data-game"); if (gameDD) gameDD.refresh(); readFilters(); loadUsers(); gotoTab("general"); });
      });
    }).catch(errBox(v));
  }

  // ---- General (game-agnostic) dashboard ------------------------------------
  function renderGeneral(v) {
    var g = encodeURIComponent(state.gameId);
    Promise.all([api("/games/" + g + "/summary" + filterQS()), api("/games/" + g + "/timeseries" + filterQS()), api("/games/" + g + "/research" + filterQS())]).then(function (res) {
      var s = res[0], ts = res[1].series, R = res[2], T = s.tiles;
      var html = '<div class="tiles">' +
        tile("Players", fmt(T.players)) + tile("Sessions", fmt(T.sessions)) + tile("Events", fmt(T.events)) + tile("Runs", fmt(T.runs)) +
        tile("Avg session", T.avgSessionMin == null ? "—" : T.avgSessionMin + "<small> min</small>") +
        tile("Events / session", T.avgEventsPerSession == null ? "—" : dec(T.avgEventsPerSession, 1)) +
        tile("Returning", T.returningRate == null ? "—" : pct(T.returningRate)) + "</div>";

      if (s.hasSpecific) html += '<div class="card" style="padding:12px 16px;display:flex;align-items:center;gap:10px"><span class="pill" style="background:#16351f;border-color:#2b5c3a;color:#8ee6b0">✦ ' + esc(s.specificLabel || "Game insights") + '</span><span class="small muted">This game has a dedicated analytics view — open the <b>' + esc(s.specificLabel || "Insights") + '</b> tab.</span></div>';

      html += '<div class="grid2">';
      html += card("Activity over time", "Daily events, sessions and runs. Click the legend to toggle series; hover for values.",
        lineChart(ts, "day", [{ key: "events", color: COL.blue, label: "Events" }, { key: "sessions", color: COL.green, label: "Sessions" }, { key: "runs", color: COL.gold, label: "Runs" }]));
      html += card("New vs returning players", "Active players each day, and how many were brand new.",
        lineChart(ts, "day", [{ key: "players", color: COL.green, label: "Active players" }, { key: "newPlayers", color: COL.gold, label: "New players" }]));
      html += "</div>";

      html += '<div class="grid2">';
      html += card("Score distribution", "How runs are spread across the score range.",
        barChart(s.scoreHistogram.map(function (b) { return { label: b.bucket, value: b.value }; }), { color: COL.green }));
      html += card("Session length", "How long a play session lasts (from first to last event).",
        barChart(s.sessionLength.map(function (b) { return { label: b.bucket, value: b.value }; }), { color: COL.blue }));
      html += "</div>";

      html += '<div class="grid2">';
      html += card("Activity by hour of day", "When students play (UTC hour).",
        barChart(s.hourly.map(function (h) { return { label: String(h.hour), tip: h.hour + ":00", value: h.value }; }), { color: COL.purple, maxLabels: 12 }));
      html += card("Most active players", "Top players by event volume. Full list in the Players tab.",
        hBars(s.topPlayers.map(function (p) { return { label: p.username, value: p.events, color: COL.blue }; }), { labelW: 130 }));
      html += "</div>";

      html += renderResearch(R);
      v.innerHTML = html;
      flushCharts();
    }).catch(errBox(v));
  }

  // ---- Research analytics (learning-analytics oriented, game-agnostic) -------
  function renderResearch(R) {
    R = R || {};
    var lc = R.learningCurve || [], ef = R.effort || {}, ret = R.retention || [], en = R.engagement || {};
    var needScore = '<p class="muted small">Needs per-run score data. Import a <b>Score</b>/<b>Stars</b> column, or use a game that records scores.</p>';
    var html = '<div class="section-head"><h2>Research analytics</h2><span class="small muted">Learning-analytics metrics derived from the generic event + score log — useful across serious games.</span></div>';
    // Scores are game-specific (0–1, 0–100, points…), so format numerically rather
    // than as a percentage. Compact: integers plain, small values to 2 decimals.
    var numFmt = function (v) { return v == null ? "—" : (Math.abs(v) >= 10 ? fmt(Math.round(v)) : dec(v, 2)); };

    // Learning curve
    var lcBody = lc.length
      ? xyLine(lc.map(function (r) { return { x: r.attempt, y: r.avg, n: r.n }; }),
          { color: COL.gold, area: true, ymin: 0, yfmt: numFmt, xfmt: function (v) { return String(v); }, xlabel: "attempt", ylabel: "mean score" })
      : needScore;
    html += card("Learning curve", "Mean score by attempt number (a player's 1st, 2nd, 3rd… run). Rising = players improve with practice. Only attempts with ≥3 players shown.", lcBody);

    // Effort vs performance
    html += '<div class="grid2">';
    var efBody;
    if (ef.n && ef.scatter && ef.scatter.length) {
      efBody = '<div class="tiles" style="margin-bottom:10px">' +
        tile("r (duration→score)", ef.rDurationScore == null ? "—" : dec(ef.rDurationScore, 2)) +
        tile("r (events→score)", ef.rEventsScore == null ? "—" : dec(ef.rEventsScore, 2)) +
        tile("Runs", fmt(ef.n)) + "</div>" +
        scatterXY(ef.scatter.map(function (p) { return { x: p.durMin, y: p.score }; }),
          { color: COL.blue, xlabel: "session minutes", ylabel: "score", yfmt: numFmt, xfmt: function (v) { return dec(v, 1); } });
    } else efBody = needScore;
    html += card("Effort vs performance", "Does time-on-task relate to achievement? Each dot is a run: session length vs score, with a trend line and Pearson r.", efBody);

    // Retention (survival)
    var retBody = ret.length
      ? xyLine(ret.map(function (r) { return { x: r.day, y: r.retained }; }),
          { color: COL.green, area: true, ymin: 0, ymax: 1, yfmt: function (v) { return pct(v, 0); }, xfmt: function (v) { return String(v) + "d"; }, xlabel: "days after first play", ylabel: "still returning" })
      : '<p class="muted small">No player activity in range.</p>';
    html += card("Player retention", "Share of players who keep returning at least N days after their first play — a survival curve for engagement.", retBody);
    html += "</div>";

    // Engagement distribution (Lorenz + Gini)
    var enBody;
    if (en.lorenz && en.lorenz.length) {
      var giniPct = en.gini == null ? null : Math.round(en.gini * 100);
      enBody = '<div style="display:flex;flex-wrap:wrap;gap:18px;align-items:center">' +
        '<div style="flex:0 0 auto">' + lorenzChart(en.lorenz) + "</div>" +
        '<div style="flex:1 1 200px">' +
        '<div class="tiles">' + tile("Gini", en.gini == null ? "—" : dec(en.gini, 2)) + tile("Players", fmt(en.players)) + "</div>" +
        '<p class="muted small" style="margin-top:8px">Gini 0 = every player contributes equally; 1 = a single player accounts for all activity.' +
        (giniPct != null ? " Here the most active players drive a disproportionate share of events." : "") + "</p></div></div>";
    } else enBody = '<p class="muted small">No player activity in range.</p>';
    html += card("Engagement distribution", "How evenly participation is spread across players (Lorenz curve + Gini). The further the curve bows below the diagonal, the more a few players dominate.", enBody);

    return html;
  }

  // ---- Process / sequence mining -------------------------------------------
  function renderProcess(v) {
    var g = encodeURIComponent(state.gameId);
    api("/games/" + g + "/process" + filterQS()).then(function (d) {
      var acts = d.activities || [], S = d.stats || {};
      // Stable colour per activity, assigned by overall volume (most frequent first).
      var amap = {}; acts.forEach(function (a, i) { amap[a.type] = PALETTE[i % PALETTE.length]; });
      function ac(t) { return amap[t] || COL.muted; }
      function pill(t, sm) { var c = ac(t); return '<span class="seqpill' + (sm ? " sm" : "") + '" style="background:' + c + ';color:' + inkOn(c) + '">' + esc(prettyAct(t)) + '</span>'; }

      if (!S.sessions) { v.innerHTML = '<div class="empty">No sessions in this range to mine.<br><span class="small">Process mining needs event sequences — widen the date range or clear the player filter.</span></div>'; return; }

      var html = '<div class="tiles">' +
        tile("Sessions mined", fmt(S.sessions)) +
        tile("Distinct paths", fmt(S.variants)) +
        tile("Avg steps / path", S.avgSteps == null ? "—" : dec(S.avgSteps, 1)) +
        tile("Avg events / session", S.avgEvents == null ? "—" : dec(S.avgEvents, 1)) +
        tile("Activities", fmt(S.distinctActivities)) +
        tile("Self-loop rate", S.selfLoopRate == null ? "—" : pct(S.selfLoopRate)) + "</div>";

      if (S.truncated) html += '<div class="card" style="padding:12px 16px;border-color:#5c4a2b;background:#2a230f"><span class="small" style="color:#e6c98e">⚠ Large event volume — only the most recent slice was mined. Narrow the date range or pick a player for exact results.</span></div>';

      // Activity colour legend.
      html += '<div class="card" style="padding:14px 17px"><div class="card-head" style="margin-bottom:9px"><h3>Activities</h3><span class="pill">' + acts.length + ' types</span></div>' +
        '<div class="act-legend">' + acts.map(function (a) { return pill(a.type) + '<span class="small muted" style="margin:0 10px 0 -3px;align-self:center">' + fmt(a.count) + '</span>'; }).join("") + '</div></div>';

      // Flagship: trace variants as pill chains (the "event sequences" view).
      var maxV = (d.variants && d.variants[0]) ? d.variants[0].count : 1, cap = 16;
      var vrows = (d.variants || []).map(function (vr, ri) {
        var chain = vr.sequence, shown = chain.slice(0, cap);
        var ch = shown.map(function (t, i) { return (i ? '<span class="seqarrow">→</span>' : "") + pill(t); }).join("");
        if (chain.length > cap) ch += '<span class="seqarrow">→</span><span class="muted small">+' + (chain.length - cap) + ' more</span>';
        return '<div class="seqrow"><span class="seqrank">' + (ri + 1) + '</span><div class="seqchain">' + ch + '</div>' +
          '<div class="seqfreq"><div class="fbar"><i style="width:' + (vr.count / maxV * 100) + '%"></i></div>' +
          '<div class="fn">' + fmt(vr.count) + ' <small>· ' + pct(vr.coverage) + '</small></div></div></div>';
      }).join("");
      html += card("Common event sequences", "The distinct paths sessions take through the game, ranked by how many sessions follow each (full raw traces, repeated loops are shown in full).",
        (d.variants && d.variants.length) ? vrows : '<p class="muted small">No sequences in range.</p>');

      // Directly-follows transitions + start/end activities.
      html += '<div class="grid2">';
      // Chains of 2/3/4 consecutive activities. All three step lengths ship in
      // one response, so switching is instant and never re-queries the DB.
      var byN = d.transitionsByN || { 2: d.transitions || [] };
      function dfgRows(n) {
        var list = byN[n] || [];
        if (!list.length) return '<p class="muted small">No ' + n + '-step chains in range.</p>';
        var mx = list[0].count || 1;
        return list.map(function (tr) {
          var seq = tr.seq || [tr.from, tr.to];
          var chain = seq.map(function (t, i) { return (i ? '<span class="seqarrow">→</span>' : "") + pill(t, 1); }).join("");
          return '<div class="trow"><div class="seqchain">' + chain + '</div>' +
            '<div class="tn" style="flex:none;width:88px"><i style="width:' + (tr.count / mx * 100) + '%;background:' + ac(seq[seq.length - 1]) + '"></i></div>' +
            '<div class="tv">' + fmt(tr.count) + '</div></div>';
        }).join("");
      }
      var dfgHead = '<div class="card-head"><h3>Directly-follows transitions</h3>' +
        '<span class="spacer"></span><div class="seg sm" id="dfgSteps">' +
        [2, 3, 4].map(function (n) { return '<button class="chip' + (n === 2 ? " active" : "") + '" data-n="' + n + '">' + n + '-step</button>'; }).join("") + '</div></div>';
      html += '<div class="card">' + dfgHead +
        '<p class="cap">How often a run of activities occurs back-to-back (self-loops included). 2-step is the backbone of the process graph; 3- and 4-step reveal longer recurring routines.</p>' +
        '<div id="dfgBody">' + dfgRows(2) + '</div></div>';

      function seList(list) {
        if (!list || !list.length) return '<p class="muted small">None.</p>';
        var mx = list[0].count || 1;
        return list.map(function (a) { return '<div class="trow">' + pill(a.type, 1) + '<div class="tn"><i style="width:' + (a.count / mx * 100) + '%;background:' + ac(a.type) + '"></i></div><div class="tv">' + fmt(a.count) + '</div></div>'; }).join("");
      }
      html += card("Start and end activities", "Where sessions begin and where they end — entry points and exit points of the process.",
        '<h4>First activity</h4>' + seList(d.startActivities) + '<h4 style="margin-top:15px">Last activity</h4>' + seList(d.endActivities));
      html += "</div>";

      v.innerHTML = html;

      // Directly-follows step selector: swap the list locally (no re-fetch).
      var dfgSeg = v.querySelector("#dfgSteps"), dfgBody = v.querySelector("#dfgBody");
      if (dfgSeg) [].forEach.call(dfgSeg.querySelectorAll("[data-n]"), function (b) {
        b.addEventListener("click", function () {
          [].forEach.call(dfgSeg.querySelectorAll("[data-n]"), function (x) { x.classList.remove("active"); });
          b.classList.add("active");
          dfgBody.innerHTML = dfgRows(parseInt(b.getAttribute("data-n"), 10));
        });
      });
    }).catch(errBox(v));
  }

  // ---- Transition Network Analysis (delegated to tna.js) --------------------
  // View-local state persists across the module's local redraws and server
  // reloads (weight mode + validation are server-computed; threshold/labels are
  // display-only). It resets when you switch games so stale settings don't leak.
  var tnaState = { game: null, weight: "probability", bootstrap: false, iter: 300, minWeight: 0, labels: true, k: 3, clAlgo: "pam", clDiss: "lv", clLink: "average", centMeasure: "betweenness", patOutcome: "score", patSupport: 0.1, cmpGroupBy: "score", cmpIter: 500, cmpView: "graph", patView: "graph", stabView: "graph", stabHidden: {} };
  function renderTNA(v) {
    if (tnaState.game !== state.gameId) { tnaState.game = state.gameId; tnaState.bootstrap = false; tnaState.minWeight = 0; }
    if (!window.SuiteTNA) { v.innerHTML = '<div class="empty">Network module not loaded.</div>'; return; }
    var g = encodeURIComponent(state.gameId);
    var q = qs({ from: state.from, to: state.to, user: state.player, weight: tnaState.weight,
      bootstrap: tnaState.bootstrap ? 1 : null, iter: tnaState.bootstrap ? tnaState.iter : null });
    v.innerHTML = '<div class="spin">Computing transition network…</div>';
    api("/games/" + g + "/tna" + q).then(function (d) {
      window.SuiteTNA.render(v, d, {
        dash: SuiteDash, state: tnaState,
        reload: function (patch) { Object.assign(tnaState, patch); renderTNA(v); },
        // Lazy fetch for clustering (only when the user runs it), same filters.
        loadClusters: function (o) {
          o = o || {};
          return api("/games/" + g + "/tna/clusters" + qs({
            from: state.from, to: state.to, user: state.player, weight: tnaState.weight,
            k: o.k, algorithm: o.algorithm, dissimilarity: o.dissimilarity, linkage: o.linkage,
          }));
        },
        // Page through the sequence index plot (same filters; order is stable).
        loadSequences: function (o) {
          o = o || {};
          return api("/games/" + g + "/tna/sequences" + qs({
            from: state.from, to: state.to, user: state.player,
            offset: o.offset, limit: o.limit,
          }));
        },
        // Behaviour patterns → outcome (lazy; only when the user runs it).
        loadPatterns: function (o) {
          o = o || {};
          return api("/games/" + g + "/tna/patterns" + qs({
            from: state.from, to: state.to, user: state.player,
            outcome: o.outcome, minSupport: o.minSupport,
          }));
        },
        // Cohort comparison via permutation test (lazy).
        loadCompare: function (o) {
          o = o || {};
          return api("/games/" + g + "/tna/compare" + qs({
            from: state.from, to: state.to, user: state.player,
            groupBy: o.groupBy, iter: o.iter,
          }));
        },
      });
    }).catch(errBox(v));
  }

  // ---- Prediction (delegated to predict.js) ---------------------------------
  // Like TNA, view-local state survives the module's local redraws and the
  // server retrains (target / features / hyperparameters are server-computed).
  // Resets when you switch games so stale settings don't leak across games.
  var predictState = { game: null, target: "score", threshold: 0.6, features: null, algorithm: "gbtree", estimators: 150, learningRate: 0.1, maxDepth: 3, l2: 0.1, seed: 42 };
  function renderPredict(v) {
    if (predictState.game !== state.gameId) {
      predictState.game = state.gameId;
      predictState.target = "score"; predictState.threshold = 0.6; predictState.features = null;
      predictState.algorithm = "gbtree"; predictState.estimators = 150; predictState.learningRate = 0.1; predictState.maxDepth = 3; predictState.l2 = 0.1;
    }
    if (!window.SuitePredict) { v.innerHTML = '<div class="empty">Prediction module not loaded.</div>'; return; }
    var g = encodeURIComponent(state.gameId);
    var q = qs({
      from: state.from, to: state.to, user: state.player,
      target: predictState.target, threshold: predictState.threshold,
      features: predictState.features ? predictState.features.join(",") : null,
      algorithm: predictState.algorithm,
      estimators: predictState.estimators, learningRate: predictState.learningRate, maxDepth: predictState.maxDepth, l2: predictState.l2, seed: predictState.seed,
    });
    v.innerHTML = '<div class="spin">Training model & computing SHAP…</div>';
    api("/games/" + g + "/predict" + q).then(function (d) {
      // Keep the enabled feature groups in sync with what the server used.
      if (d.features) predictState.features = d.features.slice();
      window.SuitePredict.render(v, d, {
        dash: SuiteDash, state: predictState,
        reload: function (patch) {
          // Switching algorithm clears the tuning knobs so the server's
          // per-algorithm defaults apply (qs omits null values).
          if (patch.algorithm && patch.algorithm !== predictState.algorithm) {
            patch.estimators = null; patch.learningRate = null; patch.maxDepth = null; patch.l2 = null;
          }
          Object.assign(predictState, patch); renderPredict(v);
        },
      });
    }).catch(errBox(v));
  }

  // ---- Game-specific insights (dispatched to a per-game renderer) -----------
  function renderInsights(v) {
    var g = encodeURIComponent(state.gameId);
    api("/games/" + g + "/specific" + filterQS()).then(function (d) {
      if (!d.hasModule) {
        v.innerHTML = '<div class="empty">No game-specific analytics for <b>' + esc(state.gameId) + '</b> yet.<br><span class="small">The <b>General</b> tab has analytics that work for every game. Game-specific views live in <code>server/src/games-analytics/</code> + <code>public/admin/games/</code>.</span></div>';
        return;
      }
      var renderer = (window.SuiteGameRenderers || {})[d.moduleId];
      if (!renderer) { v.innerHTML = '<div class="empty">No dashboard renderer for module “' + esc(d.moduleId) + '”.</div>'; return; }
      try { v.innerHTML = renderer(d, SuiteDash); flushCharts(); }
      catch (e) { v.innerHTML = '<div class="empty">Insights renderer error: ' + esc(e.message) + "</div>"; }
    }).catch(errBox(v));
  }

  // ---- Players --------------------------------------------------------------
  var playerSort = { key: "events", dir: -1 };
  function renderPlayers(v) {
    var g = encodeURIComponent(state.gameId);
    api("/games/" + g + "/players" + filterQS()).then(function (d) {
      var cols = [["username", "Player", 0], ["sessions", "Sessions", 1], ["events", "Events", 1], ["runs", "Runs", 1], ["bestScore", "Best", 1], ["bestStars", "Stars", 1], ["lastSeen", "Last seen", 0]];
      var rows = d.players.slice().sort(function (a, b) { var k = playerSort.key, x = a[k], y = b[k]; if (x == null) x = -Infinity; if (y == null) y = -Infinity; return (x < y ? -1 : x > y ? 1 : 0) * playerSort.dir; });
      var html = '<div class="card"><div class="card-head"><h3>Players</h3><span class="pill">' + rows.length + ' in range</span></div><div class="tbl-wrap"><table><thead><tr>' +
        cols.map(function (c) { return '<th class="' + (c[2] ? "num " : "") + '" data-k="' + c[0] + '">' + c[1] + (playerSort.key === c[0] ? (playerSort.dir < 0 ? " ▾" : " ▴") : "") + '</th>'; }).join("") + '</tr></thead><tbody>' +
        (rows.length ? rows.map(function (p) {
          return '<tr class="clickable" data-user="' + esc(p.username) + '"><td><b>' + esc(p.username) + '</b></td>' +
            '<td class="num">' + fmt(p.sessions) + '</td><td class="num">' + fmt(p.events) + '</td>' +
            '<td class="num">' + fmt(p.runs) + '</td><td class="num">' + (p.bestScore == null ? "—" : pct(p.bestScore)) + '</td>' +
            '<td class="num">' + (p.bestStars == null ? "—" : "★".repeat(p.bestStars)) + '</td><td class="muted small">' + esc((p.lastSeen || "").slice(0, 16)) + '</td></tr>';
        }).join("") : '<tr><td colspan="7" class="muted">No players in range.</td></tr>') + "</tbody></table></div></div>";
      v.innerHTML = html;
      [].forEach.call(v.querySelectorAll("th[data-k]"), function (th) { th.addEventListener("click", function () { var k = th.getAttribute("data-k"); if (playerSort.key === k) playerSort.dir *= -1; else { playerSort.key = k; playerSort.dir = -1; } renderPlayers(v); }); });
      [].forEach.call(v.querySelectorAll("[data-user]"), function (tr) { tr.addEventListener("click", function () { openPlayer(tr.getAttribute("data-user")); }); });
    }).catch(errBox(v));
  }

  // ---- Player drilldown modal ----------------------------------------------
  function openPlayer(username) {
    var mr = $("#modalRoot");
    mr.innerHTML = '<div class="scrim"><div class="modal"><div class="spin">Loading ' + esc(username) + '…</div></div></div>';
    mr.querySelector(".scrim").addEventListener("click", function (e) { if (e.target === this) mr.innerHTML = ""; });
    api("/players/" + encodeURIComponent(username) + qs({ game: state.gameId })).then(function (d) {
      var pg = d.perGame;
      var html = '<button class="x" id="mx">✕</button><h2 style="margin:0 0 2px">' + esc(d.player.username) + '</h2>' +
        '<p class="muted small">joined ' + esc((d.player.created_at || "").slice(0, 10)) + ' · last seen ' + esc((d.player.last_seen_at || "").slice(0, 16)) + '</p>';
      html += '<div class="row-tiles">' + miniTile("Games", pg.length) + miniTile("Sessions", pg.reduce(function (a, x) { return a + x.sessions; }, 0)) + miniTile("Events", pg.reduce(function (a, x) { return a + x.events; }, 0)) + miniTile("Runs", pg.reduce(function (a, x) { return a + (x.runs || 0); }, 0)) + '</div>';
      html += '<div class="card" style="margin:0 0 14px"><h3>Per game</h3><div class="tbl-wrap"><table><thead><tr><th>Game</th><th class="num">Sessions</th><th class="num">Events</th><th class="num">Runs</th><th class="num">Best</th></tr></thead><tbody>' +
        pg.map(function (x) { return '<tr><td>' + esc(x.gameId) + '</td><td class="num">' + fmt(x.sessions) + '</td><td class="num">' + fmt(x.events) + '</td><td class="num">' + fmt(x.runs) + '</td><td class="num">' + (x.best == null ? "—" : pct(x.best)) + '</td></tr>'; }).join("") + '</tbody></table></div></div>';
      html += '<div class="card" style="margin:0"><h3>Recent runs</h3><div class="tbl-wrap"><table><thead><tr><th>When</th><th>Game</th><th>Level</th><th class="num">Score</th><th class="num">Stars</th></tr></thead><tbody>' +
        (d.runs.length ? d.runs.slice(0, 20).map(function (r) { return '<tr><td class="muted small">' + esc((r.created_at || "").slice(0, 16)) + '</td><td>' + esc(r.gameId) + '</td><td>' + esc(r.level) + '</td><td class="num">' + (r.score == null ? "—" : pct(r.score)) + '</td><td class="num">' + (r.stars == null ? "—" : "★".repeat(r.stars)) + '</td></tr>'; }).join("") : '<tr><td colspan="5" class="muted">No runs.</td></tr>') + '</tbody></table></div></div>';
      mr.querySelector(".modal").innerHTML = html;
      flushCharts();
      $("#mx").addEventListener("click", function () { mr.innerHTML = ""; });
    }).catch(function (e) { mr.querySelector(".modal").innerHTML = '<button class="x" id="mx">✕</button><p class="muted">Could not load player.</p>'; var x = $("#mx"); if (x) x.addEventListener("click", function () { mr.innerHTML = ""; }); });
  }

  // ---- Events (raw, paginated) ---------------------------------------------
  var evState = { type: "", offset: 0, limit: 50, total: null, sig: "" };
  function renderEvents(v) {
    var g = encodeURIComponent(state.gameId);
    // If the active filter changed (game/date/player/type), restart at page 1
    // with a fresh count so the carried-forward total can't go stale.
    var sig = [state.gameId, state.from, state.to, state.player, evState.type].join("|");
    if (sig !== evState.sig) { evState.sig = sig; evState.offset = 0; evState.total = null; }
    api("/games/" + g + "/summary" + filterQS()).then(function (sum) {
      var types = sum.eventTypes.map(function (t) { return t.type; });
      // Carry the row count forward: the server only recounts on page 1 (or when
      // no cached total is sent), so paging back and forth doesn't re-COUNT.
      var cachedTotal = evState.offset > 0 ? evState.total : null;
      return api("/games/" + g + "/events" + qs({ from: state.from, to: state.to, user: state.player, type: evState.type, limit: evState.limit, offset: evState.offset, total: cachedTotal })).then(function (d) {
        evState.total = d.total;
        var html = '<div class="card"><div class="toolbar"><div class="grp"><label class="small muted">Event type</label> ' +
          '<select id="evType"><option value="">all types</option>' + types.map(function (t) { return '<option ' + (evState.type === t ? "selected" : "") + '>' + esc(t) + '</option>'; }).join("") + '</select></div>' +
          '<span class="spacer" style="flex:1"></span><span class="pill">' + fmt(d.total) + ' events</span></div>' +
          '<div class="tbl-wrap"><table><thead><tr><th>#</th><th>When</th><th>Player</th><th>Type</th><th>Lvl</th><th class="no-sort">Payload</th></tr></thead><tbody>' +
          (d.events.length ? d.events.map(function (e) {
            var lvl = e.payload && e.payload.level != null ? e.payload.level : "";
            return '<tr><td class="muted small">' + e.id + '</td><td class="muted small">' + esc((e.created_at || "").slice(5, 16)) + '</td><td>' + esc(e.username) + '</td><td><span class="pill">' + esc(e.type) + '</span></td><td class="num">' + esc(lvl) + '</td><td><code class="j">' + esc(JSON.stringify(e.payload)) + '</code></td></tr>';
          }).join("") : '<tr><td colspan="6" class="muted">No events.</td></tr>') + '</tbody></table></div>';
        var page = Math.floor(evState.offset / evState.limit) + 1, pages = Math.max(1, Math.ceil(d.total / evState.limit));
        html += '<div class="toolbar" style="margin-top:12px;justify-content:flex-end"><button class="btn ghost sm" id="prev" ' + (evState.offset ? "" : "disabled") + '>← Prev</button><span class="small muted">page ' + page + ' / ' + pages + '</span><button class="btn ghost sm" id="next" ' + (evState.offset + evState.limit < d.total ? "" : "disabled") + '>Next →</button></div></div>';
        v.innerHTML = html;
        $("#evType").addEventListener("change", function () { evState.type = this.value; evState.offset = 0; renderEvents(v); });
        var pv = $("#prev"), nx = $("#next");
        if (pv) pv.addEventListener("click", function () { evState.offset = Math.max(0, evState.offset - evState.limit); renderEvents(v); });
        if (nx) nx.addEventListener("click", function () { evState.offset += evState.limit; renderEvents(v); });
      });
    }).catch(errBox(v));
  }

  // ---- Export ---------------------------------------------------------------
  function renderExport(v) {
    function link(dataset, format) {
      return "/api/admin/export" + qs({ game: state.gameId, dataset: dataset, format: format, from: state.from, to: state.to, user: state.player });
    }
    var scope = '<b>' + esc(state.gameId) + '</b>' + (state.player ? ' · player <b>' + esc(state.player) + '</b>' : "") + (state.from || state.to ? ' · ' + esc(state.from || "start") + " → " + esc(state.to || "now") : " · all dates");
    v.innerHTML = '<div class="card"><h3>Download data</h3><p class="cap">Respects the filters above: ' + scope + '</p>' +
      '<div class="grid2">' +
      '<div><h4 style="margin:0 0 8px">Analytics events</h4><p class="muted small">Every logged event with its full JSON payload.</p><div class="toolbar"><a class="btn sm" href="' + link("events", "csv") + '">Events · CSV</a><a class="btn ghost sm" href="' + link("events", "json") + '">Events · JSON</a></div></div>' +
      '<div><h4 style="margin:0 0 8px">Runs / scores</h4><p class="muted small">One row per completed run (score, stars, level, meta).</p><div class="toolbar"><a class="btn sm" href="' + link("scores", "csv") + '">Runs · CSV</a><a class="btn ghost sm" href="' + link("scores", "json") + '">Runs · JSON</a></div></div>' +
      '</div><p class="muted small" style="margin-top:12px">Tip: add a player in the filter bar to export just their data, or a date range to slice by time.</p></div>';
  }

  // ---- Accounts -------------------------------------------------------------
  function renderAccounts(v) {
    api("/accounts").then(function (d) {
      var html = '<div class="card"><div class="card-head"><h3>Admin accounts</h3><span class="pill">' + d.accounts.length + '</span></div>' +
        '<div class="tbl-wrap"><table><thead><tr><th>Username</th><th>Created</th><th>Last login</th><th class="no-sort"></th></tr></thead><tbody>' +
        d.accounts.map(function (a) {
          var self = state.user && a.username.toLowerCase() === state.user.username.toLowerCase();
          return '<tr><td><b>' + esc(a.username) + '</b>' + (self ? ' <span class="pill">you</span>' : "") + '</td><td class="muted small">' + esc((a.created_at || "").slice(0, 16)) + '</td><td class="muted small">' + esc((a.last_login_at || "—").slice(0, 16)) + '</td><td>' + (self ? "" : '<button class="btn danger sm" data-del="' + a.id + '" data-name="' + esc(a.username) + '">Remove</button>') + '</td></tr>';
        }).join("") + '</tbody></table></div></div>';
      html += '<div class="card"><h3>Add an admin</h3><p class="cap">They can view analytics and manage accounts.</p>' +
        '<div class="toolbar"><input id="naUser" placeholder="username" style="max-width:200px"/><input id="naPass" type="password" placeholder="password (8+ chars)" style="max-width:220px"/><button class="btn sm" id="naAdd">Add admin</button></div><div class="err" id="naErr"></div></div>';
      v.innerHTML = html;
      [].forEach.call(v.querySelectorAll("[data-del]"), function (b) {
        b.addEventListener("click", function () {
          if (!confirm("Remove admin " + b.getAttribute("data-name") + "?")) return;
          fetch("/api/admin/accounts/" + b.getAttribute("data-del"), { method: "DELETE", credentials: "same-origin" }).then(function () { renderAccounts(v); });
        });
      });
      $("#naAdd").addEventListener("click", function () {
        $("#naErr").textContent = "";
        post("/accounts", { username: $("#naUser").value.trim(), password: $("#naPass").value }).then(function (r) {
          if (r.ok) { renderAccounts(v); return; }
          return r.json().then(function (e) { $("#naErr").textContent = e.detail || "Could not add admin."; });
        });
      });
    }).catch(errBox(v));
  }

  // ---- Import ---------------------------------------------------------------
  // Upload an existing event log (CSV/JSON), confirm a column mapping, and import
  // it into a game bucket so the whole game-agnostic dashboard runs on it.
  function renderImport(v) {
    var st = { text: "", filename: "" };
    function kb(n) { return n < 1024 ? n + " B" : (n / 1024).toFixed(0) + " KB"; }
    function trunc(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n) + "…" : s; }

    v.innerHTML =
      '<div class="card"><div class="card-head"><h3>Import event data</h3></div>' +
      '<p class="cap">Bring an existing event log (CSV or JSON) into a game so the whole dashboard — General, Process, Network, clustering — runs on it. Each row needs a case/session, an activity, and an order (a sequence column, or a timestamp to sort by). Add a <b>score</b>, <b>stars</b>, or <b>level</b> column to also unlock the Prediction tab. A Ludix export re-imports as-is.</p>' +
      '<div class="toolbar"><input type="file" id="impFile" accept=".csv,.tsv,.json,.txt" style="display:none">' +
      '<button class="btn sm" id="impPick">Choose a CSV or JSON file</button>' +
      '<span class="muted small" id="impName">No file selected</span></div>' +
      '<div class="err" id="impErr"></div></div>' +
      '<div id="impResult"></div>' +
      '<div id="impList"></div>';

    loadImports();
    $("#impPick").addEventListener("click", function () { $("#impFile").click(); });
    $("#impFile").addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0]; if (!f) return;
      $("#impName").textContent = f.name + " · " + kb(f.size);
      var reader = new FileReader();
      reader.onload = function () { st.text = String(reader.result || ""); st.filename = f.name; analyze(); };
      reader.onerror = function () { $("#impErr").textContent = "Could not read that file."; };
      reader.readAsText(f);
    });

    function analyze() {
      $("#impErr").textContent = "Analysing…"; $("#impResult").innerHTML = "";
      post("/import/analyze", { text: st.text, filename: st.filename })
        .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.detail || d.error || "Analyse failed."); return d; }); })
        .then(function (a) { $("#impErr").textContent = ""; renderMapping(a); })
        .catch(function (e) { $("#impErr").textContent = e.message; });
    }

    var ROLES = [
      { key: "session", label: "Case / session", req: true },
      { key: "activity", label: "Activity / event", req: true },
      { key: "timestamp", label: "Timestamp", req: false },
      { key: "actor", label: "Actor / user", req: false },
      { key: "seq", label: "Sequence order", req: false },
      { key: "score", label: "Score (outcome)", req: false },
      { key: "stars", label: "Stars (outcome)", req: false },
      { key: "level", label: "Level", req: false },
    ];

    function suggestGame() {
      var s = String(st.filename || "import").replace(/\.[^.]+$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
      return s || "imported";
    }

    // Which target role a source column is currently assigned to (or "none").
    function roleForCol(mapping, col) { for (var i = 0; i < ROLES.length; i++) if (mapping[ROLES[i].key] === col) return ROLES[i].key; return "none"; }

    function colValues(a, col) {
      return (a.sample || []).map(function (r) { var val = r[col]; if (val && typeof val === "object") val = JSON.stringify(val); return val == null ? "" : String(val); }).filter(function (val) { return val.trim() !== ""; });
    }
    // A light type hint for each column (badge only; the import handles any type).
    // Date detection requires a real date-ish shape, not just a lenient
    // Date.parse (which accepts things like "sess-1").
    function looksDate(val) {
      val = val.trim();
      if (/^-?\d+(\.\d+)?$/.test(val)) return false;               // pure number, not a date
      if (!/(\d{4}-\d{2}-\d{2})|(\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4})|(\d{1,2}:\d{2})/.test(val)) return false;
      return !isNaN(Date.parse(val));
    }
    function inferType(a, col) {
      var vals = colValues(a, col); if (!vals.length) return "empty";
      if (vals.every(function (val) { return /^-?\d+(\.\d+)?$/.test(val.trim()); })) return "number";
      if (vals.every(function (val) { return looksDate(val); })) return "date";
      return "text";
    }
    function sampleChips(a, col) {
      var vals = colValues(a, col), seen = {}, out = [];
      for (var i = 0; i < vals.length && out.length < 3; i++) { if (!seen[vals[i]]) { seen[vals[i]] = 1; out.push(vals[i]); } }
      if (!out.length) return '<span class="muted small">empty</span>';
      return out.map(function (x) { return '<span class="imp-cv">' + esc(trunc(x, 26)) + "</span>"; }).join("");
    }

    function renderMapping(a) {
      st.analysis = a;   // kept so updateStatus can re-judge mapping quality live
      var badge = a.isLudixExport ? '<span class="pill">Ludix export</span>' : '<span class="pill">' + esc(String(a.format).toUpperCase()) + "</span>";
      var roleOpts = function (selRole) {
        return '<option value="none">— ignore —</option>' + ROLES.map(function (R) {
          return '<option value="' + R.key + '"' + (selRole === R.key ? " selected" : "") + ">" + esc(R.label) + "</option>";
        }).join("");
      };
      var rows = a.headers.map(function (c) {
        var role = roleForCol(a.mapping, c), ty = inferType(a, c);
        return '<tr data-col="' + esc(c) + '">' +
          '<td class="imp-cname"><b>' + esc(c) + "</b></td>" +
          '<td><span class="t-badge t-' + ty + '">' + ty + "</span></td>" +
          '<td class="imp-samp">' + sampleChips(a, c) + "</td>" +
          '<td><select class="imp-rolesel" data-col="' + esc(c) + '">' + roleOpts(role) + "</select></td></tr>";
      }).join("");

      $("#impResult").innerHTML =
        '<div class="card"><div class="card-head"><h3>Map your columns</h3>' + badge + ' <span class="pill">' + fmt(a.rowCount) + " rows</span></div>" +
        '<p class="cap">Assign each column in your file to a target field. <b>Case</b> and <b>Activity</b> are required; a <b>timestamp</b> adds date filters and session durations; a <b>score</b>/<b>stars</b> column unlocks prediction. We auto-detected the mapping below — adjust anything that looks off.</p>' +
        '<div id="impVerdict"></div>' +
        '<div class="imp-status" id="impStatus"></div>' +
        '<div class="tbl-wrap"><table class="imp-cols"><thead><tr><th>Your column</th><th>Type</th><th>Sample values</th><th>Maps to</th></tr></thead><tbody>' + rows + "</tbody></table></div>" +
        '<div class="imp-actor" id="impActorRow"><span class="k">With no actor column, use</span>' +
        '<label><input type="radio" name="impActor" value="session" checked> one player per case</label>' +
        '<label><input type="radio" name="impActor" value="single"> a single "imported" player</label></div>' +
        '<div class="toolbar" style="margin-top:16px;align-items:flex-end">' +
        '<label class="imp-role" style="max-width:220px"><span class="k">Import into game</span><input id="impGame" placeholder="e.g. my-study" value="' + esc(suggestGame()) + '"></label>' +
        '<button class="btn primary sm" id="impGo">Import</button><span class="muted small" id="impExisting"></span></div>' +
        '<div class="err" id="impGoErr"></div></div>';

      var sels = $("#impResult").querySelectorAll("select.imp-rolesel");
      [].forEach.call(sels, function (s) {
        s.addEventListener("change", function () {
          // a role maps to exactly one column: clear it from any other select
          if (this.value !== "none") [].forEach.call(sels, function (o) { if (o !== s && o.value === s.value) o.value = "none"; });
          updateStatus();
        });
      });
      var gi = $("#impGame");
      gi.addEventListener("blur", checkExisting); checkExisting();
      $("#impGo").addEventListener("click", doCommit);
      updateStatus();
    }

    // Judge whether the chosen columns are good enough to import — reuses the
    // per-column stats analyze() returned, so it re-runs on every remap with no
    // server round-trip. Returns { level: ok|warn|blocked, messages:[{lvl,text}] }.
    function assessReadiness(m) {
      var a = st.analysis || {}, stats = a.columnStats || {}, rowCount = a.rowCount || 0;
      var msgs = [], level = "ok";
      function bump(l) { if (l === "blocked") level = "blocked"; else if (l === "warn" && level !== "blocked") level = "warn"; }
      function add(l, t) { msgs.push({ lvl: l, text: t }); bump(l === "info" ? "ok" : l); }
      var uniqueish = function (s) { return s && rowCount > 20 && s.distinctRatio > 0.95; };

      // Activity — required, needs variety to be meaningful.
      if (!m.activity) add("blocked", "Assign an Activity / event column — the analytics can’t run without it.");
      else {
        var av = stats[m.activity] || {};
        if (av.fill < 0.5) add("blocked", "The Activity column is empty in most rows — pick a fuller column.");
        else if (av.distinct <= 1) add("warn", "Only one distinct activity — the Process and Network views need more than one event type.");
        else if (uniqueish(av)) add("warn", "Almost every row has a different activity — that looks like an ID, not an event type.");
      }
      // Case / session — recommended.
      if (!m.session) add("warn", "No Case / session column — every row is folded into one session, so sequences won’t be meaningful.");
      else {
        var sv = stats[m.session] || {};
        if (sv.fill < 0.5) add("warn", "The Case column is empty in most rows — those rows fall back to a single session.");
        else if (uniqueish(sv)) add("warn", "Almost every row is its own case — each session will hold a single event.");
      }
      // Order — timestamp or explicit sequence.
      if (m.timestamp) {
        var tv = stats[m.timestamp] || {};
        if (tv.tsParseRate < 0.5) add("warn", "Most values in the Timestamp column don’t parse as dates — check the column, or map a Sequence column instead.");
      } else if (!m.seq) {
        add("info", "No Timestamp or Sequence column — events keep file order, and date filters and session durations stay off.");
      }
      // Outcome — enables the Prediction tab.
      var oc = m.score || m.stars;
      if (oc) {
        var ov = stats[oc] || {};
        if (ov.numericRate < 0.5) add("warn", "The outcome column isn’t mostly numeric — prediction will be weak. A score/stars column should be numbers.");
        else add("ok", "An outcome column is mapped — the Prediction tab will train on it.");
      } else {
        add("info", "Tip: map a Score or Stars column to predict outcomes. Without one, only “Session length” can be predicted.");
      }
      return { level: level, messages: msgs };
    }

    // Live required-field status + quality verdict + row highlight + gating.
    function updateStatus() {
      var m = currentMapping();
      $("#impStatus").innerHTML = ROLES.map(function (R) {
        var col = m[R.key], cls = col ? "ok" : (R.req ? "req" : "opt");
        return '<span class="imp-chip ' + cls + '"><i></i>' + esc(R.label) + ": <b>" + (col ? esc(col) : (R.req ? "required" : "not set")) + "</b></span>";
      }).join("");

      var verdict = assessReadiness(m), vel = $("#impVerdict");
      if (vel) {
        var head = verdict.level === "blocked"
          ? '<span class="imp-v-badge blocked">Not ready</span> Fix the blocking issue below before importing.'
          : verdict.level === "warn"
            ? '<span class="imp-v-badge warn">Importable, with caveats</span> These won’t block the import, but may weaken the analytics.'
            : '<span class="imp-v-badge ok">Ready to import</span> The mapping looks good.';
        var items = verdict.messages.map(function (mm) { return '<li class="imp-v-' + mm.lvl + '">' + esc(mm.text) + "</li>"; }).join("");
        vel.innerHTML = '<div class="imp-verdict ' + verdict.level + '"><div class="imp-v-head">' + head + "</div>" +
          (items ? '<ul class="imp-v-list">' + items + "</ul>" : "") + "</div>";
      }

      [].forEach.call($("#impResult").querySelectorAll("tr[data-col]"), function (tr) {
        var s = tr.querySelector("select.imp-rolesel");
        tr.className = s && s.value !== "none" ? "mapped" : "";
      });
      var actorRow = $("#impActorRow"), hasActor = !!m.actor;
      if (actorRow) { actorRow.style.opacity = hasActor ? ".4" : ""; [].forEach.call(actorRow.querySelectorAll("input"), function (i) { i.disabled = hasActor; }); }
      var go = $("#impGo"); if (go) { go.disabled = verdict.level === "blocked"; go.title = verdict.level === "blocked" ? "Resolve the blocking issue first" : ""; }
    }

    function currentMapping() {
      var m = { session: null, activity: null, timestamp: null, actor: null, seq: null, score: null, stars: null, level: null };
      [].forEach.call($("#impResult").querySelectorAll("select.imp-rolesel"), function (s) {
        var role = s.value; if (role && role !== "none") m[role] = s.getAttribute("data-col");
      });
      return m;
    }
    function currentActorMode() {
      var m = currentMapping(); if (m.actor) return "column";
      var r = $("#impResult").querySelector('input[name="impActor"]:checked');
      return r ? r.value : "session";
    }
    function checkExisting() {
      var g = ($("#impGame").value || "").trim(), el = $("#impExisting"); if (!el) return;
      if (!g) { el.textContent = ""; return; }
      api("/import/existing?game=" + encodeURIComponent(g))
        .then(function (d) { el.textContent = d.events ? ("“" + g + "” already has " + fmt(d.events) + " events — import appends.") : "New game."; })
        .catch(function () { el.textContent = ""; });
    }

    function doCommit() {
      var gameId = ($("#impGame").value || "").trim();
      $("#impGoErr").textContent = "";
      var m = currentMapping();
      if (!m.activity) { $("#impGoErr").textContent = "Pick an Activity / event column."; return; }
      if (!gameId) { $("#impGoErr").textContent = "Name the game to import into."; return; }
      var btn = $("#impGo"); btn.disabled = true; btn.textContent = "Importing…";
      post("/import/commit", { text: st.text, filename: st.filename, gameId: gameId, mapping: m, actorMode: currentActorMode() })
        .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.detail || d.error || "Import failed."); return d; }); })
        .then(showSummary)
        .catch(function (e) { btn.disabled = false; btn.textContent = "Import"; $("#impGoErr").textContent = e.message; });
    }

    function showSummary(s) {
      $("#impResult").innerHTML =
        '<div class="card"><div class="card-head"><h3>Imported into “' + esc(s.gameId) + '”</h3>' +
        '<span class="pill" style="background:#16351f;border-color:#2b5c3a;color:#8ee6b0">done</span></div>' +
        '<div class="row-tiles">' + miniTile("Events", fmt(s.events)) + miniTile("Runs", fmt(s.runs)) + miniTile("Sessions", fmt(s.sessions)) +
        miniTile("Activities", fmt(s.activities)) + miniTile("Players added", fmt(s.playersCreated)) + "</div>" +
        '<p class="muted small">' + (s.hasOutcome
          ? "An outcome column was mapped, so the <b>Prediction</b> tab can now train a model for this game."
          : "One run per session was created — the <b>Prediction</b> tab can model <b>Session length</b>. Map a score/stars column next time to predict outcomes too.") + "</p>" +
        (s.unparsedTimestamps ? '<p class="muted small">' + fmt(s.unparsedTimestamps) + " rows had an unreadable timestamp and were ordered by file position.</p>" : "") +
        (s.dateRange ? '<p class="muted small">Date range: ' + esc(s.dateRange.from) + " → " + esc(s.dateRange.to) + "</p>" : "") +
        '<div class="toolbar" style="margin-top:12px"><button class="btn primary sm" id="impOpen">Open the ' + esc(s.gameId) + ' dashboard</button>' +
        '<button class="btn ghost sm" id="impAgain">Import another file</button></div></div>';
      loadImports();
      // Make the imported game usable immediately: refresh the game selector and
      // make it the active game — no page reload needed.
      syncGames(s.gameId);
      $("#impOpen").addEventListener("click", function () { syncGames(s.gameId, function () { gotoTab("general"); }); });
      $("#impAgain").addEventListener("click", function () { renderImport(v); });
    }

    // ---- Previous imports (removable batches) -------------------------------
    function loadImports() {
      api("/imports").then(function (d) { renderImports(d.imports || []); }).catch(function () {});
    }
    function renderImports(list) {
      var el = $("#impList"); if (!el) return;
      if (!list.length) { el.innerHTML = ""; return; }
      var rows = list.map(function (im) {
        var when = String(im.createdAt || "").replace("T", " ").slice(0, 16);
        return '<tr data-id="' + im.id + '">' +
          '<td><b>' + esc(im.gameId) + "</b></td>" +
          '<td class="imp-l-file">' + esc(im.filename || "—") + "</td>" +
          '<td class="num">' + fmt(im.events || 0) + "</td>" +
          '<td class="num">' + fmt(im.runs || 0) + "</td>" +
          '<td class="num">' + fmt(im.sessions || 0) + "</td>" +
          '<td class="muted small">' + esc(when) + "</td>" +
          '<td><button class="btn ghost sm imp-del" data-id="' + im.id + '" data-game="' + esc(im.gameId) + '" data-ev="' + (im.events || 0) + '">Delete</button></td></tr>';
      }).join("");
      el.innerHTML =
        '<div class="card"><div class="card-head"><h3>Previous imports</h3><span class="pill">' + fmt(list.length) + "</span></div>" +
        '<p class="cap">Each import is its own batch. Deleting one removes exactly its events and runs — and any players it created — leaving every other import and native game data untouched.</p>' +
        '<div class="err" id="impDelErr"></div>' +
        '<div class="tbl-wrap"><table class="imp-list"><thead><tr><th>Game</th><th>File</th><th class="num">Events</th><th class="num">Runs</th><th class="num">Sessions</th><th>Imported</th><th></th></tr></thead><tbody>' + rows + "</tbody></table></div></div>";
      [].forEach.call(el.querySelectorAll(".imp-del"), function (b) {
        b.addEventListener("click", function () { delImport(b); });
      });
    }
    function delImport(btn) {
      var id = btn.getAttribute("data-id"), game = btn.getAttribute("data-game"), ev = fmt(btn.getAttribute("data-ev"));
      var derr = $("#impDelErr"); if (derr) derr.textContent = "";
      if (!window.confirm("Delete this import into “" + game + "” (" + ev + " events)?\nIts events and runs will be permanently removed. This cannot be undone.")) return;
      btn.disabled = true; btn.textContent = "Deleting…";
      del("/imports/" + encodeURIComponent(id))
        .then(function () {
          loadImports();
          syncGames();   // an emptied game drops out of the selector without a reload
        })
        .catch(function (e) { btn.disabled = false; btn.textContent = "Delete"; if (derr) derr.textContent = e.message; });
    }
  }

  // ---- small render helpers -------------------------------------------------
  function tile(k, v) { return '<div class="tile"><div class="k">' + esc(k) + '</div><div class="v">' + v + '</div></div>'; }
  function miniTile(k, v, sub) { return '<div class="tile"><div class="k">' + esc(k) + '</div><div class="v" style="font-size:20px">' + v + '</div>' + (sub ? '<div class="k" style="text-transform:none;margin-top:2px">' + esc(sub) + '</div>' : "") + '</div>'; }
  function card(title, cap, body) { return '<div class="card"><h3>' + esc(title) + '</h3>' + (cap ? '<p class="cap">' + esc(cap) + '</p>' : "") + body + '</div>'; }
  function errBox(v) { return function (e) { if (e && e.message === "unauthorized") return; v.innerHTML = '<div class="empty">Could not load: ' + esc(e && e.message) + '</div>'; }; }
  function gotoTab(name) { [].forEach.call($("#tabs").children, function (c) { c.classList.toggle("active", c.getAttribute("data-tab") === name); }); state.tab = name; render(); }

  // Toolkit exposed to per-game insight renderers (public/admin/games/<id>.js).
  // Each registers window.SuiteGameRenderers[gameId] = function(data, dash){...}
  // and returns an HTML string built with these helpers; charts mount on flush.
  var SuiteDash = {
    lineChart: lineChart, funnelChart: funnelChart, donutChart: donutChart, barChart: barChart,
    hBars: hBars, legendRow: legendRow, tile: tile, miniTile: miniTile, card: card,
    esc: esc, fmt: fmt, pct: pct, dec: dec, COL: COL,
  };
  window.SuiteDash = SuiteDash;
  window.SuiteGameRenderers = window.SuiteGameRenderers || {};

  // =========================================================================
  // BOOT
  // =========================================================================
  function boot() {
    showApp();
    if (state.user) {
      $("#who").innerHTML = '<span class="av">' + esc(state.user.username.slice(0, 1).toUpperCase()) + '</span>' + esc(state.user.username);
    } else { $("#who").textContent = ""; }
    api("/overview").then(function (d) {
      state.games = d.games;
      var sel = $("#fGame");
      sel.innerHTML = d.games.length ? d.games.map(function (g) { return '<option value="' + esc(g.gameId) + '">' + esc(g.gameId) + '</option>'; }).join("") : '<option value="">(no games yet)</option>';
      state.gameId = d.games.length ? d.games[0].gameId : null;
      if (gameDD) gameDD.refresh();
      loadUsers();
      render();
    }).catch(errBox($("#view")));
  }

  bindFilters();
  gameDD = initGameDropdown();
  userDD = initPlayerDropdown();
  // Session check on load.
  api("/me").then(function (d) { state.user = d.user; boot(); }).catch(function () { showLogin(); });
})();
