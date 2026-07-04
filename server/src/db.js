import { PrismaClient } from "@prisma/client";

// Reuse a single client across hot reloads / serverless invocations.
export const prisma = globalThis.__prisma || new PrismaClient();
if (process.env.NODE_ENV !== "production") globalThis.__prisma = prisma;
