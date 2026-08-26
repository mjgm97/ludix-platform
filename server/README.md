# Suite Server

A game-agnostic backend for a suite of games. It receives a completed game run,
keyed by `gameId` and a unique username, and stores it (with the full analytics
event log) in a single SQLite file. One server and one database back any number
of games, and the server can optionally host the games themselves, each at its
own URL.

- Stack: Node.js, Express, and [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3).
- Database: one file, schema created on boot; no migration step.
- Multi-game: the API is keyed by `gameId`, and static hosting serves a folder of games, each at `/<slug>/`. Nothing is specific to any one game.
- Config: environment variables only (see `.env.example`); no hardcoded hosts or IPs.
- Identity: password-free. A player claims a unique name once and receives a private `token`; only the token holder can submit under that name. Names are shared across the suite.

---

## Quick start (development)

```bash
cd server
cp .env.example .env      # optional; the defaults work without changes
npm install
npm run dev               # auto-restarts on change (or: npm start)
```

Server boots on `http://localhost:3000`. Smoke-test it:

```bash
npm run smoke             # claims a name, submits a run, reads the leaderboard
```

With `SERVE_STATIC=true` (the default in `.env.example`), the server also hosts
the games. On first run it builds the bundled games into `../dist/`, so
opening `http://localhost:3000` shows the suite index and the reference game is
live at `http://localhost:3000/quick-tap/`.

---

## Hosting games

The server serves a games folder (`GAMES_DIR`, default `../dist`, the build
output of `npm run build`; game source lives in `games/`). Every immediate
subfolder that contains an `index.html` is a self-contained game build and is
served at `/<subfolder>/`. The root `/` shows a small index linking to each one.

```
dist/
  quick-tap/     → served at /quick-tap/
  my-game/       → served at /my-game/
```

Adding a game to the suite means dropping its build folder in: no code change and
no restart-time config. A game only needs to (1) submit runs to the API with its
own `gameId`, and (2) be a static folder with an `index.html`.

To publish this repo's game into the folder yourself:

```bash
npm run build              # in the repo root → dist/quick-tap/, dist/…
# or, for any game bundler:  OUT_DIR=/path/to/games/<slug> node build.js
```

> `/admin` and `/api` are reserved by the server, so don't name a game folder
> `admin` or `api`.

---

## Analytics dashboard

The analytics UI lives at `/admin` (e.g. `http://localhost:3000/admin`). It is
the server's own page, always available and independent of `SERVE_STATIC`, scoped
per game and filterable by date range and one or more players. It has interactive
charts (hover for values, click legends to toggle series), a raw event explorer,
and filtered CSV / JSON export of events or runs.

Most views are game-agnostic, derived from the event envelope and scores, so
every game gets them for free. The dashboard is a set of tabs:

- **Overview**: every game that has data, with suite-wide totals (games, players,
  events, runs, admins).
- **General**: the headline tiles (players, sessions, events, runs, engagement —
  session length, events/session, returning rate), activity over time and
  distributions, most active players and event-type volume. Plus a research
  layer: a learning curve (mean score by attempt), an effort–performance
  relationship (time-on-task vs achievement, with Pearson r), a retention/survival
  curve, and engagement inequality (Gini + Lorenz).
- **Process**: process mining from the raw event stream — trace variants, a
  directly-follows graph, and start/end activities.
- **Network**: transition network analysis. A Markov transition network (nodes are
  activities, edges are transition probabilities) with node/edge centralities,
  initial-state probabilities, a paginated sequence index plot, and bootstrap edge
  validation; sequence clustering (k-means, k-medoids, or hierarchical over several
  dissimilarities, including sequence edit distance), each cluster with its own
  network; frequent behaviour patterns screened for association with a run outcome;
  and cohort comparison (two networks — high vs low on an outcome — compared
  edge-by-edge with a permutation test).
- **Prediction**: trains a gradient-boosted decision-tree ensemble to estimate a
  selectable target (score, stars, session length, or pass/fail) from a run's
  behaviour features, and explains it with exact TreeSHAP — global feature
  importance and per-run local attributions.
- **Insights**: per-game. A game can add its own analytics view (for example a
  domain-specific funnel or learning signal). None ship by default, so a game with
  no module shows an empty state until one is added.
- **Players** / **Events**: a per-player roster and drill-down, and a paginated
  raw-event explorer.
- **Export** / **Import** / **Admin**: filtered downloads and shareable reports,
  bringing in an existing log, and managing admin accounts (all covered below).

Adding a game's insights takes two files:

1. `src/games-analytics/<gameId>.js` — exports `{ id, label, compute(gameId, query) }`
   returning the aggregates (register it in `src/games-analytics/index.js`).
2. `public/admin/games/<gameId>.js` — registers
   `window.SuiteGameRenderers["<gameId>"] = function (data, dash) { … }` that
   returns HTML built with the shared `dash` chart toolkit, and add a
   `<script>` for it in `public/admin/index.html`.

The general layer needs no per-game work; a new game gets it automatically.

### Logging in

The dashboard needs an admin account, which is separate from players: admins have
a password, players never do. Create one:

```bash
npm run admin -- add teacher "a-good-password"   # add an account
npm run admin list                               # list accounts
npm run admin -- remove teacher                  # remove one
```

Alternatively, seed the first admin from the environment: set `ADMIN_USER` and
`ADMIN_PASSWORD` in `.env` and it is created on boot if the admin table is empty.
Additional admins can then be added from the dashboard's Accounts tab.

Sessions are server-side (an httpOnly, SameSite cookie), last `SESSION_DAYS` days
(default 7), and `/api/admin/login` has a brute-force guard. Over HTTPS in
production the cookie is marked `Secure` automatically (`COOKIE_SECURE`).

### Try it with sample data

```bash
npm run seed:demo        # players, runs and events for quick-tap over ~2 weeks
```

Then log in at `/admin` and explore.

Games can also be hosted elsewhere (Netlify, S3, nginx) and point at this
server's API: set `SERVE_STATIC=false` and list their origins in
`ALLOWED_ORIGINS`.

### Reports

The **Export** tab does two things. First, filtered raw-data downloads: events or
runs, as CSV or JSON, honouring the current game / date / player selection.
Second, a **report builder** — a self-contained HTML page (open it and use
**Print → Save as PDF** for a PDF) assembled from the same analytics as the
dashboard, scoped to the current selection, with tick-boxes for which sections to
include. Generated reports are stored and listed in a history you can reopen,
download or delete; the suite keeps up to 50 at a time.

### Importing an existing event log

The dashboard's **Import** tab brings an existing log (from another game, tool,
or study) into a game bucket so every game-agnostic view runs on it. Upload a CSV
or JSON file; the parser proposes a column mapping, which you confirm:

- **Case / session** → `session_id` (one trace)
- **Activity / event** → `type` (the network's nodes) — required
- **Timestamp** → `created_at` (date filters) and `t_ms` (session duration) — optional but recommended
- **Actor / user** → the player — optional (otherwise each case is its own player)
- **Sequence** → explicit ordering, overriding the timestamp — optional

This is the standard process-mining (case, activity, timestamp) triple, so most
existing logs map straight in. A file exported from Ludix's own **Export** tab is
auto-detected and re-imports exactly. Upload size is capped by `IMPORT_LIMIT`
(default 32mb). Each import is tracked as a batch (its events and synthetic runs
carry the batch id), so it can be listed and removed again as a unit if a mapping
turns out wrong.

---

## Configuration

Configuration is driven by environment variables (loaded from `.env` in
development, or the real environment in production). The full list with comments
is in [`.env.example`](.env.example). The common ones:

| Variable | Default | What it does |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Where the server listens |
| `DB_PATH` | `./data/suite.db` | SQLite file, suite-wide (point at a persistent volume in prod) |
| `ALLOWED_ORIGINS` | `*` | Comma-separated site origins allowed to call the API |
| `SERVE_STATIC` | `false` | Also host the games from this server |
| `GAMES_DIR` | `../dist` | Folder of game builds; each subfolder is served at `/<slug>/` |
| `RATE_LIMIT_PER_MIN` | `120` | Per-IP throttle of `/api/` only; static serving is never throttled |
| `MAX_EVENTS` | `5000` | Cap on analytics events per submission |
| `ADMIN_USER` / `ADMIN_PASSWORD` | — | Seed the first dashboard admin on boot (if none exist) |
| `SESSION_DAYS` | `7` | Admin login session lifetime |
| `COOKIE_SECURE` | prod: `true` | Mark the admin session cookie HTTPS-only |

### Pointing a game at this server

Each game carries its own client config. The only two things it needs are a
`gameId` (its leaderboard/analytics bucket) and an `apiBase` (where this server
is). Nothing about the game lives on the server; the config lives in the game's
baked `window.SUITE_CONFIG`, written by the build step (see
[`../games/_template/build.js`](../games/_template/build.js)):

```js
window.SUITE_CONFIG = {
  gameId:  "quick-tap",
  apiBase: "https://api.yourgames.com/api"   // or "http://192.168.1.50:3000/api", or "" for same-origin
};
```

When a game is hosted by this server (at `/<slug>/`), the API is same-origin, so
`apiBase: ""` is all it needs. Set `enabled: false` to run fully offline, with no
calls to this server.

---

## API

Base path: `/api`. All bodies are JSON.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/health` | Liveness check |
| `POST` | `/api/players` | Claim a unique username → `{ player, token }` (409 if taken) |
| `GET` | `/api/players/:username` | Availability / public profile |
| `POST` | `/api/games/:gameId/scores` | Submit a run: score (+ optional inline events) |
| `POST` | `/api/games/:gameId/events` | Stream a batch of analytics events (token auth) |
| `GET` | `/api/games/:gameId/events?limit=&since=&username=` | **Live event feed** (newest first) |
| `GET` | `/api/games/:gameId/leaderboard?limit=&level=` | Top runs |
| `GET` | `/api/games/:gameId/players/:username?limit=` | One player's runs in a game |

**Admin (dashboard) API** — under `/api/admin`, all JSON, session-cookie auth
(only `/login` is public):

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/admin/login` · `/logout` · `GET /me` | Session auth |
| `GET`/`POST`/`DELETE` | `/api/admin/accounts[/:id]` | Manage admin accounts |
| `GET` | `/api/admin/overview` | Games with data + suite totals |
| `GET` | `/api/admin/games/:gameId/summary?from=&to=&user=` | **General** tiles + distributions |
| `GET` | `/api/admin/games/:gameId/timeseries?from=&to=&user=` | **General** daily activity series |
| `GET` | `/api/admin/games/:gameId/research?from=&to=&user=` | **General** research layer — learning curve, effort/performance, retention, Gini |
| `GET` | `/api/admin/games/:gameId/process?from=&to=&user=` | **Process** mining (variants, DFG, start/end) |
| `GET` | `/api/admin/games/:gameId/tna?…&weight=&bootstrap=&iter=` | **Network** — transition network, centralities, sequences, validation |
| `GET` | `/api/admin/games/:gameId/tna/clusters?k=&algorithm=&dissimilarity=&linkage=` | Sequence clustering → per-cluster networks |
| `GET` | `/api/admin/games/:gameId/tna/sequences?offset=&limit=` | One page of the sequence index plot |
| `GET` | `/api/admin/games/:gameId/tna/patterns?outcome=&minSupport=` | Frequent behaviour patterns vs a run outcome |
| `GET` | `/api/admin/games/:gameId/tna/compare?outcome=&…` | Cohort comparison (two networks, permutation test) |
| `GET` | `/api/admin/games/:gameId/predict?target=&features=&estimators=&maxDepth=&…` | **Prediction** — GBDT estimate + TreeSHAP explanations |
| `GET` | `/api/admin/games/:gameId/specific?from=&to=&user=` | **Insights** — game-specific analytics (or `{hasModule:false}`) |
| `GET` | `/api/admin/games/:gameId/players?light=` | Per-player breakdown (`light=1` = roster only) |
| `GET` | `/api/admin/players/:username?game=` | One player, drilled down |
| `GET` | `/api/admin/games/:gameId/events?type=&limit=&offset=` | Paginated raw events |
| `GET` | `/api/admin/export?game=&dataset=events\|scores&format=csv\|json&from=&to=&user=&type=` | Filtered download |
| `POST` | `/api/admin/import/analyze` | Sniff an uploaded CSV/JSON, propose a column mapping (no writes) |
| `POST` | `/api/admin/import/commit` | Import the log into a game with a confirmed mapping |
| `GET` | `/api/admin/import/existing?game=` | Events already stored under a game (import warns before appending) |
| `GET`/`DELETE` | `/api/admin/imports[/:id]?game=` | List import batches, or remove one as a unit |
| `POST` | `/api/admin/reports` | Build + store a report from the current selection → `{ id }` |
| `GET` | `/api/admin/reports?game=` | Saved reports (with `total` + `max`) |
| `GET` | `/api/admin/reports/:id?download=` | View the report as HTML (`download=1` = attachment) |
| `DELETE` | `/api/admin/reports/:id` | Delete a saved report |

> `user=` accepts one name or a comma-separated list (filter to several players
> at once); `from`/`to`/`user` apply to every analytics endpoint above. The
> analytics tabs also take their own tuning params (e.g. `weight`, `bootstrap`,
> `iter` for the network; `k`, `algorithm`, `dissimilarity`, `linkage` for
> clustering; `target`, `features`, `estimators`, `maxDepth`, `learningRate`,
> `threshold` for prediction).

### Watching the data live

The game streams every analytics event to `POST .../events` on a periodic flush
(default every 5 s, set by `flushMs` in `window.SUITE_CONFIG`). Events stay
queued until the server confirms them, so a failed flush loses nothing and retries
with backoff on the next tick. To watch them arrive:

```bash
# newest 100 events for the game
curl "localhost:3000/api/games/quick-tap/events?limit=100"
# only new ones since id 42 (cheap polling), or filter to one player
curl "localhost:3000/api/games/quick-tap/events?since=42"
curl "localhost:3000/api/games/quick-tap/events?username=ada_lovelace"
```

Only the JSON API under `/api/` is rate-limited; static file serving is exempt
(so page loads never trip the limit).

**Claim a name**

```bash
curl -X POST localhost:3000/api/players \
  -H 'Content-Type: application/json' -d '{"username":"ada_lovelace"}'
# -> 201 { "player": {...}, "token": "…" }   (store the token; it's shown once)
```

**Submit a run** (token proves ownership of the name)

```bash
curl -X POST localhost:3000/api/games/quick-tap/scores \
  -H 'Content-Type: application/json' -d '{
    "username":"ada_lovelace","token":"…",
    "level":"quick-tap","score":12,"stars":2,"session_id":"…",
    "meta":{"hits":12,"round_ms":20000},
    "events":[ { "seq":0,"type":"round_start","t":0,"iso":"…" } ]
  }'
```

**Send events** — `POST /api/games/:gameId/events`

Stream a batch of analytics events. The request body is JSON:

| Field | Type | Required | What it is |
|---|---|---|---|
| `username` | string | yes | The player these events belong to (must have claimed a name). |
| `token` | string | yes | That player's private token (from claiming the name). |
| `session_id` | string | no | The session (trace) the batch belongs to; can also be set per event as `sessionId`. |
| `events` | array | yes | The event objects (up to `MAX_EVENTS`, default 5000; older ones are trimmed if you send more). |

Each object in `events` may carry these recognised fields — all optional, but
`type` is what the analytics key on. Each maps to its own column so it's
queryable; **every other key you include is kept too**, because the whole event
object is stored verbatim as JSON in the `payload` column (so game-specific
fields like `x`, `y`, `correct`, `score` survive round-trips through the feed and
exports).

| Event field | Type | Stored column | Purpose |
|---|---|---|---|
| `type` | string | `type` | The activity / event name — the nodes of the process & network views. |
| `t` | number (ms) | `t_ms` | Elapsed time since the session started — drives session duration and timing. |
| `iso` | string (ISO 8601) | `iso` | Wall-clock timestamp of the event. |
| `seq` | number | `seq` | Explicit order within the session (used to break ties). |
| `sessionId` | string | `session_id` | Per-event session override (falls back to the batch-level `session_id`). |

Response: `201 { "ok": true, "stored": <n> }` (an empty batch returns
`{ "ok": true, "stored": 0 }`). Auth failures are `404 no_such_player` or
`401 bad_token`. Events can also be sent inline with a run via the `events` array
on `/scores` (same event-object shape).

```bash
curl -X POST localhost:3000/api/games/quick-tap/events \
  -H 'Content-Type: application/json' -d '{
    "username":"ada_lovelace","token":"…",
    "session_id":"sess-abc",
    "events":[
      { "seq":0, "type":"round_start", "t":0,     "iso":"2026-08-26T10:00:00.000Z" },
      { "seq":1, "type":"hit",         "t":812,   "iso":"2026-08-26T10:00:00.812Z", "x":140, "y":90 },
      { "seq":2, "type":"round_end",   "t":20000, "iso":"2026-08-26T10:00:20.000Z", "score":12 }
    ]
  }'
```

---

## Data model

`players` (shared across the suite), `scores` (one row per run, powers
leaderboards), and `events` (the full analytics log, one row per event).
Everything is keyed by `game_id`, so adding a new game needs no schema change;
just submit with a new `gameId`. Four more tables back the dashboard:
`admin_users` (login accounts, scrypt-hashed passwords), `admin_sessions`,
`imports` (one row per import batch, so a commit can be undone as a unit), and
`reports` (saved report HTML + the selection it was built from).

---

## Deploying to production

1. Put the DB on a **persistent disk** and set `DB_PATH` to it.
2. Set `ALLOWED_ORIGINS` to your real site origin(s), not `*`.
3. Run behind a process manager and a TLS reverse proxy (nginx / Caddy), e.g.
   proxy `/api` → this server, and either serve the games from the same proxy or
   set `SERVE_STATIC=true`. With the API on the same domain, each game's
   `apiBase` can be `""`. To give a game its own hostname, point that host at
   `/<slug>/` (or host the game's folder there directly).
4. Keep it alive: `pm2 start src/server.js --name suite`, a `systemd` unit, or
   a container (`node:20-slim`, `npm ci --omit=dev`, `CMD ["node","src/server.js"]`).

Scaling note: SQLite is great to a few hundred requests/sec on one box. If you
outgrow it, the DB access is isolated in `src/db.js` — swap it for Postgres
there without touching the routes.
