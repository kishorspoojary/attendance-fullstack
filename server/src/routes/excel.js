// ============================================================================
// Excel support for the Database Manager: download a per-class template,
// upload a filled one to bulk-add students to that class, or export a
// class's current student list.
//
// Import still goes through the same PendingChange + AO-approval flow as
// every other Database Manager action (see routes/changes.js) — a filled
// sheet becomes ONE PendingChange of type "bulk_add_students" rather than
// one per row, so an AO can review and approve it in one click.
//
// The template is generated per class rather than generic, because a
// generic sheet let people type a class or hostel name that doesn't exist
// ("class 10", "Boys Hostal A") and only find out at upload time. Making
// the class implicit (baked into the file, not a column) and turning
// "hostel or day scholar" into an in-cell dropdown makes most of that class
// of typo simply impossible to enter in the first place.
//
// A HARD-WON LESSON baked into this file: exceljs has a couple of API
// corners that silently do nothing instead of erroring, and the previous
// version of this file tripped both:
//   1. `sheet.columns = [...]` REPLACES the entire column collection. Any
//      per-column property (like `hidden`) set before that reassignment —
//      even on a different column — gets silently wiped. Every column
//      property for a sheet is therefore set in exactly ONE `.columns =`
//      assignment, and nothing later ever reassigns `.columns` again.
//   2. `row.values = { 1: "x", 2: "y" }` (object form) writes NOTHING —
//      the row comes back empty, with no error. Only the array form
//      (`row.values = ["x", "y"]`, index 0 = column A) or explicit
//      `row.getCell(n).value = ...` actually work. This file only uses
//      the latter, cell-by-cell, to stay unambiguous.
// Both were caught by unzipping a real generated .xlsx and inspecting the
// raw sheet/workbook XML — the exceljs-object-level round-trip a Node test
// does is not proof the bytes on disk are right; see verifyTemplateXml() in
// the (non-committed) test script this fix was verified with.
// ============================================================================
import { Router } from "express";
import multer from "multer";
import ExcelJS from "exceljs";
import { prisma } from "../db.js";
import { requireAuth, requireRole } from "../auth.js";

export const excelRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const DAY_SCHOLAR = "Day scholar";
const HEADERS = ["Roll no.", "Name", "Hostel / day scholar", "Room"];
const TITLE_ROW = 1;
const HEADER_ROW = 2;
const FIRST_DATA_ROW = 3;
const LAST_VALIDATED_ROW = FIRST_DATA_ROW + 497; // "generous" range per spec — ~500 rows total

const REFERENCE_SHEET = "Reference";
// The class id lives ONLY here: a hidden column on the protected Reference
// sheet, never on the Students sheet at all (that's the whole fix for "the
// class id is visible on the Students sheet"), plus a workbook-level
// defined name pointing at it so the upload endpoint can find it even if
// this cell ever moves. White font is a third, redundant layer in case a
// resave ever strips the hidden-column flag — see readClassIdFromWorkbook.
const CLASS_ID_CELL = "H1";
const CLASS_ID_RANGE = `'${REFERENCE_SHEET}'!$H$1`;
const CLASS_ID_DEFINED_NAME = "VigilClassId";

function sendWorkbook(res, workbook, filename) {
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return workbook.xlsx.write(res);
}
function sanitizeFilenamePart(s) {
  return String(s || "").trim().replace(/[^a-zA-Z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "class";
}
const norm = (s) => String(s ?? "").trim().toLowerCase();

// Every existing student, college-wide, as a Map of normalized roll -> the
// name of the class they're currently in — the shape validateImportRows'
// existingRollOwners expects. Not scoped to any one class: roll uniqueness
// is global, so a colliding student may well be in a different class than
// whichever one is being uploaded to, and that's exactly what the error
// message needs to say. Shared by the upload route below and
// routes/changes.js's PUT /changes/:id (the sent-back-batch edit-and-
// resubmit flow), which both need this same global lookup.
export async function fetchExistingRollOwners(client) {
  const students = await client.student.findMany({ include: { class: true } });
  const owners = new Map();
  for (const s of students) owners.set(norm(s.roll), s.class?.name || "another class");
  return owners;
}

// exceljs's row.values doesn't always hand back a plain string/number for a
// cell — a formula cell comes back as { formula, result, ... }, rich text
// as { richText: [{ text }, ...] }, a hyperlink as { text, hyperlink }. The
// previous version of this file did `String(values[n] ?? "").trim()`
// directly, which for any of those turns into the literal string
// "[object Object]" instead of the cell's actual displayed value — this is
// exactly how two rows that visually showed the same roll number (one a
// plain value, one a formula referencing it, e.g. from a dragged fill
// handle) slipped past in-sheet duplicate detection: the formula row's
// "roll" normalized to "[object Object]", not the number, so it never
// collided with the other row at all. Recurses through result/richText/text
// so a formula-that-returns-rich-text (unlikely, but exceljs allows it)
// still resolves to plain text rather than falling through to "".
export function cellToPlainString(raw) {
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "object") {
    if (raw instanceof Date) return raw.toISOString();
    if ("result" in raw) return cellToPlainString(raw.result); // formula cell — use the evaluated value
    if (Array.isArray(raw.richText)) return raw.richText.map((r) => r.text).join("");
    if ("text" in raw) return cellToPlainString(raw.text); // hyperlink cell
    return ""; // an error cell ({ error: "#REF!" }) or anything unrecognized — treat as blank, not "[object Object]"
  }
  return String(raw);
}

function fillCell(cell, argb) {
  cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb } };
}

// Column widths + the title row + the bold/filled header row + the cell
// note explaining columns C/D + frozen panes. Shared by the template and
// the export, since both are "Students" sheets with the same four columns
// — the template additionally gets an example row and a dropdown (see
// buildStudentTemplateWorkbook), neither of which the export needs.
function writeStudentsSheetHeader(sheet, cls) {
  sheet.columns = [{ width: 14 }, { width: 24 }, { width: 26 }, { width: 12 }];

  const titleCell = sheet.getCell(`A${TITLE_ROW}`);
  titleCell.value = `Class: ${cls.name}`;
  titleCell.font = { bold: true, size: 13 };
  fillCell(titleCell, "FFBDD7EE");
  sheet.mergeCells(`A${TITLE_ROW}:D${TITLE_ROW}`);
  sheet.getRow(TITLE_ROW).height = 22;

  const headerRow = sheet.getRow(HEADER_ROW);
  HEADERS.forEach((h, i) => { headerRow.getCell(i + 1).value = h; });
  headerRow.eachCell((cell) => { cell.font = { bold: true }; fillCell(cell, "FFE7ECF3"); });
  sheet.getCell(`C${HEADER_ROW}`).note =
    'Column C: choose "Day scholar" or a hostel from the dropdown.\nColumn D: room number, only for hostellers — see the Reference sheet for valid values.';

  sheet.views = [{ state: "frozen", ySplit: HEADER_ROW }];
}

// A real example row, styled and roll-flagged so the upload endpoint can
// reliably skip it if it's still there — see the "example" check in
// validateImportRows below. Written cell-by-cell (never `row.values = {...}`
// object form — see the file-level comment on why).
function addExampleRow(sheet, hostels, hostelFloors, hostelRooms) {
  let exampleHostelOrDay = DAY_SCHOLAR;
  let exampleRoom = "";
  if (hostels.length > 0) {
    const firstHostel = hostels[0];
    const floorsOfHostel = hostelFloors.filter((f) => f.hostelId === firstHostel.id);
    const room = hostelRooms.find((r) => floorsOfHostel.some((f) => f.id === r.hostelFloorId));
    if (room) { exampleHostelOrDay = firstHostel.name; exampleRoom = room.roomNo; }
  }
  const row = sheet.getRow(FIRST_DATA_ROW);
  ["EXAMPLE", "Example Student — delete this row", exampleHostelOrDay, exampleRoom].forEach((v, i) => { row.getCell(i + 1).value = v; });
  row.eachCell({ includeEmpty: true }, (cell) => {
    cell.font = { italic: true, color: { argb: "FF888888" } };
    fillCell(cell, "FFF2F2F2");
  });
}

// Column C's in-cell dropdown: "Day scholar" first, then every approved
// hostel name, sourced from a hidden column on the Reference sheet (a range
// reference rather than an inline list, so it isn't limited by Excel's
// ~255-char inline-list length once there are several hostels with long
// names).
function applyHostelDropdown(sheet, listRangeRef) {
  // One dataValidation covering the whole range, not a per-cell loop — the
  // loop used to assign an equal-but-distinct rule object to every cell,
  // which exceljs serialized as two overlapping <dataValidation> sqref
  // ranges (e.g. "C10:C500" and "C3:C500") instead of one clean "C3:C500".
  // Functionally harmless (their union had no gaps), but pointless.
  sheet.dataValidations.add(`C${FIRST_DATA_ROW}:C${LAST_VALIDATED_ROW}`, {
    type: "list",
    allowBlank: false,
    formulae: [listRangeRef],
    showErrorMessage: true,
    errorStyle: "stop",
    errorTitle: "Invalid entry",
    error: 'Choose "Day scholar" or one of the approved hostel names from the dropdown.',
  });
}

// The hidden class-id cell + workbook-level defined name — the one piece
// every Reference sheet needs, whether or not it also carries the
// hostel/room lookup table (template only). Split out so the template and
// the export both go through this exact same code path instead of
// duplicating the hidden-cell/defined-name logic in two places — the
// export's earlier bug was precisely that it never called anything that
// wrote this at all, not that a resave had stripped it.
function writeClassIdMarker(workbook, ref, cls) {
  const classIdCell = ref.getCell(CLASS_ID_CELL);
  classIdCell.value = cls.id;
  classIdCell.font = { color: { argb: "FFFFFFFF" } }; // white-on-white: a redundant layer even if the hidden-column flag is ever stripped by a resave
  workbook.definedNames.add(CLASS_ID_RANGE, CLASS_ID_DEFINED_NAME);
}

// The read-only lookup sheet: a human-readable Hostel/Floor/Room table for
// people to check column D values against, plus (in hidden columns, never
// part of that visible table) the exact dropdown source list for column C
// and the class id itself. Protected so it reads as clearly not-for-editing.
// Template-only — see addMinimalReferenceSheet for the export's stripped-down
// equivalent, which needs the class-id marker but not the lookup table.
async function addReferenceSheet(workbook, hostels, hostelFloors, hostelRooms, cls) {
  const ref = workbook.addWorksheet(REFERENCE_SHEET);

  // ONE column assignment for the whole sheet: widths for the visible
  // Hostel/Floor/Room table (A-C), a spacer (E), the hidden dropdown-source
  // column (F), another spacer (G), and the hidden class-id column (H).
  // See the file-level comment for why this can't be split into multiple
  // `.columns =` assignments or later per-column mutations.
  ref.columns = [{ width: 22 }, { width: 22 }, { width: 22 }, {}, {}, { width: 34, hidden: true }, {}, { width: 20, hidden: true }];

  ref.getRow(1).values = ["Hostel", "Floor", "Room"];
  ref.getRow(1).eachCell((cell) => { cell.font = { bold: true }; fillCell(cell, "FFE7ECF3"); });
  for (const h of hostels) {
    for (const f of hostelFloors.filter((x) => x.hostelId === h.id)) {
      for (const room of hostelRooms.filter((x) => x.hostelFloorId === f.id)) {
        ref.addRow([h.name, f.name, room.roomNo]);
      }
    }
  }

  const dropdownOptions = [DAY_SCHOLAR, ...hostels.map((h) => h.name)];
  ref.getCell("F1").value = "Valid entries for Students!C (internal — do not edit)";
  dropdownOptions.forEach((opt, i) => { ref.getCell(`F${i + 2}`).value = opt; });

  writeClassIdMarker(workbook, ref, cls);

  await ref.protect("", { selectLockedCells: true, selectUnlockedCells: true });
  return `'${REFERENCE_SHEET}'!$F$2:$F$${dropdownOptions.length + 1}`;
}

// The export's equivalent of addReferenceSheet — same hidden class-id
// marker (so an edited-and-reuploaded export resolves its class exactly
// like a template does), but deliberately WITHOUT the hostel/room lookup
// table or the dropdown-source column, which are template-only concerns
// (an export's column C/D values are already real, current data, not
// something someone needs a lookup sheet to fill in from scratch).
async function addMinimalReferenceSheet(workbook, cls) {
  const ref = workbook.addWorksheet(REFERENCE_SHEET);
  ref.columns = [{}, {}, {}, {}, {}, {}, {}, { width: 20, hidden: true }]; // only column H (the class-id cell) needs a real column property
  writeClassIdMarker(workbook, ref, cls);
  await ref.protect("", { selectLockedCells: true, selectUnlockedCells: true });
}

// Reads the class id back out of an uploaded workbook. Primary: the
// workbook-level defined name (Formulas > Name Manager in Excel — genuinely
// invisible while browsing sheets, unlike a column someone could unhide).
// Falls back to reading the fixed Reference!H1 cell directly, in case the
// defined name itself didn't survive a resave in some other tool.
export function readClassIdFromWorkbook(workbook) {
  try {
    const ranges = workbook.definedNames.getRanges(CLASS_ID_DEFINED_NAME)?.ranges || [];
    for (const range of ranges) {
      const m = range.match(/^(?:'([^']+)'|([^!]+))!\$?([A-Z]+)\$?(\d+)$/);
      if (!m) continue;
      const sheet = workbook.getWorksheet(m[1] || m[2]);
      const v = sheet?.getCell(`${m[3]}${m[4]}`).value;
      if (v) return String(v).trim();
    }
  } catch {
    // fall through to the direct-cell fallback below
  }
  const ref = workbook.getWorksheet(REFERENCE_SHEET);
  const v = ref?.getCell(CLASS_ID_CELL).value;
  return v ? String(v).trim() : "";
}

// Exported so it can be exercised directly with fixture data — both by the
// route below and by a standalone script that unzips the real output and
// inspects the raw XML (see the file-level comment on why that matters).
export async function buildStudentTemplateWorkbook({ cls, hostels, hostelFloors, hostelRooms }) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Students");
  writeStudentsSheetHeader(sheet, cls);
  addExampleRow(sheet, hostels, hostelFloors, hostelRooms);

  const listRangeRef = await addReferenceSheet(workbook, hostels, hostelFloors, hostelRooms, cls);
  applyHostelDropdown(sheet, listRangeRef);

  return workbook;
}

export async function buildStudentExportWorkbook({ cls, students }) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Students");
  writeStudentsSheetHeader(sheet, cls);
  students.forEach((s, i) => {
    const hostelName = s.room?.hostelFloor?.hostel?.name;
    const row = sheet.getRow(FIRST_DATA_ROW + i);
    [s.roll, s.name, hostelName || DAY_SCHOLAR, s.room?.roomNo || ""].forEach((v, j) => { row.getCell(j + 1).value = v; });
  });

  await addMinimalReferenceSheet(workbook, cls);

  return workbook;
}

excelRouter.get("/excel/students/template", requireAuth, requireRole("DB_MANAGER"), async (req, res) => {
  const { classId } = req.query;
  if (!classId) return res.status(400).json({ error: "classId is required" });
  const cls = await prisma.classroom.findUnique({ where: { id: classId } });
  if (!cls) return res.status(404).json({ error: "Class not found" });

  const [hostels, hostelFloors, hostelRooms] = await Promise.all([
    prisma.hostel.findMany({ orderBy: { name: "asc" } }),
    prisma.hostelFloor.findMany({ orderBy: { name: "asc" } }),
    prisma.hostelRoom.findMany({ orderBy: { roomNo: "asc" } }),
  ]);

  const workbook = await buildStudentTemplateWorkbook({ cls, hostels, hostelFloors, hostelRooms });
  await sendWorkbook(res, workbook, `vigil_students_${sanitizeFilenamePart(cls.name)}.xlsx`);
});

excelRouter.get("/excel/students/export", requireAuth, requireRole("DB_MANAGER"), async (req, res) => {
  const { classId } = req.query;
  if (!classId) return res.status(400).json({ error: "classId is required" });
  const cls = await prisma.classroom.findUnique({ where: { id: classId } });
  if (!cls) return res.status(404).json({ error: "Class not found" });

  const students = await prisma.student.findMany({
    where: { classId },
    orderBy: { seq: "asc" }, // entry order, not roll — see schema.prisma's comment on Student.seq
    include: { room: { include: { hostelFloor: { include: { hostel: true } } } } },
  });

  const workbook = await buildStudentExportWorkbook({ cls, students });
  await sendWorkbook(res, workbook, `vigil_students_${sanitizeFilenamePart(cls.name)}_export.xlsx`);
});

// Everyone absent on a given date — same roll/name/class shape as the
// Database Manager's read-only Absentees view, combining Warden/LAI-reported
// absentees for that date with students currently flagged "away".
excelRouter.get("/excel/absentees/export", requireAuth, requireRole("DB_MANAGER"), async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "date is required" });

  const [records, classes, students] = await Promise.all([
    prisma.attendanceRecord.findMany({ where: { date } }),
    prisma.classroom.findMany(),
    prisma.student.findMany(),
  ]);
  const recordByClassId = Object.fromEntries(records.map((r) => [r.classId, r]));

  // Same reason resolution as the client's AbsenteesView: a Warden's
  // wardenAbsences entry (may have a reason), an LAI's laiAbsences entry
  // (schema.prisma notes LAI never sets a reason, hence "—"), or the
  // persistent away flag on the student — at most one applies per student.
  const resolveReason = (studentId, record, student) => {
    const wardenEntry = record?.wardenAbsences?.[studentId];
    if (wardenEntry) return wardenEntry.reason || "—";
    if (record?.laiAbsences?.[studentId]) return "—";
    if (student.awayReason) return `${student.awayReason} (away)`;
    return "—";
  };

  const rows = [];
  for (const c of classes) {
    const r = recordByClassId[c.id];
    const ids = new Set([...Object.keys(r?.wardenAbsences || {}), ...Object.keys(r?.laiAbsences || {})]);
    students.filter((s) => s.classId === c.id && s.awayReason).forEach((s) => ids.add(s.id));
    for (const sid of ids) {
      const student = students.find((s) => s.id === sid);
      if (student) rows.push({ roll: student.roll, name: student.name, className: c.name, reason: resolveReason(sid, r, student) });
    }
  }
  // Grouped by class (contiguous blocks), roll order within each — sorting
  // by className first is what makes this "grouped" in a plain worksheet.
  rows.sort((a, b) => a.className.localeCompare(b.className) || a.roll.localeCompare(b.roll));

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Absentees");
  sheet.addRow(["Roll Number", "Name", "Class / Batch", "Reason"]).font = { bold: true };
  rows.forEach((r) => sheet.addRow([r.roll, r.name, r.className, r.reason]));
  sheet.columns.forEach((col) => { col.width = 20; });

  await sendWorkbook(res, workbook, `absentees-${date}.xlsx`);
});

// The actual per-row rules (section 3 of the spec): required fields, roll
// uniqueness (within the sheet, and against EVERY existing student
// college-wide — not scoped to the class being uploaded to, since roll
// numbers are unique across the whole institution), the hostel-or-day-
// scholar choice, and the room/hostel cross-check. Pure — no exceljs or
// Prisma calls — so it's testable against a plain fixture. `rows` is
// already-extracted {rowNumber, roll, name, hostelOrDay, roomNo} per row;
// blank rows should already be filtered out by the caller (a blank row
// isn't an error, just nothing to validate). `existingRollOwners` is a Map
// of normalized roll -> the class name of whichever existing student
// already has it (anywhere in the college), not a Set — the error needs to
// say WHICH class, since it's often not the one being uploaded to.
export function validateImportRows(rows, { classId, className, hostels, hostelFloors, hostelRooms, existingRollOwners }) {
  const seenRollsInSheet = new Set();
  const toAdd = [];
  const errors = [];

  for (const { rowNumber, roll, name, hostelOrDay, roomNo } of rows) {
    if (!roll && !name && !hostelOrDay && !roomNo) continue; // fully blank row, ignore silently
    if (norm(roll) === "example") continue; // the untouched example row, ignore silently

    const rowLabel = `Row ${rowNumber}`;
    if (!roll || !name) { errors.push(`${rowLabel}: roll no. and name are both required`); continue; }

    const rollKey = norm(roll);
    if (seenRollsInSheet.has(rollKey)) { errors.push(`${rowLabel}: roll no. "${roll}" is duplicated within this sheet`); continue; }
    const existingOwnerClass = existingRollOwners.get(rollKey);
    if (existingOwnerClass) { errors.push(`${rowLabel}: roll no. "${roll}" already exists (currently in ${existingOwnerClass})`); continue; }

    if (!hostelOrDay) { errors.push(`${rowLabel}: choose "Day scholar" or a hostel in column C`); continue; }

    let roomId = null;
    let isLocal;
    if (norm(hostelOrDay) === norm(DAY_SCHOLAR)) {
      isLocal = true;
      if (roomNo) { errors.push(`${rowLabel}: room must be left empty for a day scholar`); continue; }
    } else {
      const hostel = hostels.find((h) => norm(h.name) === norm(hostelOrDay));
      if (!hostel) { errors.push(`${rowLabel}: "${hostelOrDay}" isn't "Day scholar" or an approved hostel name`); continue; }
      isLocal = false;
      if (!roomNo) { errors.push(`${rowLabel}: room is required for a hostel student`); continue; }
      const floorsOfHostel = hostelFloors.filter((f) => f.hostelId === hostel.id);
      const room = hostelRooms.find((r) => floorsOfHostel.some((f) => f.id === r.hostelFloorId) && norm(r.roomNo) === norm(roomNo));
      if (!room) { errors.push(`${rowLabel}: room "${roomNo}" not found in ${hostel.name}`); continue; }
      roomId = room.id;
    }

    seenRollsInSheet.add(rollKey);
    toAdd.push({ name, roll, classId, roomId, isLocal });
  }

  return { toAdd, errors };
}

// "Cheap hardening" (per the bug report): catches the common case of two
// still-pending requests colliding on roll number before either is even
// approved, rather than leaving it entirely to studentApproval.js's
// in-transaction re-check at approval time — that re-check is still the
// real safety net (this is just a nicer, earlier error), since a THIRD
// request could always slip in between this check and the eventual
// approval. Roll uniqueness is global (college-wide, not per-class), so
// this matches on roll alone — two pending requests for DIFFERENT classes
// still collide if they use the same roll number. Pure — takes
// already-fetched PendingChange rows, not a Prisma client — for a direct
// test. excludeChangeId lets the edit route (PUT /changes/:id) skip
// comparing a batch against itself.
export function findPendingRollCollision(pendingChanges, roll, excludeChangeId) {
  const rollKey = norm(roll);
  for (const c of pendingChanges) {
    if (c.id === excludeChangeId || c.status !== "pending") continue;
    if (c.type === "add_student" && norm(c.payload?.roll) === rollKey) return c;
    if (c.type === "bulk_add_students" && Array.isArray(c.payload?.students)) {
      if (c.payload.students.some((s) => norm(s.roll) === rollKey)) return c;
    }
    // A sync's `adds` are shaped exactly like bulk_add_students' `students` —
    // both are validateImportRows' toAdd output — so the same check applies.
    if (c.type === "sync_class_students" && Array.isArray(c.payload?.adds)) {
      if (c.payload.adds.some((s) => norm(s.roll) === rollKey)) return c;
    }
  }
  return null;
}

// A student's CURRENT hostel/room, as the same {hostelOrDay, roomNo} display
// strings a sheet row uses — so diffAndValidateRoster can compare "what the
// sheet says" against "what's actually in the database" with one equality
// check per field, canonical-vs-canonical (never raw sheet text against a
// resolved name, which would false-positive on case/whitespace alone).
function resolveStudentHostelRoom(student, hostels, hostelFloors, hostelRooms) {
  if (student.isLocal || !student.roomId) return { hostelOrDay: DAY_SCHOLAR, roomNo: "" };
  const room = hostelRooms.find((r) => r.id === student.roomId);
  const floor = room && hostelFloors.find((f) => f.id === room.hostelFloorId);
  const hostel = floor && hostels.find((h) => h.id === floor.hostelId);
  return { hostelOrDay: hostel?.name || "?", roomNo: room?.roomNo || "" };
}

// The SYNC counterpart to validateImportRows: instead of every row needing
// to be a brand-new student (rejecting any roll that already exists), a row
// whose roll matches a student ALREADY IN THIS CLASS is a "keep" (and an
// "edit" if any field differs), a roll that exists nowhere is an "add", a
// roll that belongs to a DIFFERENT class is a row-level error (roster
// uploads don't move students between classes — see the Move-feature
// message below), and any of THIS CLASS's current students whose roll never
// appears in the sheet is a "removal". `order` is every row's roll in sheet
// sequence (adds + kept/edited, never removals) — what Student.seq gets
// renumbered to on approval, so the roster's on-screen order always matches
// the sheet's row order. Pure — no exceljs or Prisma calls — for a direct
// test, same reasoning as validateImportRows.
export function diffAndValidateRoster(rows, { classId, className, hostels, hostelFloors, hostelRooms, existingStudentsInClass, existingRollOwners }) {
  const existingByRoll = new Map(existingStudentsInClass.map((s) => [norm(s.roll), s]));
  const seenRollsInSheet = new Set();
  const errors = [];
  const adds = [];
  const edits = [];
  const order = [];

  for (const { rowNumber, roll, name, hostelOrDay, roomNo } of rows) {
    if (!roll && !name && !hostelOrDay && !roomNo) continue; // fully blank row, ignore silently
    if (norm(roll) === "example") continue; // the untouched example row, ignore silently

    const rowLabel = `Row ${rowNumber}`;
    if (!roll || !name) { errors.push(`${rowLabel}: roll no. and name are both required`); continue; }

    const rollKey = norm(roll);
    if (seenRollsInSheet.has(rollKey)) { errors.push(`${rowLabel}: roll no. "${roll}" is duplicated within this sheet`); continue; }

    if (!hostelOrDay) { errors.push(`${rowLabel}: choose "Day scholar" or a hostel in column C`); continue; }

    let roomId = null;
    let isLocal;
    let canonicalHostelOrDay;
    let canonicalRoomNo;
    if (norm(hostelOrDay) === norm(DAY_SCHOLAR)) {
      isLocal = true;
      canonicalHostelOrDay = DAY_SCHOLAR;
      canonicalRoomNo = "";
      if (roomNo) { errors.push(`${rowLabel}: room must be left empty for a day scholar`); continue; }
    } else {
      const hostel = hostels.find((h) => norm(h.name) === norm(hostelOrDay));
      if (!hostel) { errors.push(`${rowLabel}: "${hostelOrDay}" isn't "Day scholar" or an approved hostel name`); continue; }
      isLocal = false;
      canonicalHostelOrDay = hostel.name;
      if (!roomNo) { errors.push(`${rowLabel}: room is required for a hostel student`); continue; }
      const floorsOfHostel = hostelFloors.filter((f) => f.hostelId === hostel.id);
      const room = hostelRooms.find((r) => floorsOfHostel.some((f) => f.id === r.hostelFloorId) && norm(r.roomNo) === norm(roomNo));
      if (!room) { errors.push(`${rowLabel}: room "${roomNo}" not found in ${hostel.name}`); continue; }
      roomId = room.id;
      canonicalRoomNo = room.roomNo;
    }

    seenRollsInSheet.add(rollKey);

    const existing = existingByRoll.get(rollKey);
    if (existing) {
      order.push(roll);
      const old = resolveStudentHostelRoom(existing, hostels, hostelFloors, hostelRooms);
      const changes = {};
      if (existing.name !== name) changes.name = { old: existing.name, new: name };
      if (old.hostelOrDay !== canonicalHostelOrDay) changes.hostelOrDay = { old: old.hostelOrDay, new: canonicalHostelOrDay };
      if (old.roomNo !== canonicalRoomNo) changes.room = { old: old.roomNo || "—", new: canonicalRoomNo || "—" };
      if (Object.keys(changes).length > 0) {
        edits.push({ studentId: existing.id, roll, name, roomId, isLocal, changes });
      }
      continue;
    }

    const otherClassName = existingRollOwners.get(rollKey);
    if (otherClassName) {
      errors.push(`${rowLabel}: roll "${roll}" belongs to a student in ${otherClassName}. To move students between classes, use the Move feature (coming soon) — a roster upload only manages this class.`);
      continue;
    }

    order.push(roll);
    adds.push({ name, roll, classId, roomId, isLocal });
  }

  const removals = existingStudentsInClass
    .filter((s) => !seenRollsInSheet.has(norm(s.roll)))
    .map((s) => ({ studentId: s.id, roll: s.roll, name: s.name }));

  const currentOrder = existingStudentsInClass.slice().sort((a, b) => a.seq - b.seq).map((s) => s.roll);
  const orderChanged = order.length !== currentOrder.length || order.some((roll, i) => norm(roll) !== norm(currentOrder[i]));

  return { errors, adds, edits, removals, order, orderChanged };
}

// The human-readable summary shown on the AO's card and in My Requests —
// only mentions the parts that actually changed, always ends with the
// resulting total so both sides can sanity-check the count at a glance.
export function buildSyncSummary(className, { adds, edits, removals, orderChanged }, totalAfter) {
  const parts = [];
  if (adds.length > 0) parts.push(`${adds.length} added`);
  if (removals.length > 0) parts.push(`${removals.length} removed`);
  if (edits.length > 0) parts.push(`${edits.length} edited`);
  if (orderChanged) parts.push("order updated");
  const partsText = parts.length > 0 ? parts.join(", ") : "no changes";
  return `Sync ${className}: ${partsText} (${totalAfter} student${totalAfter === 1 ? "" : "s"} total)`;
}

// Reads an uploaded per-class sheet (see addReferenceSheet/
// readClassIdFromWorkbook above — the class is baked into a hidden cell on
// the Reference sheet, never a Students-sheet column, and never inferred
// from the filename) and SYNCS the class to match it: adds rows that are
// new, edits rows whose roll matches an existing student in this class but
// whose other fields differ, and removes existing students of this class
// whose roll no longer appears anywhere in the sheet. A first-time upload
// against an empty class is just the special case where every row is an
// add and nothing is removed — no separate code path needed (see
// diffAndValidateRoster). Any row with a problem rejects the whole file;
// nothing is partially imported, same all-or-nothing philosophy as the
// structure batch (see structureBatch.js). Because removals are
// destructive, a diff that includes any is NOT applied on the first
// request — it comes back as {needsConfirmation, diff} instead, and only
// a second request with confirm=true (the same file, re-sent after the
// Database Manager reviews exactly who'd be removed) actually creates the
// PendingChange.
excelRouter.post("/excel/students/import", requireAuth, requireRole("DB_MANAGER"), upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const confirmed = req.body?.confirm === "true"; // multer parses non-file multipart fields as strings

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(req.file.buffer);
  } catch {
    return res.status(400).json({ error: "Couldn't read that file — make sure it's a .xlsx file" });
  }
  const sheet = workbook.getWorksheet("Students") || workbook.worksheets[0];
  if (!sheet) return res.status(400).json({ error: "The file has no sheets" });

  const classId = readClassIdFromWorkbook(workbook);
  const cls = classId ? await prisma.classroom.findUnique({ where: { id: classId } }) : null;
  if (!cls) {
    return res.status(400).json({
      error: "This file doesn't have a valid class attached — it may be an old or unrelated file. Download a fresh template for the class you want to import and use that.",
    });
  }

  const [hostels, hostelFloors, hostelRooms, existingRollOwners, existingStudentsInClass] = await Promise.all([
    prisma.hostel.findMany(),
    prisma.hostelFloor.findMany(),
    prisma.hostelRoom.findMany(),
    fetchExistingRollOwners(prisma),
    prisma.student.findMany({ where: { classId } }),
  ]);

  // sheet.eachRow -> a plain array of {rowNumber, roll, name, hostelOrDay,
  // roomNo}, so the actual validation (the risky part) is a pure function
  // that can be exercised with a plain fixture, with no exceljs/DB involved.
  const rawRows = [];
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber < FIRST_DATA_ROW) return; // title + header rows
    const values = row.values;
    rawRows.push({
      rowNumber,
      roll: cellToPlainString(values[1]).trim(),
      name: cellToPlainString(values[2]).trim(),
      hostelOrDay: cellToPlainString(values[3]).trim(),
      roomNo: cellToPlainString(values[4]).trim(),
    });
  });

  const { errors, adds, edits, removals, order, orderChanged } = diffAndValidateRoster(rawRows, {
    classId, className: cls.name, hostels, hostelFloors, hostelRooms, existingStudentsInClass, existingRollOwners,
  });

  if (errors.length > 0) {
    return res.status(400).json({ error: `${errors.length} row(s) had problems — nothing was imported.`, errors });
  }

  const pendingChanges = await prisma.pendingChange.findMany({ where: { status: "pending", type: { in: ["add_student", "bulk_add_students", "sync_class_students"] } } });
  const pendingCollisionErrors = [];
  for (const s of adds) {
    const collision = findPendingRollCollision(pendingChanges, s.roll, null);
    if (collision) pendingCollisionErrors.push(`Roll no. "${s.roll}" is already used in another pending request ("${collision.summary}") awaiting AO approval.`);
  }
  if (pendingCollisionErrors.length > 0) {
    return res.status(400).json({ error: `${pendingCollisionErrors.length} row(s) collide with other pending requests — nothing was imported.`, errors: pendingCollisionErrors });
  }

  if (adds.length === 0 && edits.length === 0 && removals.length === 0 && !orderChanged) {
    return res.status(400).json({ error: "No changes detected — the sheet matches the current roster." });
  }

  const totalAfter = existingStudentsInClass.length - removals.length + adds.length;
  const summary = buildSyncSummary(cls.name, { adds, edits, removals, orderChanged }, totalAfter);

  // Removals are destructive and must be confirmed explicitly — see the
  // route-level comment above. Everything else about the sheet already
  // validated cleanly by this point, so confirming is the ONLY thing left
  // standing between this request and actually creating the PendingChange.
  if (removals.length > 0 && !confirmed) {
    return res.json({ needsConfirmation: true, diff: { classId, className: cls.name, adds, edits, removals, orderChanged, summary } });
  }

  const change = await prisma.pendingChange.create({
    data: {
      type: "sync_class_students",
      summary,
      payload: { classId, adds, edits, removals, order, orderChanged },
      requestedById: req.user.id,
      status: "pending",
    },
  });

  res.json({ change, diff: { classId, className: cls.name, adds, edits, removals, orderChanged, summary } });
});