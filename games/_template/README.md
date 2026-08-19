# Ludix game template

A complete, working starter for a new game in the suite. It is a small reaction
game ("Quick Tap") already wired into the shared identity, analytics, and
leaderboard. Copy it, replace the game logic, and build.

> Folders starting with `_` (like this one) are ignored by the build and the
> server, so the template never appears as a real game. Copy it to a normal name
> to make it live.

## Create a new game

```bash
# from the repo root — pick a slug (lowercase, dashes); it becomes the URL and gameId
cp -R games/_template games/my-game

npm run build      # builds all games → dist/ (yours is now dist/my-game/)
npm start          # serve the suite
```

Your game is live at http://localhost:3000/my-game/ and appears on the landing
page and the educator dashboard automatically. The folder name is the game's
`gameId` in the database, so keep it stable once you have real scores.

## What's inside

```
_template/
├── index.html        # dev entry (loads css + js unbundled)
├── css/style.css     # brand-consistent base styles (edit freely)
├── js/
│   ├── suite.js      # reusable suite client — you normally don't edit this
│   └── game.js       # the example game — REPLACE with your own
├── build.js          # bundles this game into ../../dist/<slug>/
├── package.json
└── (assets/)         # optional: images/audio/fonts, copied verbatim on build
```

## The suite client (`js/suite.js`)

Three calls connect any game to the suite:

```js
Suite.ensureIdentity()                       // claim/restore a username (built-in modal)
Suite.event("thing_happened", { any: "data" })   // batched analytics event
Suite.submitScore({ level: "l1", score: 42, stars: 3, meta: { … } })  // a completed run
```

- Identity is password-free but ownership-safe (a private token is stored in
  `localStorage`). It degrades gracefully: "Play offline" or no network turns the
  calls into no-ops and the game keeps running.
- Events are queued and flushed in batches (and on page hide via `sendBeacon`),
  with retry, so nothing is lost or duplicated.
- Config is baked at build time into `window.SUITE_CONFIG` (`gameId`, `apiBase`).
  `apiBase` defaults to same-origin `/api`, which is correct when the suite
  server hosts the game.

## Build options

```bash
npm run build                                   # same-origin API (default)
API_BASE=https://api.example.com npm run build  # host the game apart from the API
OFFLINE=1 npm run build                         # analytics disabled in the bundle
```

## Add assets

Drop images/audio/fonts in an `assets/` folder and reference them as
`assets/name.png` from your CSS/JS. `build.js` copies the folder into the bundle
(served at `/<slug>/assets/…`). A game that needs a single-file, fully portable
bundle can instead embed its assets as data URIs from its own `build.js`.

## Custom landing card and dashboard view (optional)

- Landing card and illustration: add an entry to `GAME_META` in
  [`server/src/landing.js`](../../server/src/landing.js).
- Game-specific dashboard insights: add a module under
  [`server/src/games-analytics/`](../../server/src/games-analytics/) and a matching
  renderer under `server/public/admin/games/`.

Without these, a game still gets the generic landing card and all the shared
analytics; they only add extra polish.
