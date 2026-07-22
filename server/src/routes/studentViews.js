// ============================================================================
// Two read-only "browse students" endpoints for the Database Manager and AO
// — grouped by class (college side) and by the full hostel tree (hostel
// side), each with a "day scholars" bucket since day scholars have no room.
// Nothing here mutates anything; both routes are plain GETs.
//
// Each route does its one (or two) Prisma queries, then hands the result to
// a pure shaping function below — kept separate from the route handlers so
// the grouping/counting logic can be exercised directly against a plain
// fixture, without a database.
// ============================================================================
import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth, requireRole } from "../auth.js";

export const studentViewsRouter = Router();

// `classes` is a Classroom[] with students included, each student's `room`
// included down through hostelFloor -> hostel (see the query below).
export function shapeByClass(classes) {
  return {
    classes: classes.map((c) => ({
      id: c.id,
      name: c.name,
      count: c.students.length,
      students: c.students.map((s) => ({
        id: s.id,
        roll: s.roll,
        name: s.name,
        isLocal: s.isLocal,
        // Only populated for hostellers — the frontend shows a "Day
        // scholar" pill whenever this is null (see schema.prisma: roomId
        // null is the actual source of truth for "no hostel room").
        hostelName: s.room?.hostelFloor?.hostel?.name || null,
        floorName: s.room?.hostelFloor?.name || null,
        roomNo: s.room?.roomNo || null,
      })),
    })),
  };
}

// `hostels` is a Hostel[] with floors -> rooms -> students (each student's
// `class` included) nested in. `dayScholarStudents` is a flat Student[]
// (roomId null), each with `class` included.
export function shapeByHostel(hostels, dayScholarStudents) {
  const hostelsOut = hostels.map((h) => {
    const floorsOut = h.floors.map((f) => {
      const roomsOut = f.rooms.map((r) => ({
        id: r.id,
        roomNo: r.roomNo,
        count: r.students.length,
        occupants: r.students.map((s) => ({ id: s.id, roll: s.roll, name: s.name, className: s.class?.name || null })),
      }));
      return { id: f.id, name: f.name, count: roomsOut.reduce((n, r) => n + r.count, 0), rooms: roomsOut };
    });
    return { id: h.id, name: h.name, count: floorsOut.reduce((n, f) => n + f.count, 0), floors: floorsOut };
  });

  // Group day scholars by class — same "unassigned class" fallback the rest
  // of the app doesn't otherwise need, since every student here is expected
  // to have a class, but nothing enforces it at the schema level.
  const byClass = new Map();
  for (const s of dayScholarStudents) {
    const bucketKey = s.classId || "__unassigned";
    if (!byClass.has(bucketKey)) byClass.set(bucketKey, { classId: s.classId, className: s.class?.name || "Unassigned", count: 0, students: [] });
    const bucket = byClass.get(bucketKey);
    bucket.count++;
    bucket.students.push({ id: s.id, roll: s.roll, name: s.name });
  }
  const dayScholars = [...byClass.values()].sort((a, b) => a.className.localeCompare(b.className));

  return { hostels: hostelsOut, dayScholars };
}

studentViewsRouter.get("/students/by-class", requireAuth, requireRole("DB_MANAGER", "AO"), async (req, res) => {
  // One query: Prisma resolves the nested includes itself rather than the
  // route looping per class to fetch its students.
  const classes = await prisma.classroom.findMany({
    orderBy: { name: "asc" },
    include: {
      students: {
        orderBy: { roll: "asc" },
        include: { room: { include: { hostelFloor: { include: { hostel: true } } } } },
      },
    },
  });
  res.json(shapeByClass(classes));
});

studentViewsRouter.get("/students/by-hostel", requireAuth, requireRole("DB_MANAGER", "AO"), async (req, res) => {
  // Two queries total: the whole hostel -> floor -> room -> student tree in
  // one, and the day-scholar list (roomId null, per schema.prisma) in the
  // other — no per-row loops against the database.
  const [hostels, dayScholarStudents] = await Promise.all([
    prisma.hostel.findMany({
      orderBy: { name: "asc" },
      include: {
        floors: {
          orderBy: { name: "asc" },
          include: {
            rooms: {
              orderBy: { roomNo: "asc" },
              include: { students: { orderBy: { roll: "asc" }, include: { class: true } } },
            },
          },
        },
      },
    }),
    prisma.student.findMany({
      where: { roomId: null },
      orderBy: { roll: "asc" },
      include: { class: true },
    }),
  ]);
  res.json(shapeByHostel(hostels, dayScholarStudents));
});