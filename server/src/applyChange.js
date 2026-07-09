// ============================================================================
// What actually happens when an AO approves a PendingChange.
//
// The Database Manager never edits the real tables directly — every action
// (add a student, create a staff account, etc.) first creates a
// PendingChange row with status "pending" (see routes/changes.js). Only once
// an AO approves it does this file run, translating the change's `type` and
// `payload` into a real write against the actual tables.
// ============================================================================
import bcrypt from "bcryptjs";
import { DEFAULT_PASSWORD } from "./constants.js";

export async function applyChange(prisma, change) {
  const p = change.payload; // the data the Database Manager submitted, shape depends on change.type

  switch (change.type) {
    case "add_student":
      await prisma.student.create({
        data: {
          name: p.name, roll: p.roll, classId: p.classId, roomId: p.roomId || null,
          // Explicit tag wins if the Database Manager set one; otherwise
          // infer it from whether a hostel room was given.
          isLocal: p.isLocal !== undefined ? p.isLocal : !p.roomId,
        },
      });
      break;

    // One Excel upload becomes one PendingChange with an array of rows,
    // rather than one PendingChange per student — otherwise a 200-row
    // spreadsheet would mean 200 separate things for an AO to click through.
    case "bulk_add_students":
      await prisma.student.createMany({
        data: p.students.map((s) => ({
          name: s.name, roll: s.roll, classId: s.classId, roomId: s.roomId || null,
          isLocal: s.isLocal !== undefined ? s.isLocal : !s.roomId,
        })),
      });
      break;

    case "edit_student":
      await prisma.student.update({
        where: { id: p.studentId },
        data: {
          ...(p.changes.name !== undefined && { name: p.changes.name }),
          ...(p.changes.roll !== undefined && { roll: p.changes.roll }),
          ...(p.changes.classId !== undefined && { classId: p.changes.classId }),
          ...(p.changes.roomId !== undefined && { roomId: p.changes.roomId || null }),
          ...(p.changes.isLocal !== undefined && { isLocal: p.changes.isLocal }),
        },
      });
      break;

    case "delete_student":
      await prisma.student.delete({ where: { id: p.studentId } });
      break;

    case "add_hostel":
      await prisma.hostel.create({ data: { name: p.name } });
      break;

    case "add_hostel_floor":
      await prisma.hostelFloor.create({ data: { name: p.name, hostelId: p.hostelId } });
      break;

    case "add_room":
      await prisma.hostelRoom.create({ data: { roomNo: p.roomNo, hostelFloorId: p.hostelFloorId } });
      break;

    case "add_college_floor":
      await prisma.collegeFloor.create({ data: { name: p.name } });
      break;

    case "add_class":
      await prisma.classroom.create({ data: { name: p.name, collegeFloorId: p.collegeFloorId } });
      break;

    case "assign_warden":
      // Wardens can cover several rooms at once, so we just overwrite their
      // whole roomIds list with whatever the Database Manager selected.
      await prisma.user.update({ where: { id: p.staffId }, data: { roomIds: p.roomIds } });
      break;

    case "assign_do":
    case "assign_teacher":
      // DOs and Incharge Teachers are "pooled" per CollegeFloor — several
      // staff can share the same floorIds, and any one of them can act.
      await prisma.user.update({ where: { id: p.staffId }, data: { floorIds: p.floorIds } });
      break;

    case "assign_lai":
      await prisma.user.update({ where: { id: p.staffId }, data: { classIds: p.classIds } });
      break;

    // Creates a brand-new Warden/LAI/DO/Incharge Teacher account. The login
    // key was already generated back when the Database Manager proposed
    // this (see routes/changes.js) — never here, so the same key that was
    // shown then is the one that actually ends up on the account.
    case "create_staff": {
      const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 10);
      await prisma.user.create({
        data: {
          name: p.name,
          role: p.role,
          loginKey: p.loginKey,
          passwordHash,
          status: "ACTIVE",
          mustChangePassword: true,
          roomIds: p.roomIds || [],
          floorIds: p.floorIds || [],
          classIds: p.classIds || [],
        },
      });
      break;
    }

    default:
      // Should never happen unless the frontend sends a type we don't
      // recognize — fail loudly rather than silently doing nothing.
      throw new Error(`Unknown change type: ${change.type}`);
  }
}
