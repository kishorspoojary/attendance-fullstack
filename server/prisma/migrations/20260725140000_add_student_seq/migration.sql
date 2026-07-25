-- AlterTable
-- Adds an explicit, DB-assigned, strictly-increasing insertion-order
-- counter to Student. Existing rows get backfilled with whatever order
-- Postgres assigns them (their original entry order isn't recoverable);
-- every row created from here on gets a value strictly greater than every
-- row created before it, in the exact order the INSERT presents them —
-- see schema.prisma's comment on Student.seq for why createdAt/id alone
-- aren't reliable tiebreakers for a bulk-created batch.
ALTER TABLE "Student" ADD COLUMN "seq" SERIAL NOT NULL;