-- CreateTable
CREATE TABLE "WardenFinalization" (
    "id" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "hostelFloorId" TEXT NOT NULL,
    "session" "Session" NOT NULL DEFAULT 'MORNING',
    "by" TEXT NOT NULL,
    "byName" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WardenFinalization_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "WardenFinalization_date_hostelFloorId_session_key" ON "WardenFinalization"("date", "hostelFloorId", "session");

-- AddForeignKey
ALTER TABLE "WardenFinalization" ADD CONSTRAINT "WardenFinalization_hostelFloorId_fkey" FOREIGN KEY ("hostelFloorId") REFERENCES "HostelFloor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
