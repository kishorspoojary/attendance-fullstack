import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth, publicUser } from "../auth.js";

export const stateRouter = Router();

// One convenience endpoint returning the whole app snapshot. Simple and
// good enough for an institution-sized dataset; split into paginated
// endpoints later if the student count grows into the tens of thousands.
stateRouter.get("/state", requireAuth, async (req, res) => {
  const [floors, classes, hostelRooms, students, staff, pendingChanges, attendanceRows] = await Promise.all([
    prisma.floor.findMany(),
    prisma.classroom.findMany(),
    prisma.hostelRoom.findMany(),
    prisma.student.findMany(),
    prisma.user.findMany(),
    prisma.pendingChange.findMany({ orderBy: { createdAt: "desc" } }),
    prisma.attendanceRecord.findMany(),
  ]);

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
    staff: staff.map(publicUser),
    pendingChanges,
    attendance,
    me: publicUser(req.user),
  });
});
