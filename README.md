# Attendance & Hostel Management System

A full-stack app for the workflow: DB Manager proposes changes → AO approves →
daily attendance flows Warden/LAI → DO → Incharge Teacher → Coordinator → AO →
Principal's report, with pooled DO/Incharge Teacher coverage per floor and a
deadline cutoff that auto-publishes unfinished lists with a tag.

```
attendance-fullstack/
  server/   Node.js + Express + Prisma API (Postgres)
  client/   React + Vite frontend
```

## 1. Run it locally

### 1.1 Get a free database
Create a free Postgres database at **[neon.tech](https://neon.tech)** or
**[supabase.com](https://supabase.com)** and copy its connection string
(looks like `postgresql://user:pass@host/db?sslmode=require`).

### 1.2 Backend
```bash
cd server
cp .env.example .env
# paste your DATABASE_URL into .env, and set a random JWT_SECRET
npm install
npx prisma migrate dev --name init
npm run seed          # creates demo users, students, rooms, classes
npm run dev           # API on http://localhost:4000
```

### 1.3 Frontend
```bash
cd client
cp .env.example .env   # VITE_API_URL=http://localhost:4000
npm install
npm run dev             # opens http://localhost:5173
```

### 1.4 Log in
All seeded accounts use the password `password123`:

| Username | Role |
|---|---|
| principal | Principal |
| ao | AO |
| coordinator | Coordinator |
| dbm | Database Manager |
| warden1, warden2 | Warden |
| do1, do2 | Discipline Officer (pooled per floor) |
| teacher1, teacher2, teacher3 | Incharge Teacher (teacher3 starts inactive) |
| lai1, lai2 | Local Attendance Incharge |

## 2. Push it to GitHub

From inside the `attendance-fullstack` folder (a git repo is already
initialized with everything committed):

```bash
git remote add origin https://github.com/<your-username>/<your-repo>.git
git branch -M main
git push -u origin main
```

If you haven't created the GitHub repo yet: go to github.com → **New
repository** → give it a name → **do not** initialize with a README (this
project already has one) → create → then run the two commands GitHub shows
you (`git remote add origin ...` and `git push`).

## 3. Deploy for free

A simple free setup: **Neon** (database, already set up in step 1.1) +
**Render** (backend) + **Vercel** (frontend).

### 3.1 Backend on Render
1. [render.com](https://render.com) → New → **Web Service** → connect your
   GitHub repo.
2. Root directory: `server`
3. Build command: `npm install && npx prisma migrate deploy && npx prisma generate`
4. Start command: `npm start`
5. Add environment variables: `DATABASE_URL` (your Neon string), `JWT_SECRET`
   (any long random string), `CORS_ORIGIN` (your Vercel URL — you can add
   this after step 3.2).
6. Deploy. Once it's live, run the seed once from Render's **Shell** tab:
   `npm run seed`.

### 3.2 Frontend on Vercel
1. [vercel.com](https://vercel.com) → **Add New Project** → import the same
   GitHub repo.
2. Root directory: `client`
3. Framework preset: Vite (auto-detected).
4. Environment variable: `VITE_API_URL` = your Render backend URL (e.g.
   `https://attendance-server.onrender.com`).
5. Deploy.
6. Go back to Render and set `CORS_ORIGIN` to your Vercel URL (e.g.
   `https://attendance-app.vercel.app`), then redeploy the backend so it
   accepts requests from it.

Render's free web services sleep after inactivity and take ~30–60 seconds to
wake up on the first request — fine for a pilot, worth upgrading before
real daily use at a fixed 11:00 AM deadline.

## 4. What's new since v1

- **Status views anytime, not just when it's your turn**: Coordinator and
  Incharge Teacher now have a "status" tab showing the same live table
  Principal sees (Incharge Teacher's is scoped to their floor). AO has a
  "Hierarchy status" tab showing who covers what, and flags gaps (a room
  with no Warden, a floor with no DO, an inactive account, etc.).
- **Cutoff no longer bypasses Warden/LAI/DO verification.** The deadline
  cutoff can still auto-pass a list stuck at Teacher, Coordinator, or AO,
  but a list still waiting on the DO stays untouched \u2014 it has no tag and
  isn't published until a person actually verifies it.
- **Reasons for absence, and a persistent "away" status.** A Warden must
  pick a reason when marking someone absent. Picking "Went home" doesn't
  write to today's record at all \u2014 it sets a flag on the student that
  counts them absent automatically every day until a Warden taps "Mark
  reported." LAIs still just flag absentees with no reason.
- **DO workflow now: headcount \u2192 verify each reason \u2192 approve.** The
  absentee list only appears after the headcount is saved. For each
  absentee, the DO confirms the Warden's reason or \u2014 for LAI-reported day
  scholars, who arrive with no reason \u2014 enters one after a phone call.
  Approval is blocked until every absentee has a verified reason.

If you already ran `prisma migrate dev` against an older schema, run it
again to pick up the new `Student.awayReason` / `awaySince` and
`AttendanceRecord.doVerified` fields:
```bash
cd server
npx prisma migrate dev --name add-reasons-and-away-status
npm run seed   # optional: re-seed to see the demo away-student
```

## 5. What's simplified for v1

- One combined `/api/state` endpoint returns the whole snapshot rather than
  many small paginated endpoints — fine at one-institution scale, worth
  splitting up if the student count grows very large.
- Only "today" is used for daily attendance in the UI; the data model
  already supports any date, so a date picker is a small addition.
- Assignment scope (rooms/floors/classes) is stored as plain ID arrays on
  the user rather than a join table — simpler to reason about at this size.

## 6. Next steps worth considering

- Email/SMS reminders before the cutoff time.
- A proper admin UI for creating floors (currently seed-only).
- Password reset flow (currently demo passwords only).
- Audit history view showing full before/after diffs on master-data edits.
