// ============================================================================
// Shared logic for "structure_batch" PendingChange rows — a Database
// Manager's draft tree of hostels -> floors -> rooms and college floors ->
// classrooms, submitted and approved as a single unit instead of one
// PendingChange per item (see routes/structure.js and applyChange.js).
//
// buildStructurePlan() is the single source of truth for validating a draft
// payload against the live database (existence of referenced parents, no
// duplicate names) and turning it into a "plan" — the same shape as the
// payload, but with every hostel/floor/college-floor entry resolved to
// either {kind:"existing", id} or {kind:"new", name}. It's called three
// times: at propose time and at edit/resubmit time (both just dry runs, to
// produce a validation error or a summary string), and again at approval
// time — that last call is made with the transaction client (`tx`) instead
// of the plain `prisma` client, and re-validates against the live DB from
// inside the transaction. That's what makes a batch that went stale between
// propose and approve (e.g. someone else already created that hostel name)
// fail the whole transaction instead of partially applying — see
// applyChange.js's "structure_batch" case.
//
// Room numbers and classroom names are leaves, never referenced as existing
// parents — every one listed always gets created. Only hostels, hostel
// floors, and college floors can point at an existing row instead of being
// created (existingHostelId / existingFloorId / existingCollegeFloorId).
// ============================================================================

function normName(s) {
  return String(s ?? "").trim();
}
function key(s) {
  return normName(s).toLowerCase();
}
function plural(n, word, pluralWord) {
  return `${n} ${n === 1 ? word : pluralWord || `${word}s`}`;
}

async function resolveHostel(client, entry, seenNames) {
  if (entry.existingHostelId && entry.name) {
    throw new Error("A hostel entry can't have both a name and existingHostelId");
  }
  if (entry.existingHostelId) {
    const hostel = await client.hostel.findUnique({ where: { id: entry.existingHostelId } });
    if (!hostel) throw new Error(`Referenced hostel (${entry.existingHostelId}) doesn't exist`);
    return { kind: "existing", id: hostel.id, name: hostel.name };
  }
  const name = normName(entry.name);
  if (!name) throw new Error("Every hostel needs a name, or must reference an existing one");
  const k = key(name);
  if (seenNames.has(k)) throw new Error(`Duplicate hostel name in this batch: "${name}"`);
  const existing = await client.hostel.findFirst({ where: { name: { equals: name, mode: "insensitive" } } });
  if (existing) throw new Error(`A hostel named "${name}" already exists`);
  seenNames.add(k);
  return { kind: "new", name };
}

async function resolveHostelFloor(client, entry, hostel, seenNames) {
  if (entry.existingFloorId && entry.name) {
    throw new Error("A floor entry can't have both a name and existingFloorId");
  }
  if (entry.existingFloorId) {
    if (hostel.kind === "new") {
      throw new Error(`"${hostel.name}" is a brand-new hostel — it can't have a floor that references an existing floor`);
    }
    const floor = await client.hostelFloor.findUnique({ where: { id: entry.existingFloorId } });
    if (!floor) throw new Error(`Referenced floor (${entry.existingFloorId}) doesn't exist`);
    if (floor.hostelId !== hostel.id) throw new Error(`Floor "${floor.name}" doesn't belong to hostel "${hostel.name}"`);
    return { kind: "existing", id: floor.id, name: floor.name };
  }
  const name = normName(entry.name);
  if (!name) throw new Error("Every floor needs a name, or must reference an existing one");
  const k = key(name);
  if (seenNames.has(k)) throw new Error(`Duplicate floor name "${name}" under hostel "${hostel.name}"`);
  if (hostel.kind === "existing") {
    const existing = await client.hostelFloor.findFirst({ where: { hostelId: hostel.id, name: { equals: name, mode: "insensitive" } } });
    if (existing) throw new Error(`Hostel "${hostel.name}" already has a floor named "${name}"`);
  }
  seenNames.add(k);
  return { kind: "new", name };
}

async function resolveRooms(client, roomsIn, floor) {
  const seen = new Set();
  const rooms = [];
  for (const raw of Array.isArray(roomsIn) ? roomsIn : []) {
    const roomNo = normName(raw);
    if (!roomNo) continue;
    const k = key(roomNo);
    if (seen.has(k)) throw new Error(`Duplicate room "${roomNo}" under floor "${floor.name}"`);
    if (floor.kind === "existing") {
      const existing = await client.hostelRoom.findFirst({ where: { hostelFloorId: floor.id, roomNo: { equals: roomNo, mode: "insensitive" } } });
      if (existing) throw new Error(`Floor "${floor.name}" already has room "${roomNo}"`);
    }
    seen.add(k);
    rooms.push(roomNo);
  }
  return rooms;
}

async function resolveCollegeFloor(client, entry, seenNames) {
  if (entry.existingCollegeFloorId && entry.name) {
    throw new Error("A college floor entry can't have both a name and existingCollegeFloorId");
  }
  if (entry.existingCollegeFloorId) {
    const floor = await client.collegeFloor.findUnique({ where: { id: entry.existingCollegeFloorId } });
    if (!floor) throw new Error(`Referenced college floor (${entry.existingCollegeFloorId}) doesn't exist`);
    return { kind: "existing", id: floor.id, name: floor.name };
  }
  const name = normName(entry.name);
  if (!name) throw new Error("Every college floor needs a name, or must reference an existing one");
  const k = key(name);
  if (seenNames.has(k)) throw new Error(`Duplicate college floor name in this batch: "${name}"`);
  const existing = await client.collegeFloor.findFirst({ where: { name: { equals: name, mode: "insensitive" } } });
  if (existing) throw new Error(`A college floor named "${name}" already exists`);
  seenNames.add(k);
  return { kind: "new", name };
}

async function resolveClassrooms(client, classroomsIn, floor) {
  const seen = new Set();
  const classrooms = [];
  for (const raw of Array.isArray(classroomsIn) ? classroomsIn : []) {
    const name = normName(raw);
    if (!name) continue;
    const k = key(name);
    if (seen.has(k)) throw new Error(`Duplicate class "${name}" under college floor "${floor.name}"`);
    if (floor.kind === "existing") {
      const existing = await client.classroom.findFirst({ where: { collegeFloorId: floor.id, name: { equals: name, mode: "insensitive" } } });
      if (existing) throw new Error(`College floor "${floor.name}" already has a class named "${name}"`);
    }
    seen.add(k);
    classrooms.push(name);
  }
  return classrooms;
}

// Validates `payload` against `client` (either the plain `prisma` client for
// a dry run, or a transaction's `tx` for a live, atomic check) and returns a
// fully-resolved plan. Throws a plain Error with a human-readable message on
// any problem — every route that calls this turns that into a 400.
export async function buildStructurePlan(client, payload) {
  const hostelsIn = Array.isArray(payload?.hostels) ? payload.hostels : [];
  const collegeFloorsIn = Array.isArray(payload?.collegeFloors) ? payload.collegeFloors : [];

  const counts = { hostels: 0, floors: 0, rooms: 0, collegeFloors: 0, classrooms: 0 };
  const seenHostelNames = new Set();
  const seenCollegeFloorNames = new Set();

  const hostels = [];
  for (const h of hostelsIn) {
    const hostel = await resolveHostel(client, h, seenHostelNames);
    if (hostel.kind === "new") counts.hostels++;

    const seenFloorNames = new Set();
    const floors = [];
    for (const f of Array.isArray(h.floors) ? h.floors : []) {
      const floor = await resolveHostelFloor(client, f, hostel, seenFloorNames);
      if (floor.kind === "new") counts.floors++;
      const rooms = await resolveRooms(client, f.rooms, floor);
      counts.rooms += rooms.length;
      floors.push({ ...floor, rooms });
    }
    hostels.push({ ...hostel, floors });
  }

  const collegeFloors = [];
  for (const cf of collegeFloorsIn) {
    const floor = await resolveCollegeFloor(client, cf, seenCollegeFloorNames);
    if (floor.kind === "new") counts.collegeFloors++;
    const classrooms = await resolveClassrooms(client, cf.classrooms, floor);
    counts.classrooms += classrooms.length;
    collegeFloors.push({ ...floor, classrooms });
  }

  const total = counts.hostels + counts.floors + counts.rooms + counts.collegeFloors + counts.classrooms;
  if (total === 0) {
    throw new Error("Nothing to submit — add at least one hostel, floor, room, or class first");
  }

  const parts = [];
  if (counts.hostels) parts.push(plural(counts.hostels, "hostel"));
  if (counts.floors) parts.push(plural(counts.floors, "floor"));
  if (counts.rooms) parts.push(plural(counts.rooms, "room"));
  if (counts.collegeFloors) parts.push(plural(counts.collegeFloors, "college floor"));
  if (counts.classrooms) parts.push(plural(counts.classrooms, "class", "classes"));

  return { hostels, collegeFloors, counts, total, summary: parts.join(", ") };
}

// Walks an already-built plan and actually creates the rows. Only ever
// called with a transaction client, immediately after re-building the plan
// against that same transaction — see applyChange.js.
export async function createFromStructurePlan(tx, plan) {
  for (const h of plan.hostels) {
    const hostelId = h.kind === "new" ? (await tx.hostel.create({ data: { name: h.name } })).id : h.id;
    for (const f of h.floors) {
      const floorId = f.kind === "new" ? (await tx.hostelFloor.create({ data: { name: f.name, hostelId } })).id : f.id;
      if (f.rooms.length > 0) {
        await tx.hostelRoom.createMany({ data: f.rooms.map((roomNo) => ({ roomNo, hostelFloorId: floorId })) });
      }
    }
  }
  for (const cf of plan.collegeFloors) {
    const floorId = cf.kind === "new" ? (await tx.collegeFloor.create({ data: { name: cf.name } })).id : cf.id;
    if (cf.classrooms.length > 0) {
      await tx.classroom.createMany({ data: cf.classrooms.map((name) => ({ name, collegeFloorId: floorId })) });
    }
  }
}