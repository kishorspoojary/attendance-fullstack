// ============================================================================
// What actually happens when an AO approves a PendingChange.
//
// The Database Manager never edits the real tables directly — every action
// (add a student, create a staff account, etc.) first creates a
// PendingChange row with status "pending" (see routes/changes.js). Only once
// an AO approves it does this file run, translating the change's `type` and
// `payload` into a real write against the actual tables.
// ============================================================================
import bcrypt from "bcryptjs";
import { generateTempPassword } from "./auth.js";
import { buildStructurePlan, createFromStructurePlan } from "./structureBatch.js";
import { revalidateStudentsForApproval, revalidateEditForApproval } from "./studentApproval.js";

// The re-validation above (revalidateStudentsForApproval /
// revalidateEditForApproval) is the primary defense, but it reads, then
// writes, in two separate steps — two concurrent approvals can both pass
// that read before either has written, then both attempt the write. That's
// exactly what Student.roll's database-level UNIQUE constraint (see the
// migration that added it) exists to catch. Without this, a real
// duplicate-roll race would surface as Prisma's raw "Unique constraint
// failed on the fields: (`roll`)" — technically correct, useless to an AO.
// Translates it into the same clear, actionable message the revalidation
// helpers already use elsewhere in this file.
export function isRollUniqueViolation(e) {
  if (e?.code !== "P2002") return false;
  const target = e.meta?.target;
  return Array.isArray(target) ? target.includes("roll") : String(target || "").toLowerCase().includes("roll");
}
async function withRollConstraintHandling(fn) {
  try {
    return await fn();
  } catch (e) {
    if (isRollUniqueViolation(e)) {
      throw new Error("A roll number in this request now collides with another student — this request is stale. Send it back or reject it.");
    }
    throw e;
  }
}

// Returns undefined for most change types. create_staff is the one
// exception — it returns { password }, the plaintext temp password for the
// account it just created, generated here at approval time (not earlier,
// at proposal time) specifically so it's never written to PendingChange.payload
// and only ever exists in the one response the approving AO gets back. See
// routes/changes.js's /approve route for where that response is built.
export async function applyChange(prisma, change) {
  const p = change.payload; // the data the Database Manager submitted, shape depends on change.type

  switch (change.type) {
    // Re-validated INSIDE the transaction, right before the create — a
    // batch that validated cleanly at propose time can go stale by
    // approval time (another batch for the same class got approved first,
    // introducing a roll collision neither proposal could have seen — see
    // studentApproval.js). A collision throws and rolls back the whole
    // transaction; nothing is created and the change is not marked approved.
    case "add_student":
      await prisma.$transaction(async (tx) => {
        await revalidateStudentsForApproval(tx, [p]);
        await withRollConstraintHandling(() => tx.student.create({
          data: {
            name: p.name, roll: p.roll, classId: p.classId, roomId: p.roomId || null,
            // Explicit tag wins if the Database Manager set one; otherwise
            // infer it from whether a hostel room was given.
            isLocal: p.isLocal !== undefined ? p.isLocal : !p.roomId,
          },
        }));
      });
      break;

    // One Excel upload becomes one PendingChange with an array of rows,
    // rather than one PendingChange per student — otherwise a 200-row
    // spreadsheet would mean 200 separate things for an AO to click through.
    // Created ONE AT A TIME, awaited in order — not createMany, and not
    // Promise.all — so each row's Student.seq is assigned strictly after
    // the previous row's, by construction. (createMany would very likely
    // preserve order too, since Postgres evaluates a multi-row VALUES
    // list's sequence defaults in the order the rows are given — but that
    // rests on an engine-level guarantee this app doesn't need to lean on
    // when a plain sequential loop makes the ordering airtight instead, at
    // the cost of N round trips instead of 1 — fine at the class-roster
    // sizes this app deals with.) Never reorder p.students before this.
    case "bulk_add_students":
      await prisma.$transaction(async (tx) => {
        await revalidateStudentsForApproval(tx, p.students);
        for (const s of p.students) {
          await withRollConstraintHandling(() => tx.student.create({
            data: {
              name: s.name, roll: s.roll, classId: s.classId, roomId: s.roomId || null,
              isLocal: s.isLocal !== undefined ? s.isLocal : !s.roomId,
            },
          }));
        }
      });
      break;

    // Re-validated INSIDE the transaction, same reasoning as add_student/
    // bulk_add_students above — but only the roll actually needs it (see
    // revalidateEditForApproval): this is the rare "college re-numbers a
    // student's roll" case, and that new number must still be unique
    // college-wide by the moment this actually runs, not just when it was
    // proposed.
    case "edit_student":
      await prisma.$transaction(async (tx) => {
        await revalidateEditForApproval(tx, p.studentId, p.changes);
        await withRollConstraintHandling(() => tx.student.update({
          where: { id: p.studentId },
          data: {
            ...(p.changes.name !== undefined && { name: p.changes.name }),
            ...(p.changes.roll !== undefined && { roll: p.changes.roll }),
            ...(p.changes.classId !== undefined && { classId: p.changes.classId }),
            ...(p.changes.roomId !== undefined && { roomId: p.changes.roomId || null }),
            ...(p.changes.isLocal !== undefined && { isLocal: p.changes.isLocal }),
          },
        }));
      });
      break;

    // Re-checked inside a transaction, same reasoning as
    // revalidateStudentsForApproval: two duplicate delete_student requests
    // for the same student (e.g. from a double-click before a busy guard
    // existed) can both sit in the pending queue, both looking valid. If an
    // AO approves one and then the other, the second must fail loudly
    // rather than silently no-op or throw Prisma's own less-clear
    // "record to update not found" error.
    case "delete_student":
      await prisma.$transaction(async (tx) => {
        const student = await tx.student.findUnique({ where: { id: p.studentId } });
        if (!student) throw new Error("This student no longer exists — likely already deleted by an earlier request.");
        await tx.student.delete({ where: { id: p.studentId } });
      });
      break;

    case "add_hostel":
      await prisma.hostel.create({ data: { name: p.name } });
      break;

    case "add_hostel_floor":
      await prisma.hostelFloor.create({ data: { name: p.name, hostelId: p.hostelId } });
      break;

    case "add_room":
      await prisma.hostelRoom.create({ data: { roomNo: p.roomNo, hostelFloorId: p.hostelFloorId } });
      break;

    case "add_college_floor":
      await prisma.collegeFloor.create({ data: { name: p.name } });
      break;

    case "add_class":
      await prisma.classroom.create({ data: { name: p.name, collegeFloorId: p.collegeFloorId } });
      break;

    // A whole draft tree of hostels/floors/rooms and college
    // floors/classrooms, approved as one unit. The plan is rebuilt (and
    // re-validated — names/parents could have changed since this was
    // proposed) from inside the transaction, so a validation failure here
    // rolls back every create in the batch rather than leaving it half done.
    case "structure_batch":
      await prisma.$transaction(async (tx) => {
        const plan = await buildStructurePlan(tx, p);
        await createFromStructurePlan(tx, plan);
      });
      break;

    case "assign_warden":
      // Wardens can cover several rooms at once, so we just overwrite their
      // whole roomIds list with whatever the Database Manager selected.
      await prisma.user.update({ where: { id: p.staffId }, data: { roomIds: p.roomIds } });
      break;

    case "assign_do":
    case "assign_teacher":
      // DOs and Incharge Teachers are "pooled" per CollegeFloor — several
      // staff can share the same floorIds, and any one of them can act.
      await prisma.user.update({ where: { id: p.staffId }, data: { floorIds: p.floorIds } });
      break;

    case "assign_lai":
      await prisma.user.update({ where: { id: p.staffId }, data: { classIds: p.classIds } });
      break;

    // Creates a brand-new Warden/LAI/DO/Incharge Teacher account. The login
    // key was already generated back when the Database Manager proposed
    // this (see routes/changes.js) — never here, so the same key that was
    // shown then is the one that actually ends up on the account.
    case "create_staff": {
      const password = generateTempPassword();
      const passwordHash = await bcrypt.hash(password, 10);
      await prisma.user.create({
        data: {
          name: p.name,
          role: p.role,
          loginKey: p.loginKey,
          passwordHash,
          status: "ACTIVE",
          mustSetPassword: true,
          roomIds: p.roomIds || [],
          floorIds: p.floorIds || [],
          classIds: p.classIds || [],
        },
      });
      return { password };
    }

    default:
      // Should never happen unless the frontend sends a type we don't
      // recognize — fail loudly rather than silently doing nothing.
      throw new Error(`Unknown change type: ${change.type}`);
  }
}
