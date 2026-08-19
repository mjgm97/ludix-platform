/* =============================================================================
 * Ludix — player landing page
 * -----------------------------------------------------------------------------
 * The public front door for players at "/". Renders a branded, self-contained
 * page with one illustrated card per hosted game, plus a quiet doorway to the
 * analytics dashboard for admins / educators.
 *
 * Games are still discovered dynamically (subfolders of GAMES_DIR that contain
 * an index.html — see server.js `listGames`). This module only adds *presentation*
 * on top of that list:
 *   - GAME_META[slug]  → rich copy + accent + illustration for known games.
 *   - Unknown folders   → a graceful generic card (title from the slug), so a
 *                         game shows up the moment its folder is dropped in.
 *
 * Brand & art:
 *   - The Ludix logo is designed here from scratch (mark + wordmark lockup, with
 *     light & dark variants). `writeBrandAssets()` emits the standalone SVGs to
 *     public/brand/ so the logo is a real, reusable asset — not just page markup.
 *   - Game illustrations are drawn to match each game's actual art & palette
 *     (see ILLUSTRATIONS below). A game with no bespoke entry gets a friendly
 *     generic card, so it shows up the moment its folder is dropped in.
 *
 * The whole page is one string with inline CSS/JS: no build step, no bundle. The
 * only external request is Google Fonts (the same Fredoka the game uses).
 * ========================================================================== */
"use strict";

const fs = require("fs");
const path = require("path");

const BRAND = {
  name: "Ludix",
  tagline: "Where learning plays.",
  taglineCaps: "Where learning plays",
  blurb:
    "A suite of playful lessons you actually play. Each game turns a real idea " +
    "into a world you explore, with progress and mastery tracked for every learner.",
};

// Signature palette — the suite's brand colours (shared with every game's CSS).
const C = {
  ink: "#0b1120",      // deep navy (bg0)
  white: "#eef2ff",    // ink text
  gold: "#ffd54a",     // accent
  green: "#4ad6a0",    // accent2
  panel: "#0e1626",
  line: "#2c3a58",
};

/* ---- Per-game presentation metadata --------------------------------------- */
const GAME_META = {
  "quick-tap": {
    title: "Quick Tap",
    kicker: "Reference game",
    tagline: "Tap the targets before the clock runs out.",
    description:
      "The suite's tiny demo game — a 20-second reaction test built straight from " +
      "the game template. It ships as a working example of shared identity, scoring, " +
      "and analytics: copy the template to build your own.",
    tags: ["Reaction", "Demo", "Single player"],
    accent: C.gold,
    illo: "quickTap",
  },
};

/* ============================================================================
 * Public entry point
 * ==========================================================================*/
function renderLanding(slugs) {
  const cards = (slugs || []).map(cardFor).join("\n");
  const games = (slugs || []).length;

  const gallery = games
    ? `<section class="grid" id="games">${cards}</section>`
    : `<section class="grid"><div class="empty">
         <div class="empty-ill">${mark({ size: 56 })}</div>
         <h3>No games installed yet</h3>
         <p>Drop a game build into the games folder — each subfolder is served at its own URL and appears here automatically.</p>
       </div></section>`;

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="description" content="${esc(BRAND.name)} — ${esc(BRAND.tagline)} ${esc(BRAND.blurb)}" />
<meta name="theme-color" content="${C.ink}" />
<title>${esc(BRAND.name)} — ${esc(BRAND.tagline)}</title>
<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(faviconSvg())}" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Fredoka:wght@400;500;600;700&family=Nunito:wght@400;600;700;800&display=swap" rel="stylesheet" />
<style>${CSS}</style>
</head>
<body>
  <div class="bg" aria-hidden="true">
    <div class="blob b1"></div><div class="blob b2"></div><div class="blob b3"></div>
    <div class="grid-bg"></div>
  </div>

  <header class="nav">
    <a class="brand" href="/" aria-label="${esc(BRAND.name)} — home">${lockup({ dark: true, height: 34 })}</a>
    <nav class="nav-links">
      <a href="#games">Games</a>
      <a class="btn ghost sm" href="/admin">${iconChart()}<span>Ludix Analytics</span></a>
    </nav>
  </header>

  <main>
    <section class="hero">
      <h1 class="hero-title">Play a game.<br /><span class="grad">Learn something real.</span></h1>
      <p class="hero-sub">${esc(BRAND.blurb)}</p>
      <div class="hero-cta">
        <a class="btn primary" href="#games">Browse the games ↓</a>
        <a class="btn ghost" href="/admin">I'm an educator</a>
      </div>
    </section>

    ${gallery}
  </main>

  <footer class="foot">
    <div class="foot-brand">${lockup({ dark: true, height: 26 })}</div>
    <div class="foot-links">
      <span>One suite · shared progress &amp; analytics</span>
      <a href="/admin">Ludix Analytics →</a>
    </div>
  </footer>

  <script>${JS}</script>
</body></html>`;
}

/* ---- A single game card ----------------------------------------------------- */
function cardFor(slug) {
  const meta = GAME_META[slug] || {};
  const title = meta.title || titleFromSlug(slug);
  const accent = meta.accent || C.green;
  const kicker = meta.kicker || "Game";
  const tagline = meta.tagline || "";
  const description =
    meta.description ||
    "A game in the Ludix suite. Jump in — your progress is tracked as you play.";
  const tags = (meta.tags || []).map((t) => `<span class="tag">${esc(t)}</span>`).join("");
  const illo = (ILLUSTRATIONS[meta.illo] || ILLUSTRATIONS.generic)(accent);

  return `<a class="card" href="/${esc(slug)}/" style="--accent:${esc(accent)}">
    <div class="card-illo">${illo}<span class="card-kicker">${esc(kicker)}</span></div>
    <div class="card-body">
      <h3 class="card-title">${esc(title)}</h3>
      ${tagline ? `<p class="card-tagline">${esc(tagline)}</p>` : ""}
      <p class="card-desc">${esc(description)}</p>
      ${tags ? `<div class="card-tags">${tags}</div>` : ""}
      <span class="card-play">Play ${esc(title)} <span class="arr">→</span></span>
    </div>
  </a>`;
}

/* ============================================================================
 * LOGO SYSTEM  (designed from scratch)
 * -----------------------------------------------------------------------------
 * The mark: a gold→green "squircle" tile holding a play triangle (a game ▶) with
 * an insight spark (the learning). The wordmark: Fredoka, tracked, with a
 * gradient underline swoosh and a matching spark — a cohesive lockup, offered in
 * a light and a dark variant.
 * ==========================================================================*/

let _uid = 0;
const uid = (p) => `${p}${(++_uid).toString(36)}`;

// A 4-point "insight" sparkle centred at (cx,cy) with radius r.
function spark(cx, cy, r, fill) {
  const k = r * 0.16;
  return `<path d="M${cx} ${cy - r} Q${cx + k} ${cy - k} ${cx + r} ${cy} Q${cx + k} ${cy + k} ${cx} ${cy + r} Q${cx - k} ${cy + k} ${cx - r} ${cy} Q${cx - k} ${cy - k} ${cx} ${cy - r} Z" fill="${fill}"/>`;
}

// The tile glyph drawn on a 48-unit grid, transformed to (x,y) at scale k. Needs
// a gradient <defs> with id `gid` present in the enclosing <svg>.
function tileGlyph(x, y, s, gid) {
  const k = s / 48;
  return `<g transform="translate(${x} ${y}) scale(${k})">
    <rect width="48" height="48" rx="13" fill="url(#${gid})"/>
    <path d="M4 20 A13 13 0 0 1 20 4 L20 4 A20 20 0 0 0 4 22 Z" fill="#ffffff" opacity=".18"/>
    <path d="M19.5 14.6 L19.5 32.6 a2.3 2.3 0 0 0 3.4 2 L35 26.6 a2.3 2.3 0 0 0 0-3.9 L22.9 15 a2.3 2.3 0 0 0 -3.4 2 Z" fill="${C.ink}"/>
    ${spark(33.5, 15.5, 5.6, "#ffffff")}
    ${spark(33.5, 15.5, 2.4, C.gold)}
  </g>`;
}

// The standalone mark (favicon / small usages / hero badge).
function mark({ size = 40 }) {
  const gid = uid("m");
  return `<svg class="mark" width="${size}" height="${size}" viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <defs>${gradDef(gid)}</defs>${tileGlyph(0, 0, 48, gid)}
  </svg>`;
}

// The full horizontal lockup: mark + wordmark (+ optional tagline).
// `dark` picks the wordmark ink for the background it sits on.
function lockup({ dark = true, height = 40, tagline = false } = {}) {
  const gid = uid("l"), ugid = uid("u");
  const inkText = dark ? C.white : C.ink;
  const subText = dark ? "#9fb2d6" : "#5f6d8a";
  const vbW = tagline ? 202 : 176, vbH = tagline ? 68 : 56;
  const w = Math.round((vbW / vbH) * height);
  const tag = tagline
    ? `<text x="61" y="63" font-family="Nunito,system-ui,sans-serif" font-size="8.2" letter-spacing="1.7"
         font-weight="800" fill="${subText}">${esc(BRAND.taglineCaps.toUpperCase())}</text>`
    : "";
  return `<svg class="lockup" width="${w}" height="${height}" viewBox="0 0 ${vbW} ${vbH}" fill="none"
      role="img" aria-label="${esc(BRAND.name)}">
    <defs>${gradDef(gid)}
      <linearGradient id="${ugid}" x1="61" y1="0" x2="152" y2="0" gradientUnits="userSpaceOnUse">
        <stop stop-color="${C.gold}"/><stop offset="1" stop-color="${C.green}"/>
      </linearGradient>
    </defs>
    ${tileGlyph(4, 6, 44, gid)}
    <text x="60" y="40" font-family="Fredoka,'Segoe UI',system-ui,sans-serif" font-size="34"
      font-weight="600" letter-spacing=".4" fill="${inkText}">Ludix</text>
    <path d="M61 46 H144 q7 0 9 -5" stroke="url(#${ugid})" stroke-width="3.6" stroke-linecap="round" fill="none"/>
    ${spark(160, 18, 5, C.gold)}${spark(153, 9, 2.4, C.green)}
    ${tag}
  </svg>`;
}

function gradDef(id) {
  return `<linearGradient id="${id}" x1="6" y1="6" x2="42" y2="42" gradientUnits="userSpaceOnUse">
    <stop stop-color="${C.gold}"/><stop offset="1" stop-color="${C.green}"/></linearGradient>`;
}

function faviconSvg() {
  const gid = "f";
  return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48" viewBox="0 0 48 48" fill="none">
    <defs>${gradDef(gid)}</defs>${tileGlyph(0, 0, 48, gid)}</svg>`;
}

// Emit the logo as real, reusable brand files. Called once at module load; safe
// to fail (e.g. read-only FS) — it never blocks the server.
function writeBrandAssets() {
  try {
    const dir = path.join(__dirname, "..", "public", "brand");
    fs.mkdirSync(dir, { recursive: true });
    // Add the XML namespace only if the SVG doesn't already declare one (the
    // favicon markup does) — a duplicate xmlns attribute is invalid XML.
    const xmlns = (svg) =>
      svg.includes("xmlns=") ? svg : svg.replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" ');
    const files = {
      "mark.svg": faviconSvg(),
      "logo-dark.svg": lockup({ dark: true, height: 56 }),
      "logo-light.svg": lockup({ dark: false, height: 56 }),
      "logo-dark-tagline.svg": lockup({ dark: true, height: 72, tagline: true }),
      "logo-light-tagline.svg": lockup({ dark: false, height: 72, tagline: true }),
    };
    for (const [name, svg] of Object.entries(files)) {
      fs.writeFileSync(path.join(dir, name), xmlns(svg) + "\n");
    }
  } catch (e) {
    /* presentation nicety — never fatal */
  }
}

function iconChart() {
  return `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>`;
}

/* ============================================================================
 * Per-game illustrations — drawn to match each game's real art & palette.
 * ==========================================================================*/
const ILLUSTRATIONS = {
  // Quick Tap — the game's own look: its dark card (games/_template/css/style.css),
  // the gold HUD strip with Score / Time, and a glowing gold target on a radial
  // stage. A faithful, tiny still of the reference game.
  quickTap() {
    const u = uid("qt");
    return `<svg class="illo" viewBox="0 0 400 220" preserveAspectRatio="xMidYMid slice" role="img"
        aria-label="Quick Tap: a glowing gold target on the game's dark stage with a score-and-timer HUD">
      <defs>
        <radialGradient id="stage${u}" cx="0.5" cy="0.32" r="0.75">
          <stop offset="0" stop-color="#12203a"/><stop offset="1" stop-color="#0b1120"/>
        </radialGradient>
        <radialGradient id="targ${u}" cx="0.36" cy="0.3" r="0.75">
          <stop offset="0" stop-color="#ffe27a"/><stop offset="1" stop-color="${C.gold}"/>
        </radialGradient>
        <radialGradient id="halo${u}" cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stop-color="${C.gold}" stop-opacity=".45"/><stop offset="1" stop-color="${C.gold}" stop-opacity="0"/>
        </radialGradient>
      </defs>

      <rect width="400" height="220" fill="url(#stage${u})"/>

      <!-- HUD strip: Score · title · Time (echoes the in-game .hud) -->
      <g font-family="Nunito,sans-serif">
        <rect x="0" y="0" width="400" height="42" fill="#132039" fill-opacity=".55"/>
        <line x1="0" y1="42" x2="400" y2="42" stroke="${C.line}"/>
        <text x="24" y="18" font-size="9" letter-spacing="1" font-weight="800" fill="#9fb2d6">SCORE</text>
        <text x="24" y="34" font-size="17" font-weight="800" fill="${C.white}">7</text>
        <text x="200" y="27" text-anchor="middle" font-family="Fredoka,sans-serif" font-size="15" font-weight="600" fill="${C.white}">Quick Tap</text>
        <text x="376" y="18" text-anchor="end" font-size="9" letter-spacing="1" font-weight="800" fill="#9fb2d6">TIME</text>
        <text x="376" y="34" text-anchor="end" font-size="17" font-weight="800" fill="${C.white}">12.3</text>
      </g>

      <!-- a couple of faint spent targets -->
      <circle cx="96" cy="150" r="18" fill="${C.gold}" opacity=".14"/>
      <circle cx="320" cy="96" r="14" fill="${C.gold}" opacity=".12"/>

      <!-- the live target: halo + gold puck with a soft highlight ring -->
      <g transform="translate(214 138)">
        <circle r="72" fill="url(#halo${u})"/>
        <circle r="34" fill="url(#targ${u})" stroke="${C.gold}" stroke-opacity=".35" stroke-width="8"/>
        <circle cx="-10" cy="-11" r="8" fill="#fff" opacity=".55"/>
      </g>
    </svg>`;
  },

  // Fallback — bright, brand-aligned placeholder for any game without bespoke art.
  generic(accent) {
    const u = uid("g");
    return `<svg class="illo" viewBox="0 0 400 220" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Game illustration">
      <defs>
        <linearGradient id="bg${u}" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#cfe6f0"/><stop offset="1" stop-color="#eef3df"/></linearGradient>
      </defs>
      <rect width="400" height="220" fill="url(#bg${u})"/>
      <circle cx="316" cy="58" r="26" fill="#ffd54a" opacity=".9"/>
      <path d="M0 160 Q140 132 260 154 T400 146 V220 H0 Z" fill="#d7c98a"/>
      <path d="M0 190 Q150 174 280 188 T400 184 V220 H0 Z" fill="#c7b96f"/>
      ${coneTree(300, 150, 1.05)}${grassTuft(90, 198, "#7cc043")}
      <g transform="translate(150 118)">
        <circle r="40" fill="#ffffff" stroke="${accent}" stroke-width="4"/>
        <path d="M-12 -18 L-12 18 a3 3 0 0 0 4.6 2.6 L22 3 a3 3 0 0 0 0-5.2 L-7.4 -20.6 a3 3 0 0 0 -4.6 2.6 Z" fill="${accent}"/>
      </g>
    </svg>`;
  },
};

// A flat Kenney-style cone tree (assets/foliage/tree_a): stacked green triangles
// + a brown trunk. `x,y` is the trunk base; `s` scales it.
function coneTree(x, y, s) {
  const w = 46 * s, h = 78 * s, tw = 9 * s, th = 12 * s;
  const cx = x;
  const tri = (yTop, yBot, halfW, fill) =>
    `<path d="M${cx} ${yTop} L${cx + halfW} ${yBot} Q${cx} ${yBot + 4 * s} ${cx - halfW} ${yBot} Z" fill="${fill}"/>`;
  return `<g>
    <rect x="${cx - tw / 2}" y="${y - th}" width="${tw}" height="${th + 2 * s}" rx="${2 * s}" fill="#b0824e"/>
    ${tri(y - h, y - h * 0.52, w * 0.5, "#6cb33f")}
    ${tri(y - h * 0.74, y - h * 0.28, w * 0.42, "#7cc043")}
    ${tri(y - h * 0.5, y - th, w * 0.34, "#8ccf4d")}
  </g>`;
}

// A small grass tuft (assets/foliage/grass_a): a few blades.
function grassTuft(x, y, fill) {
  return `<g fill="${fill}">
    <path d="M${x} ${y} q-3 -14 -9 -18 q7 3 9 16 Z"/>
    <path d="M${x} ${y} q3 -16 10 -20 q-6 5 -10 18 Z"/>
    <path d="M${x} ${y} q0 -12 1 -20 q3 8 -1 20 Z"/>
  </g>`;
}

/* ============================================================================
 * Styles + tiny runtime
 * ==========================================================================*/
const CSS = `
:root{
  --bg:#0b1120; --bg2:#0e1626; --panel:#121c33; --panel2:#152039; --line:#2c3a58;
  --ink:#eef2ff; --muted:#9fb2d6; --muted2:#5f6d8a;
  --gold:#ffd54a; --green:#4ad6a0; --blue:#5aa9ff;
  color-scheme:dark;
}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{background:var(--bg);color:var(--ink);
  font:16px/1.6 "Nunito",system-ui,-apple-system,sans-serif;
  -webkit-font-smoothing:antialiased;overflow-x:hidden}
a{color:inherit;text-decoration:none}

.bg{position:fixed;inset:0;z-index:-1;overflow:hidden;
  background:radial-gradient(1200px 800px at 70% -10%,#16233d,var(--bg))}
.blob{position:absolute;border-radius:50%;filter:blur(80px)}
.b1{width:560px;height:560px;background:radial-gradient(circle,#1f6feb44,transparent 70%);top:-180px;left:-140px;animation:float1 22s ease-in-out infinite}
.b2{width:520px;height:520px;background:radial-gradient(circle,#4ad6a033,transparent 70%);bottom:-200px;right:-140px;animation:float2 26s ease-in-out infinite}
.b3{width:420px;height:420px;background:radial-gradient(circle,#ffd54a22,transparent 70%);top:30%;left:48%;animation:float1 30s ease-in-out infinite}
.grid-bg{position:absolute;inset:0;opacity:.5;
  background-image:linear-gradient(#2c3a5822 1px,transparent 1px),linear-gradient(90deg,#2c3a5822 1px,transparent 1px);
  background-size:46px 46px;mask-image:radial-gradient(ellipse 80% 60% at 50% 30%,#000,transparent 85%)}
@keyframes float1{0%,100%{transform:translate(0,0)}50%{transform:translate(46px,34px)}}
@keyframes float2{0%,100%{transform:translate(0,0)}50%{transform:translate(-34px,-46px)}}

.nav{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:16px;
  padding:16px clamp(18px,5vw,54px);
  background:linear-gradient(180deg,rgba(11,17,32,.85),rgba(11,17,32,0));backdrop-filter:blur(6px)}
.brand{display:inline-flex;align-items:center}
.lockup{display:block}
.mark{display:block;filter:drop-shadow(0 4px 12px rgba(74,214,160,.28))}
.nav-links{margin-left:auto;display:flex;align-items:center;gap:20px;font-size:14.5px;font-weight:700}
.nav-links>a:not(.btn){color:var(--muted)}
.nav-links>a:not(.btn):hover{color:var(--ink)}

.btn{display:inline-flex;align-items:center;gap:8px;border-radius:12px;padding:12px 20px;
  font-weight:800;font-size:15px;cursor:pointer;transition:transform .14s,border-color .14s,background .14s,box-shadow .14s;border:1px solid transparent}
.btn.sm{padding:8px 13px;font-size:13px;border-radius:10px}
.btn.primary{background:linear-gradient(90deg,var(--gold),var(--green));color:#0b1120;box-shadow:0 12px 30px rgba(74,214,160,.22)}
.btn.primary:hover{transform:translateY(-2px);box-shadow:0 18px 40px rgba(74,214,160,.3)}
.btn.ghost{background:rgba(19,33,53,.6);border-color:var(--line);color:var(--ink)}
.btn.ghost:hover{border-color:var(--green);transform:translateY(-1px)}

main{max-width:1160px;margin:0 auto;padding:0 clamp(18px,5vw,32px)}

.hero{text-align:center;padding:clamp(40px,8vw,88px) 0 clamp(30px,5vw,54px)}
.hero-title{font-family:"Fredoka",sans-serif;font-weight:600;letter-spacing:-.015em;
  font-size:clamp(38px,7vw,68px);line-height:1.02;margin:0 0 18px}
.grad{background:linear-gradient(90deg,var(--gold),var(--green));-webkit-background-clip:text;background-clip:text;color:transparent}
.hero-sub{color:var(--muted);font-size:clamp(16px,2.2vw,19px);max-width:640px;margin:0 auto 30px;line-height:1.65}
.hero-cta{display:flex;gap:14px;justify-content:center;flex-wrap:wrap}

.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,380px));gap:24px;
  justify-content:center;padding:8px 0 40px;scroll-margin-top:80px}
.card{position:relative;display:flex;flex-direction:column;overflow:hidden;
  background:linear-gradient(180deg,var(--panel2),var(--bg2));border:1px solid var(--line);border-radius:20px;
  transition:transform .18s,border-color .18s,box-shadow .18s}
.card:hover{transform:translateY(-4px);border-color:color-mix(in srgb,var(--accent) 60%,var(--line));
  box-shadow:0 26px 60px rgba(0,0,0,.5),0 0 0 1px color-mix(in srgb,var(--accent) 25%,transparent)}
.card-illo{position:relative;aspect-ratio:16/9;overflow:hidden;background:#bfe4ef;
  border-bottom:1px solid var(--line)}
.card-illo .illo{width:100%;height:100%;display:block;transition:transform .4s ease}
.card:hover .card-illo .illo{transform:scale(1.05)}
.card-illo::after{content:"";position:absolute;inset:0;background:linear-gradient(180deg,transparent 62%,rgba(11,17,32,.28))}
.card-kicker{position:absolute;top:12px;left:12px;z-index:2;font-size:11.5px;font-weight:800;letter-spacing:.05em;
  text-transform:uppercase;color:var(--ink);background:rgba(11,17,32,.6);border:1px solid var(--line);
  border-radius:999px;padding:5px 11px;backdrop-filter:blur(4px)}
.card-body{padding:18px 20px 20px;display:flex;flex-direction:column;flex:1}
.card-title{font-family:"Fredoka",sans-serif;font-weight:600;font-size:23px;margin:0 0 4px}
.card-tagline{color:var(--accent);font-weight:700;font-size:13.5px;margin:0 0 10px}
.card-desc{color:var(--muted);font-size:14.5px;line-height:1.6;margin:0 0 16px;flex:1}
.card-tags{display:flex;flex-wrap:wrap;gap:7px;margin-bottom:18px}
.tag{font-size:11.5px;font-weight:700;color:var(--muted);background:var(--bg2);border:1px solid var(--line);border-radius:999px;padding:4px 11px}
.card-play{display:inline-flex;align-items:center;gap:8px;font-weight:800;font-size:14.5px;
  color:#0b1120;background:var(--accent);border-radius:11px;padding:11px 16px;align-self:flex-start;
  transition:gap .16s,filter .16s}
.card:hover .card-play{filter:brightness(1.08)}
.card:hover .card-play .arr{transform:translateX(3px)}
.card-play .arr{transition:transform .16s}

.empty{grid-column:1/-1;text-align:center;color:var(--muted);
  background:var(--panel);border:1px dashed var(--line);border-radius:20px;padding:56px 30px}
.empty-ill{display:flex;justify-content:center;margin-bottom:12px}
.empty h3{margin:0 0 6px;color:var(--ink);font-family:"Fredoka",sans-serif;font-weight:600;font-size:22px}
.empty p{margin:0 auto;max-width:440px}

.foot{max-width:1160px;margin:20px auto 0;padding:26px clamp(18px,5vw,32px);
  border-top:1px solid var(--line);display:flex;flex-wrap:wrap;gap:16px;align-items:center;
  justify-content:space-between;color:var(--muted2);font-size:13.5px}
.foot-brand{display:flex;align-items:center}
.foot-links{display:flex;gap:20px;align-items:center;flex-wrap:wrap}
.foot-links a{color:var(--green);font-weight:700}
.foot-links a:hover{text-decoration:underline}

.card,.hero>*{opacity:0;transform:translateY(14px);animation:rise .6s cubic-bezier(.2,.8,.3,1) forwards}
.hero>*:nth-child(1){animation-delay:.02s}.hero>*:nth-child(2){animation-delay:.08s}
.hero>*:nth-child(3){animation-delay:.14s}.hero>*:nth-child(4){animation-delay:.2s}
@keyframes rise{to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}.card,.hero>*{opacity:1;transform:none}}

@media(max-width:600px){
  .nav-links>a:not(.btn){display:none}
  .grid{grid-template-columns:1fr}
}
`;

const JS = `
document.querySelectorAll('.card').forEach(function(c,i){
  c.style.animationDelay=(0.24 + i*0.07)+'s';
});
document.querySelectorAll('a[href^="#"]').forEach(function(a){
  a.addEventListener('click',function(e){
    var el=document.querySelector(a.getAttribute('href'));
    if(el){e.preventDefault();el.scrollIntoView({behavior:'smooth',block:'start'});}
  });
});
`;

/* ---- small helpers --------------------------------------------------------- */
function titleFromSlug(s) {
  return String(s).replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Emit brand assets on load (best-effort).
writeBrandAssets();

module.exports = { renderLanding, GAME_META, BRAND, writeBrandAssets };
