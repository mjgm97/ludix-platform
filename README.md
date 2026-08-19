<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="server/public/brand/logo-dark-tagline.svg">
  <source media="(prefers-color-scheme: light)" srcset="server/public/brand/logo-light-tagline.svg">
  <img alt="Ludix" src="server/public/brand/logo-light-tagline.svg" width="320">
</picture>

<p>
  <img alt="Node ≥18" src="https://img.shields.io/badge/Node-%E2%89%A518-339933?logo=node.js&logoColor=white">
  <img alt="Express 4" src="https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white">
  <img alt="better-sqlite3" src="https://img.shields.io/badge/SQLite-better--sqlite3-003B57?logo=sqlite&logoColor=white">
  <img alt="MIT License" src="https://img.shields.io/badge/License-MIT-informational">
</p>

<img alt="Ludix landing page" src="docs/img/landing.jpg" width="90%">

</div>

---

Ludix is a suite of learning games backed by a single, game-agnostic server. One
Node/Express/SQLite backend serves any number of self-contained games, each at
its own URL, behind a shared score and analytics API and an educator dashboard.
Learners open a landing page that lists every installed game; educators get a
game-agnostic view of how students play, built entirely from the events the games
report.

| For learners | For educators | For builders |
|:--|:--|:--|
| Self-contained games, each at its own URL, with progress and mastery tracked | A dashboard spanning engagement metrics, process mining, and network analysis | A template to copy: identity, scoring, and analytics are already wired in |

## The dashboard

Every game streams its play events to the backend, so the analytics are computed
once and apply to any game with no per-game code. Views can be scoped by game,
date range, and one or more students, then used to explore engagement, process,
and the paths learners take through a game.

<div align="center">
<img alt="Educator dashboard overview" src="docs/img/overview.jpg" width="90%">
<br><em>One dashboard for the whole suite: totals, per-game activity, and each analysis a click away.</em>
</div>

### Transition network analysis

Each game is modelled as a Markov transition network: activities are nodes, and a
directed edge A→B is the probability of moving to B immediately after A. The view
includes node and edge centralities, initial-state probabilities, a sequence
index plot, and bootstrap edge validation (which transitions are stable rather
than noise).

<div align="center">
<img alt="Transition network analysis" src="docs/img/tna-network.jpg" width="90%">
<br><em>A game's transition network; node size scales with frequency, edge width with probability.</em>
</div>

### Sequence clustering

Students can be grouped by how they move through a game, then each cluster's
transition network and sequences compared side by side. The clustering takes a
dissimilarity (Euclidean, Manhattan, Cosine, Jensen–Shannon, or sequence edit
distance) and an algorithm (k-means, k-medoids / PAM, or hierarchical), and
reports a silhouette score for the split.

<div align="center">
<img alt="Sequence clustering" src="docs/img/clustering.jpg" width="90%">
<br><em>k-medoids on sequence edit distance splits sessions into behaviour groups, each with its own network.</em>
</div>

The dashboard also covers engagement metrics and process mining.

### Import existing data

Because the analytics are game-agnostic, they run on any event log — not just
data collected through Ludix. The dashboard's **Import** tab takes a CSV or JSON
log, auto-detects the case / activity / timestamp / actor columns (the standard
process-mining triple), and imports it under a game name, where every view above
applies. A file exported from the **Export** tab re-imports exactly.

## Design

- One backend for every game: a small, game-agnostic Node/Express/SQLite server hosts the whole suite.
- Games post runs and events keyed by `gameId`; engagement, process mining, and network analysis follow with no per-game code.
- Copying the template gives a game that is already wired into identity, scoring, the leaderboard, and analytics.
- Any built game with an `index.html` appears on the landing page as a card.
- The `/admin` dashboard (charts, networks, clustering) is hand-written inline SVG, with no bundler and no CDN.
- Identity is password-free: a player claims a unique name once and receives a private token; only the token holder can submit under it.

## Quick start

```bash
npm run install:server   # install the server's dependencies (once)
npm run build            # bundle every game into dist/
npm start                # run the suite (builds missing games on first boot)
```

Then open:

- http://localhost:3000/ — the player landing page (a card per game)
- http://localhost:3000/quick-tap/ — Quick Tap, the bundled reference game
- http://localhost:3000/admin — the educator dashboard

The dashboard needs an admin account:

```bash
cd server && npm run admin -- add teacher "a-good-password"
npm run seed:demo        # optional: sample players, runs, and events to explore
```

Everything else is configured in `server/.env` (copy `server/.env.example`). See
[`server/`](server/) for the full server and API documentation.

## Add a game

Copy the template, which is a complete game already wired into the suite
(identity, scoring, analytics, leaderboard):

```bash
cp -R games/_template games/space-quiz   # the slug becomes the URL and gameId
npm run build                            # picked up automatically → dist/space-quiz/
npm start                                # live at /space-quiz/
```

Then replace `games/space-quiz/js/game.js` with your game. The three `Suite.*`
calls that connect it to the backend are documented in
[`games/_template/README.md`](games/_template/README.md). A landing card and a
game-specific dashboard view are optional, via
[`server/src/landing.js`](server/src/landing.js) (`GAME_META`) and
[`server/src/games-analytics/`](server/src/games-analytics/).

> Folders starting with `_` or `.` (such as `games/_template/`) are ignored by
> the build and the server, so the template never ships as a game.

## Repository layout

```
.
├── server/            # the backend: one Node/Express/SQLite server for the whole suite
│   ├── src/           #   score + analytics API, admin dashboard API (incl. TNA / clustering)
│   └── public/admin/  #   the no-build dashboard UI (inline-SVG charts, networks, clustering)
├── games/             # game source, one folder per game (develop here)
│   ├── _template/     #   copy-me starter (ignored by the build; never ships)
│   └── quick-tap/     #   Quick Tap: the reference game (built from the template)
├── dist/              # build output: self-contained bundles the server hosts (git-ignored)
├── docs/img/          # screenshots used in this README
└── scripts/build-all.js   # builds every game in games/* into dist/*
```

Source (`games/`) is built into served bundles (`dist/`). Each `dist/` subfolder
with an `index.html` appears on the landing page and is served at `/<slug>/`.

## Documentation

- Server and API: [`server/README.md`](server/README.md) (endpoints, config, deploy)
- Quick Tap, the reference game: [`games/quick-tap/README.md`](games/quick-tap/README.md)
- Adding a game: [`games/_template/README.md`](games/_template/README.md)

## Contributing

Contributions are welcome. The most direct way in is to add a game with the
template above, or to improve the shared server. Open an
[issue](https://github.com/mjgm97/ludix/issues) or a pull request.

## License and citation

Ludix is released under the [MIT License](LICENSE). If you use it in academic
work, please cite it using the metadata in [`CITATION.cff`](CITATION.cff), from
which GitHub renders a "Cite this repository" button.
