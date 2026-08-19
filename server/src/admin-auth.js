/* =============================================================================
 * Suite server — admin authentication
 * -----------------------------------------------------------------------------
 * Admins (teachers / researchers) log in to the analytics dashboard. This is a
 * completely separate identity space from players:
 *   - players are password-free game accounts (a claimed name + token),
 *   - admins have a username + password and a server-side session.
 *
 * No external dependencies: passwords are scrypt-hashed (node crypto), sessions
 * are opaque random tokens stored in `admin_sessions` and carried in an
 * httpOnly, SameSite=Strict cookie.
 * ========================================================================== */
"use strict";

const crypto = require("crypto");
const config = require("./config");
const db = require("./db");

const COOKIE = "suite_admin";
const SESSION_MS = Math.max(1, config.sessionDays) * 24 * 60 * 60 * 1000;

// ---- Prepared statements ----------------------------------------------------
const q = {
  insertAdmin: db.prepare(
    "INSERT INTO admin_users (username, pass_hash, pass_salt) VALUES (?, ?, ?)"
  ),
  findAdmin: db.prepare("SELECT * FROM admin_users WHERE username = ? COLLATE NOCASE"),
  listAdmins: db.prepare(
    "SELECT id, username, created_at, last_login_at FROM admin_users ORDER BY username"
  ),
  countAdmins: db.prepare("SELECT COUNT(*) AS n FROM admin_users"),
  deleteAdmin: db.prepare("DELETE FROM admin_users WHERE id = ?"),
  touchAdmin: db.prepare("UPDATE admin_users SET last_login_at = datetime('now') WHERE id = ?"),
  insertSession: db.prepare(
    "INSERT INTO admin_sessions (token, admin_id, expires_at) VALUES (?, ?, ?)"
  ),
  sessionAdmin: db.prepare(
    `SELECT a.id, a.username FROM admin_sessions s
       JOIN admin_users a ON a.id = s.admin_id
      WHERE s.token = ? AND s.expires_at > datetime('now')`
  ),
  deleteSession: db.prepare("DELETE FROM admin_sessions WHERE token = ?"),
  purgeSessions: db.prepare("DELETE FROM admin_sessions WHERE expires_at <= datetime('now')"),
};

// ---- Password hashing (scrypt) ---------------------------------------------
function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { salt, hash };
}
function verifyPassword(password, salt, expectedHex) {
  const hex = crypto.scryptSync(String(password), salt, 64).toString("hex");
  const a = Buffer.from(hex, "hex");
  const b = Buffer.from(expectedHex, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// ---- Account management (also used by the CLI) ------------------------------
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
function createAdmin(username, password) {
  username = String(username || "").trim();
  if (!USERNAME_RE.test(username)) throw new Error("username must be 3–32 chars: letters, numbers, . _ -");
  if (String(password || "").length < 8) throw new Error("password must be at least 8 characters");
  const { salt, hash } = hashPassword(password);
  try {
    const info = q.insertAdmin.run(username, hash, salt);
    return { id: info.lastInsertRowid, username };
  } catch (e) {
    if (String(e.message).includes("UNIQUE")) throw new Error("that admin username already exists");
    throw e;
  }
}
function listAdmins() { return q.listAdmins.all(); }
function countAdmins() { return q.countAdmins.get().n; }
function removeAdmin(id) { return q.deleteAdmin.run(id).changes > 0; }

// On boot, if there are no admins yet and ADMIN_USER/ADMIN_PASSWORD are set,
// seed the first one so there's always a way in. Never overwrites an existing.
function seedFromEnv() {
  if (countAdmins() > 0) return;
  const { user, pass } = config.adminSeed;
  if (!user || !pass) return;
  try {
    createAdmin(user, pass);
    console.log(`[suite] seeded first admin "${user}" from env (ADMIN_USER/ADMIN_PASSWORD).`);
  } catch (e) {
    console.warn("[suite] could not seed admin from env:", e.message);
  }
}

// ---- Sessions ---------------------------------------------------------------
function startSession(adminId) {
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_MS).toISOString().replace("T", " ").slice(0, 19);
  q.insertSession.run(token, adminId, expires);
  return token;
}
function sessionAdmin(token) { return token ? q.sessionAdmin.get(token) : null; }
function endSession(token) { if (token) q.deleteSession.run(token); }

// ---- Cookies ----------------------------------------------------------------
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  raw.split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}
function setSessionCookie(res, token) {
  const attrs = [`${COOKIE}=${token}`, "HttpOnly", "Path=/", "SameSite=Strict", `Max-Age=${Math.floor(SESSION_MS / 1000)}`];
  if (config.cookieSecure) attrs.push("Secure");
  res.append("Set-Cookie", attrs.join("; "));
}
function clearSessionCookie(res) {
  const attrs = [`${COOKIE}=`, "HttpOnly", "Path=/", "SameSite=Strict", "Max-Age=0"];
  if (config.cookieSecure) attrs.push("Secure");
  res.append("Set-Cookie", attrs.join("; "));
}

// ---- Middleware -------------------------------------------------------------
function requireAdmin(req, res, next) {
  const token = parseCookies(req)[COOKIE];
  const admin = sessionAdmin(token);
  if (!admin) return res.status(401).json({ error: "unauthorized" });
  req.admin = admin;
  req._sessionToken = token;
  next();
}

// ---- Login brute-force guard (in-memory, per IP) ----------------------------
const fails = new Map();          // ip -> { n, until }
function loginBlocked(ip) {
  const f = fails.get(ip);
  return f && f.until > Date.now() && f.n >= 8;
}
function noteLoginFail(ip) {
  const f = fails.get(ip) || { n: 0, until: 0 };
  f.n = (f.until > Date.now() ? f.n : 0) + 1;
  f.until = Date.now() + 5 * 60 * 1000;   // 5-minute window
  fails.set(ip, f);
}
function clearLoginFails(ip) { fails.delete(ip); }

// ---- Routes -----------------------------------------------------------------
// Mounted by server.js under /api/admin. Only /login is public; the rest are
// gated by requireAdmin (added at the mount site).
function mount(router) {
  // Periodic cleanup of expired sessions (cheap, hourly).
  setInterval(() => { try { q.purgeSessions.run(); } catch (e) {} }, 60 * 60 * 1000).unref();

  router.post("/login", (req, res) => {
    const ip = req.ip || "unknown";
    if (loginBlocked(ip)) return res.status(429).json({ error: "too_many_attempts" });
    const username = String((req.body && req.body.username) || "").trim();
    const password = String((req.body && req.body.password) || "");
    const admin = q.findAdmin.get(username);
    if (!admin || !verifyPassword(password, admin.pass_salt, admin.pass_hash)) {
      noteLoginFail(ip);
      return res.status(401).json({ error: "invalid_credentials" });
    }
    clearLoginFails(ip);
    q.touchAdmin.run(admin.id);
    const token = startSession(admin.id);
    setSessionCookie(res, token);
    res.json({ ok: true, user: { id: admin.id, username: admin.username } });
  });

  router.post("/logout", requireAdmin, (req, res) => {
    endSession(req._sessionToken);
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.get("/me", requireAdmin, (req, res) => {
    res.json({ user: req.admin });
  });

  // Account management (any logged-in admin can manage the roster).
  router.get("/accounts", requireAdmin, (req, res) => {
    res.json({ accounts: listAdmins() });
  });
  router.post("/accounts", requireAdmin, (req, res) => {
    try {
      const created = createAdmin(req.body && req.body.username, req.body && req.body.password);
      res.status(201).json({ ok: true, account: created });
    } catch (e) {
      res.status(400).json({ error: "invalid", detail: e.message });
    }
  });
  router.delete("/accounts/:id", requireAdmin, (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (countAdmins() <= 1) return res.status(400).json({ error: "cannot_delete_last_admin" });
    if (id === req.admin.id) return res.status(400).json({ error: "cannot_delete_self" });
    if (!removeAdmin(id)) return res.status(404).json({ error: "no_such_account" });
    res.json({ ok: true });
  });
}

module.exports = {
  mount,
  requireAdmin,
  seedFromEnv,
  // exported for the CLI
  createAdmin,
  listAdmins,
  removeAdmin,
  countAdmins,
};
