// ============================================================================
// Login tokens (JWT), permission-checking middleware, and 4-digit login keys.
//
// How login works, in plain terms:
//   1. Someone POSTs their 4-digit loginKey + password to /api/auth/login —
//      there is no username anywhere in this app.
//   2. We check the password (routes/auth.js), and if it's right, we call
//      signToken(user) here to create a JWT — a signed string that encodes
//      "this is user X with role Y" and expires after 12 hours.
//   3. The browser stores that token (see client/src/api.js) and sends it
//      back in an `Authorization: Bearer <token>` header on every future
//      request.
//   4. requireAuth (below) runs on every protected route: it reads that
//      header, verifies the signature hasn't been tampered with, and looks
//      up the real user row so the rest of the request has fresh data.
// ============================================================================
import jwt from "jsonwebtoken";
import { prisma } from "./db.js";

const SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

export function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, SECRET, { expiresIn: "12h" });
}

// Express middleware: runs before the real route handler. Blocks anyone
// whose account isn't ACTIVE — this one check covers both "AO hasn't
// approved you yet" (PENDING) and "AO froze you" (FROZEN) with the same
// code path; routes/auth.js's /me endpoint is what tells the frontend
// *which* of those it is, so it can show the right message.
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not logged in" });
  try {
    const payload = jwt.verify(token, SECRET);
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user) return res.status(401).json({ error: "Account not found" });
    if (user.status !== "ACTIVE") {
      return res.status(403).json({ error: "Account not active", status: user.status });
    }
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired session" });
  }
}

// A second middleware, used like: requireRole("AO", "COORDINATOR").
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: `This action needs one of: ${roles.join(", ")}` });
    }
    next();
  };
}

// Strips the password hash before sending a user record back to the
// frontend — the browser has no business ever seeing that, even hashed.
export function publicUser(user) {
  const { passwordHash, ...rest } = user;
  return rest;
}

// Generates a unique 4-digit numeric login key, e.g. "0483". Keeps trying
// random values until it finds one nobody already has — with 10,000
// possible keys this only ever takes one or two tries in practice for a
// school-sized app, but the loop is there so a collision literally cannot
// slip through.
export async function generateLoginKey() {
  for (let attempt = 0; attempt < 50; attempt++) {
    const key = String(Math.floor(Math.random() * 10000)).padStart(4, "0");
    const existing = await prisma.user.findUnique({ where: { loginKey: key } });
    if (!existing) return key;
  }
  throw new Error("Could not generate a unique login key — this should be virtually impossible; try again");
}

// A one-time temp password for a freshly-created or just-reset account —
// replaces the old shared constant default. No uniqueness constraint needed
// (unlike loginKey, this is never looked up by value), just enough entropy
// that it's safe to hand someone as a real, if temporary, credential.
const PASSWORD_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"; // no 0/O/1/l/I — avoids misreads when someone copies it off a banner
export function generateTempPassword(length = 12) {
  let out = "";
  for (let i = 0; i < length; i++) out += PASSWORD_CHARS[Math.floor(Math.random() * PASSWORD_CHARS.length)];
  return out;
}
