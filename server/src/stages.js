// ============================================================================
// The four approval stages every AttendanceRecord moves through, in order:
// Discipline Officer → Incharge Teacher → Coordinator → AO.
//
// We keep this list in one place because several files need to agree on the
// order and the field names: routes/attendance.js (to check "has the
// previous stage happened yet?"), and the frontend (to render progress).
// ============================================================================

export const STAGES = [
  { key: "doApproved", role: "DO", label: "DO verified" },
  { key: "teacherApproved", role: "INCHARGE_TEACHER", label: "Incharge Teacher approved" },
  { key: "coordinatorApproved", role: "COORDINATOR", label: "Coordinator approved" },
  { key: "aoApproved", role: "AO", label: "AO approved" },
];

// Finds how far a record has progressed: returns 0 if nothing's approved
// yet (waiting on the DO), 1 if DO is done but Teacher isn't, and so on.
// Returns STAGES.length (4) once every stage is complete.
export function currentStageIndex(record) {
  for (let i = 0; i < STAGES.length; i++) if (!record[STAGES[i].key]) return i;
  return STAGES.length;
}
