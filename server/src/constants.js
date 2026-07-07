// Reasons a Warden can pick when marking a hostel student absent.
// "Went home" is special: picking it does not write to today's record at
// all — it sets a persistent flag on the student (see routes/students.js)
// so they show as absent automatically every day until a Warden reports
// them back. The other reasons are single-day only.
export const DAILY_REASONS = ["Sick", "Not in room", "Other"];
export const AWAY_REASON = "Went home";
export const ALL_REASONS = [...DAILY_REASONS, AWAY_REASON];

// Every account starts with this same password. mustChangePassword stays
// true until they change it, and the frontend should keep nagging them
// (or even block them) until they do — see routes/auth.js.
export const DEFAULT_PASSWORD = "Welcome@123";

// Roles that self-register or are created directly by the Principal — they
// start ACTIVE immediately, no AO approval needed.
export const LEADERSHIP_ROLES = ["AO", "COORDINATOR", "DB_MANAGER"];

// Roles the Database Manager creates. These start PENDING and need an AO
// approval before they can log in — see routes/staff.js.
export const FIELD_STAFF_ROLES = ["WARDEN", "LAI", "DO", "INCHARGE_TEACHER"];

// Roles that can be frozen by an AO. Everyone except the Principal.
export const FREEZABLE_ROLES = [...LEADERSHIP_ROLES, ...FIELD_STAFF_ROLES];
