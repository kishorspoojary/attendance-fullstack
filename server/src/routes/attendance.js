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
// The chain is exactly two human stages — AO does NOT approve daily
// attendance, only master data and staff accounts, and Coordinator no
// longer approves daily attendance either (see stages.js):
//   DO  →  Lecturer  →  published
//
// Coordinator is now an institution-wide observer only — no approve or
// send-back capability on individual classes — but still owns the deadline
// cutoff below, which is a deadline-override tool, not a stage approval.
//
// The routes, in the order they happen during a real day:
//   1. POST .../absence     — Warden/LAI mark a student absent (with a reason, for Wardens)
//   2. POST .../reason       — DO confirms/enters the reason for one absentee
//   3. POST .../headcount    — DO records the physical headcount
//   4. POST .../approve      — DO / Lecturer sign off, in order
//   5. POST .../send-back    — DO / Lecturer can bounce it back one stage instead
//   6. POST .../cutoff       — Coordinator can force-publish anything still open past the deadline
// ============================================================================
import { Router } from "express";
import { Prisma } from "@prisma/client";
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

// Runs an update only if `guardField` is still null, closing the
// read-check-write race that a plain `if (record[guardField]) return 409;
// else update(...)` leaves open: two concurrent requests can both read
// null before either write lands, both pass the check, and the second
// `update()` would silently overwrite the first instead of failing. This
// uses `updateMany` with the null check INSIDE the `where` clause instead —
// the database evaluates it atomically per writer, so a losing concurrent
// writer's query simply matches 0 rows. Plain `null` in a Json field's
// `where` filter throws in this Prisma version (confirmed against the real
// DB before wiring this in) — Json columns need Prisma.DbNull to mean "SQL
// NULL" specifically. `guardField` and the fields actually written don't
// have to be the same one — /send-back guards on its own stageKey (can't
// send back after approving) while writing sentBack and nulling the prior
// stage instead. Returns the updated record, or null if someone else won
// the race.
async function updateIfFieldNull(recordId, guardField, data) {
  const result = await prisma.attendanceRecord.updateMany({
    where: { id: recordId, [guardField]: { equals: Prisma.DbNull } },
    data,
  });
  if (result.count === 0) return null;
  return prisma.attendanceRecord.findUnique({ where: { id: recordId } });
}

// The common case: the guarded field and the field being set to a real
// value are the same one (co-sign, and every *Approved stage). `extraData`
// rides along in the same write (e.g. /approve also clears skippedStages
// and sentBack) — it isn't part of the race guard itself, just fields that
// need to land atomically with it.
async function setJsonFieldIfNull(recordId, field, value, extraData = {}) {
  return updateIfFieldNull(recordId, field, { [field]: value, ...extraData });
}

const nowTs = () => new Date().toISOString();

// "HH:MM" 24-hour, zero-padded, server-local time — comparable with a plain
// string comparison against CollegeFloor.dailyDeadline (same "zero-padded
// string sorts like the real value" trick already used for AttendanceRecord
// .date elsewhere in this file).
const nowHHMM = () => {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

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

// Lookup: {"DO": "doApproved", "LECTURER": "teacherApproved"}
const STAGE_ROLE_TO_KEY = Object.fromEntries(STAGES.map((s) => [s.role, s.key]));

// --------------------------------------------------------------------------
// STEP 4 — one shared route for both approvals (DO, Lecturer). Which stage
// gets set is determined entirely by the logged-in user's role. Coordinator
// is deliberately not in requireRole below — they're an observer only now,
// see this file's header comment.
// --------------------------------------------------------------------------
attendanceRouter.post(
  "/attendance/:date/:classId/:session/approve",
  requireAuth,
  requireRole("DO", "LECTURER"),
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
    // Fast path: reject the common sequential case (someone already
    // approved, no race involved) before spending time on the validation
    // checks below. This alone isn't the race fix — see the atomic write
    // at the bottom, which is what actually closes the window between two
    // near-simultaneous requests (e.g. two Lecturers pooled on the same
    // floor) both reading a null stageKey here before either write lands.
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

    // The actual race guard: atomically set stageKey only if it's still
    // null. If a concurrent request (same class/session/stage) won the
    // race between our read above and this write, `updated` comes back
    // null instead of silently overwriting their approval with ours.
    const updated = await setJsonFieldIfNull(
      record.id,
      stageKey,
      { by: req.user.id, byName: req.user.name, at: nowTs() },
      // Approving clears any lingering "sent back" note — this stage is
      // resolved now, whether it was a first-time approval or a re-approval
      // after fixing whatever the send-back flagged.
      { skippedStages: skipped, sentBack: null },
    );
    if (!updated) return res.status(409).json({ error: "You've already approved this" });
    res.json({ record: updated });
  }
);

// --------------------------------------------------------------------------
// Optional cross-verification — a second Lecturer on the same floor
// voluntarily co-signing a class teacherApproved already covers. Never
// required and never gates anything downstream (Coordinator doesn't wait
// on this, the class is already fully approved without it) — purely a
// visible extra set of eyes for classes someone wants a second review on.
// Requires teacherApproved to already be set, and the co-signer to be
// someone OTHER than whoever set it — co-signing your own approval is
// meaningless. Uses setJsonFieldIfNull for the same reason /approve does
// (see that route): two Lecturers racing to co-sign the same class should
// never let one silently overwrite the other's co-sign.
// --------------------------------------------------------------------------
attendanceRouter.post("/attendance/:date/:classId/:session/co-sign", requireAuth, requireRole("LECTURER"), async (req, res) => {
  const { date, classId } = req.params;
  const session = normalizeSession(req.params.session);
  if (!session) return res.status(400).json({ error: "session must be morning or afternoon" });

  const classroom = await prisma.classroom.findUnique({ where: { id: classId } });
  if (!classroom) return res.status(404).json({ error: "Class not found" });
  if (!(req.user.floorIds || []).includes(classroom.collegeFloorId)) {
    return res.status(403).json({ error: "This class's floor isn't assigned to you" });
  }

  const record = await getOrCreateRecord(date, classId, session);
  if (!record.teacherApproved) return res.status(409).json({ error: "Not approved by a Lecturer yet — nothing to co-sign" });
  if (record.teacherApproved.by === req.user.id) {
    return res.status(400).json({ error: "You already approved this yourself — co-sign is for a second Lecturer's review" });
  }
  if (record.teacherCoSignedBy) return res.status(409).json({ error: "Already co-signed" });

  const updated = await setJsonFieldIfNull(record.id, "teacherCoSignedBy", { by: req.user.id, byName: req.user.name, at: nowTs() });
  if (!updated) return res.status(409).json({ error: "Already co-signed" });
  res.json({ record: updated });
});

// --------------------------------------------------------------------------
// STEP 5 — send back, instead of approving. Available to the same two
// roles as /approve, and only before that role's own stage is approved.
// Un-does exactly one stage: the one right before the sender's. For DO
// (nothing before it in STAGES — the "prior stage" is really the Warden/LAI
// marking step, which isn't tracked as an approval field at all) this is
// purely a note for them to see, since they're already free to edit
// whenever doApproved is null. Coordinator is deliberately not in
// requireRole below — observer only now, see this file's header comment.
// --------------------------------------------------------------------------
attendanceRouter.post(
  "/attendance/:date/:classId/:session/send-back",
  requireAuth,
  requireRole("DO", "LECTURER"),
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
    // Fast path \u2014 see /approve's comment on why this alone isn't the race
    // fix; the atomic guard below is.
    if (record[stageKey]) return res.status(409).json({ error: "You've already approved this \u2014 too late to send back" });

    const priorKey = priorStageKey(stageKey);
    const toLabel = priorKey ? STAGES.find((s) => s.key === priorKey).label : "Warden / LAI";
    const sentBack = { fromStage: stageKey, fromName: req.user.name, toStage: priorKey || "warden_lai", toLabel, reason, at: nowTs() };

    const data = { sentBack };
    if (priorKey) data[priorKey] = null; // re-opens that stage; also re-opens everything before it, since their lock checks read this same field

    // Same class of race as /approve, lower stakes: two people eligible to
    // send back the same stage racing each other wouldn't corrupt pipeline
    // state either way (the record ends up sent back regardless), but
    // without this guard the losing writer's sentBack reason would be
    // silently discarded rather than the winner's, rather than rejected.
    const updated = await updateIfFieldNull(record.id, stageKey, data);
    if (!updated) return res.status(409).json({ error: "You've already approved this \u2014 too late to send back" });
    res.json({ record: updated });
  }
);

// Shared by both cutoff routes below (the global one and the floor-scoped
// one) — force-publishes anything not fully approved, for every
// (classroom, session) pair in `classes`, tagged for follow-up. Deliberately
// never touches records still stuck at the DO stage — that verification
// must be completed by a person, never auto-passed. Same rule regardless of
// who triggered it or how narrow the scope is.
async function runCutoffForClasses(date, classes) {
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
  return { autoPassedCount: count, stillBlockedOnDO: stillBlocked };
}

// --------------------------------------------------------------------------
// STEP 6 — Coordinator's deadline cutoff (moved here from AO, since AO no
// longer takes part in the daily chain at all). Institution-wide — every
// classroom, every floor. See /attendance/:date/:collegeFloorId/floor-cutoff
// below for a Lecturer's narrower, per-floor equivalent.
// --------------------------------------------------------------------------
attendanceRouter.post("/attendance/:date/cutoff", requireAuth, requireRole("COORDINATOR"), async (req, res) => {
  const { date } = req.params;
  const classes = await prisma.classroom.findMany();
  res.json(await runCutoffForClasses(date, classes));
});

// --------------------------------------------------------------------------
// Lecturer's own, floor-scoped version of the cutoff above. Gated on that
// floor's optional dailyDeadline (set via PUT .../deadline below) actually
// having passed — this app has no scheduler, so nothing fires on its own;
// the deadline only unlocks this button for a human to click. Same
// force-publish rule as the global cutoff, including never bypassing the DO
// stage — a Lecturer's floor cutoff can auto-skip their OWN teacherApproved
// stage exactly like Coordinator's global one already can on their behalf.
// --------------------------------------------------------------------------
attendanceRouter.post("/attendance/:date/:collegeFloorId/floor-cutoff", requireAuth, requireRole("LECTURER"), async (req, res) => {
  const { date, collegeFloorId } = req.params;
  if (!(req.user.floorIds || []).includes(collegeFloorId)) {
    return res.status(403).json({ error: "This floor isn't assigned to you" });
  }

  const floor = await prisma.collegeFloor.findUnique({ where: { id: collegeFloorId } });
  if (!floor) return res.status(404).json({ error: "Floor not found" });
  if (!floor.dailyDeadline) return res.status(400).json({ error: "No deadline set for this floor" });
  if (nowHHMM() < floor.dailyDeadline) {
    return res.status(409).json({ error: `Deadline hasn't passed yet (set for ${floor.dailyDeadline})` });
  }

  const classes = await prisma.classroom.findMany({ where: { collegeFloorId } });
  res.json(await runCutoffForClasses(date, classes));
});

// --------------------------------------------------------------------------
// Set or clear a floor's optional daily deadline. Any Lecturer assigned to
// the floor can change it — shared/pooled, same as the floor assignment
// itself (see schema.prisma's CollegeFloor.dailyDeadline comment).
// --------------------------------------------------------------------------
attendanceRouter.put("/college-floors/:id/deadline", requireAuth, requireRole("LECTURER"), async (req, res) => {
  const { id } = req.params;
  if (!(req.user.floorIds || []).includes(id)) {
    return res.status(403).json({ error: "This floor isn't assigned to you" });
  }
  const { time } = req.body || {};
  if (time !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(time || "")) {
    return res.status(400).json({ error: "time must be \"HH:MM\" (24-hour) or null to clear" });
  }

  const floor = await prisma.collegeFloor.update({ where: { id }, data: { dailyDeadline: time } });
  res.json({ floor });
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
