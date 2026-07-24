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

// The read-only lookup sheet: a human-readable Hostel/Floor/Room table for
// people to check column D values against, plus (in hidden columns, never
// part of that visible table) the exact dropdown source list for column C
// and the class id itself. Protected so it reads as clearly not-for-editing.
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

  const classIdCell = ref.getCell(CLASS_ID_CELL);
  classIdCell.value = cls.id;
  classIdCell.font = { color: { argb: "FFFFFFFF" } }; // white-on-white: a redundant layer even if the hidden-column flag is ever stripped by a resave
  workbook.definedNames.add(CLASS_ID_RANGE, CLASS_ID_DEFINED_NAME);

  await ref.protect("", { selectLockedCells: true, selectUnlockedCells: true });
  return `'${REFERENCE_SHEET}'!$F$2:$F$${dropdownOptions.length + 1}`;
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

export function buildStudentExportWorkbook({ cls, students }) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Students");
  writeStudentsSheetHeader(sheet, cls);
  students.forEach((s, i) => {
    const hostelName = s.room?.hostelFloor?.hostel?.name;
    const row = sheet.getRow(FIRST_DATA_ROW + i);
    [s.roll, s.name, hostelName || DAY_SCHOLAR, s.room?.roomNo || ""].forEach((v, j) => { row.getCell(j + 1).value = v; });
  });
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
    orderBy: { roll: "asc" },
    include: { room: { include: { hostelFloor: { include: { hostel: true } } } } },
  });

  const workbook = buildStudentExportWorkbook({ cls, students });
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

  const rows = [];
  for (const c of classes) {
    const r = recordByClassId[c.id];
    const ids = new Set([...Object.keys(r?.wardenAbsences || {}), ...Object.keys(r?.laiAbsences || {})]);
    students.filter((s) => s.classId === c.id && s.awayReason).forEach((s) => ids.add(s.id));
    for (const sid of ids) {
      const student = students.find((s) => s.id === sid);
      if (student) rows.push({ roll: student.roll, name: student.name, className: c.name });
    }
  }
  rows.sort((a, b) => a.className.localeCompare(b.className) || a.roll.localeCompare(b.roll));

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Absentees");
  sheet.addRow(["Roll Number", "Name", "Class / Batch"]).font = { bold: true };
  rows.forEach((r) => sheet.addRow([r.roll, r.name, r.className]));
  sheet.columns.forEach((col) => { col.width = 20; });

  await sendWorkbook(res, workbook, `absentees-${date}.xlsx`);
});

// The actual per-row rules (section 3 of the spec): required fields, roll
// uniqueness (within the sheet, and against that class's existing
// students), the hostel-or-day-scholar choice, and the room/hostel
// cross-check. Pure — no exceljs or Prisma calls — so it's testable against
// a plain fixture. `rows` is already-extracted {rowNumber, roll, name,
// hostelOrDay, roomNo} per row; blank rows should already be filtered out
// by the caller (a blank row isn't an error, just nothing to validate).
export function validateImportRows(rows, { classId, className, hostels, hostelFloors, hostelRooms, existingRolls }) {
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
    if (existingRolls.has(rollKey)) { errors.push(`${rowLabel}: roll no. "${roll}" already exists in ${className}`); continue; }

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

// Reads an uploaded per-class sheet (see addReferenceSheet/
// readClassIdFromWorkbook above — the class is baked into a hidden cell on
// the Reference sheet, never a Students-sheet column, and never inferred
// from the filename), validates every row, and — only if every row is
// clean — creates one PendingChange for an AO to approve. Any row with a
// problem rejects the whole file; nothing is partially imported, same
// all-or-nothing philosophy as the structure batch (see structureBatch.js).
excelRouter.post("/excel/students/import", requireAuth, requireRole("DB_MANAGER"), upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

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

  const [hostels, hostelFloors, hostelRooms, existingStudentsInClass] = await Promise.all([
    prisma.hostel.findMany(),
    prisma.hostelFloor.findMany(),
    prisma.hostelRoom.findMany(),
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
      roll: String(values[1] ?? "").trim(),
      name: String(values[2] ?? "").trim(),
      hostelOrDay: String(values[3] ?? "").trim(),
      roomNo: String(values[4] ?? "").trim(),
    });
  });

  const existingRolls = new Set(existingStudentsInClass.map((s) => norm(s.roll)));
  const { toAdd, errors } = validateImportRows(rawRows, { classId, className: cls.name, hostels, hostelFloors, hostelRooms, existingRolls });

  if (errors.length > 0) {
    return res.status(400).json({ error: `${errors.length} row(s) had problems — nothing was imported.`, errors });
  }
  if (toAdd.length === 0) {
    return res.status(400).json({ error: "No student rows found in the sheet." });
  }

  const hostellerCount = toAdd.filter((s) => !s.isLocal).length;
  const dayScholarCount = toAdd.length - hostellerCount;
  const change = await prisma.pendingChange.create({
    data: {
      type: "bulk_add_students",
      summary: `Add ${toAdd.length} students to ${cls.name} (${hostellerCount} hosteller${hostellerCount === 1 ? "" : "s"}, ${dayScholarCount} day scholar${dayScholarCount === 1 ? "" : "s"})`,
      payload: { students: toAdd },
      requestedById: req.user.id,
      status: "pending",
    },
  });

  res.json({ change, addedCount: toAdd.length });
});