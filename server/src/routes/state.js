// ============================================================================
// One big "give me everything" endpoint.
//
// A more typical REST API would split this into /students, /classes,
// /staff, etc., each paginated. We deliberately didn't, because at the
// scale of one school/college, fetching everything in one call and letting
// the frontend filter it in memory is simpler to build and reason about.
// If the student count grew into the tens of thousands, this is the first
// place you'd revisit.
// ============================================================================
import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth, publicUser } from "../auth.js";

export const stateRouter = Router();

stateRouter.get("/state", requireAuth, async (req, res) => {
  // Promise.all runs all six queries concurrently instead of one after
  // another — they don't depend on each other, so there's no reason to wait.
  const [floors, classes, hostelRooms, students, staff, pendingChanges, attendanceRows] = await Promise.all([
    prisma.floor.findMany(),
    prisma.classroom.findMany(),
    prisma.hostelRoom.findMany(),
    prisma.student.findMany(),
    prisma.user.findMany(),
    prisma.pendingChange.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.attendanceRecord.findMany(),
  ]);

  // The frontend wants attendance shaped as attendance[date][classId], but
  // Prisma just gives us a flat list of rows — this loop re-groups them.
  const attendance = {};
  for (const row of attendanceRows) {
    attendance[row.date] = attendance[row.date] || {};
    attendance[row.date][row.classId] = row;
  }

  res.json({
    floors,
    classes,
    hostelRooms,
    students,
    staff: staff.map(publicUser), // strip password hashes before this ever reaches the browser
    pendingChanges,
    attendance,
    me: publicUser(req.user),
  });
});
