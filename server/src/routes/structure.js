// ============================================================================
// Structure batches — a Database Manager drafts a whole tree of hostels ->
// floors -> rooms and college floors -> classrooms locally, then submits it
// as ONE PendingChange (type "structure_batch") instead of one per item.
// The AO still approves through the existing /changes/:id/approve route
// (see routes/changes.js and applyChange.js) — the two routes below only
// cover proposing a batch and sending one back for edits; PUT lets the
// Database Manager fix and resubmit after a send-back.
// ============================================================================
import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth, requireRole } from "../auth.js";
import { buildStructurePlan } from "../structureBatch.js";

export const structureRouter = Router();

structureRouter.post("/structure/batch", requireAuth, requireRole("DB_MANAGER"), async (req, res) => {
  const payload = req.body || {};
  let plan;
  try {
    plan = await buildStructurePlan(prisma, payload);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const change = await prisma.pendingChange.create({
    data: { type: "structure_batch", summary: plan.summary, payload, requestedById: req.user.id, status: "pending" },
  });
  res.status(201).json({ change });
});

structureRouter.post("/structure/batch/:id/send-back", requireAuth, requireRole("AO"), async (req, res) => {
  const { reason } = req.body || {};
  if (!reason || !reason.trim()) return res.status(400).json({ error: "A reason is required so the Database Manager knows what to fix" });

  const change = await prisma.pendingChange.findUnique({ where: { id: req.params.id } });
  if (!change || change.type !== "structure_batch") return res.status(404).json({ error: "Structure batch not found" });
  if (change.status !== "pending") return res.status(409).json({ error: "This batch was already decided" });

  const updated = await prisma.pendingChange.update({
    where: { id: change.id },
    data: { status: "sent_back", reason: reason.trim() },
  });
  res.json({ change: updated });
});

// Database Manager fixes a sent-back (or still-pending) batch and resubmits
// it. Re-validates from scratch — the point that got flagged, or something
// else, may still be wrong — and resets it to pending either way.
structureRouter.put("/structure/batch/:id", requireAuth, requireRole("DB_MANAGER"), async (req, res) => {
  const change = await prisma.pendingChange.findUnique({ where: { id: req.params.id } });
  if (!change || change.type !== "structure_batch") return res.status(404).json({ error: "Structure batch not found" });
  if (change.requestedById !== req.user.id) return res.status(403).json({ error: "You can only edit your own requests" });
  if (!["pending", "sent_back"].includes(change.status)) {
    return res.status(409).json({ error: "This batch was already decided and can't be edited" });
  }

  const payload = req.body || {};
  let plan;
  try {
    plan = await buildStructurePlan(prisma, payload);
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
  const updated = await prisma.pendingChange.update({
    where: { id: change.id },
    data: { payload, summary: plan.summary, status: "pending", reason: null },
  });
  res.json({ change: updated });
});