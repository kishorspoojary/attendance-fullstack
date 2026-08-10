// ============================================================================
// AO-controlled settings on a CollegeFloor. A new file rather than adding to
// attendance.js or structure.js: attendance.js's existing college-floor
// route (PUT .../deadline) is Lecturer-owned scheduling config, and
// structure.js is the draft-tree/PendingChange proposal flow (add_college_floor
// etc.) — neither is "a place AO-only, direct-mutation college-floor
// settings already live." This file is that place, so future settings of
// the same shape have one obvious home instead of a third one being invented.
// ============================================================================
import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth, requireRole } from "../auth.js";

export const collegeFloorsRouter = Router();

const ATTENDANCE_MODES = ["DO_FIRST", "WARDEN_FIRST"];

// Flips which role writes absence data first for every classroom on this
// floor — see schema.prisma's AttendanceMode comment. AO-only: this changes
// how the daily pipeline behaves for every DO/Warden/LAI touching this
// floor, not something any one of them should be able to flip themselves.
collegeFloorsRouter.patch("/college-floors/:id/attendance-mode", requireAuth, requireRole("AO"), async (req, res) => {
  const { id } = req.params;
  const { mode } = req.body || {};
  if (!ATTENDANCE_MODES.includes(mode)) {
    return res.status(400).json({ error: "mode must be DO_FIRST or WARDEN_FIRST" });
  }

  const floor = await prisma.collegeFloor.findUnique({ where: { id } });
  if (!floor) return res.status(404).json({ error: "Floor not found" });

  const updated = await prisma.collegeFloor.update({ where: { id }, data: { attendanceMode: mode } });
  res.json({ floor: updated });
});
