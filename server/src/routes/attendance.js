// ============================================================================
// The daily attendance workflow — the most important file in this project.
//
// One AttendanceRecord row exists per (date, classroom, session) triple —
// two independent rows per class per day, MORNING and AFTERNOON, each
// running the full pipeline below on its own. Every route below reads or
// writes one of those rows, always re-checking permissions and the current
// state before allowing a change — the frontend's own checks (greying out
// a button, etc.) are just for a nice UI; the real rules are enforced here.
//
// The chain is exactly three human stages — AO does NOT approve daily
// attendance, only master data and staff accounts:
//   DO  →  Lecturer  →  Coordinator  →  published
//
// The routes, in the order they happen during a real day:
//   1. POST .../absence     — Warden/LAI mark a student absent (with a reason, for Wardens)
//   2. POST .../reason       — DO confirms/enters the reason for one absentee
//   3. POST .../headcount    — DO records the physical headcount
//   4. POST .../approve      — DO / Lecturer / Coordinator sign off, in order
//   5. POST .../send-back    — DO / Lecturer / Coordinator can bounce it back one stage instead
//   6. POST .../cutoff       — Coordinator can force-publish anything still open past the deadline
// ============================================================================
import { Router } from "express";
import { prisma } from "../db.js";
import { requireAuth, requireRole } from "../auth.js";
import { STAGES, currentStageIndex, priorStageKey } from "../stages.js";
import { DAILY_REASONS } from "../constants.js";
import { isStudentOnWardensFloor } from "../wardenScope.js";

export const attendanceRouter = Router();

const SESSIONS = ["MORNING", "AFTERNOON"];

// The :session URL segment travels lowercase (see api.js), the Session enum
// is uppercase — this is the one place that reconciles them. Returns null
// for anything unrecognized; every write route below rejects that with a
// 400 rather than silently falling back to MORNING. That silent fallback
// was fine in Phase 1 (every caller hardcoded "morning" — a bad value could
// only mean a stale client, and MORNING was the only session that existed
// in practice), but now that the DO screen has a real session switcher, a
// bad value here would mean a request silently lands on the WRONG session's
// row — writing MORNING data while the DO believes they're in AFTERNOON —
// which is a much worse failure mode than a loud rejection.
function normalizeSession(raw) {
  const s = String(raw || "").toUpperCase();
  return SESSIONS.includes(s) ? s : null;
}

async function getOrCreateRecord(date, classId, session) {
  const existing = await prisma.attendanceRecord.findUnique({ where: { date_classId_session: { date, classId, session } } });
  if (existing) return existing;
  return prisma.attendanceRecord.create({ data: { date, classId, session } });
}

const nowTs = () => new Date().toISOString();

// --------------------------------------------------------------------------
// STEP 1 — Warden or LAI marks a student absent (or clears them).
// "Upsert" style: the frontend always sends the reason it wants right now.
// A real reason sets/overwrites the entry; no reason removes it (present
// again). Locked once the DO has approved — see the doApproved check below.
// --------------------------------------------------------------------------
attendanceRouter.post(
  "/attendance/:date/:classId/:session/absence",
  requireAuth,
  requireRole("WARDEN", "LAI"),
  async (req, res) => {
    const { date, classId } = req.params;
    const session = normalizeSession(req.params.session);
    if (!session) return res.status(400).json({ error: "session must be morning or afternoon" });
    const { studentId, reason } = req.body || {};
    if (!studentId) return res.status(400).json({ error: "studentId is required" });

    const student = await prisma.student.findUnique({ where: { id: studentId } });
    if (!student || student.classId !== classId) return res.status(400).json({ error: "That student isn't in this class" });

    if (req.user.role === "WARDEN" && !(await isStudentOnWardensFloor(prisma, req.user, student))) {
      return res.status(403).json({ error: "This student isn't on one of your assigned hostel floors" });
    }
    if (req.user.role === "LAI" && !(req.user.classIds || []).includes(classId)) {
      return res.status(403).json({ error: "This class isn't assigned to you" });
    }
    if (req.user.role === "WARDEN" && reason && !DAILY_REASONS.includes(reason)) {
      return res.status(400).json({ error: `Reason must be one of: ${DAILY_REASONS.join(", ")} (use the "away" action for students who went home)` });
    }

    const record = await getOrCreateRecord(date, classId, session);
    if (record.doApproved) return res.status(409).json({ error: "This list is already verified by the DO \u2014 no further changes needed" });

    const field = req.user.role === "WARDEN" ? "wardenAbsences" : "laiAbsences";
    const bucket = { ...(record[field] || {}) };
    const effectiveReason = req.user.role === "LAI" ? null : reason || null;
    if (!effectiveReason) delete bucket[studentId];
    else bucket[studentId] = { by: req.user.id, byName: req.user.name, at: nowTs(), reason: effectiveReason, isLocal: student.isLocal };

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
attendanceRouter.post("/attendance/:date/:classId/:session/confirm", requireAuth, requireRole("DO"), async (req, res) => {
  const { date, classId } = req.params;
  const session = normalizeSession(req.params.session);
  if (!session) return res.status(400).json({ error: "session must be morning or afternoon" });
  const { studentId } = req.body || {};
  if (!studentId) return res.status(400).json({ error: "studentId is required" });

  const classroom = await prisma.classroom.findUnique({ where: { id: classId } });
  if (!classroom || !(req.user.floorIds || []).includes(classroom.collegeFloorId)) {
    return res.status(403).json({ error: "This class's floor isn't assigned to you" });
  }

  const record = await getOrCreateRecord(date, classId, session);
  if (record.doApproved) return res.status(409).json({ error: "Already approved" });

  const combined = { ...(record.wardenAbsences || {}), ...(record.laiAbsences || {}) };
  if (!combined[studentId]) return res.status(400).json({ error: "That student isn't on today's absentee list" });

  const doConfirmed = { ...(record.doConfirmed || {}), [studentId]: { by: req.user.id, byName: req.user.name, at: nowTs() } };
  const data = { doConfirmed };

  // Afternoon-only: if this same student was also absent AND already
  // DO-verified in the morning session for this exact class/date, carry
  // that verified reason forward right now instead of making the DO call
  // home again — Window 2 (reason) should only need a fresh call when
  // something actually changed since the morning (a presence flip), not
  // just because this session's row starts empty. Deliberately a one-time
  // snapshot copy at confirm time, not a live link back to the morning
  // record — if the morning entry is edited afterward, this one doesn't
  // follow it. carriedFromMorning marks it as such so the UI can show
  // "same as this morning" rather than implying a fresh call happened; the
  // DO can still override via /reason, which rebuilds the entry from
  // scratch and drops this flag.
  if (session === "AFTERNOON" && !record.doVerified?.[studentId]) {
    const morning = await prisma.attendanceRecord.findUnique({
      where: { date_classId_session: { date, classId, session: "MORNING" } },
    });
    const morningVerified = morning?.doVerified?.[studentId];
    if (morningVerified) {
      data.doVerified = {
        ...(record.doVerified || {}),
        [studentId]: {
          reason: morningVerified.reason,
          verifiedBy: morningVerified.verifiedBy,
          verifiedByName: morningVerified.verifiedByName,
          at: nowTs(),
          carriedFromMorning: true,
        },
      };
    }
  }

  const updated = await prisma.attendanceRecord.update({ where: { id: record.id }, data });
  res.json({ record: updated });
});

// The classroom check can also go the other way: a student the Warden or
// LAI reported absent turns out to actually be sitting right there. This
// removes them from the absentee list entirely rather than "confirming"
// them, and clears out any confirmation/reason they'd already picked up.
attendanceRouter.post("/attendance/:date/:classId/:session/correct-presence", requireAuth, requireRole("DO"), async (req, res) => {
  const { date, classId } = req.params;
  const session = normalizeSession(req.params.session);
  if (!session) return res.status(400).json({ error: "session must be morning or afternoon" });
  const { studentId } = req.body || {};
  if (!studentId) return res.status(400).json({ error: "studentId is required" });

  const classroom = await prisma.classroom.findUnique({ where: { id: classId } });
  if (!classroom || !(req.user.floorIds || []).includes(classroom.collegeFloorId)) {
    return res.status(403).json({ error: "This class's floor isn't assigned to you" });
  }

  const record = await getOrCreateRecord(date, classId, session);
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
attendanceRouter.post("/attendance/:date/:classId/:session/reason", requireAuth, requireRole("DO"), async (req, res) => {
  const { date, classId } = req.params;
  const session = normalizeSession(req.params.session);
  if (!session) return res.status(400).json({ error: "session must be morning or afternoon" });
  const { studentId, reason } = req.body || {};
  if (!studentId || !reason) return res.status(400).json({ error: "studentId and reason are required" });

  const classroom = await prisma.classroom.findUnique({ where: { id: classId } });
  if (!classroom || !(req.user.floorIds || []).includes(classroom.collegeFloorId)) {
    return res.status(403).json({ error: "This class's floor isn't assigned to you" });
  }

  const record = await getOrCreateRecord(date, classId, session);
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
attendanceRouter.post("/attendance/:date/:classId/:session/headcount", requireAuth, requireRole("DO"), async (req, res) => {
  const { date, classId } = req.params;
  const session = normalizeSession(req.params.session);
  if (!session) return res.status(400).json({ error: "session must be morning or afternoon" });
  const { headcount } = req.body || {};
  if (typeof headcount !== "number") return res.status(400).json({ error: "headcount must be a number" });

  const classroom = await prisma.classroom.findUnique({ where: { id: classId } });
  if (!classroom || !(req.user.floorIds || []).includes(classroom.collegeFloorId)) {
    return res.status(403).json({ error: "This class's floor isn't assigned to you" });
  }

  const record = await getOrCreateRecord(date, classId, session);
  if (record.doApproved) return res.status(409).json({ error: "Already approved" });

  const updated = await prisma.attendanceRecord.update({ where: { id: record.id }, data: { headcount } });
  res.json({ record: updated });
});

// Lookup: {"DO": "doApproved", "LECTURER": "teacherApproved", "COORDINATOR": "coordinatorApproved"}
const STAGE_ROLE_TO_KEY = Object.fromEntries(STAGES.map((s) => [s.role, s.key]));

// --------------------------------------------------------------------------
// STEP 4 — one shared route for all three approvals (DO, Lecturer,
// Coordinator). Which stage gets set is determined entirely by the logged-in
// user's role.
// --------------------------------------------------------------------------
attendanceRouter.post(
  "/attendance/:date/:classId/:session/approve",
  requireAuth,
  requireRole("DO", "LECTURER", "COORDINATOR"),
  async (req, res) => {
    const { date, classId } = req.params;
    const session = normalizeSession(req.params.session);
    if (!session) return res.status(400).json({ error: "session must be morning or afternoon" });
    const stageKey = STAGE_ROLE_TO_KEY[req.user.role];

    const classroom = await prisma.classroom.findUnique({ where: { id: classId } });
    if (!classroom) return res.status(404).json({ error: "Class not found" });

    if ((req.user.role === "DO" || req.user.role === "LECTURER") && !(req.user.floorIds || []).includes(classroom.collegeFloorId)) {
      return res.status(403).json({ error: "This class's floor isn't assigned to you" });
    }

    const record = await getOrCreateRecord(date, classId, session);
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
  "/attendance/:date/:classId/:session/send-back",
  requireAuth,
  requireRole("DO", "LECTURER", "COORDINATOR"),
  async (req, res) => {
    const { date, classId } = req.params;
    const session = normalizeSession(req.params.session);
    if (!session) return res.status(400).json({ error: "session must be morning or afternoon" });
    const { reason } = req.body || {};
    if (!reason) return res.status(400).json({ error: "A reason is required so they know what to fix" });

    const stageKey = STAGE_ROLE_TO_KEY[req.user.role];
    const classroom = await prisma.classroom.findUnique({ where: { id: classId } });
    if (!classroom) return res.status(404).json({ error: "Class not found" });
    if ((req.user.role === "DO" || req.user.role === "LECTURER") && !(req.user.floorIds || []).includes(classroom.collegeFloorId)) {
      return res.status(403).json({ error: "This class's floor isn't assigned to you" });
    }

    const record = await getOrCreateRecord(date, classId, session);
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
    for (const session of SESSIONS) {
      const record = await getOrCreateRecord(date, c.id, session);
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
  }
  res.json({ autoPassedCount: count, stillBlockedOnDO: stillBlocked });
});

// --------------------------------------------------------------------------
// Date-range query — additive alongside GET /state (routes/state.js), which
// still returns the whole AttendanceRecord table unfiltered for every other
// screen in the app. This one's for anything that needs a bounded slice
// (trend/long-leave calculations) without loading everything. `date` is a
// zero-padded "YYYY-MM-DD" string (see schema.prisma's comment on
// AttendanceRecord.date), so a plain string comparison sorts identically to
// a real date comparison — no need to parse into Date objects here or in
// the Prisma query itself. Returns the same
// { [date]: { [classId]: { [session]: AttendanceRecord } } } shape /state
// builds, just under an "attendance" key scoped to [from, to].
// --------------------------------------------------------------------------
attendanceRouter.get("/attendance", requireAuth, async (req, res) => {
  const { from, to } = req.query;
  if (!from || !to) return res.status(400).json({ error: "from and to are required (YYYY-MM-DD)" });
  if (from > to) return res.status(400).json({ error: "from must be on or before to" });

  const rows = await prisma.attendanceRecord.findMany({ where: { date: { gte: from, lte: to } } });

  const attendance = {};
  for (const row of rows) {
    attendance[row.date] = attendance[row.date] || {};
    attendance[row.date][row.classId] = attendance[row.date][row.classId] || {};
    attendance[row.date][row.classId][row.session] = row;
  }

  res.json({ attendance });
});
