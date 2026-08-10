-- CreateTable
CREATE TABLE "WardenFloorStart" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "hostelFloorId" TEXT NOT NULL,
    "session" "Session" NOT NULL DEFAULT 'MORNING',
    "by" TEXT NOT NULL,
    "byName" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WardenFloorStart_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WardenFloorStart_date_hostelFloorId_session_key" ON "WardenFloorStart"("date", "hostelFloorId", "session");

-- AddForeignKey
ALTER TABLE "WardenFloorStart" ADD CONSTRAINT "WardenFloorStart_hostelFloorId_fkey" FOREIGN KEY ("hostelFloorId") REFERENCES "HostelFloor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
