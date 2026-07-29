// ============================================================================
// Read-only staff directory: who works here, what role, and what are they
// responsible for. Distinct from Leadership Accounts (routes/users.js),
// which is account ADMINISTRATION (freeze/reset/offboard) for leadership
// roles only — this is assignment VISIBILITY for field roles, plus
// leadership shown for completeness. No mutations, no actions; a single GET.
//
// The assignment shape per role, and the one deliberate simplification in
// each: Warden.roomIds is the real, room-level assignment field (see
// schema.prisma's own "Wardens are assigned directly to HostelRooms, not to
// a HostelFloor" note) — this directory groups those rooms BY FLOOR for
// display, showing the floor's full student count wherever a Warden covers
// at least one room there, rather than listing every individual room. LAI's
// classIds is real per-person scoping too, but every LAI here is shown with
// the SAME college-wide day-scholar count regardless of their classIds —
// pooled LAI coverage is treated as one shared duty for directory purposes,
// not a per-person breakdown. Both are display simplifications on top of
// the real underlying fields, not a claim that the fields themselves
// changed shape.
// ============================================================================
import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth, requireRole } from "../auth.js";
import { FIELD_STAFF_ROLES } from "../constants.js";

export const staffDirectoryRouter = Router();

function baseFields(u) {
  return { id: u.id, name: u.name, loginKey: u.loginKey, status: u.status };
}

// Warden -> their assigned rooms' floors, deduped, each with that floor's
// full student count. `roomToFloor` is a Map roomId -> {id, name}; `floorCounts`
// is a Map floorId -> student count (both built once by the route, from one
// query each, and reused across every Warden rather than re-queried per row).
export function shapeWardens(wardens, roomToFloor, floorCounts) {
  return wardens.map((w) => {
    const roomIds = Array.isArray(w.roomIds) ? w.roomIds : [];
    const floorsById = new Map();
    for (const roomId of roomIds) {
      const floor = roomToFloor.get(roomId);
      if (floor && !floorsById.has(floor.id)) {
        floorsById.set(floor.id, { id: floor.id, name: floor.name, count: floorCounts.get(floor.id) || 0 });
      }
    }
    const floors = [...floorsById.values()].sort((a, b) => a.name.localeCompare(b.name));
    return {
      ...baseFields(w),
      assignmentStatus: floors.length > 0 ? "assigned" : "none",
      floors,
      totalCount: floors.reduce((n, f) => n + f.count, 0),
    };
  });
}

// DO / Lecturer -> their assigned college floors, each with that floor's
// student count (sum across every class on it). `floorLookup` is a Map
// collegeFloorId -> {id, name, count}.
export function shapeCollegeFloorStaff(users, floorLookup) {
  return users.map((u) => {
    const floorIds = Array.isArray(u.floorIds) ? u.floorIds : [];
    const floors = floorIds.map((fid) => floorLookup.get(fid)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
    return {
      ...baseFields(u),
      assignmentStatus: floors.length > 0 ? "assigned" : "none",
      floors,
      totalCount: floors.reduce((n, f) => n + f.count, 0),
    };
  });
}

// LAI -> the one shared college-wide day-scholar count, same number for
// every LAI (see the file-level comment on why this ignores classIds).
export function shapeLais(lais, dayScholarCount) {
  return lais.map((u) => ({ ...baseFields(u), assignmentStatus: "assigned", dayScholarCount }));
}

export function shapeLeadership(users) {
  return users.map((u) => ({ ...baseFields(u), role: u.role }));
}

// The response-shape decision itself, as a pure function over already-
// fetched rows — split out from the route so "Coordinator gets ONLY
// {lecturers}, nothing else" has a direct test that doesn't need a live DB
// or an HTTP round-trip, same reasoning as buildEditedChangePayload in
// routes/changes.js and diffAndValidateRoster in routes/excel.js.
export function buildStaffDirectoryResponse(role, { staff, roomToFloor, floorCounts, dayScholarCount, collegeFloorLookup }) {
  const byRole = (r) => staff.filter((s) => s.role === r);

  if (role === "COORDINATOR") {
    return { lecturers: shapeCollegeFloorStaff(byRole("LECTURER"), collegeFloorLookup) };
  }

  return {
    wardens: shapeWardens(byRole("WARDEN"), roomToFloor, floorCounts),
    lais: shapeLais(byRole("LAI"), dayScholarCount),
    dos: shapeCollegeFloorStaff(byRole("DO"), collegeFloorLookup),
    lecturers: shapeCollegeFloorStaff(byRole("LECTURER"), collegeFloorLookup),
    // Fixed institutional roles (Principal + everything in LEADERSHIP_ROLES)
    // have no assignment concept — shown for completeness, never flagged
    // "unassigned" (that styling means something different: a field-role
    // account with genuinely nothing assigned). Derived by exclusion from
    // FIELD_STAFF_ROLES rather than a separate hardcoded list, so this can't
    // drift if a field role is ever added.
    leadership: shapeLeadership(staff.filter((s) => !FIELD_STAFF_ROLES.includes(s.role))),
  };
}

staffDirectoryRouter.get("/staff-directory", requireAuth, requireRole("AO", "PRINCIPAL", "COORDINATOR"), async (req, res) => {
  const collegeFloors = await prisma.collegeFloor.findMany({
    include: { classrooms: { include: { _count: { select: { students: true } } } } },
  });
  const collegeFloorLookup = new Map(collegeFloors.map((f) => [
    f.id,
    { id: f.id, name: f.name, count: f.classrooms.reduce((n, c) => n + c._count.students, 0) },
  ]));

  // Coordinator only ever needs Lecturers, so skip fetching everything else
  // this role can't see — the actual access enforcement is
  // buildStaffDirectoryResponse's role branch below, this is just avoiding
  // pointless queries for data that would be thrown away.
  if (req.user.role === "COORDINATOR") {
    const staff = await prisma.user.findMany({ where: { role: "LECTURER" }, orderBy: { name: "asc" } });
    return res.json(buildStaffDirectoryResponse("COORDINATOR", { staff, collegeFloorLookup }));
  }

  const [staff, hostelRooms, dayScholarCount] = await Promise.all([
    prisma.user.findMany({ orderBy: { name: "asc" } }),
    prisma.hostelRoom.findMany({ include: { hostelFloor: true, _count: { select: { students: true } } } }),
    prisma.student.count({ where: { roomId: null } }),
  ]);

  const roomToFloor = new Map(hostelRooms.map((r) => [r.id, { id: r.hostelFloorId, name: r.hostelFloor.name }]));
  const floorCounts = new Map();
  for (const r of hostelRooms) floorCounts.set(r.hostelFloorId, (floorCounts.get(r.hostelFloorId) || 0) + r._count.students);

  res.json(buildStaffDirectoryResponse(req.user.role, { staff, roomToFloor, floorCounts, dayScholarCount, collegeFloorLookup }));
});
