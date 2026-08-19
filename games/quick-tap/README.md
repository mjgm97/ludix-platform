# Quick Tap

A small reaction game and the reference game for the Ludix suite: tap the targets
as fast as you can before a 20-second clock runs out. It is a live, playable copy
of [`games/_template`](../_template/), the smallest complete example of a game
wired into the shared identity, analytics, and leaderboard.

Because it ships as a normal game folder (not `_`-prefixed), it appears on the
landing page and in the educator dashboard automatically, and it is the game the
demo data seeder (`server/scripts/seed-demo.js`) populates. Use it to explore the
suite end to end without building anything of your own.

## Run it

```bash
npm run install:server   # once
npm run build            # bundles every game → dist/ (this one → dist/quick-tap/)
npm start                # serve the suite
```

Then open http://localhost:3000/quick-tap/. The landing page
(http://localhost:3000/) shows a card for it, and the dashboard
(http://localhost:3000/admin) picks up its runs and events.

## How it connects to the suite

Three calls (in `js/game.js`) are all it takes:

```js
Suite.ensureIdentity()                                  // claim/restore a username
Suite.event("hit", { reaction_ms: 210, n: 5 })          // batched analytics event
Suite.submitScore({ level: "quick-tap", score: 12 })    // a completed run
```

The events it streams (`round_start`, `hit`, `round_end`) are exactly what the
seeder reproduces, so seeded and real play look the same in the dashboard.

## Make your own game from it

`quick-tap` is just `_template` copied to a live slug. To start a new game, copy
the template the same way and replace `js/game.js`:

```bash
cp -R games/_template games/my-game
npm run build && npm start   # live at /my-game/
```

See [`games/_template/README.md`](../_template/README.md) for the full guide.
