#!/usr/bin/env node
/* =============================================================================
 * Ludix — build every game
 * -----------------------------------------------------------------------------
 * Walks games/*, and for every folder that has a build.js, runs it to produce a
 * self-contained bundle in dist/<slug>/ — the folder the suite server hosts.
 *
 * So adding a game to the suite is: drop a folder in games/ with its own
 * build.js, and it's built and served automatically. No change here needed.
 *
 *   npm run build                       # build all games → dist/*
 *   API_BASE=https://api.example.com npm run build   # bake a remote API base
 * ========================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");
const cp = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "games");
const DIST = path.join(ROOT, "dist");

// Same-origin API by default (the game reaches /api on whatever host serves it).
const API_BASE = process.env.API_BASE != null ? process.env.API_BASE : "";

let slugs = [];
try {
  slugs = fs
    .readdirSync(SRC, { withFileTypes: true })
    // Skip folders starting with "_" or "." — e.g. games/_template/ is a starter
    // to copy, not a game to ship.
    .filter((d) => d.isDirectory() && !/^[_.]/.test(d.name) && fs.existsSync(path.join(SRC, d.name, "build.js")))
    .map((d) => d.name)
    .sort();
} catch (e) {
  console.error(`No games/ folder found at ${SRC}`);
  process.exit(1);
}

if (!slugs.length) {
  console.log("No buildable games found (a game is a folder in games/ with a build.js).");
  process.exit(0);
}

console.log(`Building ${slugs.length} game(s) → dist/  (API_BASE=${JSON.stringify(API_BASE)})`);
for (const slug of slugs) {
  const out = path.join(DIST, slug);
  console.log(`\n▶ ${slug} → dist/${slug}/`);
  cp.execFileSync(process.execPath, ["build.js"], {
    cwd: path.join(SRC, slug),
    stdio: "inherit",
    env: Object.assign({}, process.env, { OUT_DIR: out, API_BASE }),
  });
}
console.log(`\n✓ Done. ${slugs.length} game(s) in dist/.`);
