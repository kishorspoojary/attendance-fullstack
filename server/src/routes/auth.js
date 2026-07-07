// ============================================================================
// Registration (Principal only, one time), leadership account creation,
// login by 4-digit key, "who am I", and changing your password.
// ============================================================================
import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../db.js";
import { signToken, requireAuth, requireRole, publicUser, generateLoginKey } from "../auth.js";
import { DEFAULT_PASSWORD, LEADERSHIP_ROLES } from "../constants.js";

export const authRouter = Router();

// One-time bootstrap: the very first person to use this app registers
// themselves as Principal. Deliberately refuses if a Principal already
// exists, so this can't be used to create a second one later — everyone
// after this point is created by someone already in the system instead.
authRouter.post("/register-principal", async (req, res) => {
  const { name, password } = req.body || {};
  if (!name || !password) return res.status(400).json({ error: "Name and password are required" });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });

  const existing = await prisma.user.findFirst({ where: { role: "PRINCIPAL" } });
  if (existing) return res.status(409).json({ error: "A Principal is already registered. Please log in instead." });

  const loginKey = await generateLoginKey();
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { name, loginKey, passwordHash, role: "PRINCIPAL", status: "ACTIVE", mustChangePassword: false },
  });

  const token = signToken(user);
  res.status(201).json({ token, user: publicUser(user) });
});

// Principal creates the AO / Coordinator / Database Manager accounts —
// "activating the system." They start ACTIVE immediately (no approval
// needed; the Principal creating them directly *is* the approval) with the
// same shared default password everyone else starts with.
authRouter.post("/leadership", requireAuth, requireRole("PRINCIPAL"), async (req, res) => {
  const { name, role } = req.body || {};
  if (!name || !LEADERSHIP_ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${LEADERSHIP_ROLES.join(", ")}` });
  }
  const loginKey = await generateLoginKey();
  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10);
  const user = await prisma.user.create({
    data: { name, loginKey, passwordHash, role, status: "ACTIVE", mustChangePassword: true },
  });
  // Returning the plain default password here (once, at creation time only)
  // is intentional and safe — it's the same fixed default for everyone and
  // never a secret; the Principal needs to actually hand it to this person.
  res.status(201).json({ user: publicUser(user), loginKey, defaultPassword: DEFAULT_PASSWORD });
});

authRouter.post("/login", async (req, res) => {
  const { loginKey, password } = req.body || {};
  if (!loginKey || !password) return res.status(400).json({ error: "Login key and password are required" });

  const user = await prisma.user.findUnique({ where: { loginKey } });
  if (!user) return res.status(401).json({ error: "Incorrect login key or password" });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Incorrect login key or password" });

  if (user.status === "PENDING") return res.status(403).json({ error: "This account is waiting on AO approval." });
  if (user.status === "FROZEN") return res.status(403).json({ error: "This account has been frozen by the AO." });
  if (user.status === "REJECTED") return res.status(403).json({ error: "This account request was not approved." });

  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// Anyone logged in can change their own password — this is also how the
// mandatory "you're still on the default password" nudge gets cleared.
authRouter.post("/change-password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: "Current and new password are required" });
  if (newPassword.length < 6) return res.status(400).json({ error: "New password must be at least 6 characters" });

  const ok = await bcrypt.compare(currentPassword, req.user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Current password is incorrect" });

  const passwordHash = await bcrypt.hash(newPassword, 10);
  const updated = await prisma.user.update({
    where: { id: req.user.id },
    data: { passwordHash, mustChangePassword: false },
  });
  res.json({ user: publicUser(updated) });
});
