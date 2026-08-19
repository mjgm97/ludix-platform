/* =============================================================================
 * Ludix suite client  (reusable — the one client every game shares)
 * -----------------------------------------------------------------------------
 * A tiny, dependency-free client for the suite backend. It is the single source
 * of truth for player identity across the whole suite, plus the transport for
 * analytics events and scores. Because every game uses the same client and the
 * same localStorage keys, a name claimed in ONE game is recognised in ALL of
 * them — one handle across the suite.
 *
 * Common use (simple games):
 *   Suite.ensureIdentity()            → claim/restore a username (built-in modal)
 *   Suite.event(type, payload)        → log an analytics event (batched, retried)
 *   Suite.submitScore({ level, score, stars, meta })  → record a completed run
 *   Suite.username                    → the current player's name (or null)
 *
 * Advanced hooks (games with their own analytics layer):
 *   Suite.log(ev)                     → enqueue a pre-built analytics event as-is
 *   Suite.leaderboard({ limit, level })
 *   Suite.claim(name) / Suite.checkAvailable(name)   → structured results
 *   Suite.setPrompt(fn) / Suite.onStale(fn)          → use your own identity UI
 *   Suite.setSession(fn)              → attach your own session id to events
 *   Suite.onBeforeUnload(fn)          → run just before the final unload beacon
 *
 * Identity is password-free but ownership-safe: claiming a name returns a private
 * token, stored in localStorage and sent with every write. Everything degrades
 * gracefully — offline / "Play offline" makes calls no-ops and the game runs on.
 *
 * Config comes from window.SUITE_CONFIG (baked by the build step):
 *   { apiBase:"/api", gameId:"my-game", enabled:true, flushMs:5000, maxEvents:5000 }
 * apiBase defaults to same-origin "/api" (correct when the suite server hosts it).
 * ========================================================================== */
(function (global) {
  "use strict";

  var cfg = Object.assign(
    { apiBase: "/api", gameId: "template", enabled: true, flushMs: 5000, maxEvents: 5000, maxBackoff: 6 },
    global.SUITE_CONFIG || {}
  );

  // Shared identity keys — the same across every Ludix game (that's the point).
  var LS_USER = "ludix_username", LS_TOKEN = "ludix_token";
  // One-time migration from legacy per-game keys, so existing players stay signed
  // in. Add ["<game>_username", "<game>_token"] pairs here if a game ever used
  // its own keys before adopting the shared ones.
  var LEGACY = [];

  var username = null, token = null;
  var ownSession = rid();                 // default session id for simple games
  var getSession = function () { return ownSession; };
  var seq = 0;
  var queue = [], sending = false, backoff = 1, loopTimer = null;
  var promptFn = null, staleFn = null, beforeUnload = [];

  function rid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function now() { return Math.round((global.performance && performance.now()) || 0); }
  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  function url(p) { return String(cfg.apiBase).replace(/\/$/, "") + p; }
  function game(p) { return url("/games/" + encodeURIComponent(cfg.gameId) + p); }
  function json(body) { return { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }; }

  /* ---- identity ---------------------------------------------------------- */
  migrateLegacy();
  loadIdentity();

  function migrateLegacy() {
    if (lsGet(LS_USER) && lsGet(LS_TOKEN)) return;
    for (var i = 0; i < LEGACY.length; i++) {
      var u = lsGet(LEGACY[i][0]), t = lsGet(LEGACY[i][1]);
      if (u && t) { lsSet(LS_USER, u); lsSet(LS_TOKEN, t); return; }
    }
  }
  function loadIdentity() { username = lsGet(LS_USER); token = lsGet(LS_TOKEN); return hasIdentity(); }
  function saveIdentity(u, t) { username = u; token = t; lsSet(LS_USER, u); lsSet(LS_TOKEN, t); }
  function clearIdentity() { username = token = null; lsDel(LS_USER); lsDel(LS_TOKEN); }
  function hasIdentity() { return !!(username && token); }

  // Claim a unique username. Resolves a structured result:
  //   { ok:true, player } | { ok:false, taken } | { ok:false, invalid, rules }
  //   | { ok:false, offline } | { ok:false, error, status }
  function claim(name) {
    return fetch(url("/players"), json({ username: name }))
      .then(function (res) {
        if (res.status === 409) return { ok: false, taken: true };
        if (res.status === 400) return res.json().catch(function () { return {}; })
          .then(function (e) { return { ok: false, invalid: true, rules: e.rules }; });
        if (!res.ok) return { ok: false, error: "http_" + res.status, status: res.status };
        return res.json().then(function (data) {
          saveIdentity(data.player.username, data.token);
          return { ok: true, player: data.player };
        });
      })
      .catch(function () { return { ok: false, offline: true }; });
  }

  // Is a username free? Resolves { taken } | { offline:true }.
  function checkAvailable(name) {
    return fetch(url("/players/" + encodeURIComponent(name)))
      .then(function (res) { return { taken: res.status !== 404 }; })
      .catch(function () { return { offline: true }; });
  }

  // Ensure we have an identity; opens the prompt UI if not. Resolves true if
  // identified, false if the player chose to play offline.
  function ensureIdentity(reason) {
    if (!cfg.enabled) return Promise.resolve(false);
    if (loadIdentity()) return Promise.resolve(true);
    return (promptFn || Modal.open)(reason);
  }

  // A stored identity stopped being valid (server said 401/404, e.g. DB reset):
  // forget it and re-prompt. Queued events are kept for the new identity.
  function handleStale(reason) {
    if (!hasIdentity()) return;
    clearIdentity();
    if (staleFn) staleFn(reason);
    else if (cfg.enabled) (promptFn || Modal.open)(reason);
  }

  /* ---- analytics events -------------------------------------------------- */
  // Simple API: build + queue an event from (type, payload).
  function event(type, payload) {
    if (!cfg.enabled) return;
    log({ type: String(type), seq: seq++, sessionId: getSession(), t: now(), iso: new Date().toISOString(), payload: payload || {} });
  }
  // Advanced API: enqueue a pre-built analytics event object as-is.
  function log(ev) {
    if (!cfg.enabled) return;
    queue.push(ev);
    if (queue.length > cfg.maxEvents) queue.splice(0, queue.length - cfg.maxEvents);
  }

  // The flusher: one timer POSTs the whole queue; events are dropped only when
  // the server confirms them (so a failed flush keeps everything and retries),
  // single-in-flight, with exponential backoff on failure (snaps back on success).
  function attempt(done) {
    if (sending || !cfg.enabled || !hasIdentity() || !queue.length) { backoff = 1; return done(); }
    sending = true;
    var batch = queue.slice(0, cfg.maxEvents), n = batch.length;
    var req = json({ username: username, token: token, session_id: getSession(), events: batch });
    req.keepalive = true;
    fetch(game("/events"), req)
      .then(function (res) { if (res.status === 401 || res.status === 404) { handleStale(); return false; } return res.ok; })
      .catch(function () { return false; })
      .then(function (ok) {
        sending = false;
        if (ok) { queue = queue.slice(n); backoff = 1; }
        else backoff = Math.min(backoff * 2, cfg.maxBackoff);
        done();
      });
  }
  function loop() { loopTimer = setTimeout(function () { attempt(loop); }, cfg.flushMs * backoff); }
  loop();
  function flush() { if (!sending) attempt(function () {}); }

  /* ---- score submission -------------------------------------------------- */
  // Record a completed run. `run` = { level, score, stars, meta, session_id?, events? }.
  function submitScore(run) {
    if (!cfg.enabled || !hasIdentity()) return Promise.resolve({ skipped: true });
    flush(); // ship pending events alongside the run
    var body = Object.assign({ username: username, token: token, session_id: (run && run.session_id) || getSession() }, run);
    return fetch(game("/scores"), json(body))
      .then(function (res) { if (res.status === 401 || res.status === 404) { handleStale(); return { stale: true }; } return res.json().catch(function () { return {}; }); })
      .catch(function () { return { error: true }; });
  }

  /* ---- leaderboard ------------------------------------------------------- */
  function leaderboard(opts) {
    opts = opts || {};
    var qs = [];
    if (opts.limit) qs.push("limit=" + opts.limit);
    if (opts.level != null) qs.push("level=" + encodeURIComponent(opts.level));
    return fetch(game("/leaderboard" + (qs.length ? "?" + qs.join("&") : "")))
      .then(function (res) { return res.ok ? res.json() : { entries: [] }; })
      .catch(function () { return { entries: [], offline: true }; });
  }

  /* ---- flush on the way out --------------------------------------------- */
  function beacon() {
    if (!cfg.enabled || !hasIdentity() || !queue.length || !global.navigator || !navigator.sendBeacon) return;
    var body = JSON.stringify({ username: username, token: token, session_id: getSession(), events: queue.slice(0, cfg.maxEvents) });
    try { if (navigator.sendBeacon(game("/events"), new Blob([body], { type: "application/json" }))) queue.length = 0; } catch (e) {}
  }
  global.addEventListener("pagehide", function () {
    for (var i = 0; i < beforeUnload.length; i++) { try { beforeUnload[i](); } catch (e) {} }
    beacon();
  });
  document.addEventListener("visibilitychange", function () { if (document.hidden) beacon(); });

  /* ---- built-in identity modal (self-styled; used unless setPrompt overrides) */
  var Modal = (function () {
    function style() {
      if (document.getElementById("suite-modal-style")) return;
      var s = document.createElement("style");
      s.id = "suite-modal-style";
      s.textContent =
        ".suite-scrim{position:fixed;inset:0;z-index:9999;display:grid;place-items:center;padding:20px;" +
        "background:rgba(6,11,20,.72);backdrop-filter:blur(4px);font-family:'Nunito',system-ui,sans-serif}" +
        ".suite-card{width:min(400px,94vw);background:linear-gradient(180deg,#132039,#0d1626);color:#eef2ff;" +
        "border:1px solid #2c3a58;border-radius:18px;padding:26px 26px 22px;box-shadow:0 30px 70px rgba(0,0,0,.55)}" +
        ".suite-card .k{color:#4ad6a0;font-weight:800;font-size:12px;letter-spacing:.08em;text-transform:uppercase}" +
        ".suite-card h2{margin:4px 0 4px;font-family:'Fredoka',sans-serif;font-weight:600;font-size:24px}" +
        ".suite-card p{margin:0 0 16px;color:#9fb2d6;font-size:14px;line-height:1.5}" +
        ".suite-card input{width:100%;box-sizing:border-box;background:#0e1626;border:1px solid #2c3a58;border-radius:11px;" +
        "color:#eef2ff;padding:12px 14px;font:inherit;font-size:16px;outline:none}" +
        ".suite-card input:focus{border-color:#ffd54a}" +
        ".suite-err{color:#ff9aa2;font-size:13px;min-height:18px;margin:8px 2px 0}" +
        ".suite-row{display:flex;gap:10px;margin-top:14px}" +
        ".suite-btn{flex:1;border:none;border-radius:11px;padding:12px;font:inherit;font-weight:800;cursor:pointer}" +
        ".suite-go{background:linear-gradient(90deg,#ffd54a,#4ad6a0);color:#0b1120}" +
        ".suite-off{flex:0 0 auto;background:transparent;color:#eef2ff;border:1px solid #2c3a58}";
      document.head.appendChild(s);
    }
    function open(reason) {
      style();
      return new Promise(function (resolve) {
        if (document.querySelector(".suite-scrim")) return resolve(hasIdentity());
        var root = document.createElement("div");
        root.className = "suite-scrim";
        root.innerHTML =
          '<div class="suite-card">' +
          '<div class="k">Player</div><h2>Claim your name</h2>' +
          "<p>Your unique handle across the game suite — it's how your scores appear on the leaderboard.</p>" +
          '<input id="suite-name" autocomplete="off" placeholder="e.g. ada_lovelace" maxlength="20" />' +
          '<div class="suite-err" id="suite-err"></div>' +
          '<div class="suite-row"><button class="suite-btn suite-go" id="suite-go">Enter →</button>' +
          '<button class="suite-btn suite-off" id="suite-off">Play offline</button></div></div>';
        document.body.appendChild(root);
        var input = root.querySelector("#suite-name");
        var err = root.querySelector("#suite-err");
        input.focus();
        if (reason) err.textContent = reason;
        function go() {
          var name = input.value.trim();
          if (name.length < 3) { err.textContent = "At least 3 characters."; return; }
          err.textContent = "Checking…";
          claim(name).then(function (r) {
            if (r.ok) return done(true);
            err.textContent = r.taken ? "That name is taken — try another."
              : r.invalid ? (r.rules || "Letters, numbers, . _ - only (3–20).")
              : r.offline ? "Can't reach the server — you can play offline."
              : "Couldn't claim that name.";
          });
        }
        function done(ok) { if (root.parentNode) root.remove(); resolve(ok); }
        root.querySelector("#suite-go").onclick = go;
        root.querySelector("#suite-off").onclick = function () { cfg.enabled = false; done(false); };
        input.addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
      });
    }
    return { open: open };
  })();

  /* ---- public API -------------------------------------------------------- */
  global.Suite = {
    config: cfg,
    configure: function (partial) { Object.assign(cfg, partial || {}); },
    // identity
    hasIdentity: hasIdentity,
    get username() { return username; },
    get token() { return token; },
    claim: claim,
    checkAvailable: checkAvailable,
    clearIdentity: clearIdentity,
    ensureIdentity: ensureIdentity,
    setPrompt: function (fn) { promptFn = fn; },
    onStale: function (fn) { staleFn = fn; },
    // analytics + score
    event: event,
    log: log,
    submitScore: submitScore,
    leaderboard: leaderboard,
    flush: flush,
    setSession: function (fn) { if (typeof fn === "function") getSession = fn; },
    onBeforeUnload: function (fn) { if (typeof fn === "function") beforeUnload.push(fn); },
  };
})(window);
