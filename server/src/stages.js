// The four sequential approval stages every daily attendance record moves through.
export const STAGES = [
  { key: "doApproved", role: "DO", label: "DO verified" },
  { key: "teacherApproved", role: "INCHARGE_TEACHER", label: "Incharge Teacher approved" },
  { key: "coordinatorApproved", role: "COORDINATOR", label: "Coordinator approved" },
  { key: "aoApproved", role: "AO", label: "AO approved" },
];

export function currentStageIndex(record) {
  for (let i = 0; i < STAGES.length; i++) if (!record[STAGES[i].key]) return i;
  return STAGES.length;
}
