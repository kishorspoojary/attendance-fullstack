// ============================================================================
// The daily attendance workflow — the most important file in this project.
//
// One AttendanceRecord row exists per (date, classroom) pair. Every route
// below reads or writes one of those rows, always re-checking permissions
// and the current state before allowing a change — the frontend's own
// checks (greying out a button, etc.) are just for a nice UI; the real
// rules are enforced here.
//
// The chain is exactly three human stages — AO does NOT approve daily
// attendance, only master data and staff accounts:
//   DO  →  Incharge Teacher  →  Coordinator  →  published
//
// The routes, in the order they happen during a real day:
//   1. POST .../absence     — Warden/LAI mark a student absent (with a reason, for Wardens)
//   2. POST .../reason       — DO confirms/enters the reason for one absentee
//   3. POST .../headcount    — DO records the physical headcount
//   4. POST .../approve      — DO / Teacher / Coordinator sign off, in order
//   5. POST .../send-back    — DO / Teacher / Coordinator can bounce it back one stage instead
//   6. POST .../cutoff       — Coordinator can force-publish anything still open past the deadline
// ============================================================================
import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth, requireRole } from "../auth.js";
import { STAGES, currentStageIndex, priorStageKey } from "../stages.js";
import { DAILY_REASONS } from "../constants.js";

export const attendanceRouter = Router();

async function getOrCreateRecord(date, classId) {
  const existing = await prisma.attendanceRecord.findUnique({ where: { date_classId: { date, classId } } });
  if (existing) return existing;
  return prisma.attendanceRecord.create({ data: { date, classId } });
}

const nowTs = () => new Date().toISOString();

// --------------------------------------------------------------------------
// STEP 1 — Warden or LAI marks a student absent (or clears them).
// "Upsert" style: the frontend always sends the reason it wants right now.
// A real reason sets/overwrites the entry; no reason removes it (present
// again). Locked once the DO has approved — see the doApproved check below.
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
    if (record.doApproved) return res.status(409).json({ error: "This list is already verified by the DO \u2014 no further changes needed" });

    const field = req.user.role === "WARDEN" ? "wardenAbsences" : "laiAbsences";
    const bucket = { ...(record[field] || {}) };
    const effectiveReason = req.user.role === "LAI" ? null : reason || null;
    if (!effectiveReason) delete bucket[studentId];
    else bucket[studentId] = { by: req.user.id, byName: req.user.name, at: nowTs(), reason: effectiveReason };

    const updated = await prisma.attendanceRecord.update({ where: { id: record.id }, data: { [field]: bucket } });
    res.json({ record: updated });
  }
);

// --------------------------------------------------------------------------
// STEP 2 — DO confirms or enters the reason for one absentee. Required for
// --------------------------------------------------------------------------
// STEP 2, WINDOW 1 — the classroom check. A DO walking into a classroom
// mid-period can tell who's physically absent right then, but can't call
// anyone's home or warden in that moment — that happens later, in Window 2
// below. This step is just "yes, this reported absentee really is absent"
// (or the opposite: the report was wrong and they're actually here).
// --------------------------------------------------------------------------
attendanceRouter.post("/attendance/:date/:classId/confirm", requireAuth, requireRole("DO"), async (req, res) => {
  const { date, classId } = req.params;
  const { studentId } = req.body || {};
  if (!studentId) return res.status(400).json({ error: "studentId is required" });

  const classroom = await prisma.classroom.findUnique({ where: { id: classId } });
  if (!classroom || !(req.user.floorIds || []).includes(classroom.collegeFloorId)) {
    return res.status(403).json({ error: "This class's floor isn't assigned to you" });
  }

  const record = await getOrCreateRecord(date, classId);
  if (record.doApproved) return res.status(409).json({ error: "Already approved" });

  const combined = { ...(record.wardenAbsences || {}), ...(record.laiAbsences || {}) };
  if (!combined[studentId]) return res.status(400).json({ error: "That student isn't on today's absentee list" });

  const doConfirmed = { ...(record.doConfirmed || {}), [studentId]: { by: req.user.id, byName: req.user.name, at: nowTs() } };
  const updated = await prisma.attendanceRecord.update({ where: { id: record.id }, data: { doConfirmed } });
  res.json({ record: updated });
});

// The classroom check can also go the other way: a student the Warden or
// LAI reported absent turns out to actually be sitting right there. This
// removes them from the absentee list entirely rather than "confirming"
// them, and clears out any confirmation/reason they'd already picked up.
attendanceRouter.post("/attendance/:date/:classId/correct-presence", requireAuth, requireRole("DO"), async (req, res) => {
  const { date, classId } = req.params;
  const { studentId } = req.body || {};
  if (!studentId) return res.status(400).json({ error: "studentId is required" });

  const classroom = await prisma.classroom.findUnique({ where: { id: classId } });
  if (!classroom || !(req.user.floorIds || []).includes(classroom.collegeFloorId)) {
    return res.status(403).json({ error: "This class's floor isn't assigned to you" });
  }

  const record = await getOrCreateRecord(date, classId);
  if (record.doApproved) return res.status(409).json({ error: "Already approved" });

  const wardenAbsences = { ...(record.wardenAbsences || {}) };
  const laiAbsences = { ...(record.laiAbsences || {}) };
  const doConfirmed = { ...(record.doConfirmed || {}) };
  const doVerified = { ...(record.doVerified || {}) };
  delete wardenAbsences[studentId];
  delete laiAbsences[studentId];
  delete doConfirmed[studentId];
  delete doVerified[studentId];

  const updated = await prisma.attendanceRecord.update({
    where: { id: record.id },
    data: { wardenAbsences, laiAbsences, doConfirmed, doVerified },
  });
  res.json({ record: updated });
});

// --------------------------------------------------------------------------
// STEP 2, WINDOW 2 — later, on the phone: the DO calls home (or the
// Warden) and records the actual reason. Only possible once a student has
// been confirmed absent in Window 1 above — you can't have a reason for
// someone you haven't actually confirmed is absent yet.
// --------------------------------------------------------------------------
attendanceRouter.post("/attendance/:date/:classId/reason", requireAuth, requireRole("DO"), async (req, res) => {
  const { date, classId } = req.params;
  const { studentId, reason } = req.body || {};
  if (!studentId || !reason) return res.status(400).json({ error: "studentId and reason are required" });

  const classroom = await prisma.classroom.findUnique({ where: { id: classId } });
  if (!classroom || !(req.user.floorIds || []).includes(classroom.collegeFloorId)) {
    return res.status(403).json({ error: "This class's floor isn't assigned to you" });
  }

  const record = await getOrCreateRecord(date, classId);
  if (record.doApproved) return res.status(409).json({ error: "Already approved" });

  const combined = { ...(record.wardenAbsences || {}), ...(record.laiAbsences || {}) };
  if (!combined[studentId]) return res.status(400).json({ error: "That student isn't on today's absentee list" });
  if (!record.doConfirmed?.[studentId]) {
    return res.status(400).json({ error: "Confirm this student absent in the classroom check first" });
  }

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
  if (!classroom || !(req.user.floorIds || []).includes(classroom.collegeFloorId)) {
    return res.status(403).json({ error: "This class's floor isn't assigned to you" });
  }

  const record = await getOrCreateRecord(date, classId);
  if (record.doApproved) return res.status(409).json({ error: "Already approved" });

  const updated = await prisma.attendanceRecord.update({ where: { id: record.id }, data: { headcount } });
  res.json({ record: updated });
});

// Lookup: {"DO": "doApproved", "INCHARGE_TEACHER": "teacherApproved", "COORDINATOR": "coordinatorApproved"}
const STAGE_ROLE_TO_KEY = Object.fromEntries(STAGES.map((s) => [s.role, s.key]));

// --------------------------------------------------------------------------
// STEP 4 — one shared route for all three approvals (DO, Incharge Teacher,
// Coordinator). Which stage gets set is determined entirely by the logged-in
// user's role.
// --------------------------------------------------------------------------
attendanceRouter.post(
  "/attendance/:date/:classId/approve",
  requireAuth,
  requireRole("DO", "INCHARGE_TEACHER", "COORDINATOR"),
  async (req, res) => {
    const { date, classId } = req.params;
    const stageKey = STAGE_ROLE_TO_KEY[req.user.role];

    const classroom = await prisma.classroom.findUnique({ where: { id: classId } });
    if (!classroom) return res.status(404).json({ error: "Class not found" });

    if ((req.user.role === "DO" || req.user.role === "INCHARGE_TEACHER") && !(req.user.floorIds || []).includes(classroom.collegeFloorId)) {
      return res.status(403).json({ error: "This class's floor isn't assigned to you" });
    }

    const record = await getOrCreateRecord(date, classId);
    if (record[stageKey]) return res.status(409).json({ error: "You've already approved this" });

    const priorKey = priorStageKey(stageKey);
    if (priorKey && !record[priorKey]) {
      const priorLabel = STAGES.find((s) => s.key === priorKey).label;
      return res.status(409).json({ error: `Waiting on ${priorLabel} first` });
    }
    if (stageKey === "doApproved" && record.headcount == null) {
      return res.status(400).json({ error: "Enter the headcount before approving" });
    }
    if (stageKey === "doApproved") {
      const combined = { ...(record.wardenAbsences || {}), ...(record.laiAbsences || {}) };
      const unconfirmed = Object.keys(combined).filter((sid) => !record.doConfirmed?.[sid]);
      if (unconfirmed.length > 0) {
        return res.status(400).json({ error: `Confirm every absentee in the classroom check first (${unconfirmed.length} remaining)` });
      }
      const unverified = Object.keys(combined).filter((sid) => !record.doVerified?.[sid]);
      if (unverified.length > 0) {
        return res.status(400).json({ error: `Call and confirm the reason for every absentee first (${unverified.length} remaining)` });
      }
    }

    const skipped = (record.skippedStages || []).filter((k) => k !== stageKey);

    const updated = await prisma.attendanceRecord.update({
      where: { id: record.id },
      // Approving clears any lingering "sent back" note — this stage is
      // resolved now, whether it was a first-time approval or a re-approval
      // after fixing whatever the send-back flagged.
      data: { [stageKey]: { by: req.user.id, byName: req.user.name, at: nowTs() }, skippedStages: skipped, sentBack: null },
    });
    res.json({ record: updated });
  }
);

// --------------------------------------------------------------------------
// STEP 5 — send back, instead of approving. Available to the same three
// roles as /approve, and only before that role's own stage is approved.
// Un-does exactly one stage: the one right before the sender's. For DO
// (nothing before it in STAGES — the "prior stage" is really the Warden/LAI
// marking step, which isn't tracked as an approval field at all) this is
// purely a note for them to see, since they're already free to edit
// whenever doApproved is null.
// --------------------------------------------------------------------------
attendanceRouter.post(
  "/attendance/:date/:classId/send-back",
  requireAuth,
  requireRole("DO", "INCHARGE_TEACHER", "COORDINATOR"),
  async (req, res) => {
    const { date, classId } = req.params;
    const { reason } = req.body || {};
    if (!reason) return res.status(400).json({ error: "A reason is required so they know what to fix" });

    const stageKey = STAGE_ROLE_TO_KEY[req.user.role];
    const classroom = await prisma.classroom.findUnique({ where: { id: classId } });
    if (!classroom) return res.status(404).json({ error: "Class not found" });
    if ((req.user.role === "DO" || req.user.role === "INCHARGE_TEACHER") && !(req.user.floorIds || []).includes(classroom.collegeFloorId)) {
      return res.status(403).json({ error: "This class's floor isn't assigned to you" });
    }

    const record = await getOrCreateRecord(date, classId);
    if (record[stageKey]) return res.status(409).json({ error: "You've already approved this \u2014 too late to send back" });

    const priorKey = priorStageKey(stageKey);
    const toLabel = priorKey ? STAGES.find((s) => s.key === priorKey).label : "Warden / LAI";
    const sentBack = { fromStage: stageKey, fromName: req.user.name, toStage: priorKey || "warden_lai", toLabel, reason, at: nowTs() };

    const data = { sentBack };
    if (priorKey) data[priorKey] = null; // re-opens that stage; also re-opens everything before it, since their lock checks read this same field

    const updated = await prisma.attendanceRecord.update({ where: { id: record.id }, data });
    res.json({ record: updated });
  }
);

// --------------------------------------------------------------------------
// STEP 6 — Coordinator's deadline cutoff (moved here from AO, since AO no
// longer takes part in the daily chain at all).
//
// Force-publishes anything not fully approved by the deadline, tagged for
// follow-up. Deliberately does NOT touch records still stuck at the DO
// stage — that verification must be completed by a person, never
// auto-passed.
// --------------------------------------------------------------------------
attendanceRouter.post("/attendance/:date/cutoff", requireAuth, requireRole("COORDINATOR"), async (req, res) => {
  const { date } = req.params;
  const classes = await prisma.classroom.findMany();
  let count = 0;
  let stillBlocked = 0;

  for (const c of classes) {
    const record = await getOrCreateRecord(date, c.id);
    const idx = currentStageIndex(record);
    if (idx === 0) {
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
