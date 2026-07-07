// The three sequential approval stages every daily attendance record moves
// through. AO does not approve daily attendance (only master-data changes
// and staff accounts) — so Coordinator is the final human stage; once they
// approve, the record is published straight to the Principal's report.
export const STAGES = [
  { key: "doApproved", role: "DO", label: "DO verified" },
  { key: "teacherApproved", role: "INCHARGE_TEACHER", label: "Incharge Teacher approved" },
  { key: "coordinatorApproved", role: "COORDINATOR", label: "Coordinator approved" },
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
