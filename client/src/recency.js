// ============================================================================
// The "2-day decision window" rule shared by AOApprovals' Recent Decisions
// and MyChanges' My Requests — split out into its own plain (non-JSX)
// module so it's directly importable from a plain Node test, the same way
// server/src/structureBatch.js and routes/excel.js's validateImportRows are
// tested without a browser or a JSX-aware loader.
//
// PendingChange has no separate "decided at" timestamp (schema.prisma only
// has createdAt), so "last 2 days" uses createdAt as the age reference for
// approved/rejected rows. sent_back rows are exempt entirely: the ball is
// back in the Database Manager's court, so — like pending — they always
// show regardless of age.
// ============================================================================
export const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

export function isAlwaysVisibleDecision(c) {
  if (c.status !== "approved" && c.status !== "rejected") return true; // pending, sent_back
  return Date.now() - new Date(c.createdAt).getTime() <= TWO_DAYS_MS;
}