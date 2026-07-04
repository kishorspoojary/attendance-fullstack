// ============================================================================
// Two small routes for a Warden to manage a student's persistent "away"
// status. See constants.js for why "went home" is handled differently from
// the other absence reasons — short version: it shouldn't need re-marking
// every single day.
// ============================================================================
import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth, requireRole } from "../auth.js";
import { AWAY_REASON } from "../constants.js";

export const studentsRouter = Router();

// Shared permission check for both routes below: a Warden may only act on
// students in one of their own assigned rooms.
async function assertOwnedByWarden(req, res) {
  const student = await prisma.student.findUnique({ where: { id: req.params.id } });
  if (!student) { res.status(404).json({ error: "Student not found" }); return null; }
  if (!(req.user.roomIds || []).includes(student.roomId)) { res.status(403).json({ error: "This student isn't in one of your assigned rooms" }); return null; }
  return student;
}

// Warden marks a student as having gone home. They'll count as absent
// automatically every day \u2014 no re-marking needed \u2014 until reported back.
studentsRouter.post("/students/:id/mark-away", requireAuth, requireRole("WARDEN"), async (req, res) => {
  const student = await assertOwnedByWarden(req, res);
  if (!student) return; // assertOwnedByWarden already sent the error response
  const updated = await prisma.student.update({
    where: { id: student.id },
    data: { awayReason: req.body?.reason || AWAY_REASON, awaySince: new Date().toISOString().slice(0, 10) },
  });
  res.json({ student: updated });
});

// Warden clears the away status once the student is back.
studentsRouter.post("/students/:id/report-back", requireAuth, requireRole("WARDEN"), async (req, res) => {
  const student = await assertOwnedByWarden(req, res);
  if (!student) return;
  const updated = await prisma.student.update({ where: { id: student.id }, data: { awayReason: null, awaySince: null } });
  res.json({ student: updated });
});
