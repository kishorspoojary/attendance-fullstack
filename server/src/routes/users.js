// ============================================================================
// AO account management: freeze/unfreeze anyone except the Principal.
//
// Freezing reuses the exact same "status must be ACTIVE to log in" check
// that already blocks a PENDING account (see auth.js's requireAuth) — the
// only difference the frontend needs to show is *why* you're blocked, which
// comes from the status value itself (FROZEN vs PENDING vs REJECTED).
// ============================================================================
import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth, requireRole, publicUser } from "../auth.js";
import { FREEZABLE_ROLES } from "../constants.js";

export const usersRouter = Router();

usersRouter.post("/users/:id/freeze", requireAuth, requireRole("AO"), async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ error: "Account not found" });
  if (!FREEZABLE_ROLES.includes(target.role)) {
    return res.status(403).json({ error: "The Principal's account can't be frozen" });
  }
  const updated = await prisma.user.update({ where: { id: target.id }, data: { status: "FROZEN" } });
  res.json({ user: publicUser(updated) });
});

usersRouter.post("/users/:id/unfreeze", requireAuth, requireRole("AO"), async (req, res) => {
  const target = await prisma.user.findUnique({ where: { id: req.params.id } });
  if (!target) return res.status(404).json({ error: "Account not found" });
  if (target.status !== "FROZEN") return res.status(409).json({ error: "This account isn't frozen" });
  const updated = await prisma.user.update({ where: { id: target.id }, data: { status: "ACTIVE" } });
  res.json({ user: publicUser(updated) });
});
