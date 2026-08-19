#!/usr/bin/env node
/* =============================================================================
 * Ludix game bundler (generic starter)
 * -----------------------------------------------------------------------------
 * Assembles this game into a self-contained folder the suite server hosts:
 *
 *   dist/<slug>/index.html   CSS inlined, JS modules inlined in order, and a
 *                            baked window.SUITE_CONFIG (gameId + apiBase).
 *   dist/<slug>/assets/…     copied verbatim if an assets/ folder exists.
 *
 * The <slug> is the output folder name (from OUT_DIR, or this game's folder
 * name). It becomes the game's URL (/<slug>/) AND its gameId in the database, so
 * scores/analytics are attributed correctly — keep the folder name stable.
 *
 * Usage:
 *   npm run build                                   # → ../../dist/<slug>/ (same-origin API)
 *   API_BASE=https://api.example.com npm run build  # bake a remote API origin
 *   OFFLINE=1 npm run build                         # analytics disabled in the bundle
 *
 * Add/rename JS modules in MODULES below (load order matters). No other change
 * is needed to ship a new game.
 * ========================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const OUT = process.env.OUT_DIR
  ? (path.isAbsolute(process.env.OUT_DIR) ? process.env.OUT_DIR : path.join(ROOT, process.env.OUT_DIR))
  : path.join(ROOT, "..", "..", "dist", path.basename(ROOT));
const SLUG = process.env.GAME_ID || path.basename(OUT);

// JS files inlined into the page, in load order. Suite client first, then yours.
const MODULES = ["js/suite.js", "js/game.js"];
// CSS files inlined into the page, in order.
const STYLES = ["css/style.css"];

// Baked runtime config. apiBase = <API_BASE origin> + "/api" (same-origin when
// API_BASE is empty, i.e. the suite server hosts both the game and the API).
const apiBase = (process.env.API_BASE != null ? process.env.API_BASE : "").replace(/\/$/, "") + "/api";
const suiteConfig = { gameId: SLUG, apiBase: apiBase };
if (process.env.OFFLINE) suiteConfig.enabled = false;

function read(rel) { return fs.readFileSync(path.join(ROOT, rel), "utf8"); }
// Inlined <script>/<style> bodies must not contain a literal closing tag.
function safe(s, tag) { return s.replace(new RegExp("</(" + tag + ")", "gi"), "<\\/$1"); }
function kb(n) { return (n / 1024).toFixed(0) + " KB"; }

function build() {
  const css = STYLES.map((f) => "/* " + f + " */\n" + read(f)).join("\n");
  const scripts = MODULES
    .map((f) => "  <!-- " + f + " -->\n  <script>\n" + safe(read(f), "script") + "\n  </script>")
    .join("\n");

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
  <title>${SLUG}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600;700&family=Nunito:wght@400;600;700;800&display=swap" rel="stylesheet" />
  <style>
${safe(css, "style")}
  </style>
  <script>window.SUITE_CONFIG = ${JSON.stringify(suiteConfig)};</script>
</head>
<body>
  <div id="game"></div>
${scripts}
</body>
</html>
`;

  // Fresh output folder.
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "index.html"), html);

  // Copy assets/ verbatim if present (images, audio, fonts — referenced as
  // "assets/…" from your CSS/JS; served at /<slug>/assets/…).
  const assetsDir = path.join(ROOT, "assets");
  let assetNote = "no assets/ folder";
  if (fs.existsSync(assetsDir)) {
    fs.cpSync(assetsDir, path.join(OUT, "assets"), { recursive: true });
    assetNote = "assets/ copied";
  }

  const outName = path.relative(path.join(ROOT, "..", ".."), OUT) || OUT;
  console.log(`${SLUG} build complete → ${outName}/`);
  console.log(`  index.html : ${kb(Buffer.byteLength(html))}   (${assetNote})`);
  console.log(`  gameId     : ${SLUG}   apiBase: ${apiBase}` + (suiteConfig.enabled === false ? "   (offline)" : ""));
}

build();
