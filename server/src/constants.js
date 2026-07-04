// ============================================================================
// The fixed list of reasons a Warden can pick from when marking a hostel
// student absent.
//
// "Went home" is intentionally handled differently from the others: picking
// it doesn't touch today's AttendanceRecord at all. Instead it sets a flag
// directly on the Student row (see routes/students.js: mark-away) so the
// student is treated as absent every day automatically, without anyone
// re-marking them, until a Warden explicitly reports them back. The other
// three reasons are "just for today" and live inside the day's record.
// ============================================================================
export const DAILY_REASONS = ["Sick", "Not in room", "Other"];
export const AWAY_REASON = "Went home";
export const ALL_REASONS = [...DAILY_REASONS, AWAY_REASON];
