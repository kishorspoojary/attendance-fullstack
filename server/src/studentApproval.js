// ============================================================================
// Re-validates an add_student/bulk_add_students payload against the LIVE
// database from inside the approval transaction — the same "rebuild the
// plan, re-check against reality, then create" pattern structure_batch uses
// (see structureBatch.js), applied to student adds.
//
// Why this exists: a batch validates cleanly at PROPOSE time against
// whatever students already exist. But two Excel uploads for the same
// class, both proposed before either is approved, can each validate fine
// on their own — each only sees already-APPROVED students, not each
// other's still-pending rolls. If an AO approves both, the second one's
// rolls now collide with students the first one just created. Re-running
// the same roll/class/room checks here, right before the actual create,
// catches that staleness and aborts the whole transaction instead of
// creating a duplicate — see applyChange.js's "add_student" and
// "bulk_add_students" cases.
// ============================================================================
const norm = (s) => String(s ?? "").trim().toLowerCase();

// `client` is a transaction client (`tx`) from inside applyChange.js's
// prisma.$transaction — never the plain top-level `prisma`, so every read
// here sees a consistent snapshot with the create that follows it.
// `students` is always an array — add_student wraps its single payload
// object in one, bulk_add_students passes its `students` array as-is.
// Throws a plain Error with a message meant to be shown to the AO
// (routes/changes.js's /approve route already surfaces applyChange's
// thrown message as the response's `error`) the moment anything is stale;
// callers should let that abort the transaction rather than catching it.
export async function revalidateStudentsForApproval(client, students) {
  const classCache = new Map(); // classId -> Classroom | null
  const roomCache = new Map(); // roomId -> HostelRoom | null
  const existingRollsByClass = new Map(); // classId -> Set(normalized roll)
  const seenInThisBatch = new Map(); // classId -> Set(normalized roll)

  for (const s of students) {
    if (!classCache.has(s.classId)) {
      classCache.set(s.classId, await client.classroom.findUnique({ where: { id: s.classId } }));
    }
    const cls = classCache.get(s.classId);
    if (!cls) {
      throw new Error(`The class for "${s.name}" (roll ${s.roll}) no longer exists — this request is stale. Send it back or reject it.`);
    }

    if (!existingRollsByClass.has(s.classId)) {
      const existing = await client.student.findMany({ where: { classId: s.classId } });
      existingRollsByClass.set(s.classId, new Set(existing.map((e) => norm(e.roll))));
    }
    if (!seenInThisBatch.has(s.classId)) seenInThisBatch.set(s.classId, new Set());

    const rollKey = norm(s.roll);
    if (existingRollsByClass.get(s.classId).has(rollKey)) {
      throw new Error(`Roll no. "${s.roll}" now already exists in ${cls.name} — this request is stale. Send it back or reject it.`);
    }
    // Defense-in-depth: propose-time and edit-time validation
    // (validateImportRows) already reject in-batch duplicates, so this
    // should never actually fire — but if it somehow did (a bug in that
    // check, or a payload built some other way), this is the last line
    // before a real duplicate would be created.
    if (seenInThisBatch.get(s.classId).has(rollKey)) {
      throw new Error(`Roll no. "${s.roll}" is duplicated within this request — this shouldn't have passed validation. Send it back or reject it.`);
    }
    seenInThisBatch.get(s.classId).add(rollKey);

    if (s.roomId) {
      if (!roomCache.has(s.roomId)) {
        roomCache.set(s.roomId, await client.hostelRoom.findUnique({ where: { id: s.roomId } }));
      }
      if (!roomCache.get(s.roomId)) {
        throw new Error(`The room for "${s.name}" (roll ${s.roll}) no longer exists — this request is stale. Send it back or reject it.`);
      }
    }
  }
}