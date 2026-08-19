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
  var els = {};
  var state = null;             // { score, spawnAt, timerId, endAt } while playing

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
  });

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
    var r = 34;
    var w = els.stage.clientWidth, h = els.stage.clientHeight;
    var x = r + Math.random() * (w - 2 * r);
    var y = r + Math.random() * (h - 2 * r);
    var t = document.createElement("button");
    t.className = "target";
    t.style.left = x + "px";
    t.style.top = y + "px";
    state.spawnAt = performance.now();
    t.addEventListener("pointerdown", onHit);
    els.stage.appendChild(t);
  }

  function onHit(e) {
    if (!state) return;
    e.preventDefault();
    var reaction = Math.round(performance.now() - state.spawnAt);
    state.score += 1;
    state.hits += 1;
    els.score.textContent = state.score;
    // One analytics event per hit — appears live in the dashboard's event feed.
    Suite.event("hit", { reaction_ms: reaction, n: state.score });
    spawnTarget();
  }

  function end() {
    if (!state) return;
    var score = state.score, hits = state.hits;
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
