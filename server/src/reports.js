/* =============================================================================
 * Suite server — report generation (Export tab → "Build a report")
 * -----------------------------------------------------------------------------
 * Turns the SAME game-agnostic analytics the dashboard already computes (summary
 * tiles, engagement distributions, the daily timeline, the per-student roster)
 * into a single self-contained HTML document, filtered by a date/time range and
 * an optional set of students. The document embeds its own CSS + inline-SVG
 * charts (no external assets), carries a "Print / Save as PDF" button and a
 * print stylesheet, and is stored in the `reports` table so it can be listed,
 * re-opened, downloaded and printed later — that's the "record of exported ones".
 *
 * Filtering reuses analytics-util's helpers (filterParams / whereFor / joinFor),
 * so a report's numbers match the dashboard's for the same scope, and the
 * multi-student selection rides the existing `user` filter (which already accepts
 * a list). All routes are mounted behind requireAdmin (see admin-api → server).
 * ========================================================================== */
"use strict";

const db = require("./db");
const U = require("./analytics-util");
const pm = require("./process-mining");

const HIST_SCORE_LABELS = ["0–10", "10–20", "20–30", "30–40", "40–50", "50–60", "60–70", "70–80", "80–90", "90–100"];
const HIST_DUR_LABELS = ["0–2m", "2–5m", "5–10m", "10–20m", "20–40m", "40m+"];
const SECTION_KEYS = ["summary", "engagement", "timeline", "students"];
// Hard cap on stored reports (global, across all games). Enforced server-side so
// the generate endpoint can't be spammed into filling the DB — the check runs
// before any query/mining work, so a caller at the cap is rejected cheaply.
const MAX_REPORTS = 50;

// ---- tiny format/escape helpers --------------------------------------------
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmt(n) { return n == null || isNaN(n) ? "—" : Number(n).toLocaleString("en-US"); }
function pct(x, d) { return x == null || isNaN(x) ? "—" : (x * 100).toFixed(d == null ? 0 : d) + "%"; }
function titleCase(s) { return String(s).replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim().replace(/\b\w/g, (c) => c.toUpperCase()); }
function prettyGame(id) { return titleCase(id).replace(/\bAi\b/g, "AI").replace(/\bMl\b/g, "ML").replace(/\bVr\b/g, "VR"); }

// ============================================================================
// DATA — mirrors the dashboard's queries (same tables, same U filter helpers)
// ============================================================================
function computeReportData(gameId, query, sections) {
  const P = Object.assign({ g: gameId }, U.filterParams(query));
  const eW = U.whereFor("e", query), sW = U.whereFor("s", query);
  const eJ = U.joinFor("e", query), sJ = U.joinFor("s", query);
  const out = { gameId };

  // ---- Summary tiles ----
  const ev = db.prepare(
    `SELECT COUNT(*) AS events, COUNT(DISTINCT e.player_id) AS players, COUNT(DISTINCT e.session_id) AS sessions
       FROM events e${eJ} WHERE e.game_id=@g${eW}`
  ).get(P);
  const sc = db.prepare(
    `SELECT COUNT(*) AS runs, AVG(s.score) AS avgScore, AVG(s.stars) AS avgStars
       FROM scores s${sJ} WHERE s.game_id=@g${sW}`
  ).get(P);
  const returning = db.prepare(
    `SELECT COUNT(*) AS n FROM (SELECT e.player_id FROM events e${eJ}
       WHERE e.game_id=@g${eW} GROUP BY e.player_id HAVING COUNT(DISTINCT e.session_id) > 1)`
  ).get(P).n;
  const durAgg = db.prepare(
    `SELECT AVG(m) AS avgMin,
            SUM(m < 2) AS b0, SUM(m >= 2 AND m < 5) AS b1, SUM(m >= 5 AND m < 10) AS b2,
            SUM(m >= 10 AND m < 20) AS b3, SUM(m >= 20 AND m < 40) AS b4, SUM(m >= 40) AS b5
       FROM (SELECT MAX(0, MAX(e.t_ms) - MIN(e.t_ms)) / 60000.0 AS m
               FROM events e${eJ} WHERE e.game_id=@g${eW} GROUP BY e.session_id)`
  ).get(P);
  out.tiles = {
    players: ev.players || 0, sessions: ev.sessions || 0, events: ev.events || 0, runs: sc.runs || 0,
    avgScore: sc.avgScore != null ? U.round(sc.avgScore, 4) : null,
    avgStars: sc.avgStars != null ? U.round(sc.avgStars, 2) : null,
    avgSessionMin: durAgg.avgMin != null ? U.round(durAgg.avgMin, 1) : null,
    avgEventsPerSession: ev.sessions ? U.round(ev.events / ev.sessions, 1) : null,
    sessionsPerPlayer: ev.players ? U.round(ev.sessions / ev.players, 1) : null,
    returningRate: ev.players ? U.round(returning / ev.players, 3) : null,
  };
  out.sessionLength = HIST_DUR_LABELS.map((bucket, i) => ({ label: bucket, value: durAgg["b" + i] || 0 }));

  // ---- Engagement distributions ----
  if (sections.engagement) {
    const scoreAgg = db.prepare(
      `SELECT MIN(9, MAX(0, CAST(s.score * 10 AS INT))) AS b, COUNT(*) AS n
         FROM scores s${sJ} WHERE s.game_id=@g${sW} GROUP BY b`
    ).all(P);
    const sb = {}; scoreAgg.forEach((r) => (sb[r.b] = r.n));
    out.scoreHistogram = HIST_SCORE_LABELS.map((label, i) => ({ label, value: sb[i] || 0 }));

    const hourRows = db.prepare(
      `SELECT CAST(strftime('%H', e.created_at) AS INT) AS h, COUNT(*) AS n
         FROM events e${eJ} WHERE e.game_id=@g${eW} GROUP BY h`
    ).all(P);
    const hm = {}; hourRows.forEach((r) => (hm[r.h] = r.n));
    out.hourly = Array.from({ length: 24 }, (_, h) => ({ label: String(h).padStart(2, "0"), value: hm[h] || 0 }));

    out.eventTypes = db.prepare(
      `SELECT e.type AS type, COUNT(*) AS count FROM events e${eJ}
         WHERE e.game_id=@g${eW} GROUP BY e.type ORDER BY count DESC LIMIT 12`
    ).all(P).map((r) => ({ label: titleCase(r.type || "—"), value: r.count }));

    // Behaviour patterns + the transition network, reusing the process-mining
    // module (same computation as the dashboard's Process / Network tabs). Wrapped
    // defensively so sparse data or a mining hiccup never breaks the whole report.
    try {
      const proc = pm.compute(gameId, query);
      out.patterns = (proc.variants || []).slice(0, 6);
      out.transitions = (proc.transitions || []).slice(0, 8);
    } catch (e) { out.patterns = []; out.transitions = []; }
  }

  // ---- Daily timeline ----
  if (sections.timeline) {
    let daily = db.prepare(
      `SELECT date(e.created_at) AS day, COUNT(*) AS events,
              COUNT(DISTINCT e.session_id) AS sessions, COUNT(DISTINCT e.player_id) AS players
         FROM events e${eJ} WHERE e.game_id=@g${eW} GROUP BY day ORDER BY day`
    ).all(P);
    daily = U.fillDays(daily, P.from, P.to, ["events", "sessions", "players"]);
    out.timeline = daily.map((r) => ({ day: r.day, events: r.events || 0, sessions: r.sessions || 0, players: r.players || 0 }));
  }

  // ---- Per-student roster (respects the same filters) ----
  if (sections.students) {
    const players = db.prepare(
      `SELECT p.id AS id, p.username AS username,
              COUNT(DISTINCT e.session_id) AS sessions, COUNT(*) AS events, MAX(e.created_at) AS lastSeen
         FROM events e JOIN players p ON p.id=e.player_id WHERE e.game_id=@g${eW} GROUP BY p.id`
    ).all(P);
    const runs = db.prepare(
      `SELECT s.player_id AS id, COUNT(*) AS runs, MAX(s.score) AS bestScore, AVG(s.score) AS avgScore
         FROM scores s JOIN players p ON p.id=s.player_id WHERE s.game_id=@g${sW} GROUP BY s.player_id`
    ).all(P);
    const rm = {}; runs.forEach((r) => (rm[r.id] = r));
    out.students = players.map((pl) => {
      const r = rm[pl.id] || {};
      return {
        username: pl.username, sessions: pl.sessions, events: pl.events, lastSeen: pl.lastSeen,
        runs: r.runs || 0,
        bestScore: r.bestScore != null ? U.round(r.bestScore, 4) : null,
        avgScore: r.avgScore != null ? U.round(r.avgScore, 4) : null,
      };
    }).sort((a, b) => b.events - a.events);
  }

  return out;
}

// ============================================================================
// CHARTS — small self-contained inline SVG (no external libs), light theme
// ============================================================================
const C = { ink: "#0f172a", muted: "#64748b", line: "#e2e8f0", grid: "#eef2f7", green: "#0ea371", gold: "#d99a00", blue: "#2563eb", purple: "#7c3aed" };

// Vertical bars with value-scaled height. `every` thins x-labels for dense axes.
function svgBars(items, opts) {
  opts = opts || {};
  const color = opts.color || C.green, every = opts.every || 1;
  const W = 720, H = 240, padL = 44, padR = 14, padT = 14, padB = 34;
  const n = items.length || 1;
  const max = Math.max(1, ...items.map((d) => d.value));
  const iw = W - padL - padR, ih = H - padT - padB;
  const bw = iw / n, bar = Math.max(2, Math.min(bw * 0.68, 46));
  const y = (v) => padT + ih - (v / max) * ih;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" class="rep-svg">`;
  // y grid + ticks (4 lines)
  for (let i = 0; i <= 4; i++) {
    const gy = padT + (ih * i) / 4, val = Math.round((max * (4 - i)) / 4);
    s += `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}" stroke="${C.grid}"/>`;
    s += `<text x="${padL - 8}" y="${(gy + 4).toFixed(1)}" text-anchor="end" class="rep-tick">${fmt(val)}</text>`;
  }
  items.forEach((d, i) => {
    const cx = padL + bw * i + bw / 2, h = padT + ih - y(d.value);
    s += `<rect x="${(cx - bar / 2).toFixed(1)}" y="${y(d.value).toFixed(1)}" width="${bar.toFixed(1)}" height="${Math.max(0, h).toFixed(1)}" rx="3" fill="${color}"/>`;
    if (i % every === 0) s += `<text x="${cx.toFixed(1)}" y="${H - 12}" text-anchor="middle" class="rep-xlab">${esc(d.label)}</text>`;
  });
  return s + "</svg>";
}

// Horizontal bars: label · bar · value. Good for event types / top students.
function svgHBars(items, opts) {
  opts = opts || {};
  const color = opts.color || C.blue;
  const rows = items.slice(0, opts.limit || 12);
  const max = Math.max(1, ...rows.map((d) => d.value));
  const rh = 26, W = 720, padL = 150, padR = 66, top = 6;
  const H = top * 2 + rows.length * rh || 40;
  const iw = W - padL - padR;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" class="rep-svg">`;
  rows.forEach((d, i) => {
    const cy = top + i * rh, bh = 15, bw = (d.value / max) * iw;
    s += `<text x="${padL - 10}" y="${cy + rh / 2 + 4}" text-anchor="end" class="rep-hlab">${esc(String(d.label).slice(0, 22))}</text>`;
    s += `<rect x="${padL}" y="${cy + (rh - bh) / 2}" width="${iw}" height="${bh}" rx="4" fill="${C.grid}"/>`;
    s += `<rect x="${padL}" y="${cy + (rh - bh) / 2}" width="${Math.max(2, bw).toFixed(1)}" height="${bh}" rx="4" fill="${color}"/>`;
    s += `<text x="${W - padR + 8}" y="${cy + rh / 2 + 4}" class="rep-hval">${fmt(d.value)}</text>`;
  });
  return s + "</svg>";
}

// Activity colour (stable per name) for the pattern / transition chips.
const ACT_PALETTE = ["#2563eb", "#0ea371", "#d99a00", "#7c3aed", "#ea7a3c", "#0891b2", "#db2777", "#65a30d", "#e11d48", "#4f46e5"];
function hashStr(s) { let h = 0; s = String(s); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
function actColor(a) { return ACT_PALETTE[hashStr(a) % ACT_PALETTE.length]; }
function actChip(a) { const c = actColor(a); return `<span class="rep-actpill" style="background:${c}1a;border-color:${c}59;color:${c}">${esc(titleCase(a))}</span>`; }
function covPct(c) { if (c == null) return ""; return Math.round(c <= 1 ? c * 100 : c) + "%"; }

// Common play patterns: the most frequent whole-session paths, as chip chains.
function patternsHtml(variants) {
  const rows = variants.map((v, i) => {
    const seq = v.sequence || [];
    let chain = seq.slice(0, 8).map(actChip).join('<span class="rep-arrow">→</span>');
    if (seq.length > 8) chain += `<span class="rep-arrow">→</span><span class="rep-actmore">+${seq.length - 8}</span>`;
    return `<div class="rep-seqrow"><span class="rep-rank">${i + 1}</span><div class="rep-chain">${chain}</div><span class="rep-seqn">${fmt(v.count)}<small> · ${covPct(v.coverage)}</small></span></div>`;
  }).join("");
  return `<div class="rep-seqs">${rows}</div>`;
}

// Transition network, shown as the strongest directly-follows links (from → to).
function transitionsHtml(trans) {
  const max = Math.max(1, ...trans.map((t) => t.count));
  const rows = trans.map((t) => {
    const w = (t.count / max) * 100;
    return `<div class="rep-trow">${actChip(t.from)}<span class="rep-arrow">→</span>${actChip(t.to)}<div class="rep-tbar"><i style="width:${w.toFixed(1)}%"></i></div><span class="rep-tn">${fmt(t.count)}</span></div>`;
  }).join("");
  return `<div class="rep-trans">${rows}</div>`;
}

// Multi-series day line chart for the timeline.
function svgLines(days, series) {
  const W = 720, H = 260, padL = 44, padR = 14, padT = 14, padB = 40;
  const n = days.length || 1;
  const max = Math.max(1, ...series.flatMap((se) => days.map((d) => d[se.key])));
  const iw = W - padL - padR, ih = H - padT - padB;
  const x = (i) => padL + (n === 1 ? iw / 2 : (iw * i) / (n - 1));
  const y = (v) => padT + ih - (v / max) * ih;
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" class="rep-svg">`;
  for (let i = 0; i <= 4; i++) {
    const gy = padT + (ih * i) / 4, val = Math.round((max * (4 - i)) / 4);
    s += `<line x1="${padL}" y1="${gy.toFixed(1)}" x2="${W - padR}" y2="${gy.toFixed(1)}" stroke="${C.grid}"/>`;
    s += `<text x="${padL - 8}" y="${(gy + 4).toFixed(1)}" text-anchor="end" class="rep-tick">${fmt(val)}</text>`;
  }
  series.forEach((se) => {
    const pts = days.map((d, i) => `${x(i).toFixed(1)},${y(d[se.key]).toFixed(1)}`).join(" ");
    s += `<polyline points="${pts}" fill="none" stroke="${se.color}" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>`;
  });
  // sparse x labels (first, ~middle, last)
  const idxs = n <= 1 ? [0] : [0, Math.floor((n - 1) / 2), n - 1];
  idxs.forEach((i) => { if (days[i]) s += `<text x="${x(i).toFixed(1)}" y="${H - 20}" text-anchor="middle" class="rep-xlab">${esc(days[i].day)}</text>`; });
  // legend
  let lx = padL;
  series.forEach((se) => {
    s += `<rect x="${lx}" y="${H - 12}" width="10" height="10" rx="2" fill="${se.color}"/><text x="${lx + 15}" y="${H - 3}" class="rep-xlab">${esc(se.label)}</text>`;
    lx += 30 + se.label.length * 7;
  });
  return s + "</svg>";
}

// ============================================================================
// HTML DOCUMENT
// ============================================================================
function tile(k, v, sub) {
  return `<div class="rep-tile"><div class="rep-k">${esc(k)}</div><div class="rep-v">${v}</div>${sub ? `<div class="rep-sub">${esc(sub)}</div>` : ""}</div>`;
}
function card(title, cap, body) {
  return `<section class="rep-card"><h2>${esc(title)}</h2>${cap ? `<p class="rep-cap">${esc(cap)}</p>` : ""}${body}</section>`;
}

function scopeLine(meta) {
  const range = (meta.from || meta.to) ? `${esc(meta.fromLabel || "start")} → ${esc(meta.toLabel || "now")}` : "all dates";
  const who = meta.students && meta.students.length
    ? `${meta.students.length} student${meta.students.length === 1 ? "" : "s"}`
    : "all students";
  return `${range} · ${who}`;
}

function buildReportHtml(meta, data, sections) {
  const t = data.tiles;
  let body = "";

  if (sections.summary) {
    // Same headline metrics as the dashboard's General tab (which deliberately
    // omits a single "avg score" number — score scales differ per game, so it
    // isn't meaningful as one figure; score lives in the distribution + tables).
    const tiles = [
      tile("Students", fmt(t.players)),
      tile("Sessions", fmt(t.sessions)),
      tile("Events", fmt(t.events)),
      tile("Runs", fmt(t.runs)),
      tile("Avg session", t.avgSessionMin != null ? t.avgSessionMin + " min" : "—"),
      tile("Events / session", t.avgEventsPerSession != null ? fmt(t.avgEventsPerSession) : "—"),
      tile("Sessions / student", t.sessionsPerPlayer != null ? fmt(t.sessionsPerPlayer) : "—"),
      tile("Returning rate", t.returningRate != null ? pct(t.returningRate) : "—"),
    ].join("");
    body += card("Summary", "Headline engagement for the selected scope.", `<div class="rep-tiles">${tiles}</div>`);
  }

  if (sections.engagement) {
    const anyRuns = data.scoreHistogram && data.scoreHistogram.some((d) => d.value);
    const patterns = (data.patterns && data.patterns.length)
      ? `<h3>Common play patterns</h3><p class="rep-note">The most frequent paths students take through a session, with how many sessions followed each and the share of all sessions they cover.</p>${patternsHtml(data.patterns)}` : "";
    const transitions = (data.transitions && data.transitions.length)
      ? `<h3>Common transitions</h3><p class="rep-note">The strongest step-to-step moves in the activity network, ranked by how often one action is followed by the next.</p>${transitionsHtml(data.transitions)}` : "";
    body += card("Engagement",
      "How play is distributed: score outcomes, session length, when students play, which actions they take, and the patterns and transitions in their behaviour.",
      `<h3>Score distribution (%)</h3>${anyRuns ? svgBars(data.scoreHistogram, { color: C.gold }) : '<p class="rep-empty">No scored runs in range.</p>'}
       <h3>Session length</h3>${svgBars(data.sessionLength, { color: C.green })}
       <h3>Activity by hour of day</h3>${svgBars(data.hourly, { color: C.blue, every: 3 })}
       ${data.eventTypes && data.eventTypes.length ? `<h3>Top event types</h3>${svgHBars(data.eventTypes, { color: C.purple })}` : ""}
       ${patterns}${transitions}`);
  }

  if (sections.timeline) {
    const days = data.timeline || [];
    body += card("Activity timeline", "Daily events, sessions and active students across the range.",
      days.length ? svgLines(days, [
        { key: "events", label: "Events", color: C.blue },
        { key: "sessions", label: "Sessions", color: C.green },
        { key: "players", label: "Students", color: C.gold },
      ]) : '<p class="rep-empty">No activity in range.</p>');
  }

  if (sections.students) {
    // Columns mirror the dashboard's Players table (best score shown as a %).
    const rows = (data.students || []).map((r) =>
      `<tr><td>${esc(r.username)}</td><td class="num">${fmt(r.sessions)}</td><td class="num">${fmt(r.events)}</td><td class="num">${fmt(r.runs)}</td><td class="num">${r.bestScore != null ? pct(r.bestScore, 1) : "—"}</td><td class="rep-when">${esc((r.lastSeen || "").slice(0, 16))}</td></tr>`
    ).join("");
    body += card("Students", `${(data.students || []).length} student${(data.students || []).length === 1 ? "" : "s"} in scope.`,
      rows ? `<div class="rep-tbl-wrap"><table class="rep-tbl"><thead><tr><th>Student</th><th class="num">Sessions</th><th class="num">Events</th><th class="num">Runs</th><th class="num">Best score</th><th>Last seen</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<p class="rep-empty">No students in range.</p>');
  }

  const genAt = new Date().toISOString().replace("T", " ").slice(0, 16) + " UTC";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>${esc(meta.title)}</title>
<style>
  :root{--ink:${C.ink};--muted:${C.muted};--line:${C.line};--accent:${C.green};--gold:${C.gold}}
  *{box-sizing:border-box}
  html,body{margin:0}
  body{background:#f1f5f9;color:var(--ink);font:14px/1.55 "Nunito",system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased;padding:32px 16px}
  .rep-doc{max-width:860px;margin:0 auto;background:#fff;border:1px solid var(--line);border-radius:16px;box-shadow:0 30px 60px -40px rgba(15,23,42,.4);overflow:hidden}
  .rep-head{padding:30px 34px 24px;border-bottom:1px solid var(--line);background:linear-gradient(120deg,#fffdf5,#f4fbf7)}
  .rep-brand{display:flex;align-items:center;gap:11px;margin-bottom:16px}
  .rep-mark{width:34px;height:34px;flex:none;display:block;filter:drop-shadow(0 4px 10px rgba(74,214,160,.28))}
  .rep-wm{font-size:16px;font-weight:800;letter-spacing:-.01em}
  .rep-wm i{font-style:normal;background:linear-gradient(120deg,#d99a00,#0ea371);-webkit-background-clip:text;background-clip:text;color:transparent}
  .rep-tag{color:var(--muted);font-weight:800;font-size:12px;border:1px solid var(--line);border-radius:999px;padding:2px 9px}
  .rep-title{font-size:26px;font-weight:800;letter-spacing:-.02em;margin:0 0 6px}
  .rep-scope{color:var(--muted);font-size:13.5px;margin:0}
  .rep-meta{margin-top:14px;display:flex;flex-wrap:wrap;gap:8px}
  .rep-chip{font-size:12px;font-weight:700;color:#334155;background:#fff;border:1px solid var(--line);border-radius:999px;padding:4px 11px}
  .rep-body{padding:22px 34px 34px}
  .rep-card{margin:22px 0 0;padding-top:20px;border-top:1px solid var(--line)}
  .rep-card:first-child{border-top:none;margin-top:6px;padding-top:0}
  .rep-card h2{font-size:18px;font-weight:800;margin:0 0 3px;letter-spacing:-.01em}
  .rep-card h3{font-size:13px;font-weight:800;color:#334155;margin:18px 0 6px;text-transform:uppercase;letter-spacing:.04em}
  .rep-cap{color:var(--muted);font-size:13px;margin:0 0 12px}
  .rep-tiles{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
  .rep-tile{border:1px solid var(--line);border-radius:12px;padding:13px 15px;background:#fbfdff;position:relative;overflow:hidden}
  .rep-tile::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:linear-gradient(180deg,var(--gold),var(--accent))}
  .rep-k{font-size:10.5px;font-weight:800;color:var(--muted);text-transform:uppercase;letter-spacing:.05em}
  .rep-v{font-size:23px;font-weight:800;margin-top:4px;letter-spacing:-.01em}
  .rep-sub{font-size:11.5px;color:var(--muted);margin-top:2px}
  .rep-svg{width:100%;height:auto;display:block;margin:2px 0 6px}
  .rep-tick{fill:var(--muted);font-size:10px}
  .rep-xlab{fill:var(--muted);font-size:10.5px;font-weight:700}
  .rep-hlab{fill:#334155;font-size:12px;font-weight:700}
  .rep-hval{fill:var(--ink);font-size:12px;font-weight:800;font-variant-numeric:tabular-nums}
  .rep-tbl-wrap{overflow-x:auto}
  .rep-tbl{width:100%;border-collapse:collapse;font-size:13px}
  .rep-tbl th,.rep-tbl td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);white-space:nowrap}
  .rep-tbl th{font-size:10.5px;text-transform:uppercase;letter-spacing:.04em;color:var(--muted);font-weight:800}
  .rep-tbl td.num,.rep-tbl th.num{text-align:right;font-variant-numeric:tabular-nums}
  .rep-tbl tbody tr:nth-child(even){background:#fafcff}
  .rep-when{color:var(--muted)}
  .rep-empty{color:var(--muted);font-style:italic;padding:14px 0}
  .rep-note{color:var(--muted);font-size:12px;margin:0 0 9px;line-height:1.5}
  /* common play patterns (chip chains) */
  .rep-seqs{display:flex;flex-direction:column;gap:2px}
  .rep-seqrow{display:flex;align-items:center;gap:11px;padding:8px 4px;border-bottom:1px solid var(--line)}
  .rep-seqrow:last-child{border-bottom:none}
  .rep-rank{flex:none;width:20px;height:20px;border-radius:6px;background:#f1f5f9;border:1px solid var(--line);display:grid;place-items:center;font-size:11px;font-weight:800;color:var(--muted)}
  .rep-chain{flex:1;min-width:0;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
  .rep-seqn{flex:none;font-variant-numeric:tabular-nums;font-weight:800;font-size:12.5px}
  .rep-seqn small{color:var(--muted);font-weight:600}
  .rep-actpill{display:inline-flex;align-items:center;padding:2px 9px;border-radius:999px;border:1px solid;font-size:11.5px;font-weight:800;white-space:nowrap}
  .rep-arrow{color:#94a3b8;font-size:13px;flex:none}
  .rep-actmore{font-size:11.5px;color:var(--muted);font-weight:700}
  /* common transitions (from → to with a strength bar) */
  .rep-trans{display:flex;flex-direction:column;gap:4px}
  .rep-trow{display:flex;align-items:center;gap:8px;padding:5px 4px}
  .rep-tbar{flex:1;height:8px;border-radius:5px;background:#eef2f7;overflow:hidden;min-width:40px}
  .rep-tbar>i{display:block;height:100%;border-radius:5px;background:linear-gradient(90deg,#d99a00,#0ea371)}
  .rep-tn{flex:none;width:52px;text-align:right;font-variant-numeric:tabular-nums;font-weight:800;font-size:12.5px}
  .rep-foot{padding:18px 34px 26px;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
  .rep-print{position:fixed;top:18px;right:18px;z-index:9;background:linear-gradient(120deg,#ffd54a,#4ad6a0);color:#0b1120;border:none;border-radius:10px;padding:11px 16px;font:800 13px/1 inherit;cursor:pointer;box-shadow:0 12px 26px -10px rgba(74,214,160,.5)}
  .rep-print:hover{filter:brightness(1.05)}
  @media print{
    body{background:#fff;padding:0}
    .rep-doc{border:none;box-shadow:none;border-radius:0;max-width:none}
    .rep-print{display:none}
    .rep-card{break-inside:avoid}
  }
  @media(max-width:640px){ .rep-tiles{grid-template-columns:repeat(2,1fr)} body{padding:0} .rep-head,.rep-body,.rep-foot{padding-left:18px;padding-right:18px} }
</style></head>
<body>
  <button class="rep-print" onclick="window.print()">Print / Save as PDF</button>
  <div class="rep-doc">
    <header class="rep-head">
      <div class="rep-brand">
        <svg class="rep-mark" viewBox="0 0 40 40" aria-hidden="true">
          <defs><linearGradient id="rlm" x1="0" y1="0" x2="40" y2="40" gradientUnits="userSpaceOnUse"><stop stop-color="#ffd54a"/><stop offset="1" stop-color="#4ad6a0"/></linearGradient></defs>
          <rect width="40" height="40" rx="11" fill="url(#rlm)"/>
          <path d="M4 16 A11 11 0 0 1 16 4 A17 17 0 0 0 4 17 Z" fill="#ffffff" opacity=".16"/>
          <rect x="10.5" y="22" width="4.6" height="9" rx="2.2" fill="#0b1120"/>
          <rect x="17.7" y="17" width="4.6" height="14" rx="2.2" fill="#0b1120"/>
          <rect x="24.9" y="12" width="4.6" height="19" rx="2.2" fill="#0b1120"/>
          <path d="M28.2 8.4 Q28.9 11 31.5 11.7 Q28.9 12.4 28.2 15 Q27.5 12.4 24.9 11.7 Q27.5 11 28.2 8.4 Z" fill="#ffffff"/>
        </svg>
        <b class="rep-wm">Ludix <i>Analytics</i></b><span class="rep-tag">Report</span></div>
      <h1 class="rep-title">${esc(meta.title)}</h1>
      <p class="rep-scope">${esc(prettyGame(meta.gameId))} · ${scopeLine(meta)}</p>
      <div class="rep-meta">
        <span class="rep-chip">Game: ${esc(meta.gameId)}</span>
        <span class="rep-chip">Generated ${esc(genAt)}</span>
        ${meta.createdBy ? `<span class="rep-chip">By ${esc(meta.createdBy)}</span>` : ""}
        ${meta.students && meta.students.length ? `<span class="rep-chip">${esc(meta.students.slice(0, 6).join(", "))}${meta.students.length > 6 ? " +" + (meta.students.length - 6) : ""}</span>` : ""}
      </div>
    </header>
    <div class="rep-body">${body || '<p class="rep-empty">No sections selected.</p>'}</div>
    <footer class="rep-foot">Generated by Ludix Analytics from the event log for the scope shown above. Numbers match the dashboard for the same filters.</footer>
  </div>
</body></html>`;
}

// ============================================================================
// PERSISTENCE
// ============================================================================
const Q = {
  insert: db.prepare(
    `INSERT INTO reports (game_id, title, date_from, date_to, students, sections, bytes, html, created_by)
     VALUES (@game_id, @title, @date_from, @date_to, @students, @sections, @bytes, @html, @created_by)`
  ),
  list: db.prepare(
    `SELECT id, game_id, title, date_from, date_to, students, sections, bytes, created_by, created_at
       FROM reports WHERE (@game IS NULL OR game_id=@game) ORDER BY id DESC LIMIT 200`
  ),
  get: db.prepare(`SELECT * FROM reports WHERE id=?`),
  del: db.prepare(`DELETE FROM reports WHERE id=?`),
  count: db.prepare(`SELECT COUNT(*) AS n FROM reports`),
};
function totalCount() { return Q.count.get().n; }

function normSections(raw) {
  const out = {};
  // Default: everything on. Only turn a section off if it's explicitly false.
  SECTION_KEYS.forEach((k) => { out[k] = !(raw && raw[k] === false); });
  return out;
}

// Generate + persist a report; returns the stored row's summary (no html).
function generate(opts) {
  const gameId = String(opts.game || "").trim();
  if (!gameId) throw new ReportError("Pick a game first.");
  // Enforce the cap up front — before the (potentially heavy) mining/queries —
  // so a caller already at the limit is rejected without doing any work. This is
  // synchronous (better-sqlite3), so the count check and the insert below run in
  // one uninterrupted turn: no window for a concurrent request to slip past.
  if (totalCount() >= MAX_REPORTS) {
    throw new ReportError(`You've reached the maximum of ${MAX_REPORTS} saved reports. Delete one before generating another.`);
  }
  const sections = normSections(opts.sections);
  const students = U.userList({ user: opts.students || [] });   // dedupe + cap, same as filters
  const from = opts.from ? String(opts.from) : "";
  const to = opts.to ? String(opts.to) : "";
  const query = { from: from || undefined, to: to || undefined, user: students };

  const data = computeReportData(gameId, query, sections);
  const meta = {
    title: (String(opts.title || "").trim() || `${prettyGame(gameId)} report`).slice(0, 120),
    gameId, from, to,
    fromLabel: from ? from.replace("T", " ") : "", toLabel: to ? to.replace("T", " ") : "",
    students, createdBy: opts.createdBy || null,
  };
  const html = buildReportHtml(meta, data, sections);
  const info = Q.insert.run({
    game_id: gameId, title: meta.title,
    date_from: from || null, date_to: to || null,
    students: JSON.stringify(students), sections: JSON.stringify(sections),
    bytes: Buffer.byteLength(html, "utf8"), html, created_by: meta.createdBy,
  });
  return { id: info.lastInsertRowid, title: meta.title, bytes: Buffer.byteLength(html, "utf8") };
}

function listReports(game) {
  return Q.list.all({ game: game || null }).map((r) => ({
    id: r.id, gameId: r.game_id, title: r.title,
    from: r.date_from, to: r.date_to,
    students: safeJson(r.students, []), sections: safeJson(r.sections, {}),
    bytes: r.bytes, createdBy: r.created_by, createdAt: r.created_at,
  }));
}
function getReport(id) { return Q.get.get(id) || null; }
function deleteReport(id) { return Q.del.run(id).changes > 0; }
function safeJson(s, d) { try { return JSON.parse(s); } catch (e) { return d; } }

class ReportError extends Error {}

// ============================================================================
// ROUTES (mounted behind requireAdmin by admin-api)
// ============================================================================
function mount(router) {
  // Build + store a report; returns its id so the client can open/download it.
  router.post("/reports", (req, res) => {
    try {
      const b = req.body || {};
      const out = generate({
        game: b.game, title: b.title, from: b.from, to: b.to,
        students: b.students, sections: b.sections,
        createdBy: req.admin && req.admin.username,
      });
      res.status(201).json(Object.assign({ ok: true }, out));
    } catch (e) {
      if (e instanceof ReportError) return res.status(400).json({ error: "report_failed", detail: e.message });
      console.error("report error:", e);
      res.status(500).json({ error: "server_error", detail: "Report generation failed." });
    }
  });

  // List saved reports (optionally scoped to one game via ?game=). `total` is the
  // global count (across all games) and `max` the cap, so the UI can show usage
  // and disable the generate button when the limit is reached.
  router.get("/reports", (req, res) => {
    res.json({ reports: listReports(req.query.game || null), total: totalCount(), max: MAX_REPORTS });
  });

  // Serve a stored report as HTML. ?download=1 sends it as an attachment.
  router.get("/reports/:id", (req, res) => {
    const row = getReport(parseInt(req.params.id, 10));
    if (!row) return res.status(404).type("html").send("<h1>Report not found</h1>");
    const slug = String(row.title || "report").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50) || "report";
    const fname = `${slug}-${(row.created_at || "").slice(0, 10)}.html`;
    if (req.query.download === "1" || req.query.download === "true") {
      res.setHeader("Content-Disposition", `attachment; filename="${fname}"`);
    }
    res.type("html").send(row.html);
  });

  router.delete("/reports/:id", (req, res) => {
    if (!deleteReport(parseInt(req.params.id, 10))) return res.status(404).json({ error: "not_found" });
    res.json({ ok: true });
  });
}

module.exports = { mount, generate, listReports, ReportError, MAX_REPORTS };
