// ============================================================================
// A Warden is assigned to one or more HOSTEL FLOORS (User.floorIds, pooled —
// several Wardens can share one), responsible for every room on each floor
// they cover — see schema.prisma's IMPORTANT MODELING NOTE. Two call sites
// need "is this student one of mine": the absence-marking route in
// routes/attendance.js, and the mark-away/report-back routes in
// routes/students.js. Both resolve the student's room to its floor and
// check that floor against the Warden's floorIds — pulled out here so that
// resolution lives in exactly one place instead of being duplicated.
// ============================================================================
export async function isStudentOnWardensFloor(prisma, warden, student) {
  if (!student.roomId) return false; // day scholar — no room, so no floor, so never a Warden's responsibility
  const room = await prisma.hostelRoom.findUnique({ where: { id: student.roomId } });
  if (!room) return false;
  return (warden.floorIds || []).includes(room.hostelFloorId);
}
