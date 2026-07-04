// ============================================================================
// The "propose a change, get it approved" flow for master data (students,
// hostel rooms, classes, staff assignments). See applyChange.js for what
// actually happens to the real tables once something here is approved.
// ============================================================================
import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth, requireRole } from "../auth.js";
import { applyChange } from "../applyChange.js";

export const changesRouter = Router();

// Database Manager proposes a change. It has no effect on the real tables
// until an AO approves it below — this just creates a record of the request.
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
    await applyChange(prisma, change); // this is the line that actually writes to students/rooms/staff
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

  // Note: rejecting never calls applyChange — the real tables are simply
  // never touched, which is exactly what "rejected" should mean.
  const updated = await prisma.pendingChange.update({
    where: { id: change.id },
    data: { status: "rejected", reason: reason || "Not approved" },
  });
  res.json({ change: updated });
});
