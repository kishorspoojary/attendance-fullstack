-- Warden assignment moves from room-level to floor-level: a Warden is
-- actually responsible for every room on one or more hostel floors, not a
-- specific list of individual rooms — confirmed via
-- server/src/reportWardenCoverage.js before writing this migration (0
-- partial-floor assignments, 0 stale roomIds, across both existing Wardens
-- at the time). This mirrors how DO/Lecturer already use User.floorIds for
-- CollegeFloor ids in exactly the same "pooled, floor-level" shape — see
-- schema.prisma's IMPORTANT MODELING NOTE for why floorIds now holds a
-- HostelFloor id for a Warden and a CollegeFloor id for a DO/Lecturer,
-- distinguished only by role, never both at once for the same person.
--
-- Convert BEFORE dropping: every WARDEN row's roomIds (a JSON array of
-- HostelRoom id strings) is resolved to the DISTINCT set of hostelFloorId
-- values those rooms belong to, written into floorIds (already present on
-- every User row, just unused by Wardens until now — default '[]', so
-- there's nothing there to clobber). jsonb_array_elements_text unnests the
-- room-id array into rows, joins each against HostelRoom to find its
-- floor, and jsonb_agg(DISTINCT ...) re-collects the unique floor ids into
-- exactly the JSON array shape floorIds expects. COALESCE covers a Warden
-- with an empty roomIds array (no rows to join against) or one whose room
-- ids no longer resolve to anything (both report as an empty array, never
-- NULL, matching floorIds' own default).
--
-- Run as a plain SQL migration rather than a companion Node script: this
-- is a single atomic statement that runs automatically as part of the
-- existing `prisma migrate deploy` release step, with no separate manual
-- step for anyone to remember (or forget) to run once against production.
UPDATE "User" u
SET "floorIds" = COALESCE(
  (
    SELECT jsonb_agg(DISTINCT hr."hostelFloorId")
    FROM jsonb_array_elements_text(u."roomIds"::jsonb) AS room_id
    JOIN "HostelRoom" hr ON hr.id = room_id
  ),
  '[]'::jsonb
)
WHERE u.role = 'WARDEN';

-- roomIds is now unused by every role (Warden just moved off it onto
-- floorIds; no other role ever stored anything there) — dropped outright
-- rather than left as a dead column that could tempt a future read of
-- stale data.
ALTER TABLE "User" DROP COLUMN "roomIds";
