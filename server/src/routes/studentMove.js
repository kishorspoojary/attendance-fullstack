// ============================================================================
// Student moves: change a student's class, hostel room / day-scholar
// status, and/or roster position — the one master-data operation
// add/edit/delete/sync didn't cover. Same PendingChange + AO-approval flow
// as everything else (see applyChange.js's "move_student"/
// "move_students_batch" cases for what actually happens on approval).
//
// Roll numbers are globally unique and NEVER change on a move, so none of
// the roll-collision machinery elsewhere in this project (findRollOwner,
// findPendingRollCollision, the DB-level UNIQUE constraint) is relevant
// here — a move can never create a roll clash by construction.
// ============================================================================
import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth, requireRole } from "../auth.js";
import { findPendingStudentLock, STUDENT_LOCK_QUERY_TYPES } from "./changes.js";
import { computeSingleMoveOrder } from "../seqOrder.js";
import { isMoveNoOp, isBatchMoveNoOp, formatRoomOrDayLabel, buildMoveSummary, buildBatchMoveSummary } from "../studentMove.js";

export const studentMoveRouter = Router();

async function fetchStudentLocks() {
  return prisma.pendingChange.findMany({ where: { status: { in: ["pending", "sent_back"] }, type: { in: STUDENT_LOCK_QUERY_TYPES } } });
}
async function fetchRoomWithHostel(roomId) {
  if (!roomId) return null;
  return prisma.hostelRoom.findUnique({ where: { id: roomId }, include: { hostelFloor: { include: { hostel: true } } } });
}

// Single move: body is { newClassId?, newRoomId?, becomeDayScholar?,
// placeAfterStudentId?, placeAtEnd? }. Any of newClassId/newRoomId/
// becomeDayScholar can be omitted to mean "leave that dimension alone" —
// e.g. only newClassId means "move to this class, keep the same room/type,
// no position preference beyond wherever computeSingleMoveOrder's defaults
// put them".
studentMoveRouter.post("/students/:id/move", requireAuth, requireRole("DB_MANAGER"), async (req, res) => {
  const student = await prisma.student.findUnique({ where: { id: req.params.id }, include: { class: true } });
  if (!student) return res.status(404).json({ error: "Student not found" });

  const lock = findPendingStudentLock(await fetchStudentLocks(), student.id, null);
  if (lock) return res.status(409).json({ error: "A request for this student is already pending AO approval." });

  const { newClassId, newRoomId, becomeDayScholar, placeAfterStudentId, placeAtEnd } = req.body || {};

  const destClassId = newClassId || student.classId;
  const destClass = await prisma.classroom.findUnique({ where: { id: destClassId } });
  if (!destClass) return res.status(400).json({ error: "Destination class not found." });

  let destRoom = null;
  let destIsLocal;
  if (becomeDayScholar) {
    destIsLocal = true;
  } else {
    // No explicit room and not becoming a day scholar: keep the current
    // room if there was one (a move might only be changing class, leaving
    // hostel/room alone entirely) — but a currently-local student with no
    // room and no explicit destination has nothing to fall back to.
    const roomIdToUse = newRoomId || (!student.isLocal ? student.roomId : null);
    if (!roomIdToUse) return res.status(400).json({ error: "Choose a room, or mark this student as a day scholar." });
    destRoom = await fetchRoomWithHostel(roomIdToUse);
    if (!destRoom) return res.status(400).json({ error: "Destination room not found." });
    destIsLocal = false;
  }
  const destRoomId = destRoom?.id || null;

  if (placeAfterStudentId) {
    const target = await prisma.student.findUnique({ where: { id: placeAfterStudentId } });
    if (!target || target.classId !== destClassId) {
      return res.status(400).json({ error: "The student to place this after isn't currently in the destination class." });
    }
  }

  const destClassStudents = await prisma.student.findMany({ where: { classId: destClassId }, orderBy: { seq: "asc" } });
  const currentOrderedIds = destClassStudents.map((s) => s.id);
  const withoutMoving = currentOrderedIds.filter((id) => id !== student.id);
  const newOrder = computeSingleMoveOrder(withoutMoving, student.id, placeAfterStudentId || null, !!placeAtEnd);
  if (newOrder === null) return res.status(400).json({ error: "The student to place this after isn't currently in the destination class." });

  if (isMoveNoOp({
    oldClassId: student.classId, newClassId: destClassId,
    oldRoomId: student.roomId, newRoomId: destRoomId,
    oldIsLocal: student.isLocal, newIsLocal: destIsLocal,
    currentOrderedIds, newOrder,
  })) {
    return res.status(400).json({ error: "Nothing would actually change — pick a different class, room, or position." });
  }

  const oldRoom = await fetchRoomWithHostel(student.roomId);
  const classChanged = student.classId !== destClassId;
  const roomChanged = (student.roomId || null) !== destRoomId || student.isLocal !== destIsLocal;

  const summary = buildMoveSummary({
    studentName: student.name, roll: student.roll,
    classChanged, oldClassName: student.class?.name || "?", newClassName: destClass.name,
    roomChanged,
    oldRoomOrDayLabel: formatRoomOrDayLabel(student.isLocal, oldRoom, oldRoom?.hostelFloor?.hostel),
    newRoomOrDayLabel: formatRoomOrDayLabel(destIsLocal, destRoom, destRoom?.hostelFloor?.hostel),
  });

  const payload = {
    studentId: student.id, roll: student.roll, name: student.name,
    oldClassId: student.classId, newClassId: destClassId,
    oldRoomId: student.roomId, newRoomId: destRoomId,
    oldIsLocal: student.isLocal, newIsLocal: destIsLocal,
    placeAfterStudentId: placeAfterStudentId || null,
    placeAtEnd: !!placeAtEnd,
  };

  const change = await prisma.pendingChange.create({
    data: { type: "move_student", summary, payload, requestedById: req.user.id, status: "pending" },
  });
  res.status(201).json({ change });
});

// Batch move: body is { studentIds: [...], newClassId, newRoomId?,
// becomeDayScholar? }. newRoomId/becomeDayScholar are OPTIONAL and shared
// across the whole batch when given — if NEITHER is given, every student
// keeps their own current room/day-scholar status and only classId
// changes (a plain promotion). All-or-nothing: any per-student problem
// (already exists, already locked) rejects the whole request with every
// problem listed, nothing proposed.
studentMoveRouter.post("/students/move-batch", requireAuth, requireRole("DB_MANAGER"), async (req, res) => {
  const { studentIds, newClassId, newRoomId, becomeDayScholar } = req.body || {};
  if (!Array.isArray(studentIds) || studentIds.length === 0) return res.status(400).json({ error: "No students selected." });
  if (!newClassId) return res.status(400).json({ error: "Destination class is required." });

  const destClass = await prisma.classroom.findUnique({ where: { id: newClassId } });
  if (!destClass) return res.status(400).json({ error: "Destination class not found." });

  const changingRoomForAll = !!becomeDayScholar || !!newRoomId;
  let sharedRoom = null;
  if (changingRoomForAll && !becomeDayScholar) {
    sharedRoom = await fetchRoomWithHostel(newRoomId);
    if (!sharedRoom) return res.status(400).json({ error: "Destination room not found." });
  }

  const [students, pendingChanges] = await Promise.all([
    prisma.student.findMany({ where: { id: { in: studentIds } }, include: { class: true } }),
    fetchStudentLocks(),
  ]);
  const studentById = new Map(students.map((s) => [s.id, s]));

  const errors = [];
  const moves = [];
  for (const id of studentIds) {
    const student = studentById.get(id);
    if (!student) { errors.push(`A selected student no longer exists.`); continue; }
    const lock = findPendingStudentLock(pendingChanges, id, null);
    if (lock) { errors.push(`${student.name} (${student.roll}) already has a request pending AO approval.`); continue; }

    // "keep current room/type" default: only the students where
    // changingRoomForAll is false get their OWN current values carried
    // forward — each move is fully self-contained from here on, so
    // applyChange.js never has to re-derive "shared vs. kept" at approval time.
    const moveNewRoomId = changingRoomForAll ? (sharedRoom?.id || null) : student.roomId;
    const moveNewIsLocal = changingRoomForAll ? !!becomeDayScholar : student.isLocal;
    moves.push({
      studentId: id, roll: student.roll, name: student.name, className: student.class?.name || "?",
      oldClassId: student.classId, oldRoomId: student.roomId, oldIsLocal: student.isLocal,
      newRoomId: moveNewRoomId, newIsLocal: moveNewIsLocal,
    });
  }
  if (errors.length > 0) {
    return res.status(400).json({ error: `${errors.length} student(s) can't be moved — nothing was proposed.`, errors });
  }

  const movingIds = moves.map((m) => m.studentId);
  const destClassStudents = await prisma.student.findMany({ where: { classId: newClassId }, orderBy: { seq: "asc" } });
  const currentOrderedIds = destClassStudents.map((s) => s.id);
  const existingOrderedIds = currentOrderedIds.filter((id) => !movingIds.includes(id));
  const newOrder = [...existingOrderedIds, ...movingIds];

  if (isBatchMoveNoOp(moves, newClassId, currentOrderedIds, newOrder)) {
    return res.status(400).json({ error: "Nothing would actually change for any selected student." });
  }

  const summary = buildBatchMoveSummary(
    moves.map((m) => m.className),
    destClass.name,
    moves.length,
    changingRoomForAll,
    formatRoomOrDayLabel(!!becomeDayScholar, sharedRoom, sharedRoom?.hostelFloor?.hostel),
  );

  const payload = {
    newClassId,
    moves: moves.map(({ className, ...m }) => m), // className was only needed to build the summary above
  };

  const change = await prisma.pendingChange.create({
    data: { type: "move_students_batch", summary, payload, requestedById: req.user.id, status: "pending" },
  });
  res.status(201).json({ change });
});
