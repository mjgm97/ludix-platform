/* =============================================================================
 * Ludix Analytics — chart export (SVG + PNG, game-agnostic)
 * -----------------------------------------------------------------------------
 * Adds a hover "download" control to every chart in the dashboard and exports it
 * as a self-contained SVG (vector) or a PNG at a chosen resolution. Works on ANY
 * inline-SVG chart — transition networks, sequence plots, the stability line
 * chart, the pattern pyramid, SHAP plots, the research/overview charts — because
 * a MutationObserver decorates chart <svg>s as they appear, so new charts are
 * covered automatically with no per-chart wiring.
 *
 * Two things make an on-page SVG exportable standalone:
 *   1. The page stylesheet isn't available to a saved file, so the styles charts
 *      rely on (node/edge labels, fonts) are inlined as a <style> block, with the
 *      draw-in animation (.cline) neutralised so lines don't export invisible.
 *   2. A solid background rect is baked in (the app is dark-themed with light
 *      labels, so a transparent export would be unreadable on white).
 * PNG is produced by rasterising that self-contained SVG onto a canvas scaled by
 * the chosen factor (the SVG carries no external refs, so the canvas isn't
 * tainted and toBlob() works).
 * ========================================================================== */
(function () {
  "use strict";

  var SVGNS = "http://www.w3.org/2000/svg";
  // Chart <svg>s to decorate (deliberately NOT icon/caret/logo svgs).
  var CHART_SEL = "svg.tna-svg, svg.tna-seqsvg, svg.ichart, svg.tna-pyr-svg";
  var BG = "#0e1730";   // baked-in dark background (matches the network panels)

  // The subset of the page stylesheet charts depend on, with CSS variables
  // resolved to literals and the .cline draw animation neutralised.
  var EXPORT_CSS =
    "svg,text{font-family:'Nunito',system-ui,-apple-system,'Segoe UI',sans-serif}" +
    ".tna-nlabel{fill:#eff3ff;font-size:12px;font-weight:800;paint-order:stroke;stroke:#0a1020;stroke-width:3.4px;stroke-linejoin:round}" +
    ".tna-elabel{fill:#eff3ff;font-size:11.5px;font-weight:800;font-variant-numeric:tabular-nums;paint-order:stroke;stroke:#0a1020;stroke-width:3px;stroke-linejoin:round}" +
    ".tna-seqsvg .tna-elabel{fill:#63718f;font-size:9px;font-weight:600;stroke:none;paint-order:normal}" +
    ".cline{stroke-dasharray:none !important;stroke-dashoffset:0 !important}" +
    ".dim{opacity:1 !important}";

  var RESOLUTIONS = [1, 2, 3, 4];   // PNG scale factors

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
    var d = dims(svg);
    var clone = svg.cloneNode(true);
    clone.setAttribute("xmlns", SVGNS);
    clone.setAttribute("xmlns:xlink", "http://www.w3.org/1999/xlink");
    clone.setAttribute("width", d.w);
    clone.setAttribute("height", d.h);
    clone.setAttribute("viewBox", "0 0 " + d.w + " " + d.h);
    clone.removeAttribute("style");            // drop width:100% etc.
    if (clone.classList) clone.classList.remove("isolating");

    if (opts.bg !== "transparent") {
      var rect = document.createElementNS(SVGNS, "rect");
      rect.setAttribute("x", 0); rect.setAttribute("y", 0);
      rect.setAttribute("width", d.w); rect.setAttribute("height", d.h);
      rect.setAttribute("fill", opts.bg || BG);
      clone.insertBefore(rect, clone.firstChild);
    }
    var style = document.createElementNS(SVGNS, "style");
    style.textContent = EXPORT_CSS;
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

  function exportPNG(svg, name, scale, opts) {
    scale = scale || 2;
    var r = serialize(svg, opts);
    var svgUrl = URL.createObjectURL(new Blob([r.str], { type: "image/svg+xml;charset=utf-8" }));
    var img = new Image();
    img.onload = function () {
      var canvas = document.createElement("canvas");
      canvas.width = Math.round(r.w * scale);
      canvas.height = Math.round(r.h * scale);
      var ctx = canvas.getContext("2d");
      ctx.setTransform(scale, 0, 0, scale, 0, 0);
      ctx.drawImage(img, 0, 0);
      URL.revokeObjectURL(svgUrl);
      canvas.toBlob(function (blob) {
        if (blob) download(blob, name + "@" + scale + "x.png");
      }, "image/png");
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
        '<div class="exp-menu-lbl">Vector</div>' +
        '<button type="button" data-a="svg">SVG</button>' +
        '<div class="exp-menu-lbl">Raster (PNG)</div>' +
        RESOLUTIONS.map(function (s) {
          return '<button type="button" data-a="png" data-s="' + s + '">' + s + "× · " + Math.round(d.w * s) + "×" + Math.round(d.h * s) + " px</button>";
        }).join("") +
      "</div>";
    wrap.appendChild(ctrl);

    ctrl.querySelector(".exp-btn").addEventListener("click", function (e) {
      e.stopPropagation();
      if (openCtrl && openCtrl !== ctrl) openCtrl.classList.remove("open");
      var nowOpen = ctrl.classList.toggle("open");
      openCtrl = nowOpen ? ctrl : null;
    });
    ctrl.querySelector(".exp-menu").addEventListener("click", function (e) {
      var b = e.target.closest ? e.target.closest("button") : null;
      if (!b) return;
      e.stopPropagation();
      ctrl.classList.remove("open"); openCtrl = null;
      var name = baseName(svg);
      if (b.getAttribute("data-a") === "svg") exportSVG(svg, name);
      else exportPNG(svg, name, parseInt(b.getAttribute("data-s"), 10) || 2);
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
