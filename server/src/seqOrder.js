// ============================================================================
// Student.seq assignment — shared by every change type that needs to
// reorder a class's roster: sync_class_students (routes/excel.js's roster
// upload) and move_student/move_students_batch (routes/studentMove.js).
// Extracted here instead of duplicating the "walk an ordered list, assign
// 1..N" loop in each — see schema.prisma's comment on Student.seq for why a
// plain 1..N reassignment (ordered within a class, not globally unique or
// continuous) is sufficient.
// ============================================================================

// Pure: [id1, id2, ...] -> [{id: id1, seq: 1}, {id: id2, seq: 2}, ...].
export function computeSeqAssignments(orderedStudentIds) {
  return orderedStudentIds.map((id, i) => ({ id, seq: i + 1 }));
}

// Writes the assignments — always inside an approval transaction (`tx`).
export async function applySeqAssignments(tx, assignments) {
  for (const { id, seq } of assignments) {
    await tx.student.update({ where: { id }, data: { seq } });
  }
}

// Pure: where does `movingId` land in `existingOrderedIds` — the
// destination class's current order, WITHOUT movingId even if it was
// already a member (callers filter that out first, since a same-class
// reorder needs to remove-then-reinsert rather than leave a stale entry
// behind)? `placeAfterStudentId` falsy + not placeAtEnd means "at the top".
// Returns null if placeAfterStudentId is truthy but doesn't resolve within
// existingOrderedIds — signals "stale", which callers turn into the
// standard stale-request error rather than silently falling back to
// appending (per the spec: never guess when a position target vanished).
export function computeSingleMoveOrder(existingOrderedIds, movingId, placeAfterStudentId, placeAtEnd) {
  let insertIndex;
  if (placeAtEnd) {
    insertIndex = existingOrderedIds.length;
  } else if (!placeAfterStudentId) {
    insertIndex = 0;
  } else {
    const idx = existingOrderedIds.indexOf(placeAfterStudentId);
    if (idx === -1) return null;
    insertIndex = idx + 1;
  }
  return [...existingOrderedIds.slice(0, insertIndex), movingId, ...existingOrderedIds.slice(insertIndex)];
}
