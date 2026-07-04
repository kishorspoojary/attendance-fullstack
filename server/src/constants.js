// Reasons a Warden can pick when marking a hostel student absent.
// "Went home" is special: picking it does not write to today's record at
// all — it sets a persistent flag on the student (see routes/students.js)
// so they show as absent automatically every day until a Warden reports
// them back. The other reasons are single-day only.
export const DAILY_REASONS = ["Sick", "Not in room", "Other"];
export const AWAY_REASON = "Went home";
export const ALL_REASONS = [...DAILY_REASONS, AWAY_REASON];
