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
import { validateImportRows } from "./excel.js";

export const changesRouter = Router();

// The two change types send-back/edit apply to here — everything else
// (add_hostel, assign_*, create_staff, ...) only ever gets a flat
// approve/reject, same as before. structure_batch has its own parallel
// send-back/edit pair at /structure/batch/:id/... (see routes/structure.js)
// since it already had dedicated routes; these two follow the exact same
// pattern for student adds instead of bolting onto that structure-specific
// path.
const SENDBACKABLE_TYPES = ["add_student", "bulk_add_students"];

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

// Send an add_student/bulk_add_students change back for edits instead of a
// flat reject — mirrors structure_batch's send-back exactly (reason
// required, same "sent_back" status), so a 42-row Excel upload doesn't have
// to die over one wrong entry; the Database Manager can fix just that row
// via PUT below instead of re-uploading from scratch.
changesRouter.post("/changes/:id/send-back", requireAuth, requireRole("AO"), async (req, res) => {
  const { reason } = req.body || {};
  if (!reason || !reason.trim()) return res.status(400).json({ error: "A reason is required so the Database Manager knows what to fix" });

  const change = await prisma.pendingChange.findUnique({ where: { id: req.params.id } });
  if (!change) return res.status(404).json({ error: "Change not found" });
  if (!SENDBACKABLE_TYPES.includes(change.type)) {
    return res.status(400).json({ error: "This type of request can't be sent back — reject it instead" });
  }
  if (change.status !== "pending") return res.status(409).json({ error: "This change was already decided" });

  const updated = await prisma.pendingChange.update({
    where: { id: change.id },
    data: { status: "sent_back", reason: reason.trim() },
  });
  res.json({ change: updated });
});

// Database Manager fixes a sent-back (or still-pending) add_student /
// bulk_add_students change and resubmits it. The request body is always
// { rows: [{roll, name, hostelOrDay, roomNo}, ...] } — the same row shape
// the Excel importer works with — and re-runs the exact same
// validateImportRows rules (required fields, roll uniqueness in-sheet and
// in-class, the hostel-or-day-scholar value, the room/hostel cross-check),
// so this can't drift from what a fresh Excel upload would accept. Every
// bulk_add_students batch this app creates (the per-class Excel upload —
// see routes/excel.js) targets a single class; that class is fixed here
// too, taken from the change's own payload rather than re-derived per row.
changesRouter.put("/changes/:id", requireAuth, requireRole("DB_MANAGER"), async (req, res) => {
  const change = await prisma.pendingChange.findUnique({ where: { id: req.params.id } });
  if (!change) return res.status(404).json({ error: "Change not found" });
  if (!SENDBACKABLE_TYPES.includes(change.type)) {
    return res.status(400).json({ error: "This type of request can't be edited here" });
  }
  if (change.requestedById !== req.user.id) return res.status(403).json({ error: "You can only edit your own requests" });
  if (!["pending", "sent_back"].includes(change.status)) {
    return res.status(409).json({ error: "This request was already decided and can't be edited" });
  }

  const rawRows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (rawRows.length === 0) return res.status(400).json({ error: "No rows to submit" });
  if (change.type === "add_student" && rawRows.length !== 1) {
    return res.status(400).json({ error: "This request must have exactly one row" });
  }

  const classId = change.type === "add_student" ? change.payload.classId : change.payload.students?.[0]?.classId;
  const cls = classId ? await prisma.classroom.findUnique({ where: { id: classId } }) : null;
  if (!cls) return res.status(400).json({ error: "The original class for this request no longer exists" });

  const [hostels, hostelFloors, hostelRooms, existingStudentsInClass] = await Promise.all([
    prisma.hostel.findMany(),
    prisma.hostelFloor.findMany(),
    prisma.hostelRoom.findMany(),
    prisma.student.findMany({ where: { classId } }),
  ]);
  const existingRolls = new Set(existingStudentsInClass.map((s) => s.roll.trim().toLowerCase()));

  const rows = rawRows.map((r, i) => ({
    rowNumber: i + 1,
    roll: String(r.roll ?? "").trim(),
    name: String(r.name ?? "").trim(),
    hostelOrDay: String(r.hostelOrDay ?? "").trim(),
    roomNo: String(r.roomNo ?? "").trim(),
  }));
  const { toAdd, errors } = validateImportRows(rows, { classId, className: cls.name, hostels, hostelFloors, hostelRooms, existingRolls });

  if (errors.length > 0) {
    return res.status(400).json({ error: `${errors.length} row(s) had problems — nothing was saved.`, errors });
  }
  if (toAdd.length === 0) return res.status(400).json({ error: "No valid rows to submit" });

  let payload, summary;
  if (change.type === "add_student") {
    const s = toAdd[0];
    payload = { name: s.name, roll: s.roll, classId: s.classId, roomId: s.roomId, isLocal: s.isLocal };
    summary = `Add student ${s.name} (${s.roll})`;
  } else {
    const hostellerCount = toAdd.filter((s) => !s.isLocal).length;
    const dayScholarCount = toAdd.length - hostellerCount;
    payload = { students: toAdd };
    summary = `Add ${toAdd.length} students to ${cls.name} (${hostellerCount} hosteller${hostellerCount === 1 ? "" : "s"}, ${dayScholarCount} day scholar${dayScholarCount === 1 ? "" : "s"})`;
  }

  const updated = await prisma.pendingChange.update({
    where: { id: change.id },
    data: { payload, summary, status: "pending", reason: null },
  });
  res.json({ change: updated });
});
