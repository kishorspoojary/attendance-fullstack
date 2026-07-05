// ============================================================================
// The daily attendance workflow — the most important file in this project.
//
// One AttendanceRecord row exists per (date, classroom) pair. Every route
// below reads or writes one of those rows, always re-checking permissions
// and the current state before allowing a change — the frontend's own
// checks (greying out a button, etc.) are just for a nice UI; the real
// rules are enforced here, since a browser can always be tricked into
// sending a request the UI wouldn't normally allow.
//
// The five routes, in the order they happen during a real day:
//   1. POST .../absence    — Warden/LAI mark a student absent (with a reason, for Wardens)
//   2. POST .../reason      — DO confirms/enters the reason for one absentee
//   3. POST .../headcount   — DO records the physical headcount
//   4. POST .../approve     — any of DO / Teacher / Coordinator / AO signs off, in order
//   5. POST .../cutoff      — AO can force-publish anything still open past the deadline
// ============================================================================
import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth, requireRole } from "../auth.js";
import { STAGES, currentStageIndex } from "../stages.js";
import { DAILY_REASONS } from "../constants.js";

export const attendanceRouter = Router();

// Every route here needs "today's row for this class" and doesn't care
// whether it already existed — this helper hides that with a single call.
async function getOrCreateRecord(date, classId) {
  const existing = await prisma.attendanceRecord.findUnique({ where: { date_classId: { date, classId } } });
  if (existing) return existing;
  return prisma.attendanceRecord.create({ data: { date, classId } });
}

const nowTs = () => new Date().toISOString();

// --------------------------------------------------------------------------
// STEP 1 — Warden or LAI marks a student absent (or clears them).
//
// This route is deliberately "upsert" style rather than a simple toggle:
// the frontend always sends the reason it wants right now. Sending a real
// reason sets/overwrites the entry; sending nothing removes it (student is
// present again). That means changing your mind about *which* reason is a
// single call, not "remove, then re-add."
// --------------------------------------------------------------------------
attendanceRouter.post(
  "/attendance/:date/:classId/absence",
  requireAuth,
  requireRole("WARDEN", "LAI"),
  async (req, res) => {
    const { date, classId } = req.params;
    const { studentId, reason } = req.body || {};
    if (!studentId) return res.status(400).json({ error: "studentId is required" });

    const student = await prisma.student.findUnique({ where: { id: studentId } });
    if (!student || student.classId !== classId) return res.status(400).json({ error: "That student isn't in this class" });

    // Scope check: a Warden may only touch students in rooms assigned to
    // them; an LAI only in the classroom(s) assigned to them. This is the
    // server-side version of what the frontend already only shows them.
    if (req.user.role === "WARDEN" && !(req.user.roomIds || []).includes(student.roomId)) {
      return res.status(403).json({ error: "This student isn't in one of your assigned rooms" });
    }
    if (req.user.role === "LAI" && !(req.user.classIds || []).includes(classId)) {
      return res.status(403).json({ error: "This class isn't assigned to you" });
    }
    if (req.user.role === "WARDEN" && reason && !DAILY_REASONS.includes(reason)) {
      return res.status(400).json({ error: `Reason must be one of: ${DAILY_REASONS.join(", ")} (use the "away" action for students who went home)` });
    }

    const record = await getOrCreateRecord(date, classId);
    // Once the DO has approved, the list is locked — this is the "Warden/LAI
    // never has to keep watching it" guarantee from the workflow design.
    if (record.doApproved) return res.status(409).json({ error: "This list is already verified by the DO \u2014 no further changes needed" });

    const field = req.user.role === "WARDEN" ? "wardenAbsences" : "laiAbsences";
    const bucket = { ...(record[field] || {}) }; // copy so we don't mutate the object Prisma gave us
    // LAI never supplies a reason — the DO enters it after a phone call.
    const effectiveReason = req.user.role === "LAI" ? null : reason || null;
    if (!effectiveReason) delete bucket[studentId]; // no reason = mark present again
    else bucket[studentId] = { by: req.user.id, byName: req.user.name, at: nowTs(), reason: effectiveReason };

    const updated = await prisma.attendanceRecord.update({
      where: { id: record.id },
      data: { [field]: bucket }, // [field] is a "computed key" — writes to wardenAbsences or laiAbsences depending on role
    });
    res.json({ record: updated });
  }
);

// --------------------------------------------------------------------------
// STEP 2 — DO confirms or enters the reason for one absentee.
//
// Required for every Warden- or LAI-reported absentee before the DO can
// approve the whole list (enforced in the /approve route below, not just
// suggested by the UI). Students already on a persistent "away" status
// don't need this — their reason was already established when the Warden
// marked them away, so they're not stored in wardenAbsences/laiAbsences at
// all; see routes/students.js.
// --------------------------------------------------------------------------
attendanceRouter.post("/attendance/:date/:classId/reason", requireAuth, requireRole("DO"), async (req, res) => {
  const { date, classId } = req.params;
  const { studentId, reason } = req.body || {};
  if (!studentId || !reason) return res.status(400).json({ error: "studentId and reason are required" });

  const classroom = await prisma.classroom.findUnique({ where: { id: classId } });
  if (!classroom || !(req.user.floorIds || []).includes(classroom.floorId)) {
    return res.status(403).json({ error: "This class's floor isn't assigned to you" });
  }

  const record = await getOrCreateRecord(date, classId);
  if (record.doApproved) return res.status(409).json({ error: "Already approved" });

  const combined = { ...(record.wardenAbsences || {}), ...(record.laiAbsences || {}) };
  if (!combined[studentId]) return res.status(400).json({ error: "That student isn't on today's absentee list" });

  const doVerified = { ...(record.doVerified || {}), [studentId]: { reason, verifiedBy: req.user.id, verifiedByName: req.user.name, at: nowTs() } };
  const updated = await prisma.attendanceRecord.update({ where: { id: record.id }, data: { doVerified } });
  res.json({ record: updated });
});

// --------------------------------------------------------------------------
// STEP 3 — DO records the physical headcount, before they're allowed to approve.
// --------------------------------------------------------------------------
attendanceRouter.post("/attendance/:date/:classId/headcount", requireAuth, requireRole("DO"), async (req, res) => {
  const { date, classId } = req.params;
  const { headcount } = req.body || {};
  if (typeof headcount !== "number") return res.status(400).json({ error: "headcount must be a number" });

  const classroom = await prisma.classroom.findUnique({ where: { id: classId } });
  if (!classroom || !(req.user.floorIds || []).includes(classroom.floorId)) {
    return res.status(403).json({ error: "This class's floor isn't assigned to you" });
  }

  const record = await getOrCreateRecord(date, classId);
  if (record.doApproved) return res.status(409).json({ error: "Already approved" });

  const updated = await prisma.attendanceRecord.update({ where: { id: record.id }, data: { headcount } });
  res.json({ record: updated });
});

// A lookup table built once at startup: {"DO": "doApproved", "INCHARGE_TEACHER":
// "teacherApproved", ...} — turns "which stage does this role approve?" into
// a single object lookup instead of a chain of if/else.
const STAGE_ROLE_TO_KEY = Object.fromEntries(STAGES.map((s) => [s.role, s.key]));

// --------------------------------------------------------------------------
// STEP 4 — one shared route for all four approvals (DO, Incharge Teacher,
// Coordinator, AO). Which stage gets set is determined entirely by the
// logged-in user's role — the URL and request body are identical for all
// four; only who's asking differs.
// --------------------------------------------------------------------------
attendanceRouter.post(
  "/attendance/:date/:classId/approve",
  requireAuth,
  requireRole("DO", "INCHARGE_TEACHER", "COORDINATOR", "AO"),
  async (req, res) => {
    const { date, classId } = req.params;
    const stageKey = STAGE_ROLE_TO_KEY[req.user.role];
    const stageIdx = STAGES.findIndex((s) => s.key === stageKey);

    const classroom = await prisma.classroom.findUnique({ where: { id: classId } });
    if (!classroom) return res.status(404).json({ error: "Class not found" });

    // Only DO/Teacher are scoped to specific floors (they're "pooled" — any
    // one of several staff assigned to a floor can act). Coordinator and AO
    // aren't scoped at all; they oversee everything.
    if ((req.user.role === "DO" || req.user.role === "INCHARGE_TEACHER") && !(req.user.floorIds || []).includes(classroom.floorId)) {
      return res.status(403).json({ error: "This class's floor isn't assigned to you" });
    }

    const record = await getOrCreateRecord(date, classId);
    if (record[stageKey]) return res.status(409).json({ error: "You've already approved this" });

    // Enforce the strict order: you can't approve stage N until stage N-1
    // is done. (Stage 0, the DO, has no "prior" stage to check.)
    const priorKey = stageIdx > 0 ? STAGES[stageIdx - 1].key : null;
    if (priorKey && !record[priorKey]) {
      return res.status(409).json({ error: `Waiting on ${STAGES[stageIdx - 1].label} first` });
    }
    if (stageKey === "doApproved" && record.headcount == null) {
      return res.status(400).json({ error: "Enter the headcount before approving" });
    }
    if (stageKey === "doApproved") {
      // The DO can't approve until every absentee (from either source) has
      // a verified reason — this is the server-side enforcement of the
      // "verify each reason" step; the frontend just disables the button as
      // a courtesy, this check is what actually matters.
      const combined = { ...(record.wardenAbsences || {}), ...(record.laiAbsences || {}) };
      const unverified = Object.keys(combined).filter((sid) => !record.doVerified?.[sid]);
      if (unverified.length > 0) {
        return res.status(400).json({ error: `Verify the reason for every absentee first (${unverified.length} remaining)` });
      }
    }

    // If a deadline cutoff had already force-published this record and
    // skipped this exact stage, completing it late clears that "skipped"
    // flag — this is how a record can go from "auto-passed" to "verified
    // (late)" once everyone actually catches up.
    const skipped = (record.skippedStages || []).filter((k) => k !== stageKey);

    const updated = await prisma.attendanceRecord.update({
      where: { id: record.id },
      data: { [stageKey]: { by: req.user.id, byName: req.user.name, at: nowTs() }, skippedStages: skipped },
    });
    res.json({ record: updated });
  }
);

// --------------------------------------------------------------------------
// STEP 5 — the AO's deadline cutoff.
//
// Force-publishes anything not fully approved by the deadline, tagged for
// follow-up. Deliberately does NOT touch records still stuck at the DO
// stage — Warden, LAI, and DO verification must be completed by a person,
// never auto-passed, since that's where the actual phone-call verification
// happens. Only the Teacher / Coordinator / AO stages can be auto-passed.
// --------------------------------------------------------------------------
attendanceRouter.post("/attendance/:date/cutoff", requireAuth, requireRole("AO"), async (req, res) => {
  const { date } = req.params;
  const classes = await prisma.classroom.findMany();
  let count = 0;
  let stillBlocked = 0;

  for (const c of classes) {
    const record = await getOrCreateRecord(date, c.id);
    const idx = currentStageIndex(record);
    if (idx === 0) {
      // Still waiting on the DO — leave it completely alone, no tag, no publish.
      if (!record.doApproved) stillBlocked++;
      continue;
    }
    if (idx < STAGES.length && !record.forcedPublish) {
      await prisma.attendanceRecord.update({
        where: { id: record.id },
        data: { forcedPublish: true, skippedStages: STAGES.slice(idx).map((s) => s.key) },
      });
      count++;
    }
  }
  res.json({ autoPassedCount: count, stillBlockedOnDO: stillBlocked });
});
