// ============================================================================
// Login, and "who am I" for an already-logged-in browser.
// ============================================================================
import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../db.js";
import { signToken, requireAuth, publicUser } from "../auth.js";

export const authRouter = Router();

authRouter.post("/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "Username and password are required" });

  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) return res.status(401).json({ error: "Incorrect username or password" });
  if (!user.active) return res.status(403).json({ error: "This account isn't activated yet. Ask your Database Manager to activate it." });

  // bcrypt.compare re-hashes the submitted password with the same salt
  // stored in passwordHash and checks the results match — we never decrypt
  // anything, because password hashes aren't reversible by design.
  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Incorrect username or password" });

  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

// Called once when the frontend loads, if it already has a saved token, to
// confirm the token's still valid and fetch fresh user data.
authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});
