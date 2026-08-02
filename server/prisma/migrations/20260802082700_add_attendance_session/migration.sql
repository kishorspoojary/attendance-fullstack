-- CreateEnum
CREATE TYPE "Session" AS ENUM ('MORNING', 'AFTERNOON');

-- AlterTable
-- Existing rows predate sessions; the DEFAULT backfills every one of them
-- to MORNING so nothing currently deployed silently loses data.
ALTER TABLE "AttendanceRecord" ADD COLUMN     "session" "Session" NOT NULL DEFAULT 'MORNING';

-- DropIndex
DROP INDEX "AttendanceRecord_date_classId_key";

-- CreateIndex
CREATE UNIQUE INDEX "AttendanceRecord_date_classId_session_key" ON "AttendanceRecord"("date", "classId", "session");
