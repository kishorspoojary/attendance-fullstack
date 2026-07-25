// ============================================================================
// One-off report: existing students that share a class and a normalized
// roll number (case-insensitive, trimmed — same normalization as
// validateImportRows and studentApproval.js). Read-only — prints a report,
// never deletes anything. Run with `npm run report-duplicates` after
// deploying the stale-batch fix (applyChange.js / studentApproval.js), to
// find whatever duplicates the bug already let through so they can be
// removed by hand from the Students admin page.
// ============================================================================
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const norm = (s) => String(s ?? "").trim().toLowerCase();

async function main() {
  const [students, classes] = await Promise.all([
    prisma.student.findMany({ orderBy: { seq: "asc" } }),
    prisma.classroom.findMany(),
  ]);
  const classNameById = Object.fromEntries(classes.map((c) => [c.id, c.name]));

  const groups = new Map(); // "classId::normalizedRoll" -> Student[]
  for (const s of students) {
    const key = `${s.classId}::${norm(s.roll)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  const duplicateGroups = [...groups.values()].filter((g) => g.length > 1);

  if (duplicateGroups.length === 0) {
    console.log("No duplicate students found (same class + same roll number, case-insensitive).");
    return;
  }

  console.log(`Found ${duplicateGroups.length} duplicate group(s) — ${duplicateGroups.reduce((n, g) => n + g.length, 0)} student rows total:\n`);
  for (const group of duplicateGroups) {
    const className = classNameById[group[0].classId] || "(unknown class)";
    console.log(`Class "${className}", roll "${group[0].roll}":`);
    for (const s of group) {
      console.log(`  id=${s.id}  seq=${s.seq}  name="${s.name}"  roll="${s.roll}"  isLocal=${s.isLocal}  roomId=${s.roomId ?? "null"}`);
    }
    console.log("");
  }
  console.log("Nothing was deleted — remove the wrong rows by hand from the Students admin page (or via Prisma Studio) once you've picked which of each pair to keep.");
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());