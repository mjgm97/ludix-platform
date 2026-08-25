<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="server/public/brand/logo-dark-tagline.svg">
  <source media="(prefers-color-scheme: light)" srcset="server/public/brand/logo-light-tagline.svg">
  <img alt="Ludix" src="server/public/brand/logo-light-tagline.svg" width="320">
</picture>

### A game-agnostic backend and learning-analytics dashboard for serious games

<p>
  <img alt="Node ≥18" src="https://img.shields.io/badge/Node-%E2%89%A518-339933?logo=node.js&logoColor=white">
  <img alt="Express 4" src="https://img.shields.io/badge/Express-4-000000?logo=express&logoColor=white">
  <img alt="better-sqlite3" src="https://img.shields.io/badge/SQLite-better--sqlite3-003B57?logo=sqlite&logoColor=white">
  <img alt="No build / no CDN" src="https://img.shields.io/badge/dashboard-no%20build%20%C2%B7%20no%20CDN-6f42c1">
  <img alt="MIT License" src="https://img.shields.io/badge/License-MIT-informational">
</p>

<sub><b>Keywords</b> · learning analytics · serious games · process mining · transition network analysis · sequence clustering · explainable AI (SHAP) · educational data mining</sub>

</div>

---

**Ludix** is a research-grade platform that turns the raw event stream of *any* serious game into
reproducible learning analytics. A single Node/Express/SQLite backend hosts any number of
self-contained games, collects a generic play-event log, and exposes — through one educator
dashboard — a coherent analytics pipeline that would otherwise require stitching together several
research tools: engagement and learning-analytics metrics, **process mining**, **transition-network
analysis (TNA)**, **behaviour-based sequence clustering**, statistical **pattern→outcome** mining,
and **explainable predictive modelling** with exact SHAP.

Crucially, every analysis is computed from a game-independent `case · activity · timestamp · actor`
event envelope — the standard process-mining quadruple — so **the same methods apply to every game
with no per-game code, and to event logs imported from outside Ludix entirely**. Ludix is therefore
usable both as a ready-to-run games-plus-analytics suite *and* as a stand-alone analysis workbench
for existing serious-game telemetry.

<div align="center">
<img alt="Ludix educator dashboard — overview" src="docs/img/overview.jpg" width="92%">
<br><em>One dashboard for a whole suite of games. Every view is scoped by game, date range, and cohort, and computed from a single generic event log.</em>
</div>

## Why Ludix (motivation & significance)

Serious-games research routinely collects rich interaction telemetry, yet that data usually stays
siloed inside a single game and is analysed ad hoc. Reproducing a study, or reusing a method across
games, means re-implementing the analytics each time. Ludix addresses this with three design
commitments aimed squarely at the research community:

- **Game-agnostic by construction.** All analytics read a generic event envelope, so a method
  validated on one game transfers unchanged to the next — and to logs that were never produced by
  Ludix (see [Bring your own data](#bring-your-own-data)).
- **Method provenance and rigor, not black boxes.** The heavy statistics are delegated to validated
  implementations rather than re-derived: transition-network analysis, centralities, bootstrap edge
  validation and dissimilarity clustering come from **[ladyna](https://github.com/mohsaqr/tna-js)**,
  a machine-precision-validated JavaScript port of the R [`tna`](https://cran.r-project.org/package=tna)
  package; feature attribution uses **exact path-dependent TreeSHAP** (Lundberg et al.). Randomised
  procedures (bootstrap, clustering, train/test splits) share one seeded generator, so results are
  reproducible.
- **Publication-ready outputs.** Every chart, network and plot is hand-drawn inline SVG and can be
  exported as **SVG or PNG** (with light/dark/transparent backgrounds and a chosen resolution) for
  direct inclusion in papers and slides.

| For researchers | For educators & practitioners | For game developers |
|:--|:--|:--|
| A reproducible, game-agnostic analytics pipeline (process mining, TNA, clustering, XAI) over a standard event model, exportable for publication | A single dashboard to see how students actually play — engagement, learning curves, common paths, and cohorts — with no data-science setup | A template that ships already wired into identity, scoring, and the full analytics stack; instrument a game with three calls |

## The analytics

Every game streams play events to the backend; analyses are computed once and apply to any game.
Views can be scoped by **game**, **date range**, and one or more **students/cohorts**.

### Engagement & learning-analytics metrics

Beyond activity counts, the **General** tab reports research-oriented indicators derived from the
generic log: a **learning curve** (mean score by attempt number), **effort–performance**
correlation (session length / event volume vs. outcome, with Pearson *r*), a **player-retention
survival curve**, and an **engagement-inequality** view (Lorenz curve + Gini) quantifying how
concentrated participation is across learners.

<div align="center">
<img alt="Engagement and learning-analytics metrics" src="docs/img/general.jpg" width="92%">
<br><em>Engagement KPIs and a “research analytics” block: learning curve, effort–performance correlation, retention survival, and engagement inequality (Lorenz/Gini).</em>
</div>

### Process mining

The **Process** tab reconstructs how sessions move through a game: per-activity statistics, the
**directly-follows graph**, **start/end** activities, and **trace variants** — the distinct raw
paths learners take, ranked by frequency and coverage. Variants are standard raw traces (repeated
loops are shown in full, not collapsed), and longer *n*-step routines are surfaced as 3- and 4-step
directly-follows chains. Process discovery is delegated to ladyna’s `processmining` module.

<div align="center">
<img alt="Process mining — activities, trace variants, directly-follows graph" src="docs/img/process.jpg" width="92%">
<br><em>Activity statistics, the most common event sequences (expandable per row), and the directly-follows / start-end structure of the process.</em>
</div>

### Transition network analysis (TNA)

Each game is modelled as a first-order **Markov transition network**: activities are nodes and a
directed edge A→B carries the transition probability *P(B | A)*. The view derives **initial-state
probabilities**, the full R-`tna` set of **node/edge centralities** (out/in-strength, betweenness,
closeness, PageRank, …), a **sequence index plot**, **state cliques**, and optional **bootstrap edge
validation** — which transitions are statistically stable rather than noise. TNA is a recent
learning-analytics method; Ludix makes it available game-agnostically and interactively.

<div align="center">
<img alt="Transition network analysis" src="docs/img/tna-network.jpg" width="92%">
<br><em>A game’s transition network: node size scales with frequency, the ring encodes start probability, and edge width scales with transition probability.</em>
</div>

### Behaviour-based sequence clustering

Sessions are grouped by **how** learners move through a game, then each cluster’s transition network
and sequence-index plot are compared side by side. Clustering runs on a **validated sequence
dissimilarity** (Levenshtein / edit-distance family, Euclidean, Manhattan, cosine, or
Jensen–Shannon) with **PAM (k-medoids)**, agglomerative linkage, or k-means, and reports a
**silhouette** score for the partition — turning “types of players” into a defensible, quantified
split.

<div align="center">
<img alt="Behaviour-based sequence clustering" src="docs/img/clustering.jpg" width="92%">
<br><em>k-medoids on Levenshtein distance splits sessions into behaviour groups; each cluster gets its own transition network and sequence-index plot, with a silhouette score for the split.</em>
</div>

### Explainable predictive modelling (SHAP)

The **Prediction** tab estimates a run-level outcome (score, stars, session length, or pass/fail)
from behaviour features folded from that run’s event stream, then **explains** the model. Estimators
are dependency-free implementations — **gradient-boosted trees**, random forest, a single decision
tree, and linear/logistic regression — and explanations use **exact path-dependent TreeSHAP** for
both **global** feature importance and **per-run local** attributions (a waterfall from the model’s
baseline to its prediction). Held-out diagnostics (R²/RMSE/MAE vs. a naïve baseline, predicted-vs-
actual) keep the model honest. This brings interpretable machine learning to game telemetry without
a Python/R stack.

<div align="center">
<img alt="Explainable predictive modelling with SHAP" src="docs/img/predict.jpg" width="92%">
<br><em>An interpretable model of run outcome: held-out metrics, global SHAP importance, a SHAP summary (beeswarm), per-run local explanations, and predicted-vs-actual diagnostics.</em>
</div>

### Statistical pattern→outcome mining and cohort comparison

The Network tab also mines **frequent behavioural patterns** and screens each for association with a
run outcome — the change in Score/Stars when a pattern is present (OLS), or its log-odds for Pass
(logistic) — with **Benjamini–Hochberg** adjustment for multiple testing. A **cohort comparison**
splits sessions on a median outcome and contrasts the two transition networks edge-by-edge with a
**permutation test**, flagging transitions that genuinely differ between higher- and lower-performing
learners.

## Bring your own data

Because the analytics read a generic event log, they run on **any** log — not only data collected
through Ludix. The dashboard’s **Import** tab takes a CSV or JSON log, auto-detects the
case / activity / timestamp / actor columns (the standard process-mining quadruple), and imports it
under a game name, where every view above applies. A file exported from the **Export** tab
re-imports exactly, so datasets and figures are shareable and reproducible.

## Methods & reproducibility

- **Validated statistics.** TNA models, centralities, bootstrap validation and dissimilarity
  clustering come from [ladyna](https://github.com/mohsaqr/tna-js) (a JS port of R `tna`, validated
  to machine precision against the original); process discovery uses its `processmining` module.
- **Exact explanations.** Feature attribution is exact path-dependent **TreeSHAP** (Lundberg &
  Lee); the additive invariant *baseValue + Σ φᵢ = model output* holds per instance.
- **Determinism.** Bootstrap, clustering and train/test subsampling share a single seeded PRNG
  (mulberry32), so a given dataset and settings reproduce the same figures.
- **Standard event model.** All analyses derive from a `case · activity · timestamp · actor`
  envelope, aligning with process-mining/EDM conventions and enabling cross-game and external-log
  reuse.
- **Named methods** used across the suite include directly-follows process discovery and trace
  variants, first-order Markov transition networks, PageRank/betweenness/closeness centralities,
  silhouette-validated PAM/hierarchical/k-means clustering over sequence dissimilarities,
  gradient-boosted trees with TreeSHAP, OLS/logistic effect estimation with Benjamini–Hochberg
  correction, and permutation testing for network contrasts.

## Design

- **One backend for every game:** a small, game-agnostic Node/Express/SQLite server hosts the whole suite; the database is a single SQLite file created on boot (no migration step).
- **No per-game analytics code:** games post runs and events keyed by `gameId`; engagement, process mining, TNA, clustering and prediction all follow from the generic envelope.
- **No-build dashboard:** the `/admin` UI (charts, networks, clustering, SHAP) is hand-written inline SVG — no bundler, no CDN, no client framework — so it is auditable and dependency-light.
- **Copy-to-extend:** duplicating the template yields a game already wired into identity, scoring, the leaderboard, and analytics; any built game with an `index.html` appears on the landing page.
- **Password-free identity:** a learner claims a unique name once and receives a private token; only the token holder can submit under it — appropriate for classroom use without account management.

<div align="center">
<img alt="Ludix learner landing page" src="docs/img/landing.jpg" width="80%">
<br><em>The learner-facing landing page lists every installed game; the bundled <b>Quick Tap</b> reference game is built from the template.</em>
</div>

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

The dashboard needs an admin account, and a seeded demo makes every analysis explorable immediately:

```bash
cd server && npm run admin -- add teacher "a-good-password"
npm run seed:demo        # sample players, runs and events across three games —
                         # engagement, process mining, TNA, clustering and prediction all work off it
```

Everything else is configured in `server/.env` (copy `server/.env.example`). See
[`server/`](server/) for the full server and API documentation.

## Add a game

Copy the template — a complete game already wired into identity, scoring, analytics, and the
leaderboard:

```bash
cp -R games/_template games/space-quiz   # the slug becomes the URL and gameId
npm run build                            # picked up automatically → dist/space-quiz/
npm start                                # live at /space-quiz/
```

Then replace `games/space-quiz/js/game.js` with your game. The three `Suite.*` calls that connect it
to the backend (claim identity, submit a run, log analytics events) are documented in
[`games/_template/README.md`](games/_template/README.md). An optional landing card and a
game-specific **Insights** view are wired via
[`server/src/landing.js`](server/src/landing.js) (`GAME_META`) and
[`server/src/games-analytics/`](server/src/games-analytics/).

> Folders starting with `_` or `.` (such as `games/_template/`) are ignored by the build and the
> server, so the template never ships as a game.

## Repository layout

```
.
├── server/            # the backend: one Node/Express/SQLite server for the whole suite
│   ├── src/           #   score + analytics API; process-mining, TNA, clustering & prediction engines
│   └── public/admin/  #   the no-build dashboard UI (inline-SVG charts, networks, SHAP)
├── games/             # game source, one folder per game (develop here)
│   ├── _template/     #   copy-me starter (ignored by the build; never ships)
│   └── quick-tap/     #   Quick Tap: the reference game (built from the template)
├── dist/              # build output: self-contained bundles the server hosts (git-ignored)
├── docs/img/          # screenshots used in this README
└── scripts/build-all.js   # builds every game in games/* into dist/*
```

Source (`games/`) is built into served bundles (`dist/`). Each `dist/` subfolder with an
`index.html` appears on the landing page and is served at `/<slug>/`.

## Documentation

- Server and API: [`server/README.md`](server/README.md) (endpoints, config, deploy)
- Quick Tap, the reference game: [`games/quick-tap/README.md`](games/quick-tap/README.md)
- Adding a game: [`games/_template/README.md`](games/_template/README.md)

## Contributing

Contributions are welcome. The most direct way in is to add a game with the template above, or to
improve the shared server and analytics. Open an
[issue](https://github.com/mjgm97/ludix/issues) or a pull request.

## License and citation

Ludix is released under the [MIT License](LICENSE). If you use it in academic work, please cite it
using the metadata in [`CITATION.cff`](CITATION.cff), from which GitHub renders a “Cite this
repository” button; the accompanying SoftwareX article will be added there as the preferred citation
once published.
