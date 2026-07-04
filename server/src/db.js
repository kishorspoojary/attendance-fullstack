// ============================================================================
// A single shared Prisma Client for the whole server.
//
// PrismaClient manages a pool of database connections. Creating a new one
// every time we need to query would quickly exhaust the database's
// connection limit, so instead we create exactly one here and every route
// file imports this same `prisma` object (`import { prisma } from "../db.js"`).
//
// The `globalThis.__prisma` trick below only matters in development, where
// the server file gets reloaded automatically on every save (`--watch`).
// Without it, each reload would create a brand new client while the old one
// is still open, leaking connections. In production this is a no-op — the
// process only starts once.
// ============================================================================
import { PrismaClient } from "@prisma/client";

export const prisma = globalThis.__prisma || new PrismaClient();
if (process.env.NODE_ENV !== "production") globalThis.__prisma = prisma;
