// ============================================================================
// Principal/AO account management: freeze/unfreeze anyone except the
// Principal, and never yourself.
//
// Freezing reuses the exact same "status must be ACTIVE to log in" check
// that already blocks a PENDING account (see auth.js's requireAuth) — the
// only difference the frontend needs to show is *why* you're blocked, which
// comes from the status value itself (FROZEN vs PENDING vs REJECTED).
// ============================================================================
import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth, requireRole, publicUser, generateLoginKey } from "../auth.js";
import { FREEZABLE_ROLES, LEADERSHIP_ROLES } from "../constants.js";

export const usersRouter = Router();

usersRouter.post("/users/:id/freeze", requireAuth, requireRole("PRINCIPAL", "AO"), async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ error: "Account not found" });
  if (target.id === req.user.id) return res.status(403).json({ error: "You can't freeze your own account" });
  if (!FREEZABLE_ROLES.includes(target.role)) {
    return res.status(403).json({ error: "The Principal's account can't be frozen" });
  }
  const updated = await prisma.user.update({ where: { id: target.id }, data: { status: "FROZEN" } });
  res.json({ user: publicUser(updated) });
});

usersRouter.post("/users/:id/unfreeze", requireAuth, requireRole("PRINCIPAL", "AO"), async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ error: "Account not found" });
  if (target.id === req.user.id) return res.status(403).json({ error: "You can't unfreeze your own account" });
  if (target.status !== "FROZEN") return res.status(409).json({ error: "This account isn't frozen" });
  const updated = await prisma.user.update({ where: { id: target.id }, data: { status: "ACTIVE" } });
  res.json({ user: publicUser(updated) });
});

// Issues a brand-new login key for a leadership account (AO/Coordinator/DB
// Manager) — e.g. if the old one leaked or the person forgot it. Scoped to
// LEADERSHIP_ROLES specifically (narrower than freeze's FREEZABLE_ROLES,
// which also covers field staff) since this is a Leadership Accounts screen
// action, not a general account-management one.
//
// The new key is returned once, in this response only — it's never written
// to a log and nothing persists it anywhere else retrievable after this call.
usersRouter.post("/users/:id/reset-key", requireAuth, requireRole("PRINCIPAL", "AO"), async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ error: "Account not found" });
  if (target.id === req.user.id) return res.status(403).json({ error: "You can't reset your own key" });
  if (!LEADERSHIP_ROLES.includes(target.role)) {
    return res.status(403).json({ error: "Only AO, Coordinator, and Database Manager keys can be reset here" });
  }
  const loginKey = await generateLoginKey();
  const updated = await prisma.user.update({ where: { id: target.id }, data: { loginKey, mustChangeKey: true } });
  res.json({ user: publicUser(updated), loginKey });
});
