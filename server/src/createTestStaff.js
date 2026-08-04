// ============================================================================
// Creates the 4 staff accounts needed to exercise the finalization-test
// fixture from server/src/seedFinalizationTest.js (run that first):
//   - a Warden assigned to "Test Hostel Floor A"
//   - a Warden assigned to "Test Hostel Floor B"
//   - a DO assigned to "Test College Floor"
//   - a Lecturer assigned to "Test College Floor"
// ("Test Hostel Floor C (no Warden)" deliberately gets no Warden — see
// seedFinalizationTest.js's comment on why.)
//
// Goes through the app's REAL two-person-control flow end to end, exactly
// as a Database Manager and AO would by hand (see routes/changes.js and
// applyChange.js) — nothing here writes to the database directly:
//   1. Prompts locally for a Database Manager login key + password, logs
//      in, fetches /api/state to look up the fixture's floor IDs by name,
//      and proposes 4 create_staff changes.
//   2. Prompts locally for an AO login key + password, logs in, and
//      approves all 4 proposals.
//   3. Prints a role/name/loginKey/temp-password table — shown ONCE, right
//      now, exactly like the real approval flow (see applyChange.js's
//      comment on why create_staff's password is never persisted anywhere
//      in plaintext after that one response).
//
// Credential handling: the Database Manager/AO login key and password
// entered at the prompts below are used for exactly one thing — the
// POST .../auth/login call to this app's own API — and are never logged,
// never written to a file, and never sent anywhere else. Typed input is
// NOT masked (plain node:readline/promises, no extra dependency for
// masking) — run this somewhere over-the-shoulder-safe, same as typing a
// password into any other local CLI tool.
//
// Reads the API's base URL from API_URL (e.g. API_URL=https://... node
// src/createTestStaff.js), defaulting to http://localhost:4000 for local dev.
// ============================================================================
import "dotenv/config";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

const API_URL = process.env.API_URL || "http://localhost:4000";

async function apiRequest(path, { method = "GET", body, token } = {}) {
  const res = await fetch(`${API_URL}/api${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${method} ${path} failed (${res.status})`);
  return data;
}

// Logs in and confirms the account is actually the role this step needs —
// a wrong-role login would otherwise fail later with a less obvious 403
// from POST /changes or /changes/:id/approve.
async function loginAs(rl, roleLabel, expectedRole) {
  console.log(`\n--- Log in as ${roleLabel} ---`);
  const loginKey = await rl.question(`${roleLabel} login key: `);
  const password = await rl.question(`${roleLabel} password: `);
  const { token, user } = await apiRequest("/auth/login", { method: "POST", body: { loginKey, password } });
  if (user.role !== expectedRole) {
    throw new Error(`That login key belongs to a ${user.role} account, not a ${expectedRole} — check the key and try again.`);
  }
  console.log(`Logged in as ${user.name} (${user.role}).`);
  return token;
}

async function main() {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    console.log("Creates the 4 staff accounts for the finalization-test fixture, through the real");
    console.log("Database Manager -> AO approval flow. Run `node src/seedFinalizationTest.js` first if you haven't.");

    const dbManagerToken = await loginAs(rl, "Database Manager", "DB_MANAGER");

    const state = await apiRequest("/state", { token: dbManagerToken });
    const collegeFloor = state.collegeFloors.find((f) => f.name === "Test College Floor");
    const floorA = state.hostelFloors.find((f) => f.name === "Test Hostel Floor A");
    const floorB = state.hostelFloors.find((f) => f.name === "Test Hostel Floor B");
    if (!collegeFloor || !floorA || !floorB) {
      throw new Error('Fixture floors not found — run `node src/seedFinalizationTest.js` first.');
    }

    const proposals = [
      { role: "WARDEN", name: "Test Warden A", floorIds: [floorA.id] },
      { role: "WARDEN", name: "Test Warden B", floorIds: [floorB.id] },
      { role: "DO", name: "Test DO", floorIds: [collegeFloor.id] },
      { role: "LECTURER", name: "Test Lecturer", floorIds: [collegeFloor.id] },
    ];

    console.log("\nProposing 4 create_staff changes...");
    const proposed = [];
    for (const p of proposals) {
      const summary = `[finalization test fixture] Create ${p.role} ${p.name}`;
      const { change } = await apiRequest("/changes", {
        method: "POST",
        token: dbManagerToken,
        body: { type: "create_staff", summary, payload: { role: p.role, name: p.name, floorIds: p.floorIds } },
      });
      proposed.push({ ...p, changeId: change.id, loginKey: change.payload.loginKey });
      console.log(`  Proposed: ${summary} (login key ${change.payload.loginKey})`);
    }

    const aoToken = await loginAs(rl, "AO", "AO");

    console.log("\nApproving all 4...");
    const created = [];
    for (const c of proposed) {
      const { password } = await apiRequest(`/changes/${c.changeId}/approve`, { method: "POST", token: aoToken });
      created.push({ role: c.role, name: c.name, loginKey: c.loginKey, password });
    }

    console.log("\nDone. These temp passwords are shown ONCE, right now — the same as the real approval flow");
    console.log("(see applyChange.js) — write them down before closing this terminal.\n");
    console.log("Role      Name              Login Key  Temp Password");
    console.log("--------  ----------------  ---------  -------------");
    for (const r of created) {
      console.log(`${r.role.padEnd(8)}  ${r.name.padEnd(16)}  ${r.loginKey.padEnd(9)}  ${r.password}`);
    }
  } finally {
    rl.close();
  }
}

main().catch((e) => {
  console.error("\nFailed:", e.message);
  process.exit(1);
});
