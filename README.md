# Attendance & Hostel Management System

A full-stack app for the workflow: Principal registers and sets up
leadership → DB Manager proposes changes → AO approves → daily attendance
flows Warden/LAI → DO → Incharge Teacher → Coordinator → Principal's
report, with pooled DO/Incharge Teacher coverage per floor, send-back for
corrections, and a deadline cutoff that auto-publishes unfinished lists
with a tag (never bypassing the DO's verification step).

```
attendance-fullstack/
  server/   Node.js + Express + Prisma API (Postgres)
  client/   React + Vite frontend
```

**New to this codebase?** Every file has comments explaining what it does
and why, written for someone learning as they go — start with
`server/src/routes/attendance.js` and `client/src/App.jsx`, the two most
representative files. A separate learning manual (concepts, diagrams, and a
full walkthrough) is kept outside this repo for personal reference.


## 1. Run it locally

### 1.1 Get a free database
Create a free Postgres database at **[neon.tech](https://neon.tech)** or
**[supabase.com](https://supabase.com)**. Both give you two versions of the
connection string — a pooled one and a direct one (see `server/.env.example`
for exactly where to find each one and why you need both).

### 1.2 Backend
```bash
cd server
cp .env.example .env
# paste your DATABASE_URL (pooled) and DIRECT_URL (direct) into .env, and set a random JWT_SECRET
npm install
npx prisma migrate dev --name init
npm run seed          # optional: creates a starter hostel/college/student structure, no accounts
npm run dev           # API on http://localhost:4000
```
If `prisma migrate dev` fails with `P1001: Can't reach database server`,
the database was just asleep (Neon/Supabase free tiers pause when idle) —
simply run the same command again. If it instead fails partway through with
`P3016` / `P1017` after you confirm a schema reset, double-check `DIRECT_URL`
is actually the non-pooled string (no `-pooler` in the hostname) — using the
pooled string for both variables is the most common cause of that one.

### 1.3 Frontend
```bash
cd client
cp .env.example .env   # VITE_API_URL=http://localhost:4000
npm install
npm run dev             # opens http://localhost:5173
```

### 1.4 First-time setup (no seeded accounts anymore)
There are no demo logins — every account is created through the app itself:

1. Open the app. On the login screen, click **"Register as Principal"** and
   create that one account (your own name + a password you choose). This
   only works once — it's rejected if a Principal already exists.
2. Log in as Principal and open **Leadership accounts**. Create the AO,
   Coordinator, and Database Manager — each screen shows their generated
   4-digit login key and the shared default password (`Welcome@123`) once,
   right after creation. Write those down.
3. Log in as the Database Manager (key + `Welcome@123` — you'll be asked to
   change the password immediately). Add at least one hostel/floor/room and
   one college floor/class under **Hostels & classes**, then some students
   under **Students** (or run `npm run seed` first for starter data instead
   of entering it by hand).
4. Still as Database Manager, use **Create staff account** to add a Warden,
   an LAI, a DO, and an Incharge Teacher. Each gets a generated key shown
   immediately, but can't log in yet.
5. Log in as AO (created in step 2) and approve those staff requests under
   **Master data approvals**. Now their keys work.

Every account — including the ones you just created — must change its
password on first login; that's enforced, not optional.

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
5. Add environment variables: `DATABASE_URL` and `DIRECT_URL` (same pooled/
   direct pair from your local `.env`), `JWT_SECRET` (any long random
   string), `CORS_ORIGIN` (your Vercel URL — you can add this after step 3.2).
6. Deploy. Once it's live, open the deployed frontend URL and go through
   the registration flow (README section 1.4) to create your Principal
   account — there's nothing to seed for accounts. Run `npm run seed` from
   Render's **Shell** tab only if you want the optional starter hostel/
   class/student data.

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

## 4. How the workflow works today

This has gone through several rounds of changes since the first version;
this section describes the **current** behavior rather than the history of
how it got here (see `git log` if you want that history).

- **Login is a 4-digit key + password, everywhere.** No usernames, no role
  dropdown — the key alone identifies who you are.
- **Account setup, in order:** Principal registers once → Principal creates
  AO/Coordinator/Database Manager → Database Manager creates Warden/LAI/
  DO/Incharge Teacher accounts → AO approves each one before it can log in.
  Every account starts on the same default password (`Welcome@123`) and
  must change it on first login.
- **Two separate structures, both casually called "floor."** Hostel →
  Floor → Room (Wardens attach to rooms) and College Floor → Class/Batch
  (DOs and Incharge Teachers attach to floors, pooled). They're unrelated
  hierarchies even though people call both "floor" out loud.
- **The daily chain is three stages, not four:** DO → Incharge Teacher →
  Coordinator → published straight to the Principal. AO does not approve
  daily attendance at all — only master-data changes, new staff accounts,
  and freezing/unfreezing accounts.
- **Send-back**: instead of approving, a DO/Teacher/Coordinator can bounce
  a class's record back exactly one stage with a required reason. Whoever
  receives it can fix and re-approve, push it back further themselves, or
  just re-confirm unchanged.
- **The deadline cutoff** (moved to Coordinator's screen) can force-publish
  anything stuck at Teacher or Coordinator, tagged "auto-passed" — but
  never bypasses the DO stage, since that's where real verification (phone
  calls, headcounts) happens.
- **Absence reasons and the persistent "away" status**: a Warden must pick
  a reason when marking someone absent. Picking "Went home" doesn't touch
  today's record at all — it flags the student as away, counting them
  absent automatically every day until a Warden taps "Mark reported." LAIs
  flag absentees with no reason; the DO fills one in after a phone call.
- **AO can freeze any account** except the Principal's — frozen accounts
  simply can't log in until unfrozen.
- **Search boxes** on the Database Manager's Students screen and the
  Warden/LAI screens filter their (potentially long) lists client-side.
- **The Database Manager has a read-only Absentees view** — pick a date,
  see roll number/name/class for everyone absent, nothing else.

## 5. What's simplified for now

- One combined `/api/state` endpoint returns the whole snapshot rather than
  many small paginated endpoints — fine at one-institution scale, worth
  splitting up if the student count grows very large.
- Assignment scope (rooms/floors/classes) is stored as plain ID arrays on
  the user rather than a join table — simpler to reason about at this size.
- No Excel import/export yet for bulk-adding students, even though the data
  model (`bulk_add_students` change type) already supports it — a template
  download, upload parser, and export button are the remaining pieces.
- No dedicated mobile-layout pass yet, even though most controls already
  wrap and stack reasonably on a narrow screen.

## 6. Next steps worth considering

- Excel template download + bulk upload + export for the Students screen.
- A dedicated mobile-responsive pass, given most staff will use this on a phone.
- Email/SMS reminders before the daily deadline.
- Self-service "forgot password" flow — right now, a locked-out person needs
  an AO/Principal to freeze-and-recreate their account or manually reset it
  in the database.
- Audit history view showing full before/after diffs on master-data edits.
