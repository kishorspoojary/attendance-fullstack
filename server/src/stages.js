// The two sequential approval stages every daily attendance record moves
// through. AO does not approve daily attendance (only master-data changes
// and staff accounts), and Coordinator no longer does either — Coordinator
// is now an institution-wide observer only (still owns the deadline cutoff,
// which force-publishes anything left incomplete, but doesn't sign off on
// individual classes). Lecturer is the final human stage; once they
// approve, the record is published straight to the Principal's report —
// "published" means teacherApproved is truthy (or forcedPublish is true).
//
// AttendanceRecord.coordinatorApproved still exists as a real column —
// deliberately not dropped, since it's genuine historical data for records
// approved under the old three-stage pipeline — but it's no longer part of
// STAGES and nothing in the live pipeline reads or writes it anymore. Old
// records that have it set also always have teacherApproved set (Coordinator
// could only ever approve after Lecturer had, under the old priorStageKey
// gating), so they still read as correctly published under the new
// definition without any backfill needed.
export const STAGES = [
  { key: "doApproved", role: "DO", label: "DO verified" },
  { key: "teacherApproved", role: "LECTURER", label: "Lecturer approved" },
];

export function currentStageIndex(record) {
  for (let i = 0; i < STAGES.length; i++) if (!record[STAGES[i].key]) return i;
  return STAGES.length;
}

// Given a stage's key, what's the one right before it (or null for the
// first stage)? Used both by the normal approve flow (you can't approve
// until the prior stage has) and by send-back (which un-does exactly one
// stage, never more).
export function priorStageKey(stageKey) {
  const idx = STAGES.findIndex((s) => s.key === stageKey);
  return idx > 0 ? STAGES[idx - 1].key : null;
}

export function nextStageKey(stageKey) {
  const idx = STAGES.findIndex((s) => s.key === stageKey);
  return idx >= 0 && idx < STAGES.length - 1 ? STAGES[idx + 1].key : null;
}
