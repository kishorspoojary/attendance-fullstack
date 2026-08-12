// ============================================================================
// Coverage for POST .../do-absence (see attendance.js). No test framework
// existed anywhere in this repo before this file — uses Node's built-in
// test runner (node:test) so no new dependency is needed. Mocks the shared
// `prisma` singleton's model methods directly by plain property assignment
// (confirmed by hand that they're writable/configurable) rather than hitting
// a real database. Deliberately NOT using node:test's t.mock.method here —
// Prisma's model delegates are Proxy-backed, and Object.getOwnPropertyDescriptor
// on a Proxy'd method returns `value: undefined` even though the property
// reads as a real function; t.mock.method relies on that descriptor and
// throws "must be a method. Received undefined" as a result. Plain
// assignment (`prisma.x.y = fn`) goes through the Proxy's set trap instead
// and works fine — patch()/t.after() below just does that with manual
// restore.
// ============================================================================
import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import http from "node:http";
import { attendanceRouter } from "./attendance.js";
import { prisma } from "../db.js";
import { signToken } from "../auth.js";

// Patches `obj[key] = fn`, saving the original so it can register a t.after
// restore. Every mock*() helper below routes through this instead of
// t.mock.method — see the file header comment for why.
function patch(t, obj, key, fn) {
  const original = obj[key];
  obj[key] = fn;
  t.after(() => {
    obj[key] = original;
  });
}

const DATE = "2026-08-12";
const SESSION = "morning";
const CLASS_ID = "class-1";
const FLOOR_ID = "floor-1";

const DO_USER = { id: "do-1", role: "DO", name: "Test DO", status: "ACTIVE", floorIds: [FLOOR_ID] };

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api", attendanceRouter);
  return app;
}

async function withServer(fn) {
  const server = http.createServer(buildApp());
  await new Promise((resolve) => server.listen(0, resolve));
  const { port } = server.address();
  try {
    await fn(`http://127.0.0.1:${port}/api`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function markAbsent(base, { studentId, reason }) {
  const res = await fetch(`${base}/attendance/${DATE}/${CLASS_ID}/${SESSION}/do-absence`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${signToken(DO_USER)}` },
    body: JSON.stringify({ studentId, reason }),
  });
  return { status: res.status, body: await res.json() };
}

// Mocks requireAuth's lookup and the classroom lookups both the floor-check
// and getFloorAttendanceMode need, and gives every test a record store
// backing getOrCreateRecord/update — one record at a time is enough since
// every test here uses the same date/class/session.
function mockShared(t, { attendanceMode }) {
  patch(t, prisma.user, "findUnique", async ({ where }) => (where.id === DO_USER.id ? DO_USER : null));
  patch(t, prisma.classroom, "findUnique", async () => ({
    id: CLASS_ID,
    collegeFloorId: FLOOR_ID,
    collegeFloor: { attendanceMode },
  }));

  let record = null;
  patch(t, prisma.attendanceRecord, "findUnique", async () => record);
  patch(t, prisma.attendanceRecord, "create", async ({ data }) => {
    record = { id: "rec-1", doApproved: null, doAbsences: {}, doConfirmed: {}, ...data };
    return record;
  });
  patch(t, prisma.attendanceRecord, "update", async ({ data }) => {
    record = { ...record, ...data };
    return record;
  });
  return () => record;
}

// Wires unfinalizedFloorsForClass's own five prisma calls (see attendance.js)
// for a single hostel floor "hfloor-1" feeding this class, staffed by one
// Warden — `finalizedFloorIds` controls whether that floor still blocks.
function mockWardenFinalizationChain(t, { finalizedFloorIds }) {
  patch(t, prisma.student, "findMany", async () => [{ id: "stu-h1", classId: CLASS_ID, roomId: "room-1" }]);
  patch(t, prisma.hostelRoom, "findMany", async () => [{ id: "room-1", hostelFloorId: "hfloor-1" }]);
  patch(t, prisma.user, "findMany", async () => [{ id: "warden-1", role: "WARDEN", floorIds: ["hfloor-1"] }]);
  patch(t, prisma.wardenFinalization, "findMany", async () => finalizedFloorIds.map((id) => ({ hostelFloorId: id })));
  patch(t, prisma.hostelFloor, "findMany", async ({ where }) =>
    where.id.in.map((id) => ({ id, name: id === "hfloor-1" ? "Hostel Floor 1" : id }))
  );
}

test("DO_FIRST floor: mark-absent with no reason succeeds, entry has reason: null", async (t) => {
  const getRecord = mockShared(t, { attendanceMode: "DO_FIRST" });
  await withServer(async (base) => {
    const { status, body } = await markAbsent(base, { studentId: "stu-1" });
    assert.equal(status, 200);
    assert.equal(body.record.doAbsences["stu-1"].reason, null);
    assert.ok(body.record.doConfirmed["stu-1"]);
    assert.equal(getRecord().doAbsences["stu-1"].reason, null);
  });
});

test("DO_FIRST floor: mark-absent with a reason succeeds, entry has that reason", async (t) => {
  mockShared(t, { attendanceMode: "DO_FIRST" });
  await withServer(async (base) => {
    const { status, body } = await markAbsent(base, { studentId: "stu-1", reason: "Medical treatment" });
    assert.equal(status, 200);
    assert.equal(body.record.doAbsences["stu-1"].reason, "Medical treatment");
  });
});

test("WARDEN_FIRST floor, floor NOT finalized: mark-absent is rejected", async (t) => {
  mockShared(t, { attendanceMode: "WARDEN_FIRST" });
  mockWardenFinalizationChain(t, { finalizedFloorIds: [] });
  await withServer(async (base) => {
    const { status, body } = await markAbsent(base, { studentId: "stu-1" });
    assert.equal(status, 400);
    assert.equal(body.error, "Waiting on Warden finalization from: Hostel Floor 1");
  });
});

test("WARDEN_FIRST floor, floor finalized: mark-absent succeeds", async (t) => {
  mockShared(t, { attendanceMode: "WARDEN_FIRST" });
  mockWardenFinalizationChain(t, { finalizedFloorIds: ["hfloor-1"] });
  await withServer(async (base) => {
    const { status, body } = await markAbsent(base, { studentId: "stu-1" });
    assert.equal(status, 200);
    assert.ok(body.record.doAbsences["stu-1"]);
  });
});

test("old 'no reason clears' behavior is gone: no reason on an existing entry does not delete it", async (t) => {
  const getRecord = mockShared(t, { attendanceMode: "DO_FIRST" });
  await withServer(async (base) => {
    const first = await markAbsent(base, { studentId: "stu-1", reason: "Medical treatment" });
    assert.equal(first.status, 200);
    assert.equal(first.body.record.doAbsences["stu-1"].reason, "Medical treatment");

    const second = await markAbsent(base, { studentId: "stu-1" });
    assert.equal(second.status, 200);
    // Not deleted — still present, just with reason reset to null since this
    // route always writes an entry now rather than treating a missing
    // `reason` as "undo this student".
    assert.ok(Object.prototype.hasOwnProperty.call(second.body.record.doAbsences, "stu-1"));
    assert.equal(second.body.record.doAbsences["stu-1"].reason, null);
    assert.ok(Object.prototype.hasOwnProperty.call(getRecord().doConfirmed, "stu-1"));
  });
});
