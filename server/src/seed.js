// ============================================================================
// Optional starter data: one hostel (with a floor and rooms), one college
// floor (with two classes), and a dozen students — so there's something to
// actually test the daily attendance workflow against.
//
// Deliberately creates NO user accounts. Every account in this app now
// comes from the real onboarding flow instead:
//   1. Register as Principal (POST /api/auth/register-principal, or the
//      app's own registration screen).
//   2. Log in as Principal and create the AO / Coordinator / Database
//      Manager accounts ("activate the system").
//   3. Log in as Database Manager, create Warden / LAI / DO / Incharge
//      Teacher accounts — each needs AO approval before it can log in.
// Seeding fake users would just let you skip testing that real flow, which
// defeats the point of building it. Run this script (`npm run seed`) any
// time after step 3 above, once you have a Database Manager account, to
// avoid manually creating a dozen students by hand while you're testing.
// ============================================================================
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  console.log("Seeding starter hostel/college structure and students...");

  const hostel = await prisma.hostel.create({ data: { name: "Hostel Block A" } });
  const hostelFloor1 = await prisma.hostelFloor.create({ data: { name: "Hostel Floor 1", hostelId: hostel.id } });

  const rooms = {};
  for (const roomNo of ["101", "102", "103", "104"]) {
    rooms[roomNo] = await prisma.hostelRoom.create({ data: { roomNo, hostelFloorId: hostelFloor1.id } });
  }

  const collegeFloor1 = await prisma.collegeFloor.create({ data: { name: "Academic Floor 1" } });
  const class10A = await prisma.classroom.create({ data: { name: "Class 10-A", collegeFloorId: collegeFloor1.id } });
  const class10B = await prisma.classroom.create({ data: { name: "Class 10-B", collegeFloorId: collegeFloor1.id } });

  const students = [
    ["Rahul Verma", "10A-01", class10A.id, rooms["101"].id],
    ["Sanjay Gupta", "10A-02", class10A.id, rooms["101"].id],
    ["Kiran Shah", "10A-03", class10A.id, rooms["102"].id],
    ["Meena Joshi", "10A-04", class10A.id, null], // null roomId = day scholar, no hostel room
    ["Aisha Khan", "10A-05", class10A.id, rooms["103"].id],
    ["Ravi Teja", "10A-06", class10A.id, null],
    ["Neha Reddy", "10B-01", class10B.id, rooms["104"].id],
    ["Dev Anand", "10B-02", class10B.id, rooms["104"].id],
    ["Priyanka Rao", "10B-03", class10B.id, null],
    ["Amit Sharma", "10B-04", class10B.id, rooms["102"].id],
    ["Sonia Mehta", "10B-05", class10B.id, null],
    ["Vikas Nair", "10B-06", class10B.id, rooms["103"].id],
  ];
  await prisma.student.createMany({
    data: students.map(([name, roll, classId, roomId]) => ({ name, roll, classId, roomId })),
  });

  console.log("Done. Created: 1 hostel, 1 hostel floor, 4 rooms, 1 college floor, 2 classes, 12 students.");
  console.log("Next: register as Principal, create leadership accounts, then create/approve staff accounts to actually log in as anyone.");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
