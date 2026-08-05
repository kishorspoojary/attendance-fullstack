// Reasons a Warden can pick when marking a hostel student absent. Mirrored
// by client/src/App.jsx's own DAILY_REASONS/AWAY_REASON — the client can't
// import across the client/server boundary (separate deployments, no
// shared-constants package in this repo), so the two copies have to be kept
// in sync by hand; a shared-constants setup would be a good future refactor
// but isn't worth building as a side effect of a reason-string change.
// Changing this list only changes what NEW absences can be tagged with —
// any AttendanceRecord.wardenAbsences entry already holding an old reason
// string keeps it forever; nothing here rewrites history.
// "Went home" is special: picking it does not write to today's record at
// all — it sets a persistent flag on the student (see routes/students.js)
// so they show as absent automatically every day until a Warden reports
// them back. The other reasons are single-day only.
export const DAILY_REASONS = ["Sick", "Medical treatment", "Other"];
export const AWAY_REASON = "Went home";

// Roles that self-register or are created directly by the Principal — they
// start ACTIVE immediately, no AO approval needed.
export const LEADERSHIP_ROLES = ["AO", "COORDINATOR", "DB_MANAGER"];

// Roles the Database Manager creates. These start PENDING and need an AO
// approval before they can log in — see routes/staff.js.
export const FIELD_STAFF_ROLES = ["WARDEN", "LAI", "DO", "LECTURER"];

// Roles that can be frozen by an AO. Everyone except the Principal.
export const FREEZABLE_ROLES = [...LEADERSHIP_ROLES, ...FIELD_STAFF_ROLES];
