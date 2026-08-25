/* =============================================================================
 * Ludix Analytics — chart export (SVG + PNG, game-agnostic)
 * -----------------------------------------------------------------------------
 * Adds a hover "download" control to every chart in the dashboard and exports it
 * as a self-contained SVG (vector) or a PNG at a chosen resolution and
 * background. Works on ANY inline-SVG chart — transition networks, sequence
 * plots, the stability line chart, the pattern pyramid, SHAP plots, the
 * research/overview charts — because a MutationObserver decorates chart <svg>s as
 * they appear, so new charts are covered automatically with no per-chart wiring.
 *
 * Two things make an on-page SVG exportable standalone:
 *   1. The page stylesheet isn't available to a saved file, so the styles charts
 *      rely on (node/edge labels, fonts) are inlined as a <style> block, with the
 *      draw-in animation (.cline) neutralised so lines don't export invisible.
 *      The label colours flip for a white background so text stays legible.
 *   2. A background is baked in per the user's choice (dark / white / transparent).
 * PNG is produced by rasterising that self-contained SVG onto a canvas scaled to
 * the chosen output width (the SVG carries no external refs, so the canvas isn't
 * tainted and toBlob() works).
 * ========================================================================== */
(function () {
  "use strict";

  var SVGNS = "http://www.w3.org/2000/svg";
  // Chart <svg>s to decorate (deliberately NOT icon/caret/logo svgs).
  var CHART_SEL = "svg.tna-svg, svg.tna-seqsvg, svg.ichart, svg.tna-pyr-svg";
  var BACKGROUNDS = { dark: "#0e1730", white: "#ffffff", transparent: null };

  // Palette custom properties, so charts that colour text/marks via inline
  // `style="fill:var(--muted)"` (e.g. the SHAP plots) resolve in the standalone
  // file instead of falling back to invisible black. Dark values on dark/
  // transparent backgrounds; darker, higher-contrast values on white.
  var PALETTE = {
    dark: { ink: "#eff3ff", muted: "#93a4c9", muted2: "#63718f", line: "#25324e", bg2: "#0d1424", gold: "#ffd54a", green: "#4ad6a0", blue: "#5aa9ff", red: "#ff6b6b", orange: "#ff8a5a", purple: "#b18aff" },
    white: { ink: "#1f2a3d", muted: "#55637d", muted2: "#7784a0", line: "#c9d3e6", bg2: "#e7edf7", gold: "#b8860b", green: "#1a9e6f", blue: "#2f7fd0", red: "#d9433f", orange: "#d9642a", purple: "#7c53d6" },
  };
  function varsBlock(p) {
    var s = "svg{";
    for (var k in p) s += "--" + k + ":" + p[k] + ";";
    return s + "}";
  }

  // The subset of the page stylesheet charts depend on, resolved to literals,
  // with the .cline draw animation neutralised and label colours chosen for the
  // chosen background (light text on dark/transparent, dark text on white).
  function buildCSS(bg) {
    var light = bg === "white";
    var p = PALETTE[light ? "white" : "dark"];
    var outline = light ? "#ffffff" : "#0a1020";
    return varsBlock(p) +
      "svg,text{font-family:'Nunito',system-ui,-apple-system,'Segoe UI',sans-serif}" +
      ".tna-nlabel{fill:" + p.ink + ";font-size:12px;font-weight:800;paint-order:stroke;stroke:" + outline + ";stroke-width:3.4px;stroke-linejoin:round}" +
      ".tna-elabel{fill:" + p.ink + ";font-size:11.5px;font-weight:800;font-variant-numeric:tabular-nums;paint-order:stroke;stroke:" + outline + ";stroke-width:3px;stroke-linejoin:round}" +
      ".tna-seqsvg .tna-elabel{fill:" + p.muted2 + ";font-size:9px;font-weight:600;stroke:none;paint-order:normal}" +
      ".cline{stroke-dasharray:none !important;stroke-dashoffset:0 !important}" +
      ".dim{opacity:1 !important}";
  }

  // ---- geometry -------------------------------------------------------------
  function dims(svg) {
    var vb = (svg.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) return { w: vb[2], h: vb[3] };
    var r = svg.getBoundingClientRect();
    return { w: Math.max(1, Math.round(r.width) || 800), h: Math.max(1, Math.round(r.height) || 600) };
  }

  // ---- serialise a chart <svg> into a standalone document -------------------
  function serialize(svg, opts) {
    opts = opts || {};
    var bg = opts.bg in BACKGROUNDS ? opts.bg : "dark";
    // Some charts (the collapsible sequence map) provide a toggle-free, fully
    // expanded SVG for static export; prefer it so no "+N more" pill is baked in.
    var source = (typeof svg.__exportBuild === "function" && svg.__exportBuild()) || svg;
    var d = dims(source);
    var clone = source.cloneNode(true);
    clone.setAttribute("xmlns", SVGNS);
    clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
    clone.setAttribute("width", d.w);
    clone.setAttribute("height", d.h);
    clone.setAttribute("viewBox", "0 0 " + d.w + " " + d.h);
    clone.removeAttribute("style");            // drop width:100% etc.
    if (clone.classList) clone.classList.remove("isolating");

    var bgColor = BACKGROUNDS[bg];
    if (bgColor) {
      var rect = document.createElementNS(SVGNS, "rect");
      rect.setAttribute("x", 0); rect.setAttribute("y", 0);
      rect.setAttribute("width", d.w); rect.setAttribute("height", d.h);
      rect.setAttribute("fill", bgColor);
      clone.insertBefore(rect, clone.firstChild);
    }
    var style = document.createElementNS(SVGNS, "style");
    style.textContent = buildCSS(bg);
    clone.insertBefore(style, clone.firstChild);

    var str = new XMLSerializer().serializeToString(clone);
    if (!/^<\?xml/.test(str)) str = '<?xml version="1.0" encoding="UTF-8"?>\n' + str;
    return { str: str, w: d.w, h: d.h };
  }

  function download(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url; a.download = name; a.style.display = "none";
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
  }

  function exportSVG(svg, name, opts) {
    var r = serialize(svg, opts);
    download(new Blob([r.str], { type: "image/svg+xml;charset=utf-8" }), name + ".svg");
  }

  // opts: { bg, width } — width is the output PNG width in px (height follows the
  // chart's aspect ratio). Falls back to 2× the native width.
  function exportPNG(svg, name, opts) {
    opts = opts || {};
    var r = serialize(svg, opts);
    var outW = Math.max(1, Math.round(opts.width || r.w * 2));
    var scale = outW / r.w;
    var outH = Math.round(r.h * scale);
    var svgUrl = URL.createObjectURL(new Blob([r.str], { type: "image/svg+xml;charset=utf-8" }));
    var img = new Image();
    img.onload = function () {
      var canvas = document.createElement("canvas");
      canvas.width = outW; canvas.height = outH;
      var ctx = canvas.getContext("2d");
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(svgUrl);
      canvas.toBlob(function (blob) { if (blob) download(blob, name + "-" + outW + "x" + outH + ".png"); }, "image/png");
    };
    img.onerror = function () { URL.revokeObjectURL(svgUrl); console.warn("[export] PNG rasterisation failed"); };
    img.src = svgUrl;
  }

  // ---- naming ---------------------------------------------------------------
  function baseName(svg) {
    var card = svg.closest ? svg.closest(".card") : null;
    var h = card && card.querySelector("h3");
    var t = (h ? h.textContent : "chart").trim() || "chart";
    var slug = t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "").slice(0, 48);
    var sel = document.getElementById("fGame");
    var g = sel && sel.value ? sel.value : "";
    var gslug = g ? "-" + String(g).toLowerCase().replace(/[^a-z0-9]+/g, "-") : "";
    return "ludix" + gslug + "-" + (slug || "chart");
  }

  // ---- per-chart control ----------------------------------------------------
  var openCtrl = null;
  document.addEventListener("click", function () { if (openCtrl) { openCtrl.classList.remove("open"); openCtrl = null; } });

  function decorate(svg) {
    if (svg.__exp) return;
    svg.__exp = true;
    var d = dims(svg);
    var state = { bg: "dark", width: Math.round(d.w * 2) };

    var wrap = document.createElement("div");
    wrap.className = "exp-wrap";
    var parent = svg.parentNode;
    if (!parent) return;
    parent.insertBefore(wrap, svg);
    wrap.appendChild(svg);

    var ctrl = document.createElement("div");
    ctrl.className = "exp-ctrl";
    ctrl.innerHTML =
      '<button class="exp-btn" type="button" title="Download chart" aria-label="Download chart">' +
        '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12"/><path d="M7 11l5 5 5-5"/><path d="M5 21h14"/></svg>' +
      "</button>" +
      '<div class="exp-menu" role="menu">' +
        '<div class="exp-menu-lbl">Background</div>' +
        '<div class="exp-seg" data-role="bg">' +
          '<button type="button" data-bg="dark" class="active">Dark</button>' +
          '<button type="button" data-bg="white">White</button>' +
          '<button type="button" data-bg="transparent">Transp.</button>' +
        "</div>" +
        '<div class="exp-menu-lbl">PNG width (px)</div>' +
        '<div class="exp-res">' +
          '<input class="exp-w" type="number" min="64" max="10000" step="10" value="' + state.width + '">' +
          '<span class="exp-dim"></span>' +
        "</div>" +
        '<div class="exp-actions">' +
          '<button type="button" data-a="svg">Download SVG</button>' +
          '<button type="button" data-a="png">Download PNG</button>' +
        "</div>" +
      "</div>";
    wrap.appendChild(ctrl);

    var menu = ctrl.querySelector(".exp-menu");
    var widthIn = ctrl.querySelector(".exp-w");
    var dimSpan = ctrl.querySelector(".exp-dim");
    function refreshDim() {
      var w = Math.max(1, parseInt(widthIn.value, 10) || 0);
      dimSpan.textContent = w ? w + " × " + Math.round(w * d.h / d.w) + " px" : "";
    }
    refreshDim();

    ctrl.querySelector(".exp-btn").addEventListener("click", function (e) {
      e.stopPropagation();
      if (openCtrl && openCtrl !== ctrl) openCtrl.classList.remove("open");
      var nowOpen = ctrl.classList.toggle("open");
      openCtrl = nowOpen ? ctrl : null;
    });
    // Clicks inside the menu keep it open (only actions/outside close it).
    menu.addEventListener("click", function (e) { e.stopPropagation(); });
    widthIn.addEventListener("input", function () { state.width = Math.max(1, parseInt(widthIn.value, 10) || 0); refreshDim(); });

    ctrl.querySelector('[data-role="bg"]').addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest("button[data-bg]") : null;
      if (!b) return;
      state.bg = b.getAttribute("data-bg");
      [].forEach.call(this.querySelectorAll("button"), function (x) { x.classList.toggle("active", x === b); });
    });
    ctrl.querySelector(".exp-actions").addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest("button[data-a]") : null;
      if (!b) return;
      ctrl.classList.remove("open"); openCtrl = null;
      var name = baseName(svg);
      if (b.getAttribute("data-a") === "svg") exportSVG(svg, name, { bg: state.bg });
      else exportPNG(svg, name, { bg: state.bg, width: state.width });
    });
  }

  function scan(root) {
    var scope = root || document;
    var list = scope.querySelectorAll ? scope.querySelectorAll(CHART_SEL) : [];
    [].forEach.call(list, decorate);
  }

  function observe(root) {
    var target = root || document.body;
    scan(target);
    var pending = false;
    var mo = new MutationObserver(function () {
      if (pending) return;
      pending = true;
      // setTimeout (not rAF) so decoration still runs when the tab is backgrounded.
      setTimeout(function () { pending = false; scan(target); }, 40);
    });
    // childList only (not attributes) so live network drags don't churn this.
    mo.observe(target, { childList: true, subtree: true });
  }

  window.SuiteExport = { exportSVG: exportSVG, exportPNG: exportPNG, serialize: serialize, decorate: decorate, scan: scan, observe: observe };

  function init() { observe(document.getElementById("view") || document.body); }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
