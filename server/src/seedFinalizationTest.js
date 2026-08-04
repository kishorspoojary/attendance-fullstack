// ============================================================================
// Test fixture for exercising the Warden floor-finalization feature (see
// schema.prisma's WardenFinalization model and routes/attendance.js's
// unfinalizedFloorsForClass) — specifically the case that motivated it: one
// classroom whose hostellers are spread across more than one hostel floor,
// including a floor with no Warden assigned at all.
//
// Additive only — never deletes or modifies anything that already exists.
// Safe to run against a real dev database alongside real data; refuses to
// run twice (see the guard below) rather than silently creating duplicates.
//
// Creates:
//   1 college floor  — "Test College Floor"
//   1 class          — "Test Class F1" (in the college floor above)
//   1 hostel         — "Test Hostel"
//   3 hostel floors  — "Test Hostel Floor A", "Test Hostel Floor B",
//                       "Test Hostel Floor C (no Warden)"
//   3 hostel rooms    — one per hostel floor above
//   5 students in Test Class F1:
//     - 2 in Floor A's room (hostellers)
//     - 1 in Floor B's room (hostellers)
//     - 1 in Floor C's room (hosteller, but Floor C has no Warden —
//       exercises the "vacuously finalized" rule)
//     - 1 day scholar (roomId: null)
// All roll numbers are prefixed TEST- so they can never collide with a real
// student's globally-unique roll (see schema.prisma's comment on
// Student.roll).
//
// Deliberately creates NO user accounts — see server/src/createTestStaff.js
// for the Warden/DO/Lecturer accounts needed to actually exercise this
// fixture, created through the real Database Manager -> AO approval flow.
// ============================================================================
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const COLLEGE_FLOOR_NAME = "Test College Floor";

async function main() {
  console.log("Seeding the finalization-test fixture...");

  const existing = await prisma.collegeFloor.findFirst({ where: { name: COLLEGE_FLOOR_NAME } });
  if (existing) {
    throw new Error(
      `"${COLLEGE_FLOOR_NAME}" already exists (id ${existing.id}) — this script is additive-only and refuses to run twice. ` +
      "Remove the existing fixture by hand first if you want a fresh one (see the cleanup order this script prints on success)."
    );
  }

  const collegeFloor = await prisma.collegeFloor.create({ data: { name: COLLEGE_FLOOR_NAME } });
  const classroom = await prisma.classroom.create({ data: { name: "Test Class F1", collegeFloorId: collegeFloor.id } });

  const hostel = await prisma.hostel.create({ data: { name: "Test Hostel" } });
  const floorA = await prisma.hostelFloor.create({ data: { name: "Test Hostel Floor A", hostelId: hostel.id } });
  const floorB = await prisma.hostelFloor.create({ data: { name: "Test Hostel Floor B", hostelId: hostel.id } });
  const floorC = await prisma.hostelFloor.create({ data: { name: "Test Hostel Floor C (no Warden)", hostelId: hostel.id } });

  const roomA = await prisma.hostelRoom.create({ data: { roomNo: "TEST-A1", hostelFloorId: floorA.id } });
  const roomB = await prisma.hostelRoom.create({ data: { roomNo: "TEST-B1", hostelFloorId: floorB.id } });
  const roomC = await prisma.hostelRoom.create({ data: { roomNo: "TEST-C1", hostelFloorId: floorC.id } });

  const studentDefs = [
    ["Test Student A1", "TEST-001", roomA.id],
    ["Test Student A2", "TEST-002", roomA.id],
    ["Test Student B1", "TEST-003", roomB.id],
    ["Test Student C1", "TEST-004", roomC.id],
    ["Test Student Day Scholar", "TEST-005", null],
  ];
  await prisma.student.createMany({
    data: studentDefs.map(([name, roll, roomId]) => ({ name, roll, classId: classroom.id, roomId, isLocal: !roomId })),
  });

  console.log("\nDone. Created:");
  console.log(`  College floor: ${collegeFloor.name} (${collegeFloor.id})`);
  console.log(`  Class:         ${classroom.name} (${classroom.id})`);
  console.log(`  Hostel:        ${hostel.name} (${hostel.id})`);
  console.log(`  Hostel floors: ${floorA.name} (${floorA.id})`);
  console.log(`                 ${floorB.name} (${floorB.id})`);
  console.log(`                 ${floorC.name} (${floorC.id}) — leave this one Warden-less on purpose`);
  console.log(`  Hostel rooms:  ${roomA.roomNo} on Floor A, ${roomB.roomNo} on Floor B, ${roomC.roomNo} on Floor C`);
  console.log("  Students:");
  for (const [name, roll, roomId] of studentDefs) {
    console.log(`    ${name} (${roll}) — ${roomId ? "hosteller" : "day scholar"}`);
  }

  console.log("\nNext: run `node src/createTestStaff.js` (from server/) to create the Warden/DO/Lecturer accounts");
  console.log("needed to actually exercise this fixture.");

  console.log("\nCleanup order, if you remove this fixture by hand — foreign keys restrict deleting a parent while");
  console.log("children still reference it, so it must go in this order:");
  console.log("  1. Students (TEST-001..TEST-005)");
  console.log("  2. Class (Test Class F1)");
  console.log("  3. College floor (Test College Floor)");
  console.log("  4. Hostel rooms (TEST-A1, TEST-B1, TEST-C1)");
  console.log("  5. Hostel floors (Test Hostel Floor A/B/C)");
  console.log("  6. Hostel (Test Hostel)");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
