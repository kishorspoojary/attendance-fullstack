// ============================================================================
// Registration (Principal only, one time), leadership account creation,
// login by 4-digit key, "who am I", and changing your password.
// ============================================================================
import { Router } from "express";
import bcrypt from "bcryptjs";
import { prisma } from "../db.js";
import { signToken, requireAuth, requireRole, publicUser, generateLoginKey, generateTempPassword } from "../auth.js";
import { LEADERSHIP_ROLES } from "../constants.js";

export const authRouter = Router();

// Lets the login screen decide whether to default to "Register as Principal"
// or "Log in" without guessing — public (no auth yet, by definition), and
// reveals nothing beyond the one bit of state register-principal already
// leans on to refuse a second registration.
authRouter.get("/principal-exists", async (req, res) => {
  const existing = await prisma.user.findFirst({ where: { role: "PRINCIPAL" } });
  res.json({ exists: !!existing });
});

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
    data: { name, loginKey, passwordHash, role: "PRINCIPAL", status: "ACTIVE", mustSetPassword: false },
  });

  const token = signToken(user);
  res.status(201).json({ token, user: publicUser(user) });
});

// Principal creates the AO / Coordinator / Database Manager accounts —
// "activating the system." They start ACTIVE immediately (no approval
// needed; the Principal creating them directly *is* the approval), each
// with its own freshly generated temp password rather than a shared one.
authRouter.post("/leadership", requireAuth, requireRole("PRINCIPAL"), async (req, res) => {
  const { name, role } = req.body || {};
  if (!name || !LEADERSHIP_ROLES.includes(role)) {
    return res.status(400).json({ error: `role must be one of: ${LEADERSHIP_ROLES.join(", ")}` });
  }
  const loginKey = await generateLoginKey();
  const password = generateTempPassword();
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await prisma.user.create({
    data: { name, loginKey, passwordHash, role, status: "ACTIVE", mustSetPassword: true },
  });
  // Returning the plain temp password here (once, at creation time only) is
  // intentional and safe — it's freshly generated per account and never
  // stored or logged anywhere in plaintext after this response goes out;
  // the Principal needs to actually hand it to this person.
  res.status(201).json({ user: publicUser(user), loginKey, password });
});

authRouter.post("/login", async (req, res) => {
  const { loginKey, password } = req.body || {};
  if (!loginKey || !password) return res.status(400).json({ error: "Login key and password are required" });

  const user = await prisma.user.findUnique({ where: { loginKey } });
  if (!user) return res.status(401).json({ error: "Incorrect login key or password" });

  const ok = await bcrypt.compare(password, user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Incorrect login key or password" });

  if (user.status === "PENDING") return res.status(403).json({ error: "This account is waiting on AO approval." });
  if (user.status === "FROZEN") return res.status(403).json({ error: "Account frozen — contact Principal." });
  if (user.status === "REJECTED") return res.status(403).json({ error: "This account request was not approved." });

  const token = signToken(user);
  res.json({ token, user: publicUser(user) });
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ user: publicUser(req.user) });
});

// Self-service password change for anyone already set up — always requires
// the current password, regardless of mustSetPassword. Any role, self only
// (req.user.id — there's no :id param, so this can never target anyone else).
authRouter.post("/change-password", requireAuth, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body || {};
  if (!currentPassword || !newPassword) return res.status(400).json({ error: "Current and new password are required" });
  if (newPassword.length < 6) return res.status(400).json({ error: "New password must be at least 6 characters" });
  if (confirmPassword !== undefined && newPassword !== confirmPassword) {
    return res.status(400).json({ error: "New password and confirmation don't match" });
  }

  const ok = await bcrypt.compare(currentPassword, req.user.passwordHash);
  if (!ok) return res.status(401).json({ error: "Current password is incorrect" });

  const passwordHash = await bcrypt.hash(newPassword, 10);
  const updated = await prisma.user.update({
    where: { id: req.user.id },
    data: { passwordHash, mustSetPassword: false },
  });
  res.json({ user: publicUser(updated) });
});

// Used right after login when mustSetPassword is true (fresh account or
// just-reset password) — deliberately no current-password check, since the
// whole point is replacing a temp password nobody's supposed to keep using,
// not verifying one. Refuses outright if mustSetPassword is already false,
// so this can't be used as a backdoor password change bypassing
// change-password's current-password check.
authRouter.post("/set-password", requireAuth, async (req, res) => {
  if (!req.user.mustSetPassword) {
    return res.status(403).json({ error: "This account isn't waiting on a password setup — use Change Password instead" });
  }
  const { newPassword, confirmPassword } = req.body || {};
  if (!newPassword) return res.status(400).json({ error: "New password is required" });
  if (newPassword.length < 6) return res.status(400).json({ error: "New password must be at least 6 characters" });
  if (newPassword !== confirmPassword) return res.status(400).json({ error: "New password and confirmation don't match" });

  const passwordHash = await bcrypt.hash(newPassword, 10);
  const updated = await prisma.user.update({
    where: { id: req.user.id },
    data: { passwordHash, mustSetPassword: false },
  });
  res.json({ user: publicUser(updated) });
});
