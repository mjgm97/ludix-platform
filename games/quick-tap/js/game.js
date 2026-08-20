/* =============================================================================
 * Example game — "Quick Tap"
 * -----------------------------------------------------------------------------
 * A tiny, complete game that shows how a Ludix game plugs into the suite:
 *
 *   1. On "Start" → Suite.ensureIdentity()   (claim a username, once)
 *   2. During play → Suite.event(type, data) (streamed to analytics)
 *   3. On finish   → Suite.submitScore(run)  (recorded to the leaderboard)
 *
 * REPLACE the body of this file with your own game. Keep the three Suite.* calls
 * and the dashboard sees your game for free (shared leaderboard + analytics).
 * ========================================================================== */
(function () {
  "use strict";

  var ROUND_MS = 20000;         // a round lasts 20 seconds
  var TARGET_MS = 1400;         // a target expires (times out) if not tapped in time
  var els = {};
  var state = null;             // { score, hits, spawnAt, endAt, tx, ty, expireId } while playing

  document.addEventListener("DOMContentLoaded", function () {
    els.root = document.getElementById("game");
    els.root.innerHTML =
      '<div class="hud"><div class="stat"><span class="lbl">Score</span><b id="score">0</b></div>' +
      '<div class="title">Quick&nbsp;Tap</div>' +
      '<div class="stat"><span class="lbl">Time</span><b id="time">20.0</b></div></div>' +
      '<div class="stage" id="stage"><div class="center" id="center">' +
      '<h1>Quick Tap</h1><p>Tap the targets as fast as you can before the clock runs out.</p>' +
      '<button class="play" id="play">Start</button></div></div>';
    els.stage = document.getElementById("stage");
    els.center = document.getElementById("center");
    els.score = document.getElementById("score");
    els.time = document.getElementById("time");
    document.getElementById("play").addEventListener("click", start);
    // One handler on the whole stage: a tap on the target is a HIT, a tap on
    // empty space is a MISS. Both stream their position (normalised 0..1) so the
    // dashboard can build a click heatmap and accuracy analytics.
    els.stage.addEventListener("pointerdown", onStageTap);
  });

  // Normalise a pointer event to the stage as {x, y} in 0..1 (rounded).
  function tapPos(e) {
    var r = els.stage.getBoundingClientRect();
    return {
      x: Math.round(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * 1000) / 1000,
      y: Math.round(Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)) * 1000) / 1000,
    };
  }

  function start() {
    // Ensure the player has a suite identity before we begin (shows the modal
    // the first time; harmless afterwards / offline).
    els.center.querySelector(".play").disabled = true;
    Suite.ensureIdentity().then(function () {
      state = { score: 0, endAt: performance.now() + ROUND_MS, spawnAt: 0, hits: 0 };
      els.center.style.display = "none";
      els.score.textContent = "0";
      Suite.event("round_start", { round_ms: ROUND_MS });
      spawnTarget();
      tick();
    });
  }

  function tick() {
    if (!state) return;
    var left = Math.max(0, state.endAt - performance.now());
    els.time.textContent = (left / 1000).toFixed(1);
    if (left <= 0) return end();
    requestAnimationFrame(tick);
  }

  function spawnTarget() {
    if (!state) return;
    var old = els.stage.querySelector(".target");
    if (old) old.remove();
    if (state.expireId) clearTimeout(state.expireId);
    var r = 34;
    var w = els.stage.clientWidth, h = els.stage.clientHeight;
    var x = r + Math.random() * (w - 2 * r);
    var y = r + Math.random() * (h - 2 * r);
    var t = document.createElement("button");
    t.className = "target";
    t.style.left = x + "px";
    t.style.top = y + "px";
    state.spawnAt = performance.now();
    // Remember the target centre (normalised) so a hit reports where it was.
    state.tx = Math.round(((x + r) / w) * 1000) / 1000;
    state.ty = Math.round(((y + r) / h) * 1000) / 1000;
    els.stage.appendChild(t);
    // If it isn't tapped in time it "expires" — an error the dashboard tracks.
    state.expireId = setTimeout(onExpire, TARGET_MS);
  }

  function onStageTap(e) {
    if (!state) return;
    e.preventDefault();
    if (e.target && e.target.classList && e.target.classList.contains("target")) {
      var reaction = Math.round(performance.now() - state.spawnAt);
      state.score += 1;
      state.hits += 1;
      els.score.textContent = state.score;
      // One analytics event per hit — appears live in the dashboard's event feed.
      Suite.event("hit", { x: state.tx, y: state.ty, reaction_ms: reaction, n: state.score });
      spawnTarget();
    } else {
      // Tapped empty space — a miss. Report where the tap landed.
      var m = tapPos(e);
      Suite.event("miss", { x: m.x, y: m.y });
    }
  }

  function onExpire() {
    if (!state) return;
    Suite.event("expire", { x: state.tx, y: state.ty });
    spawnTarget();
  }

  function end() {
    if (!state) return;
    var score = state.score, hits = state.hits;
    if (state.expireId) clearTimeout(state.expireId);
    state = null;
    var t = els.stage.querySelector(".target");
    if (t) t.remove();

    Suite.event("round_end", { score: score });
    // Record the run. `level` groups runs on the leaderboard; `meta` is free-form.
    Suite.submitScore({ level: "quick-tap", score: score, meta: { hits: hits, round_ms: ROUND_MS } });

    var who = Suite.username ? ("Nice, " + Suite.username + "!") : "Round over";
    els.center.innerHTML =
      "<h1>" + score + "</h1><p>" + who + " You tapped " + hits + " target" + (hits === 1 ? "" : "s") +
      ".</p><button class='play' id='play'>Play again</button>";
    els.center.style.display = "";
    document.getElementById("play").addEventListener("click", start);
  }
})();
