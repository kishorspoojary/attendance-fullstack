// ============================================================================
// A Warden is assigned to one or more HOSTEL FLOORS (User.floorIds, pooled —
// several Wardens can share one), responsible for every room on each floor
// they cover — see schema.prisma's IMPORTANT MODELING NOTE. Two jobs need
// "which hostel floor is this student on": the absence-marking and finalize
// routes in routes/attendance.js, and the mark-away/report-back routes in
// routes/students.js. Both resolve the student's room to its floor —
// pulled out here so that resolution lives in exactly one place instead of
// being duplicated.
// ============================================================================
export async function resolveStudentHostelFloorId(prisma, student) {
  if (!student.roomId) return null; // day scholar — no room, so no floor, so never a Warden's responsibility
  const room = await prisma.hostelRoom.findUnique({ where: { id: student.roomId } });
  return room?.hostelFloorId ?? null;
}

export async function isStudentOnWardensFloor(prisma, warden, student) {
  const floorId = await resolveStudentHostelFloorId(prisma, student);
  if (!floorId) return false;
  return (warden.floorIds || []).includes(floorId);
}
