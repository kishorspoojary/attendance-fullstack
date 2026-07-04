// ============================================================================
// What actually happens when an AO approves a PendingChange.
//
// The Database Manager never edits the real tables directly — every action
// (add a student, assign a Warden, etc.) first creates a PendingChange row
// with status "pending" (see routes/changes.js: POST /changes). Only once an
// AO approves it does this file run, translating the change's `type` and
// `payload` into a real write against the actual tables.
//
// Keeping this translation in one place (rather than scattered across
// routes) makes it easy to see, for any given change type, exactly what
// "approved" is going to do to the database.
// ============================================================================
export async function applyChange(prisma, change) {
  const p = change.payload; // the data the Database Manager submitted, shape depends on change.type

  switch (change.type) {
    case "add_student":
      await prisma.student.create({
        data: { name: p.name, roll: p.roll, classId: p.classId, roomId: p.roomId || null },
      });
      break;

    case "edit_student":
      // Only include fields the request actually wants to change — this
      // spread trick builds an object like { name: "New Name" } and skips
      // any key whose value is undefined, so untouched fields are left alone.
      await prisma.student.update({
        where: { id: p.studentId },
        data: {
          ...(p.changes.name !== undefined && { name: p.changes.name }),
          ...(p.changes.roll !== undefined && { roll: p.changes.roll }),
          ...(p.changes.classId !== undefined && { classId: p.changes.classId }),
          ...(p.changes.roomId !== undefined && { roomId: p.changes.roomId || null }),
        },
      });
      break;

    case "delete_student":
      await prisma.student.delete({ where: { id: p.studentId } });
      break;

    case "add_room":
      await prisma.hostelRoom.create({
        data: { hostel: p.hostel, roomNo: p.roomNo, floorId: p.floorId },
      });
      break;

    case "add_class":
      await prisma.classroom.create({ data: { name: p.name, floorId: p.floorId } });
      break;

    case "assign_warden":
      // Wardens can cover several rooms at once, so we just overwrite their
      // whole roomIds list with whatever the Database Manager selected.
      await prisma.user.update({ where: { id: p.staffId }, data: { roomIds: p.roomIds } });
      break;

    case "assign_do":
    case "assign_teacher":
      // DOs and Incharge Teachers are "pooled" per floor — several staff can
      // share the same floorIds, and any one of them can act on a class there.
      await prisma.user.update({ where: { id: p.staffId }, data: { floorIds: p.floorIds } });
      break;

    case "assign_lai":
      await prisma.user.update({ where: { id: p.staffId }, data: { classIds: p.classIds } });
      break;

    case "activate_staff":
      // Field-staff accounts (Warden/DO/Teacher/LAI) start locked (active:
      // false) until the Database Manager requests activation and the AO
      // approves it — see routes/index.js's login check for the other half
      // of this rule.
      await prisma.user.update({ where: { id: p.staffId }, data: { active: true } });
      break;

    default:
      // Should never happen unless the frontend sends a type we don't
      // recognize — fail loudly rather than silently doing nothing.
      throw new Error(`Unknown change type: ${change.type}`);
  }
}
