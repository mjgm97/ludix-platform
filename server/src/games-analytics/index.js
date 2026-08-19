/* =============================================================================
 * Game-specific analytics — registry
 * -----------------------------------------------------------------------------
 * Maps a gameId to its analytics module. A game with no entry here simply has no
 * game-specific view (the dashboard shows only the general analytics for it).
 * To add a game: create ./<game>.js exporting { id, label, compute }, register
 * it below, and add a matching renderer in public/admin/games/<game>.js.
 * ========================================================================== */
"use strict";

// No game-specific analytics modules are registered by default. Add one like:
//   "my-game": require("./my-game"),
// and a matching renderer in public/admin/games/my-game.js.
const modules = {};

module.exports = {
  get: (gameId) => modules[gameId] || null,
  has: (gameId) => Object.prototype.hasOwnProperty.call(modules, gameId),
};
