#!/usr/bin/env node
/* =============================================================================
 * Suite server — admin account CLI
 * -----------------------------------------------------------------------------
 * Manage the dashboard logins without touching the DB by hand.
 *
 *   node scripts/admin.js add <username> <password>
 *   node scripts/admin.js list
 *   node scripts/admin.js remove <username|id>
 *
 * (Or via npm:  npm run admin -- add teacher s3cret-pass )
 * ========================================================================== */
"use strict";

const auth = require("../src/admin-auth");
const db = require("../src/db");

const [, , cmd, a, b] = process.argv;

function usage() {
  console.log("Usage:\n  admin add <username> <password>\n  admin list\n  admin remove <username|id>");
  process.exit(1);
}

try {
  if (cmd === "add") {
    if (!a || !b) usage();
    const created = auth.createAdmin(a, b);
    console.log(`✓ admin created: ${created.username} (id ${created.id})`);
  } else if (cmd === "list") {
    const rows = auth.listAdmins();
    if (!rows.length) { console.log("(no admins yet)"); }
    else rows.forEach((r) => console.log(`#${r.id}  ${r.username}\tcreated ${r.created_at}\tlast login ${r.last_login_at || "—"}`));
  } else if (cmd === "remove") {
    if (!a) usage();
    const row = /^\d+$/.test(a)
      ? { id: Number(a) }
      : db.prepare("SELECT id FROM admin_users WHERE username = ? COLLATE NOCASE").get(a);
    if (!row || !row.id) { console.error(`✗ no such admin: ${a}`); process.exit(1); }
    if (auth.countAdmins() <= 1) { console.error("✗ refusing to remove the last admin"); process.exit(1); }
    console.log(auth.removeAdmin(row.id) ? `✓ removed admin ${a}` : `✗ no such admin: ${a}`);
  } else {
    usage();
  }
  process.exit(0);
} catch (e) {
  console.error("✗", e.message);
  process.exit(1);
}
