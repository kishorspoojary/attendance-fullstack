// ============================================================================
// Re-validates add_student/bulk_add_students/edit_student payloads against
// the LIVE database from inside the approval transaction — the same
// "rebuild the plan, re-check against reality, then create" pattern
// structure_batch uses (see structureBatch.js), applied to students.
//
// Why this exists: a batch validates cleanly at PROPOSE time against
// whatever students already exist. But two Excel uploads, both proposed
// before either is approved, can each validate fine on their own — each
// only sees already-APPROVED students, not each other's still-pending
// rolls. If an AO approves both, the second one's rolls now collide with
// students the first one just created. Re-running the same roll checks
// here, right before the actual create/update, catches that staleness and
// aborts the whole transaction instead of creating a duplicate — see
// applyChange.js's "add_student", "bulk_add_students", and "edit_student"
// cases.
//
// Roll uniqueness is GLOBAL — across the whole college, not scoped to a
// class — per the institution's confirmed rule: every student has a
// genuinely unique roll number college-wide, with no per-class exceptions.
// ============================================================================
const norm = (s) => String(s ?? "").trim().toLowerCase();

// Pure: does `roll` collide with any OTHER student in `students` (case-
// insensitive, trimmed), globally? Returns the colliding student's class
// name (for the error message) or null. Takes already-fetched student rows
// (each needs its `class` relation included) so the same comparison logic
// works both as a propose-time dry-run check (against the plain `prisma`
// client, in routes/changes.js) and inside an approval-time transaction
// (against `tx`, below) without duplicating it in two places.
export function findRollOwner(students, roll, excludeStudentId) {
  const rollKey = norm(roll);
  const owner = students.find((s) => s.id !== excludeStudentId && norm(s.roll) === rollKey);
  return owner ? (owner.class?.name || "another class") : null;
}

// `client` is a transaction client (`tx`) from inside applyChange.js's
// prisma.$transaction — never the plain top-level `prisma`, so every read
// here sees a consistent snapshot with the create that follows it.
// `students` is always an array — add_student wraps its single payload
// object in one, bulk_add_students passes its `students` array as-is.
// Throws a plain Error with a message meant to be shown to the AO
// (routes/changes.js's /approve route already surfaces applyChange's
// thrown message as the response's `error`) the moment anything is stale;
// callers should let that abort the transaction rather than catching it.
export async function revalidateStudentsForApproval(client, students) {
  const classCache = new Map(); // classId -> Classroom | null
  const roomCache = new Map(); // roomId -> HostelRoom | null
  const allExisting = await client.student.findMany({ include: { class: true } }); // one global fetch — roll uniqueness has no per-class scope to narrow it by
  const seenInThisBatch = new Set(); // normalized roll — global across the whole batch, not per-class

  for (const s of students) {
    if (!classCache.has(s.classId)) {
      classCache.set(s.classId, await client.classroom.findUnique({ where: { id: s.classId } }));
    }
    const cls = classCache.get(s.classId);
    if (!cls) {
      throw new Error(`The class for "${s.name}" (roll ${s.roll}) no longer exists — this request is stale. Send it back or reject it.`);
    }

    const rollKey = norm(s.roll);
    const owner = findRollOwner(allExisting, s.roll, null);
    if (owner) {
      throw new Error(`Roll no. "${s.roll}" now already exists (currently in ${owner}) — this request is stale. Send it back or reject it.`);
    }
    // Defense-in-depth: propose-time and edit-time validation
    // (validateImportRows) already reject in-batch duplicates, so this
    // should never actually fire — but if it somehow did (a bug in that
    // check, or a payload built some other way), this is the last line
    // before a real duplicate would be created.
    if (seenInThisBatch.has(rollKey)) {
      throw new Error(`Roll no. "${s.roll}" is duplicated within this request — this shouldn't have passed validation. Send it back or reject it.`);
    }
    seenInThisBatch.add(rollKey);

    if (s.roomId) {
      if (!roomCache.has(s.roomId)) {
        roomCache.set(s.roomId, await client.hostelRoom.findUnique({ where: { id: s.roomId } }));
      }
      if (!roomCache.get(s.roomId)) {
        throw new Error(`The room for "${s.name}" (roll ${s.roll}) no longer exists — this request is stale. Send it back or reject it.`);
      }
    }
  }
}

// Re-checks an edit_student change's roll (if the edit actually changes it —
// every other field on Student has no uniqueness rule to enforce) against
// the live database, inside the approval transaction. edit_student is the
// one student-changing type that previously had NO approval-time
// revalidation at all; this closes that gap using the same global rule as
// everywhere else.
export async function revalidateEditForApproval(client, studentId, changes) {
  if (!changes || changes.roll === undefined) return;
  const others = await client.student.findMany({ where: { id: { not: studentId } }, include: { class: true } });
  const owner = findRollOwner(others, changes.roll, null); // already excluded via the query itself
  if (owner) {
    throw new Error(`Roll no. "${changes.roll}" now already exists (currently in ${owner}) — this request is stale. Send it back or reject it.`);
  }
}

// Re-validates a sync_class_students change's edits — {studentId, roll,
// roomId, isLocal, ...} rows produced by routes/excel.js's
// diffAndValidateRoster — inside the approval transaction: the target
// student must still exist, and if the edit points at a room, that room
// must still exist too. Edits never change roll (roll is the diff's
// matching key — see diffAndValidateRoster), so there's no roll-uniqueness
// check to repeat here the way there is for adds/edit_student.
export async function revalidateSyncEditsForApproval(client, edits) {
  const roomCache = new Map();
  for (const e of edits) {
    const student = await client.student.findUnique({ where: { id: e.studentId } });
    if (!student) {
      throw new Error(`A student in this sync (roll ${e.roll}) no longer exists — this request is stale. Send it back or reject it.`);
    }
    if (e.roomId) {
      if (!roomCache.has(e.roomId)) {
        roomCache.set(e.roomId, await client.hostelRoom.findUnique({ where: { id: e.roomId } }));
      }
      if (!roomCache.get(e.roomId)) {
        throw new Error(`The room for roll ${e.roll} no longer exists — this request is stale. Send it back or reject it.`);
      }
    }
  }
}

// Re-validates a sync_class_students change's removals — {studentId, roll,
// name} rows — inside the approval transaction: every target must still
// exist (an earlier, unrelated change could already have removed one).
export async function revalidateSyncRemovalsForApproval(client, removals) {
  for (const r of removals) {
    const student = await client.student.findUnique({ where: { id: r.studentId } });
    if (!student) {
      throw new Error(`A student to be removed (roll ${r.roll}) no longer exists — already deleted. This request is stale. Send it back or reject it.`);
    }
  }
}

// Re-validates a move_student change inside the approval transaction: the
// student, the destination class, the destination room (if not becoming a
// day scholar), and — if a position was requested — the student they
// should land after, must ALL still exist and still be where the payload
// expects. Roll never changes on a move, so there's no roll-uniqueness
// re-check here the way there is for adds/edit_student's roll field.
export async function revalidateMoveForApproval(client, p) {
  const student = await client.student.findUnique({ where: { id: p.studentId } });
  if (!student) {
    throw new Error(`This student (roll ${p.roll}) no longer exists — this request is stale. Send it back or reject it.`);
  }
  const destClass = await client.classroom.findUnique({ where: { id: p.newClassId } });
  if (!destClass) {
    throw new Error("The destination class no longer exists — this request is stale. Send it back or reject it.");
  }
  if (!p.newIsLocal) {
    const room = p.newRoomId ? await client.hostelRoom.findUnique({ where: { id: p.newRoomId } }) : null;
    if (!room) {
      throw new Error("The destination room no longer exists — this request is stale. Send it back or reject it.");
    }
  }
  if (p.placeAfterStudentId) {
    const target = await client.student.findUnique({ where: { id: p.placeAfterStudentId } });
    if (!target || target.classId !== p.newClassId) {
      throw new Error("The student to place this after is no longer in the destination class — this request is stale. Send it back or reject it.");
    }
  }
}

// Re-validates a move_students_batch change inside the approval
// transaction: the destination class, every moving student, and each
// move's OWN resolved destination room (either a shared room every move in
// the batch points at, or that student's own kept room — see
// routes/studentMove.js's "keep current room/type" default) must all still
// exist. No position re-check — a batch always appends, so there's no
// placeAfterStudentId to go stale.
export async function revalidateBatchMoveForApproval(client, p) {
  const destClass = await client.classroom.findUnique({ where: { id: p.newClassId } });
  if (!destClass) {
    throw new Error("The destination class no longer exists — this request is stale. Send it back or reject it.");
  }
  const roomCache = new Map();
  for (const m of p.moves) {
    const student = await client.student.findUnique({ where: { id: m.studentId } });
    if (!student) {
      throw new Error(`A student in this batch (roll ${m.roll}) no longer exists — this request is stale. Send it back or reject it.`);
    }
    if (m.newRoomId) {
      if (!roomCache.has(m.newRoomId)) {
        roomCache.set(m.newRoomId, await client.hostelRoom.findUnique({ where: { id: m.newRoomId } }));
      }
      if (!roomCache.get(m.newRoomId)) {
        throw new Error(`The room for roll ${m.roll} no longer exists — this request is stale. Send it back or reject it.`);
      }
    }
  }
}