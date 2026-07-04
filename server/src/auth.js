// ============================================================================
// Login tokens (JWT) and permission-checking middleware.
//
// How login works, in plain terms:
//   1. Someone POSTs their username/password to /api/auth/login.
//   2. We check the password (routes/auth.js), and if it's right, we call
//      signToken(user) here to create a JWT — a signed string that encodes
//      "this is user X with role Y" and expires after 12 hours.
//   3. The browser stores that token (see client/src/api.js) and sends it
//      back in an `Authorization: Bearer <token>` header on every future
//      request.
//   4. requireAuth (below) runs on every protected route: it reads that
//      header, verifies the signature hasn't been tampered with, and looks
//      up the real user row so the rest of the request has fresh data
//      (e.g. their current role/assignments, not whatever they had at login
//      time).
//
// Why not just store a session id in the database instead? We could — that's
// a valid alternative design. JWTs avoid a database lookup just to check
// "is this token valid," at the cost of not being able to instantly revoke
// one before it expires. Fine for an app this size.
// ============================================================================
import jwt from "jsonwebtoken";
import { prisma } from "./db.js";

const SECRET = process.env.JWT_SECRET || "dev-secret-change-me";

export function signToken(user) {
  // `sub` (subject) and `role` are just data we embed inside the token.
  // Anyone can *read* a JWT's contents (it's not encrypted, just signed) —
  // never put a password or other secret inside one.
  return jwt.sign({ sub: user.id, role: user.role }, SECRET, { expiresIn: "12h" });
}

// Express middleware: a function that runs *before* the actual route
// handler. If it calls next(), Express continues to the real handler and
// attaches whatever we set on `req` along the way (here, req.user). If it
// calls res.status(...).json(...) instead, the request stops right here —
// the real handler never runs.
export async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not logged in" });
  try {
    const payload = jwt.verify(token, SECRET); // throws if the signature is invalid or it's expired
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.active) return res.status(401).json({ error: "Account not active" });
    req.user = user; // every route handler after this can now read req.user
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired session" });
  }
}

// A second middleware, used like: requireRole("AO", "COORDINATOR").
// Because it's a function that *returns* a middleware, we can customize
// which roles are allowed per-route while reusing the same logic.
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
