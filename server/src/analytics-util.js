/* =============================================================================
 * Suite server — analytics helpers (shared)
 * -----------------------------------------------------------------------------
 * Pure query/format helpers used by BOTH the general analytics API and the
 * per-game analytics modules (games-analytics/*), so the general and
 * game-specific code agree on how filters and rows are built.
 * ========================================================================== */
"use strict";

// Date range is inclusive by whole day; `created_at` is server-insert time
// ("YYYY-MM-DD HH:MM:SS"). `user` filters to one player (needs a players join,
// aliased `p`, which every query here provides).
// The `user` filter accepts one player, a comma-separated list, or a repeated
// query param (Express gives an array) — so the dashboard can filter to several
// students at once. Deduped case-insensitively and capped defensively.
function userList(query) {
  let raw = query && query.user;
  if (raw == null || raw === "") return [];
  if (Array.isArray(raw)) raw = raw.join(",");
  const seen = {}; const out = [];
  String(raw).split(",").forEach((s) => {
    const u = s.trim(); const k = u.toLowerCase();
    if (u && !seen[k]) { seen[k] = 1; out.push(u); }
  });
  return out.slice(0, 50);
}
// Normalise a from/to bound to a "YYYY-MM-DD HH:MM:SS" string comparable to
// `created_at`. A plain date fills the whole day (00:00:00 / 23:59:59), so the
// existing day-granular dashboard filters behave exactly as before. A value that
// carries a time (e.g. a datetime-local "2026-08-25T14:30" from the report
// builder) is honoured to the second, with the missing seconds padded so the
// bound stays inclusive on the `to` side.
function normBound(v, end) {
  let s = String(v).trim().replace("T", " ");
  if (s.length <= 10) return s.slice(0, 10) + (end ? " 23:59:59" : " 00:00:00");
  s = s.slice(0, 19);
  if (s.length === 13) s += end ? ":59:59" : ":00:00";   // YYYY-MM-DD HH
  else if (s.length === 16) s += end ? ":59" : ":00";    // YYYY-MM-DD HH:MM
  return s;
}
function filterParams(query) {
  const p = {};
  if (query.from) p.from = normBound(query.from, false);
  if (query.to) p.to = normBound(query.to, true);
  userList(query).forEach((u, i) => { p["user" + i] = u; });
  return p;
}
function whereFor(alias, query, opts) {
  opts = opts || {};
  let c = "";
  if (query.from) c += ` AND ${alias}.created_at >= @from`;
  if (query.to) c += ` AND ${alias}.created_at <= @to`;
  const users = userList(query);
  // players.username has COLLATE NOCASE, so both forms compare case-insensitively.
  if (users.length === 1) c += ` AND p.username = @user0 COLLATE NOCASE`;
  else if (users.length > 1) c += ` AND p.username IN (${users.map((_, i) => "@user" + i).join(", ")})`;
  if (opts.type) c += ` AND ${alias}.type = @type`;
  return c;
}
// The players join (aliased `p`) is only needed when a `user` filter is active
// (or when a caller explicitly selects player columns). Skipping it otherwise
// keeps the game-wide count/aggregation queries from joining every row to the
// players table for nothing. Pass opts.force to keep the join regardless.
function joinFor(alias, query, opts) {
  opts = opts || {};
  return (opts.force || userList(query).length)
    ? ` JOIN players p ON p.id=${alias}.player_id`
    : "";
}
function num(v, d) { const n = Number(v); return Number.isFinite(n) ? n : d; }
function round(v, n) { if (v == null) return null; const f = Math.pow(10, n || 4); return Math.round(v * f) / f; }

// CSV
function csvCell(v) {
  if (v == null) return "";
  const s = typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(rows, cols) {
  return cols.join(",") + "\n" + rows.map((r) => cols.map((c) => csvCell(r[c])).join(",")).join("\n") + "\n";
}

// Fill a per-day series so line charts have no gaps. Rows keyed by `.day`.
function fillDays(rows, from, to, zeroKeys) {
  const byDay = {};
  rows.forEach((r) => (byDay[r.day] = r));
  let start = from ? from.slice(0, 10) : (rows[0] && rows[0].day);
  let end = to ? to.slice(0, 10) : (rows.length && rows[rows.length - 1].day);
  if (!start || !end) return rows;
  const out = [];
  const d = new Date(start + "T00:00:00Z");
  const last = new Date(end + "T00:00:00Z");
  let guard = 0;
  while (d <= last && guard++ < 3660) {
    const day = d.toISOString().slice(0, 10);
    const base = { day };
    (zeroKeys || []).forEach((k) => (base[k] = 0));
    out.push(Object.assign(base, byDay[day] || {}));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

// Bucket a flat list of numeric values into labelled ranges. `edges` are the
// upper bounds; the last bucket is "edges[last]+". Returns [{bucket,value}].
function histogram(values, edges, labels) {
  const counts = new Array(edges.length + 1).fill(0);
  values.forEach((v) => {
    let i = edges.findIndex((e) => v < e);
    if (i === -1) i = edges.length;
    counts[i]++;
  });
  return counts.map((n, i) => ({ bucket: labels[i], value: n }));
}

// Tiny in-memory TTL memo. Used to avoid recomputing full-table counts (e.g.
// the dashboard overview totals) on every dashboard poll. Not a correctness
// cache — values may be up to `ttlMs` stale, which is fine for headline totals.
const _memoStore = new Map();
function memo(key, ttlMs, fn) {
  const now = Date.now();
  const hit = _memoStore.get(key);
  if (hit && hit.exp > now) return hit.val;
  const val = fn();
  _memoStore.set(key, { val, exp: now + ttlMs });
  return val;
}
function memoBust(prefix) {
  if (!prefix) return _memoStore.clear();
  for (const k of _memoStore.keys()) if (k.startsWith(prefix)) _memoStore.delete(k);
}

// Deterministic RNG (mulberry32): a tiny, seedable generator so any analysis
// that resamples/subsamples/splits (TNA bootstrap + clustering, predict's
// train/test split) reproduces exactly per seed. Shared so those modules can't
// drift onto different generators.
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Delimiter for composite keys built from activity names (e.g. "from<SEP>to"
// edge keys, n-gram keys).  can't occur in an event.type, so multi-word
// activities survive being joined and split. Shared by /process and /tna so
// they key transitions identically.
const SEP = String.fromCharCode(1);

module.exports = { filterParams, normBound, whereFor, joinFor, userList, num, round, csvCell, toCsv, fillDays, histogram, memo, memoBust, rng, SEP };
