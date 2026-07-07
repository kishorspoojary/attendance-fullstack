// ============================================================================
// One big "give me everything" endpoint.
//
// A more typical REST API would split this into /students, /classes,
// /staff, etc., each paginated. We deliberately didn't, because at the
// scale of one school/college, fetching everything in one call and letting
// the frontend filter it in memory is simpler to build and reason about.
// ============================================================================
import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth, publicUser } from "../auth.js";

export const stateRouter = Router();

stateRouter.get("/state", requireAuth, async (req, res) => {
  const [hostels, hostelFloors, hostelRooms, collegeFloors, classes, students, staff, pendingChanges, attendanceRows] = await Promise.all([
    prisma.hostel.findMany(),
    prisma.hostelFloor.findMany(),
    prisma.hostelRoom.findMany(),
    prisma.collegeFloor.findMany(),
    prisma.classroom.findMany(),
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
    hostels,
    hostelFloors,
    hostelRooms,
    collegeFloors,
    classes,
    students,
    staff: staff.map(publicUser), // strip password hashes before this ever reaches the browser
    pendingChanges,
    attendance,
    me: publicUser(req.user),
  });
});
