// Applies a PendingChange's payload to the actual tables once the AO approves it.
// Keeping this in one place mirrors the "two-person control" rule: nothing here
// runs until routes/changes.js calls it after an AO approval.
export async function applyChange(prisma, change) {
  const p = change.payload;
  switch (change.type) {
    case "add_student":
      await prisma.student.create({
        data: { name: p.name, roll: p.roll, classId: p.classId, roomId: p.roomId || null },
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
      await prisma.user.update({ where: { id: p.staffId }, data: { roomIds: p.roomIds } });
      break;

    case "assign_do":
    case "assign_teacher":
      await prisma.user.update({ where: { id: p.staffId }, data: { floorIds: p.floorIds } });
      break;

    case "assign_lai":
      await prisma.user.update({ where: { id: p.staffId }, data: { classIds: p.classIds } });
      break;

    case "activate_staff":
      await prisma.user.update({ where: { id: p.staffId }, data: { active: true } });
      break;

    default:
      throw new Error(`Unknown change type: ${change.type}`);
  }
}
