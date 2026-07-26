// ============================================================================
// One-off SAFETY CHECK, run before switching roll-number uniqueness from
// per-class to global (whole college): does any roll number currently
// appear on more than one student, REGARDLESS of class, case-insensitive
// and trimmed? Read-only — prints a report, never deletes or changes
// anything. Must be run (and come back clean) before adding a DB-level
// UNIQUE constraint on Student.roll — a straight ALTER TABLE would simply
// fail if any collision like this still exists.
//
// Also flags, within each colliding group, whether the raw (non-normalized)
// roll strings are byte-identical or differ only by case/whitespace — that
// distinction is what decides whether a plain `@unique` on roll is enough,
// or whether the data needs case/whitespace normalization first (see the
// migration this report is gating).
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

  const groups = new Map(); // normalized roll -> Student[]
  for (const s of students) {
    const key = norm(s.roll);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(s);
  }

  const duplicateGroups = [...groups.values()].filter((g) => g.length > 1);

  console.log(`Checked ${students.length} student(s) across ${classes.length} class(es) for GLOBAL roll collisions (any class, case-insensitive, trimmed).\n`);

  if (duplicateGroups.length === 0) {
    console.log("No global roll collisions found. Safe to proceed with a database-level UNIQUE constraint on Student.roll.");
    return;
  }

  let exactMatchGroups = 0;
  let caseOrWhitespaceOnlyGroups = 0;

  console.log(`Found ${duplicateGroups.length} colliding roll group(s) — ${duplicateGroups.reduce((n, g) => n + g.length, 0)} student rows total:\n`);
  for (const group of duplicateGroups) {
    const rawRolls = new Set(group.map((s) => s.roll));
    const sameAcrossClasses = new Set(group.map((s) => s.classId)).size > 1;
    if (rawRolls.size === 1) exactMatchGroups++;
    else caseOrWhitespaceOnlyGroups++;

    console.log(`Roll "${group[0].roll}" (normalized: "${norm(group[0].roll)}")${sameAcrossClasses ? " — SPANS MULTIPLE CLASSES" : " — same class"}${rawRolls.size > 1 ? " — raw values differ by case/whitespace only" : ""}:`);
    for (const s of group) {
      const className = classNameById[s.classId] || "(unknown class)";
      console.log(`  id=${s.id}  seq=${s.seq}  class="${className}"  name="${s.name}"  roll="${s.roll}"`);
    }
    console.log("");
  }

  console.log(`Summary: ${exactMatchGroups} group(s) are byte-identical duplicates, ${caseOrWhitespaceOnlyGroups} group(s) differ only by case/whitespace.`);
  console.log("\nSTOP: do not add a database-level UNIQUE constraint until these are resolved by hand (Students admin page or Prisma Studio) — an ALTER TABLE would fail with rows like these still present. Nothing was changed by this script.");
  process.exitCode = 1;
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());