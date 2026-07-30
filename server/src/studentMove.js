// ============================================================================
// Pure logic for student moves (change class / hostel room / day-scholar
// status / roster position, in any combination) — split out from
// routes/studentMove.js so the risky bits (no-op detection, summary text)
// have a direct test without a live DB, same pattern as
// server/src/routes/excel.js's diffAndValidateRoster.
//
// Roll numbers are globally unique and NEVER change on a move (see
// schema.prisma's comment on Student.roll), so none of the roll-collision
// machinery elsewhere in this project is relevant here — a move can never
// create a roll clash by construction.
// ============================================================================

function arraysEqual(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// A single move is a no-op if class, room/day-scholar status, AND the
// resulting roster position are ALL unchanged — reject it rather than
// creating a PendingChange that would approve into literally nothing
// happening. `currentOrderedIds`/`newOrder` already encode position: if the
// class is changing, the moving student was never in `currentOrderedIds`
// (the destination class's current order) to begin with, so the two arrays
// can never come out equal — this function doesn't need a separate
// "did the class change" fast path for that case, the array comparison
// already covers it.
export function isMoveNoOp({ oldClassId, newClassId, oldRoomId, newRoomId, oldIsLocal, newIsLocal, currentOrderedIds, newOrder }) {
  const fieldsChanged = oldClassId !== newClassId || (oldRoomId || null) !== (newRoomId || null) || oldIsLocal !== newIsLocal;
  if (fieldsChanged) return false;
  return arraysEqual(currentOrderedIds, newOrder);
}

// A batch move (always appends, no per-student position choice) is a no-op
// only if EVERY student's class/room/day-scholar status already matches
// their OWN resolved destination (each move already carries its own
// newRoomId/newIsLocal — either a shared value the Database Manager picked
// for the whole batch, or that student's own current room/type kept as-is;
// see routes/studentMove.js) AND appending them in the given order wouldn't
// actually change the destination class's final order either.
export function isBatchMoveNoOp(moves, newClassId, currentOrderedIds, newOrder) {
  const allFieldsUnchanged = moves.every((m) => m.oldClassId === newClassId && (m.oldRoomId || null) === (m.newRoomId || null) && m.oldIsLocal === m.newIsLocal);
  if (!allFieldsUnchanged) return false;
  return arraysEqual(currentOrderedIds, newOrder);
}

// "Boys Hostel A - 101" for a hosteller, "Day scholar" for a day scholar —
// the one shared label format used in both the summary text below and
// (independently, resolved client-side from state) the AO card. `room`/
// `hostel` are already-fetched objects (or null/undefined), never ids —
// this function does no DB work itself.
export function formatRoomOrDayLabel(isLocal, room, hostel) {
  if (isLocal) return "Day scholar";
  if (!room) return "?";
  return `${hostel?.name || "?"} - ${room.roomNo}`;
}

// The compact PendingChange.summary line — only mentions dimensions that
// actually changed; "position updated" covers the pure-reorder case where
// class/room/type all stay the same but placeAfterStudentId/placeAtEnd
// still made this a real, non-no-op move.
export function buildMoveSummary({ studentName, roll, classChanged, oldClassName, newClassName, roomChanged, oldRoomOrDayLabel, newRoomOrDayLabel }) {
  const parts = [];
  if (classChanged) parts.push(`${oldClassName} -> ${newClassName}`);
  if (roomChanged) parts.push(`${oldRoomOrDayLabel} -> ${newRoomOrDayLabel}`);
  const detail = parts.length > 0 ? parts.join(", ") : "position updated";
  return `Move ${studentName} (${roll}): ${detail}`;
}

// `changingRoomForAll` is whether the Database Manager explicitly picked a
// shared hostel/room or "day scholar" for the whole batch, vs. the default
// of leaving each student's own room/type alone (only classId changes) —
// only mentioned in the summary when it's actually happening, same
// only-mention-what-changed convention as buildMoveSummary/buildSyncSummary.
export function buildBatchMoveSummary(oldClassNames, newClassName, count, changingRoomForAll, sharedRoomOrDayLabel) {
  // oldClassNames: array of each moving student's source class name —
  // usually all the same (a batch move is proposed FROM one class group
  // header), but nothing stops the payload from spanning several.
  const uniqueOld = [...new Set(oldClassNames)];
  const fromLabel = uniqueOld.length === 1 ? uniqueOld[0] : `${uniqueOld.length} classes`;
  let text = `Move ${count} student${count === 1 ? "" : "s"}: ${fromLabel} -> ${newClassName}`;
  if (changingRoomForAll) text += ` (all -> ${sharedRoomOrDayLabel})`;
  return text;
}
