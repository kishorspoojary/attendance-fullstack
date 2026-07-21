// ============================================================================
// The "propose a change, get it approved" flow for master data (students,
// hostel rooms, classes, staff assignments). See applyChange.js for what
// actually happens to the real tables once something here is approved.
// ============================================================================
import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth, requireRole, generateLoginKey } from "../auth.js";
import { applyChange } from "../applyChange.js";
import { FIELD_STAFF_ROLES } from "../constants.js";

export const changesRouter = Router();

// Database Manager proposes a change. It has no effect on the real tables
// until an AO approves it below — this just creates a record of the request.
changesRouter.post("/changes", requireAuth, requireRole("DB_MANAGER"), async (req, res) => {
  const { type, summary, payload } = req.body || {};
  if (!type || !summary || !payload) return res.status(400).json({ error: "type, summary, and payload are required" });

  // A new Warden/LAI/DO/Incharge Teacher account needs its 4-digit login
  // key assigned *before* it ever reaches the AO — generated here, on the
  // server, so the Database Manager's browser can't just make one up.
  // The actual User row still isn't created until AO approves (applyChange
  // reads this same payload.loginKey when that happens).
  if (type === "create_staff") {
    if (!FIELD_STAFF_ROLES.includes(payload.role)) {
      return res.status(400).json({ error: `role must be one of: ${FIELD_STAFF_ROLES.join(", ")}` });
    }
    payload.loginKey = await generateLoginKey();
  }

  const change = await prisma.pendingChange.create({
    data: { type, summary, payload, requestedById: req.user.id, status: "pending" },
  });
  res.status(201).json({ change });
});

changesRouter.post("/changes/:id/approve", requireAuth, requireRole("AO"), async (req, res) => {
  const change = await prisma.pendingChange.findUnique({ where: { id: req.params.id } });
  if (!change) return res.status(404).json({ error: "Change not found" });
  if (change.status !== "pending") return res.status(409).json({ error: "This change was already decided" });

  let applied;
  try {
    applied = await applyChange(prisma, change); // this is the line that actually writes to students/rooms/staff
  } catch (e) {
    return res.status(400).json({ error: `Could not apply change: ${e.message}` });
  }

  const updated = await prisma.pendingChange.update({ where: { id: change.id }, data: { status: "approved" } });
  // create_staff is the one change type applyChange() hands anything back
  // for — a freshly generated temp password, visible here once to whichever
  // AO approved it, never persisted in the change's payload. See applyChange.js.
  res.json({ change: updated, password: applied?.password });
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
