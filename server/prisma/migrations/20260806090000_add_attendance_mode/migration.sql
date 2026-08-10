-- CreateEnum
CREATE TYPE "AttendanceMode" AS ENUM ('DO_FIRST', 'WARDEN_FIRST');

-- AlterTable
ALTER TABLE "CollegeFloor" ADD COLUMN     "attendanceMode" "AttendanceMode" NOT NULL DEFAULT 'DO_FIRST';

-- AlterTable
ALTER TABLE "AttendanceRecord" ADD COLUMN     "doAbsences" JSONB NOT NULL DEFAULT '{}';
