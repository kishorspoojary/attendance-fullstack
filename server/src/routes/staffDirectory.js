// ============================================================================
// Read-only staff directory: who works here, what role, and what are they
// responsible for. Distinct from Leadership Accounts (routes/users.js),
// which is account ADMINISTRATION (freeze/reset/offboard) for leadership
// roles only — this is assignment VISIBILITY for field roles, plus
// leadership shown for completeness. No mutations, no actions; a single GET.
//
// Warden and DO/Lecturer now share the exact same assignment shape —
// floorIds -> floors with a student count each — ever since Warden
// assignment moved from room-level to floor-level (see the migration
// server/prisma/migrations/20260729110000_warden_floor_level_assignment/
// and schema.prisma's IMPORTANT MODELING NOTE); shapeFloorAssignedStaff
// below handles all three roles, just given a different floor lookup
// (HostelFloor-keyed for Wardens, CollegeFloor-keyed for DO/Lecturer).
// LAI's classIds is real per-person scoping too, but every LAI here is
// shown with the SAME college-wide day-scholar count regardless of their
// classIds — pooled LAI coverage is treated as one shared duty for
// directory purposes, not a per-person breakdown. That's a display
// simplification on top of the real underlying field, not a claim that
// the field itself changed shape.
// ============================================================================
import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth, requireRole } from "../auth.js";
import { FIELD_STAFF_ROLES } from "../constants.js";

export const staffDirectoryRouter = Router();

function baseFields(u) {
  return { id: u.id, name: u.name, loginKey: u.loginKey, status: u.status };
}

// Warden / DO / Lecturer -> their assigned floors, each with that floor's
// student count. `floorLookup` is a Map floorId -> {id, name, count} — the
// caller decides which floor universe it's built from (HostelFloor for
// Wardens, CollegeFloor for DO/Lecturer); this function doesn't need to
// know or care which, it just resolves whatever ids are in floorIds.
export function shapeFloorAssignedStaff(users, floorLookup) {
  return users.map((u) => {
    const floorIds = Array.isArray(u.floorIds) ? u.floorIds : [];
    // Dedupe defensively — floorIds shouldn't ever contain a repeat (the
    // Assign Staff picker only ever toggles a value in/out, and the Warden
    // migration's DISTINCT already guarantees it for existing data), but a
    // repeat here would double-count that floor's students in totalCount.
    const floors = [...new Set(floorIds)].map((fid) => floorLookup.get(fid)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
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
export function buildStaffDirectoryResponse(role, { staff, hostelFloorLookup, dayScholarCount, collegeFloorLookup }) {
  const byRole = (r) => staff.filter((s) => s.role === r);

  if (role === "COORDINATOR") {
    return { lecturers: shapeFloorAssignedStaff(byRole("LECTURER"), collegeFloorLookup) };
  }

  return {
    wardens: shapeFloorAssignedStaff(byRole("WARDEN"), hostelFloorLookup),
    lais: shapeLais(byRole("LAI"), dayScholarCount),
    dos: shapeFloorAssignedStaff(byRole("DO"), collegeFloorLookup),
    lecturers: shapeFloorAssignedStaff(byRole("LECTURER"), collegeFloorLookup),
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

  const [staff, hostelFloors, dayScholarCount] = await Promise.all([
    prisma.user.findMany({ orderBy: { name: "asc" } }),
    prisma.hostelFloor.findMany({ include: { rooms: { include: { _count: { select: { students: true } } } } } }),
    prisma.student.count({ where: { roomId: null } }),
  ]);

  const hostelFloorLookup = new Map(hostelFloors.map((f) => [
    f.id,
    { id: f.id, name: f.name, count: f.rooms.reduce((n, r) => n + r._count.students, 0) },
  ]));

  res.json(buildStaffDirectoryResponse(req.user.role, { staff, hostelFloorLookup, dayScholarCount, collegeFloorLookup }));
});
