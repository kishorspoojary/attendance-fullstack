/*
  Warnings:

  - You are about to drop the column `mustChangeKey` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `mustChangePassword` on the `User` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "User" DROP COLUMN "mustChangeKey",
DROP COLUMN "mustChangePassword",
ADD COLUMN     "mustSetPassword" BOOLEAN NOT NULL DEFAULT true;
