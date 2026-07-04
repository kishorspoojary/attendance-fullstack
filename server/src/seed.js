import "dotenv/config";
import bcrypt from "bcryptjs";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const DEMO_PASSWORD = "password123";

async function main() {
  console.log("Seeding demo data...");
  const passwordHash = await bcrypt.hash(DEMO_PASSWORD, 10);

  const floor1 = await prisma.floor.create({ data: { name: "Academic Floor 1" } });

  const class10A = await prisma.classroom.create({ data: { name: "Class 10-A", floorId: floor1.id } });
  const class10B = await prisma.classroom.create({ data: { name: "Class 10-B", floorId: floor1.id } });

  const rooms = {};
  for (const roomNo of ["101", "102", "103", "104"]) {
    rooms[roomNo] = await prisma.hostelRoom.create({ data: { hostel: "Hostel Block A", roomNo, floorId: floor1.id } });
  }

  await prisma.user.createMany({
    data: [
      { username: "principal", name: "Dr. Rao", role: "PRINCIPAL", passwordHash },
      { username: "ao", name: "Meera Nair", role: "AO", passwordHash },
      { username: "coordinator", name: "Arjun Iyer", role: "COORDINATOR", passwordHash },
      { username: "dbm", name: "Suresh Kumar", role: "DB_MANAGER", passwordHash },
      { username: "warden1", name: "Latha", role: "WARDEN", passwordHash, roomIds: [rooms["101"].id, rooms["102"].id, rooms["103"].id] },
      { username: "warden2", name: "Kumar", role: "WARDEN", passwordHash, roomIds: [rooms["104"].id] },
      { username: "do1", name: "Priya", role: "DO", passwordHash, floorIds: [floor1.id] },
      { username: "do2", name: "Vikram", role: "DO", passwordHash, floorIds: [floor1.id] },
      { username: "teacher1", name: "Anita", role: "INCHARGE_TEACHER", passwordHash, floorIds: [floor1.id] },
      { username: "teacher2", name: "Rakesh", role: "INCHARGE_TEACHER", passwordHash, floorIds: [floor1.id] },
      { username: "teacher3", name: "Divya", role: "INCHARGE_TEACHER", passwordHash, floorIds: [floor1.id], active: false },
      { username: "lai1", name: "Sneha", role: "LAI", passwordHash, classIds: [class10A.id] },
      { username: "lai2", name: "Farha", role: "LAI", passwordHash, classIds: [class10B.id] },
    ],
  });

  const students = [
    ["Rahul Verma", "10A-01", class10A.id, rooms["101"].id],
    ["Sanjay Gupta", "10A-02", class10A.id, rooms["101"].id],
    ["Kiran Shah", "10A-03", class10A.id, rooms["102"].id],
    ["Meena Joshi", "10A-04", class10A.id, null],
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

  console.log("Done. Every demo account's password is:", DEMO_PASSWORD);
  console.log("Usernames: principal, ao, coordinator, dbm, warden1, warden2, do1, do2, teacher1, teacher2, teacher3 (inactive), lai1, lai2");
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
