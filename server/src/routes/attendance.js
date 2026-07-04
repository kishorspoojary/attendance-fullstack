import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth, requireRole } from "../auth.js";
import { STAGES, currentStageIndex } from "../stages.js";
import { DAILY_REASONS } from "../constants.js";

export const attendanceRouter = Router();

async function getOrCreateRecord(date, classId) {
  const existing = await prisma.attendanceRecord.findUnique({ where: { date_classId: { date, classId } } });
  if (existing) return existing;
  return prisma.attendanceRecord.create({ data: { date, classId } });
}

const nowTs = () => new Date().toISOString();

// Set or clear a student on a Warden's or LAI's absentee list.
// Sending a non-empty reason marks them absent with that reason; sending an
// empty/missing reason clears them (marks present again for today).
// Locked once the DO has approved the list for that class/day.
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
    // LAI never supplies a reason \u2014 the DO enters it after a phone call.
    const effectiveReason = req.user.role === "LAI" ? null : reason || null;
    if (!effectiveReason) delete bucket[studentId];
    else bucket[studentId] = { by: req.user.id, byName: req.user.name, at: nowTs(), reason: effectiveReason };

    const updated = await prisma.attendanceRecord.update({
      where: { id: record.id },
      data: { [field]: bucket },
    });
    res.json({ record: updated });
  }
);

// DO confirms/enters the reason for one absentee \u2014 required for every
// warden- or LAI-reported absentee before the DO can approve the list.
// (Students on a persistent "away" status don't need this \u2014 their reason
// was already established when the Warden marked them away.)
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

// DO enters the physical headcount before approving.
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

const STAGE_ROLE_TO_KEY = Object.fromEntries(STAGES.map((s) => [s.role, s.key]));

// Any of the four sequential approvals: DO, Incharge Teacher, Coordinator, AO.
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

    if ((req.user.role === "DO" || req.user.role === "INCHARGE_TEACHER") && !(req.user.floorIds || []).includes(classroom.floorId)) {
      return res.status(403).json({ error: "This class's floor isn't assigned to you" });
    }

    const record = await getOrCreateRecord(date, classId);
    if (record[stageKey]) return res.status(409).json({ error: "You've already approved this" });

    const priorKey = stageIdx > 0 ? STAGES[stageIdx - 1].key : null;
    if (priorKey && !record[priorKey]) {
      return res.status(409).json({ error: `Waiting on ${STAGES[stageIdx - 1].label} first` });
    }
    if (stageKey === "doApproved" && record.headcount == null) {
      return res.status(400).json({ error: "Enter the headcount before approving" });
    }
    if (stageKey === "doApproved") {
      const combined = { ...(record.wardenAbsences || {}), ...(record.laiAbsences || {}) };
      const unverified = Object.keys(combined).filter((sid) => !record.doVerified?.[sid]);
      if (unverified.length > 0) {
        return res.status(400).json({ error: `Verify the reason for every absentee first (${unverified.length} remaining)` });
      }
    }

    // Clear this stage from the skipped list if it had been auto-passed earlier.
    const skipped = (record.skippedStages || []).filter((k) => k !== stageKey);

    const updated = await prisma.attendanceRecord.update({
      where: { id: record.id },
      data: { [stageKey]: { by: req.user.id, byName: req.user.name, at: nowTs() }, skippedStages: skipped },
    });
    res.json({ record: updated });
  }
);

// Force-publish anything not fully approved by the deadline, tagged for
// follow-up. Deliberately does NOT touch records still stuck at the DO
// stage \u2014 Warden, LAI, and DO verification must be completed by a person,
// never auto-passed, since that's where the actual phone-call verification
// happens. Only the Teacher / Coordinator / AO stages can be auto-passed.
attendanceRouter.post("/attendance/:date/cutoff", requireAuth, requireRole("AO"), async (req, res) => {
  const { date } = req.params;
  const classes = await prisma.classroom.findMany();
  let count = 0;
  let stillBlocked = 0;

  for (const c of classes) {
    const record = await getOrCreateRecord(date, c.id);
    const idx = currentStageIndex(record);
    if (idx === 0) {
      if (!record.doApproved) stillBlocked++;
      continue; // never auto-pass the DO stage
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
