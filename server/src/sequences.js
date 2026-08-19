/* =============================================================================
 * Suite server — sequence builder (shared)
 * -----------------------------------------------------------------------------
 * Turns the raw event log into one ordered activity sequence per session, the
 * common input for BOTH process mining (/process) and transition-network
 * analysis (/tna). Keeping it in one place means the two analyses always agree
 * on what "a session's path" is, and share the same date/player filters and the
 * same defensive read cap.
 * ========================================================================== */
"use strict";

const db = require("./db");
const U = require("./analytics-util");
const config = require("./config");

// Fetch the game's event stream (honouring from/to/user filters) and fold it
// into one activity sequence per session, ordered by (seq, id). The read is
// bounded by processMaxEvents so a huge game can't pull the whole table into
// memory; when the cap is hit the tail is dropped and `truncated` is true.
function fetchSequences(gameId, query, capOverride) {
  const P = Object.assign({ g: gameId }, U.filterParams(query));
  const eW = U.whereFor("e", query);
  const eJ = U.joinFor("e", query);
  const cap = Math.max(1000, capOverride || config.processMaxEvents);

  const rows = db.prepare(
    `SELECT e.session_id AS sid, e.type AS type
       FROM events e${eJ}
      WHERE e.game_id=@g${eW}
      ORDER BY e.session_id, e.seq, e.id
      LIMIT @cap`
  ).all(Object.assign({ cap: cap + 1 }, P));
  const truncated = rows.length > cap;
  if (truncated) rows.length = cap;

  const sessions = []; let curSid = null, cur = null;
  for (const r of rows) {
    if (r.sid !== curSid) { curSid = r.sid; cur = []; sessions.push(cur); }
    cur.push(r.type == null ? "?" : String(r.type));
  }

  return { sessions: sessions.filter((s) => s.length), events: rows.length, truncated };
}

module.exports = { fetchSequences };
