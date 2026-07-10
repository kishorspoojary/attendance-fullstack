// ============================================================================
// Excel support for the Database Manager: download a blank template, upload
// a filled one to bulk-add students, or export the current student list.
//
// Import still goes through the same PendingChange + AO-approval flow as
// every other Database Manager action (see routes/changes.js) — a 200-row
// spreadsheet becomes ONE PendingChange of type "bulk_add_students" rather
// than 200 separate ones, so an AO can review and approve it in one click.
// ============================================================================
import { Router } from "express";
import multer from "multer";
import ExcelJS from "exceljs";
import { prisma } from "../db.js";
import { requireAuth, requireRole } from "../auth.js";

export const excelRouter = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const TEMPLATE_HEADERS = ["Name", "Roll Number", "Class / Batch", "Local or Hostel", "Hostel Name", "Hostel Floor", "Room Number"];

function sendWorkbook(res, workbook, filename) {
  res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  return workbook.xlsx.write(res);
}

// A blank sheet with the right headers, plus a reference sheet listing the
// exact class and room names already in the system — since import matches
// by name, this is what tells the Database Manager what to type.
excelRouter.get("/excel/students/template", requireAuth, requireRole("DB_MANAGER"), async (req, res) => {
  const [classes, hostels, hostelFloors, hostelRooms] = await Promise.all([
    prisma.classroom.findMany(), prisma.hostel.findMany(), prisma.hostelFloor.findMany(), prisma.hostelRoom.findMany(),
  ]);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Students");
  sheet.addRow(TEMPLATE_HEADERS).font = { bold: true };
  sheet.addRow(["Rahul Verma", "10A-01", "Class 10-A", "Hostel", "Hostel Block A", "Hostel Floor 1", "101"]);
  sheet.addRow(["Meena Joshi", "10A-04", "Class 10-A", "Local", "", "", ""]);
  sheet.columns.forEach((col) => { col.width = 20; });

  const ref = workbook.addWorksheet("Reference - valid names");
  ref.addRow(["Existing class / batch names"]).font = { bold: true };
  classes.forEach((c) => ref.addRow([c.name]));
  ref.addRow([]);
  ref.addRow(["Existing hostel / floor / room combinations"]).font = { bold: true };
  hostelRooms.forEach((r) => {
    const floor = hostelFloors.find((f) => f.id === r.hostelFloorId);
    const hostel = floor && hostels.find((h) => h.id === floor.hostelId);
    ref.addRow([hostel?.name || "?", floor?.name || "?", r.roomNo]);
  });
  ref.columns.forEach((col) => { col.width = 24; });

  await sendWorkbook(res, workbook, "student-import-template.xlsx");
});

// Every student currently in the system, in the same column shape as the
// template — handy both as a backup and as a starting point for edits.
excelRouter.get("/excel/students/export", requireAuth, requireRole("DB_MANAGER"), async (req, res) => {
  const [students, classes, hostels, hostelFloors, hostelRooms] = await Promise.all([
    prisma.student.findMany(), prisma.classroom.findMany(), prisma.hostel.findMany(), prisma.hostelFloor.findMany(), prisma.hostelRoom.findMany(),
  ]);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Students");
  sheet.addRow(TEMPLATE_HEADERS).font = { bold: true };
  for (const s of students) {
    const cls = classes.find((c) => c.id === s.classId);
    const room = hostelRooms.find((r) => r.id === s.roomId);
    const floor = room && hostelFloors.find((f) => f.id === room.hostelFloorId);
    const hostel = floor && hostels.find((h) => h.id === floor.hostelId);
    sheet.addRow([s.name, s.roll, cls?.name || "", s.isLocal ? "Local" : "Hostel", hostel?.name || "", floor?.name || "", room?.roomNo || ""]);
  }
  sheet.columns.forEach((col) => { col.width = 20; });

  await sendWorkbook(res, workbook, "students-export.xlsx");
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

// Reads an uploaded spreadsheet, resolves each row's class/hostel/floor/room
// names against what's actually in the database, and — if anything resolved
// — creates one PendingChange for an AO to approve. Rows with a bad or
// missing name/roll/class are skipped with an error message; rows with a
// bad room reference are still added, just without a room, with a warning.
excelRouter.post("/excel/students/import", requireAuth, requireRole("DB_MANAGER"), upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const [classes, hostels, hostelFloors, hostelRooms, existingStudents] = await Promise.all([
    prisma.classroom.findMany(), prisma.hostel.findMany(), prisma.hostelFloor.findMany(), prisma.hostelRoom.findMany(), prisma.student.findMany(),
  ]);
  const norm = (s) => String(s || "").trim().toLowerCase();
  const existingRolls = new Set(existingStudents.map((s) => norm(s.roll)));

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(req.file.buffer);
  } catch {
    return res.status(400).json({ error: "Couldn't read that file — make sure it's a .xlsx file" });
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) return res.status(400).json({ error: "The file has no sheets" });

  const toAdd = [];
  const errors = [];
  const warnings = [];

  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // header row
    const [_, name, roll, className, localOrHostel, hostelName, hostelFloorName, roomNo] = row.values;
    if (!name && !roll) return; // blank row, ignore silently

    const rowLabel = `Row ${rowNumber}`;
    if (!name || !roll) return errors.push(`${rowLabel}: missing name or roll number`);
    if (!className) return errors.push(`${rowLabel}: missing class / batch`);
    if (existingRolls.has(norm(roll))) return warnings.push(`${rowLabel}: skipped — roll number "${roll}" already exists`);

    const cls = classes.find((c) => norm(c.name) === norm(className));
    if (!cls) return errors.push(`${rowLabel}: class "${className}" not found — check the Reference sheet for exact names`);

    let roomId = null;
    const wantsRoom = norm(localOrHostel) === "hostel" || (hostelName && hostelFloorName && roomNo);
    if (wantsRoom) {
      const hostel = hostels.find((h) => norm(h.name) === norm(hostelName));
      const floor = hostel && hostelFloors.find((f) => f.hostelId === hostel.id && norm(f.name) === norm(hostelFloorName));
      const room = floor && hostelRooms.find((r) => r.hostelFloorId === floor.id && norm(r.roomNo) === norm(roomNo));
      if (room) roomId = room.id;
      else warnings.push(`${rowLabel}: room "${hostelName} / ${hostelFloorName} / ${roomNo}" not found — added with no room assigned`);
    }

    const isLocal = norm(localOrHostel) === "local" ? true : norm(localOrHostel) === "hostel" ? false : !roomId;
    toAdd.push({ name: String(name).trim(), roll: String(roll).trim(), classId: cls.id, roomId, isLocal });
    existingRolls.add(norm(roll)); // guard against duplicate rolls within the same sheet
  });

  let change = null;
  if (toAdd.length > 0) {
    change = await prisma.pendingChange.create({
      data: {
        type: "bulk_add_students",
        summary: `Bulk import ${toAdd.length} student(s) from Excel`,
        payload: { students: toAdd },
        requestedById: req.user.id,
        status: "pending",
      },
    });
  }

  res.json({ change, addedCount: toAdd.length, warnings, errors });
});
