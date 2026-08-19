# Per-game dashboard renderers

Drop one file per game here — `<gameId>.js` — to give that game a dedicated
**Insights** tab in the dashboard. Each file registers a renderer:

```js
window.SuiteGameRenderers = window.SuiteGameRenderers || {};
window.SuiteGameRenderers["my-game"] = function (data, D) {
  // `data` is the /games/my-game/specific payload (see
  // server/src/games-analytics/my-game.js); `D` is the shared SuiteDash toolkit.
  return "<div>…HTML…</div>";
};
```

Then load it from `server/public/admin/index.html`
(`<script src="games/my-game.js"></script>`) and add the matching compute module
under [`server/src/games-analytics/`](../../../src/games-analytics/).

None ship by default. Games without a renderer still get the full **General**
dashboard (engagement, process mining, TNA, clustering) for free.
