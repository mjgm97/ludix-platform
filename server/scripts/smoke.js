/* Quick end-to-end smoke test against a running server.
 * Usage:  BASE=http://localhost:3000 node scripts/smoke.js
 * Uses Node's built-in fetch (Node 18+). Exits non-zero on failure. */
"use strict";

const BASE = process.env.BASE || "http://localhost:3000";
const GAME = "quick-tap";

async function j(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch (e) {}
  return { status: res.status, data };
}

function assert(cond, msg) {
  if (!cond) { console.error("  ✗ " + msg); process.exitCode = 1; throw new Error(msg); }
  console.log("  ✓ " + msg);
}

(async () => {
  console.log("Smoke test against " + BASE);

  const health = await j("GET", "/api/health");
  assert(health.status === 200 && health.data.ok, "health ok");

  const name = "smoke_" + Date.now().toString(36);
  const claim = await j("POST", "/api/players", { username: name });
  assert(claim.status === 201 && claim.data.token, "claim username -> token");
  const token = claim.data.token;

  const dup = await j("POST", "/api/players", { username: name });
  assert(dup.status === 409, "duplicate username rejected (409)");

  const bad = await j("POST", "/api/players", { username: "no spaces!" });
  assert(bad.status === 400, "invalid username rejected (400)");

  const submit = await j("POST", `/api/games/${GAME}/scores`, {
    username: name, token,
    level: "quick-tap", score: 12, stars: 2, session_id: "sess-abc",
    meta: { hits: 12, round_ms: 20000 },
    events: [
      { seq: 0, type: "round_start", t: 0, iso: new Date().toISOString(), round_ms: 20000 },
      { seq: 1, type: "round_end", t: 12340, iso: new Date().toISOString(), score: 12 },
    ],
  });
  assert(submit.status === 201 && submit.data.storedEvents === 2, "submit run + 2 events");

  const forged = await j("POST", `/api/games/${GAME}/scores`, {
    username: name, token: "wrong", score: 1,
  });
  assert(forged.status === 401, "wrong token rejected (401)");

  const lb = await j("GET", `/api/games/${GAME}/leaderboard?limit=5`);
  assert(lb.status === 200 && Array.isArray(lb.data.entries), "leaderboard returns entries");
  assert(lb.data.entries.some((e) => e.username === name), "our run appears on leaderboard");

  const hist = await j("GET", `/api/games/${GAME}/players/${name}`);
  assert(hist.status === 200 && hist.data.runs.length >= 1, "player history returns run");

  console.log(process.exitCode ? "\nFAILED" : "\nAll smoke checks passed ✅");
})().catch(() => { process.exitCode = 1; });
