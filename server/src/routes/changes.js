import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth, requireRole } from "../auth.js";
import { applyChange } from "../applyChange.js";

export const changesRouter = Router();

// Database Manager proposes a change. It has no effect until an AO approves it.
changesRouter.post("/changes", requireAuth, requireRole("DB_MANAGER"), async (req, res) => {
  const { type, summary, payload } = req.body || {};
  if (!type || !summary || !payload) return res.status(400).json({ error: "type, summary, and payload are required" });

  const change = await prisma.pendingChange.create({
    data: { type, summary, payload, requestedById: req.user.id, status: "pending" },
  });
  res.status(201).json({ change });
});

changesRouter.post("/changes/:id/approve", requireAuth, requireRole("AO"), async (req, res) => {
  const change = await prisma.pendingChange.findUnique({ where: { id: req.params.id } });
  if (!change) return res.status(404).json({ error: "Change not found" });
  if (change.status !== "pending") return res.status(409).json({ error: "This change was already decided" });

  try {
    await applyChange(prisma, change);
  } catch (e) {
    return res.status(400).json({ error: `Could not apply change: ${e.message}` });
  }

  const updated = await prisma.pendingChange.update({ where: { id: change.id }, data: { status: "approved" } });
  res.json({ change: updated });
});

changesRouter.post("/changes/:id/reject", requireAuth, requireRole("AO"), async (req, res) => {
  const { reason } = req.body || {};
  const change = await prisma.pendingChange.findUnique({ where: { id: req.params.id } });
  if (!change) return res.status(404).json({ error: "Change not found" });
  if (change.status !== "pending") return res.status(409).json({ error: "This change was already decided" });

  const updated = await prisma.pendingChange.update({
    where: { id: change.id },
    data: { status: "rejected", reason: reason || "Not approved" },
  });
  res.json({ change: updated });
});
