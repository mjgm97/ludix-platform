/* =============================================================================
 * Game-specific analytics — registry
 * -----------------------------------------------------------------------------
 * Maps a gameId to its analytics module. A game with no entry here simply has no
 * game-specific view (the dashboard shows only the general analytics for it).
 * To add a game: create ./<game>.js exporting { id, label, compute }, register
 * it below, and add a matching renderer in public/admin/games/<game>.js.
 * ========================================================================== */
"use strict";

// Register a game's analytics module here, and add a matching renderer in
// public/admin/games/<game>.js (loaded from public/admin/index.html).
const modules = {
  "quick-tap": require("./quick-tap"),
};

module.exports = {
  get: (gameId) => modules[gameId] || null,
  has: (gameId) => Object.prototype.hasOwnProperty.call(modules, gameId),
};
