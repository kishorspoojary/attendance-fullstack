# Project Manual

A complete reference for working on this codebase, learning the
technologies behind it, running/debugging/deploying it, and eventually
building something like it yourself from scratch.

This manual assumes you've read `HOW_IT_WORKS.md` (or will alongside this).
That doc explains the *concepts*. This one is more like a workshop
handbook: diagrams, algorithms, tool-by-tool rationale, and step-by-step
procedures.

---

## Table of contents

1. [How the program works, visually](#1-how-the-program-works-visually)
2. [The algorithms this app actually runs](#2-the-algorithms-this-app-actually-runs)
3. [Tools and languages used \u2014 and why](#3-tools-and-languages-used--and-why)
4. [How to learn each technology](#4-how-to-learn-each-technology)
5. [How to run this program](#5-how-to-run-this-program)
6. [How to debug it](#6-how-to-debug-it)
7. [How to host and deploy it for free](#7-how-to-host-and-deploy-it-for-free)
8. [How to publish this code on GitHub](#8-how-to-publish-this-code-on-github)
9. [How to build a project like this yourself](#9-how-to-build-a-project-like-this-yourself)
10. [File-by-file map of the repo](#10-file-by-file-map-of-the-repo)
11. [Reference links](#11-reference-links)

---

## 1. How the program works, visually

### 1.1 System architecture

```mermaid
graph LR
  U[User's browser] -- "HTTP requests (JSON)" --> C[client/ \n React + Vite]
  C -- "fetch() calls" --> S[server/ \n Node.js + Express]
  S -- "Prisma queries" --> D[(Postgres database)]
  S -- "JWT token" --> C
```

- The **browser** never talks to the database. It only ever calls the
  server's API.
- The **server** is the only thing trusted to check permissions and write
  data. Every rule ("only an AO can approve this") is enforced here, not
  just hidden in the UI.
- The **database** just stores rows in tables. It has no logic of its own.

### 1.2 The daily attendance workflow

```mermaid
flowchart TD
  A["Warden marks hostel absentees\n(with a reason)"] --> C{DO reviews}
  B["LAI marks classroom absentees\n(no reason yet)"] --> C
  C -->|"headcount entered +\nevery reason verified"| D["DO approves"]
  D --> E["Incharge Teacher approves"]
  E --> F["Coordinator approves"]
  F --> G["AO approves"]
  G --> H["Published to Principal's report"]

  D -.->|"cutoff time reached\nand DO hasn't acted"| X["Stays blocked \u2014\nnever auto-passed"]
  E -.->|"cutoff time reached"| Y["Auto-passed, tagged\n'missing: Teacher'"]
  F -.->|"cutoff time reached"| Y
  G -.->|"cutoff time reached"| Y
  Y -.->|"can still be completed later"| H
```

The important asymmetry: **the DO stage can never be skipped**, because
that's where real-world verification (phone calls, headcounts) happens.
Everything after it *can* be auto-passed by the deadline, but gets tagged
so it's visible that it wasn't properly signed off in time.

### 1.3 Data model (entity-relationship diagram)

```mermaid
erDiagram
  User ||--o{ PendingChange : requests
  Floor ||--o{ Classroom : contains
  Floor ||--o{ HostelRoom : contains
  Classroom ||--o{ Student : enrolls
  HostelRoom ||--o{ Student : houses
  Classroom ||--o{ AttendanceRecord : "has one per day"

  User {
    string id
    string name
    string username
    string passwordHash
    enum role
    boolean active
    json roomIds "Warden only"
    json floorIds "DO / Incharge Teacher only"
    json classIds "LAI only"
  }
  Student {
    string id
    string name
    string roll
    string classId
    string roomId "nullable \u2014 day scholars have none"
    string awayReason "nullable, persistent"
    string awaySince
  }
  AttendanceRecord {
    string id
    string date
    string classId
    int headcount
    json wardenAbsences
    json laiAbsences
    json doVerified
    json doApproved
    json teacherApproved
    json coordinatorApproved
    json aoApproved
    boolean forcedPublish
    json skippedStages
  }
  PendingChange {
    string id
    string type
    string summary
    json payload
    string status
  }
```

### 1.4 A single request, step by step (sequence diagram)

This traces "Warden marks a student absent with reason 'Sick'":

```mermaid
sequenceDiagram
  participant Browser
  participant api.js
  participant Express
  participant Middleware as auth.js
  participant Route as attendance.js
  participant Prisma
  participant DB as Postgres

  Browser->>api.js: setAbsence(date, classId, studentId, "Sick")
  api.js->>Express: POST /api/attendance/.../absence + JWT
  Express->>Middleware: requireAuth, requireRole("WARDEN","LAI")
  Middleware-->>Express: OK, user attached to request
  Express->>Route: run handler
  Route->>Prisma: find student, find/create today's record
  Prisma->>DB: SELECT / INSERT
  DB-->>Prisma: rows
  Route->>Prisma: update record.wardenAbsences
  Prisma->>DB: UPDATE
  Route-->>Browser: 200 OK + updated record (via Express)
  Browser->>api.js: getState() (refresh everything)
  api.js->>Express: GET /api/state
  Express-->>Browser: full snapshot
  Note over Browser: React re-renders with new data
```

---

## 2. The algorithms this app actually runs

None of these are exotic \u2014 they're the everyday algorithms of a
CRUD/workflow app. Knowing them by name will help you recognize the same
patterns elsewhere.

### 2.1 Password verification (never store real passwords)

```
to register/seed a user:
    hash = bcrypt.hash(plainPassword, cost=10)
    store hash in the database (never the plain password)

to log in:
    fetch stored hash for the given username
    ok = bcrypt.compare(submittedPassword, storedHash)
    if ok: issue a token
    else: reject
```
`bcrypt` is deliberately slow (by design, tunable via the "cost" factor) so
that even if a database leaks, guessing passwords by brute force is
expensive. See `server/src/routes/auth.js`.

### 2.2 Stateless authentication with JWT

```
on login:
    payload = { userId, role }
    token = sign(payload, SERVER_SECRET, expiresIn="12h")
    send token to browser

on every later request:
    token = read from "Authorization" header
    payload = verify(token, SERVER_SECRET)   // throws if tampered or expired
    look up the fresh user record by payload.userId
    attach it to the request, continue
```
The key property: the server can verify a token **without a database
lookup for the token itself** \u2014 the signature alone proves it wasn't
tampered with. See `server/src/auth.js`.

### 2.3 The approval-stage state machine

This is the core algorithm of the whole app, and it's genuinely simple:

```
STAGES = [doApproved, teacherApproved, coordinatorApproved, aoApproved]

function currentStageIndex(record):
    for i, stage in enumerate(STAGES):
        if record[stage] is null:
            return i          // "stuck waiting on this stage"
    return length(STAGES)      // every stage done

function canApprove(record, stageBeingAttempted):
    priorStage = the stage right before this one (if any)
    return priorStage is null OR record[priorStage] is not null
```
Every screen in the app \u2014 dashboards, approval queues, badges \u2014 is just
a different *view* over this one function's result. See `server/src/stages.js`.

### 2.4 The deadline cutoff (partial auto-pass)

```
function runCutoff(date):
    for each classroom:
        record = today's attendance record for this classroom
        stage = currentStageIndex(record)
        if stage == 0:
            continue                      // never bypass the DO stage
        if stage < STAGES.length and not record.forcedPublish:
            record.forcedPublish = true
            record.skippedStages = STAGES[stage:]   // remember what was skipped
            save(record)
```
Notice the early `continue` \u2014 that one line is what implements "Wardens,
LAIs, and DOs can never be auto-passed," a rule that came directly from a
real conversation about how the workflow should behave. This is a good
example of turning a plain-English business rule into one guard clause.

### 2.5 Pooled-role authorization ("any one of N people can act")

```
function isAuthorizedForFloor(user, floorId):
    return floorId in user.floorIds

// Two DOs can both have the same floorId in their floorIds array.
// Whichever one calls the approve endpoint first succeeds; the
// record then shows doApproved = {by: thatPerson}, and the other
// DO's screen simply shows it as already done.
```
There's no explicit "locking" mechanism here \u2014 the state machine in 2.3
does the job implicitly: once `doApproved` is set, the check in `canApprove`
for a *second* DO trying the same action will find the record already has
`doApproved`, and the route rejects it as "already approved."

### 2.6 The propose \u2192 approve \u2192 apply pattern (two-person control)

```
Database Manager proposes a change:
    save a PendingChange row with status = "pending", payload = {...}
    (nothing else in the database changes yet)

AO approves it:
    look up the PendingChange
    run applyChange(payload)     // the actual INSERT/UPDATE/DELETE happens here
    mark the PendingChange as "approved"

AO rejects it:
    mark the PendingChange as "rejected" \u2014 payload is simply discarded
```
This is a common pattern anywhere you need "two different people must be
involved before X takes effect" \u2014 you separate *proposing* a change from
*applying* it, and only the approval step is allowed to trigger the second
half. See `server/src/applyChange.js` and `server/src/routes/changes.js`.

---

## 3. Tools and languages used \u2014 and why

| Layer | Tool | Why it was chosen here | Popular alternatives | When you'd pick an alternative instead |
|---|---|---|---|---|
| Language (both sides) | **JavaScript** (via Node.js on the server) | One language for frontend and backend means less context-switching while learning, and it's the most common stack for small-to-medium web apps | Python (Django/Flask), PHP (Laravel), Java (Spring), Go, TypeScript | TypeScript is the most natural upgrade from this exact codebase \u2014 same syntax, adds type-checking. Python/Django is great if you want a more "batteries included" backend with less setup. |
| Backend framework | **Express** | Minimal, unopinionated, huge ecosystem, easiest to actually *see* how a request is handled (no hidden magic) | Fastify (faster, similar style), Koa, NestJS (much more structured, Angular-like) | NestJS if the project grows large and you want enforced structure; Fastify if raw performance matters. |
| Database | **PostgreSQL** | Real relational database, generous free tiers (Neon/Supabase), handles the relational structure here (students \u2192 classes \u2192 floors) naturally | MySQL/MariaDB, SQLite, MongoDB | SQLite is great for a single-user local tool with zero setup. MongoDB if your data is naturally document-shaped rather than tabular \u2014 this project's data (rows with clear relationships) is a poor fit for that. |
| ORM (database access) | **Prisma** | Type-safe, autocompletes table names, `schema.prisma` doubles as living documentation of the data model | Raw SQL, Sequelize, TypeORM, Drizzle | Raw SQL if you want to learn exactly what's happening underneath (recommended once, as an exercise). Drizzle is a lighter, more SQL-like alternative to Prisma worth trying next. |
| Authentication | **JWT (jsonwebtoken)** | Stateless \u2014 no server-side session storage needed, works well with a separate frontend/backend | Session cookies + server-side sessions, OAuth/social login | Session cookies are simpler to reason about for a single-server app with no mobile app. OAuth if you want "Sign in with Google" instead of your own usernames. |
| Password hashing | **bcrypt** | Battle-tested, simple API, intentionally slow to resist brute-forcing | argon2, scrypt | argon2 is the newer recommended default in security circles \u2014 a reasonable upgrade later. |
| Frontend framework | **React** | Component model matches this app's many small repeated pieces (Card, Badge, per-role screens); huge learning-resource ecosystem | Vue, Svelte, Angular | Svelte if you want less boilerplate and a gentler learning curve. Vue sits between React and Svelte in complexity. |
| Build tool | **Vite** | Near-instant dev server start and reload; the current standard for new React projects | Webpack (manual config), Next.js (adds server-side rendering & routing) | Next.js if you want the same project to also do server-rendering/SEO, or you want file-based routing. |
| Styling | **Tailwind CSS** | Utility classes directly in JSX avoid context-switching to separate CSS files; fast to prototype consistent spacing/color | Plain CSS / CSS Modules, Bootstrap, styled-components | Plain CSS if you want to deeply learn CSS itself first. Bootstrap if you want ready-made components rather than utility classes. |
| Icons | **lucide-react** | Clean, consistent icon set, tree-shakeable (only bundles icons you actually import) | react-icons, Heroicons, Font Awesome | react-icons if you want access to many icon families through one package. |
| Version control | **Git + GitHub** | Industry standard; free private/public repos; required by almost every free hosting platform's deploy flow | GitLab, Bitbucket | GitLab if you want built-in CI/CD pipelines beyond what GitHub Actions offers for free. |
| Hosting (backend) | **Render** (free tier) | Deploys straight from a GitHub repo, free tier needs no credit card | Railway, Fly.io, Heroku (no longer free), a VPS | Railway has a slightly different free-tier structure (usage credits) \u2014 worth comparing at signup time since free tiers change. |
| Hosting (frontend) | **Vercel** | Built by the creators of Next.js but works with any Vite/React app; instant global CDN, free tier | Netlify, GitHub Pages (static only, no server needed) | Netlify is nearly interchangeable with Vercel \u2014 pick whichever's UI you prefer. |
| Hosting (database) | **Neon / Supabase** (free tier) | Real managed Postgres, no server to maintain, generous free storage | Railway Postgres, ElephantSQL, running Postgres yourself | Supabase additionally gives you a UI file browser and instant REST API over your tables, which is nice while learning. |

---

## 4. How to learn each technology

Suggested order, going from foundations to this project's specifics. Each
step assumes the previous one. Don't try to learn everything before
starting \u2014 the best way to learn most of this is to keep editing this
project and looking things up as you hit them.

1. **JavaScript fundamentals** (if new to programming or coming from
   another language): variables, functions, arrays/objects, `async/await`,
   arrow functions. MDN's JavaScript Guide (developer.mozilla.org) is the
   most trustworthy free reference; freeCodeCamp's JavaScript curriculum
   is a good structured course.
2. **Git basics**: `git init/add/commit/push/pull`, branches. The official
   Git book (git-scm.com/book) is free and thorough; you only need
   chapters 1\u20133 to get productive.
3. **HTML & CSS basics**: enough to read JSX comfortably and understand
   what Tailwind's utility classes are doing under the hood. MDN again.
4. **Node.js basics**: what `npm`, `package.json`, and `import`/`export`
   mean. The official Node.js docs (nodejs.org/docs) have a "Guides"
   section aimed at exactly this.
5. **SQL and relational databases**: what a table, row, foreign key, and
   `JOIN` are \u2014 even though Prisma writes the SQL for you, you should be
   able to read `schema.prisma` and know what it implies. PostgreSQL's own
   tutorial (postgresql.org/docs, "Tutorial" section) or
   sqlbolt.com (interactive, free) both work well.
6. **Express**: read expressjs.com's official guide start to finish (it's
   short) before touching this project's route files.
7. **Prisma**: prisma.io/docs \u2014 specifically the "Getting Started" and
   "Data model" sections. Their docs are unusually beginner-friendly.
8. **React**: react.dev (the official docs were rewritten from scratch to
   be beginner-friendly) \u2014 do the "Learn React" tutorial before reading
   `App.jsx` line by line.
9. **JWT & authentication concepts**: jwt.io has a good "Introduction"
   page and a debugger where you can paste a token and see it decoded.
10. **Tailwind CSS**: tailwindcss.com/docs \u2014 skim the "Core Concepts"
    page, then just keep the "Utility classes" reference open while
    reading this project's `className` attributes.
11. **Deployment**: each platform's own quick-start is enough \u2014
    render.com/docs, vercel.com/docs, neon.tech/docs. Do these last, once
    the app already runs locally.

If you prefer one all-in-one course instead of piecing together docs:
freeCodeCamp's "Full Stack" curriculum (freecodecamp.org) covers items 1,
3, 4, 6, and 8 above in a single free structured path.

---

## 5. How to run this program

Detailed beginner version of what's in `README.md`:

1. **Install Node.js** (version 18 or later) from nodejs.org \u2014 this gives
   you both `node` and `npm` on your computer. Confirm it worked:
   ```bash
   node --version
   npm --version
   ```
2. **Install a code editor** \u2014 VS Code (code.visualstudio.com) is free and
   the most common choice; it has built-in terminal, debugging, and a huge
   extension marketplace.
3. **Get a free database** \u2014 sign up at neon.tech or supabase.com, create
   a project, and copy the connection string it gives you (it looks like
   `postgresql://user:pass@host/db?sslmode=require`).
4. **Set up the backend**:
   ```bash
   cd server
   cp .env.example .env      # then paste your DATABASE_URL into .env
   npm install                # downloads all the packages listed in package.json
   npx prisma migrate dev --name init   # creates the actual tables in your database
   npm run seed                # fills in demo data
   npm run dev                  # starts the API on http://localhost:4000
   ```
5. **Set up the frontend**, in a second terminal tab/window:
   ```bash
   cd client
   cp .env.example .env
   npm install
   npm run dev       # opens http://localhost:5173
   ```
6. Open `http://localhost:5173` in your browser and log in with one of the
   demo accounts listed in `README.md`.

---

## 6. How to debug it

### 6.1 Reading errors, generally
Don't skim past an error message \u2014 read the first line and the last line
of a stack trace first. The first line usually says *what* went wrong; the
bottom-most line from *your own code* (not from a library) usually says
*where*.

### 6.2 Backend debugging
- **`console.log` everywhere.** Not elegant, but effective: drop
  `console.log(req.body)` or `console.log(record)` inside a route handler
  and watch the terminal running `npm run dev`.
- **VS Code's built-in debugger.** Click left of a line number to set a
  breakpoint, then run the server via VS Code's "Run and Debug" panel
  instead of the terminal \u2014 execution pauses there and you can inspect
  every variable.
- **Prisma errors** almost always tell you exactly which field/query was
  the problem \u2014 read the whole error, it's usually more helpful than
  typical JavaScript errors.
- **"Port already in use"** means a previous `npm run dev` is still
  running somewhere \u2014 find and stop it, or change the `PORT` in `.env`.

### 6.3 Frontend debugging
- **Browser DevTools** (F12 or right-click \u2192 Inspect):
  - **Console tab**: shows JavaScript errors and anything you
    `console.log` from React code.
  - **Network tab**: shows every `fetch()` call `api.js` makes \u2014 click
    one to see the exact request sent and response received. This is the
    single most useful tab for "why didn't my click do anything?"
  - **React DevTools** (a free browser extension): lets you inspect any
    component's current props and state live.
- **A blank white screen** almost always means a JavaScript error stopped
  React from rendering \u2014 check the Console tab first.

### 6.4 Common errors in this specific project

| Symptom | Likely cause | Fix |
|---|---|---|
| CORS error in the browser console | `CORS_ORIGIN` in the server's `.env` doesn't match the URL the frontend is actually running on | Update `CORS_ORIGIN` and restart the server |
| "401 Unauthorized" on every request | Login token missing/expired | Log out and back in; check `localStorage` in DevTools \u2192 Application tab |
| Prisma "table does not exist" | Migrations haven't been run against this database yet | `npx prisma migrate dev` |
| Changes don't show up after clicking something | Forgot to check the Network tab for a failed request | Check Network tab; also confirm `runAction`'s refresh actually ran |
| "Cannot find module X" | Dependencies not installed in that folder | `npm install` inside the specific folder (`client/` or `server/`) that's missing it |

---

## 7. How to host and deploy it for free

Full step-by-step is in `README.md` section 3. Summary of the shape:

```mermaid
graph LR
  GH[GitHub repo] --> R[Render\n\u2014 runs server/]
  GH --> V[Vercel\n\u2014 runs client/]
  R --> N[Neon or Supabase\n\u2014 hosts the database]
  V -.->|VITE_API_URL| R
  R -.->|CORS_ORIGIN| V
```

Both Render and Vercel redeploy automatically whenever you push new
commits to GitHub \u2014 that's the main reason to have the code on GitHub
before setting either of them up.

---

## 8. How to publish this code on GitHub

If you've never used Git before:

1. **Create a free GitHub account** at github.com.
2. **Install Git** from git-scm.com if `git --version` in a terminal
   doesn't already work.
3. **Tell Git who you are** (once, ever, per computer):
   ```bash
   git config --global user.name "Your Name"
   git config --global user.email "you@example.com"
   ```
4. **Create a new empty repository on GitHub** (github.com \u2192 "+" in the
   top right \u2192 "New repository"). Give it a name. Do **not** check
   "Add a README" \u2014 this project already has one, and GitHub will refuse
   to push into a repo whose history conflicts with what you're pushing.
5. **From inside this project's folder** (this repo already has git
   initialized and a first commit made, per `README.md` section 2):
   ```bash
   git remote add origin https://github.com/<your-username>/<repo-name>.git
   git branch -M main
   git push -u origin main
   ```
6. From now on, whenever you make changes you want saved:
   ```bash
   git add -A
   git commit -m "Describe what you changed, in plain English"
   git push
   ```

**Prefer a visual tool over the command line?** GitHub Desktop
(desktop.github.com) does the same four steps above (add, commit, push,
pull) through buttons instead of typed commands \u2014 a very reasonable way
to work while you're still getting comfortable with Git.

**Writing good commit messages**: describe *what changed and why*, not
*how*. `"Fix cutoff so it never skips the DO stage"` is a good message;
`"fixed bug"` is not \u2014 six months from now, only the first one will mean
anything to you.

---

## 9. How to build a project like this yourself

The single most valuable transferable skill here isn't any specific tool
\u2014 it's the *process* that produced this project. Here's that process,
generalized:

1. **Write the real-world workflow down in plain English first**,
   role by role, before touching any code. (This project started from
   exactly that \u2014 a description of who does what, in what order, with
   what authority. Everything else was translation.)
2. **Draw the data model before the data model becomes a `schema.prisma`
   file.** Identify the *nouns* in the workflow (Student, Classroom,
   AttendanceRecord...) and the relationships between them. A simple
   box-and-arrow sketch on paper is enough at this stage.
3. **List every role and exactly what they're allowed to do.** This
   becomes your permission checks (`requireRole(...)`) later \u2014 write it
   as a table first: Role \u2192 Can do X, Y, Z.
4. **Design the API before the UI.** For each action a role can take,
   write down: the URL, the HTTP method, what data it needs, what it
   checks, what it changes. This becomes your route files.
5. **Build the backend first, and test it without a UI at all** \u2014 tools
   like `curl`, Postman, or the free "Thunder Client" VS Code extension
   let you send requests directly and see JSON responses, before any
   frontend exists to get in the way of debugging.
6. **Build the frontend screen by screen, one role at a time.** Get one
   role's one screen fully working against the real backend before moving
   to the next \u2014 resist building all the UI first and wiring it up later.
7. **Seed realistic fake data early.** A schema with zero rows in it is
   hard to reason about; this project's `seed.js` exists for exactly that
   reason \u2014 write yours as soon as your tables exist.
8. **Deploy early, even before every feature is done.** A working, deployed
   skeleton is more valuable than a fully-featured app that only runs on
   your laptop \u2014 you'll also catch environment-specific bugs (like CORS)
   much earlier.

A few durable principles worth internalizing, independent of any framework:

- **Never trust the client.** Every check the frontend does for a nice UI
  (greying out a button) must be re-checked on the server, because a
  browser request can always be sent by something other than your UI.
- **Model state as data, not as scattered booleans.** The four approval
  stages here are just fields checked in order \u2014 resist the urge to add a
  separate `isDoApprovedButNotYetTeacherApproved` flag; derive it instead.
- **Separate "propose" from "apply"** whenever two different people need
  to be involved in a change (see \u00a72.6). It's a small pattern that solves
  a surprising number of "who's allowed to do this" problems.
- **Write the rule in one place.** The cutoff's "never skip the DO stage"
  rule lives in exactly one `if` statement, not copy-pasted across every
  route that touches attendance \u2014 if the rule ever changes, there's one
  place to change it.

---

## 10. File-by-file map of the repo

| File | What it's responsible for |
|---|---|
| `server/prisma/schema.prisma` | The entire data model \u2014 every table and column |
| `server/src/db.js` | The one shared database connection |
| `server/src/auth.js` | Login-token creation and the `requireAuth`/`requireRole` checks |
| `server/src/constants.js` | The list of valid absence reasons |
| `server/src/stages.js` | The four-stage approval state machine logic |
| `server/src/applyChange.js` | Turns an approved `PendingChange` into a real database write |
| `server/src/seed.js` | Fills a fresh database with demo users/students/rooms |
| `server/src/index.js` | Wires all the route files into one Express app |
| `server/src/routes/auth.js` | Login and "who am I" endpoints |
| `server/src/routes/state.js` | The one endpoint that returns the whole app's current data |
| `server/src/routes/changes.js` | Propose / approve / reject master-data changes |
| `server/src/routes/attendance.js` | The entire daily attendance workflow \u2014 the heart of the app |
| `server/src/routes/students.js` | The Warden-only "mark away" / "report back" actions |
| `client/src/main.jsx` | The very first file that runs in the browser |
| `client/src/api.js` | Every network call the frontend makes, in one place |
| `client/src/App.jsx` | The entire UI \u2014 login screen and one component per role/screen |
| `README.md` | Setup, GitHub, and deployment instructions |
| `HOW_IT_WORKS.md` | Conceptual explanation for beginners, with a full request walkthrough |
| `MANUAL.md` | This file |

---

## 11. Reference links

Grouped by topic, official/primary sources only:

- **JavaScript**: developer.mozilla.org (MDN)
- **Git**: git-scm.com/book, docs.github.com
- **Node.js**: nodejs.org/docs
- **SQL / Postgres**: postgresql.org/docs, sqlbolt.com
- **Express**: expressjs.com
- **Prisma**: prisma.io/docs
- **React**: react.dev
- **Vite**: vitejs.dev
- **Tailwind CSS**: tailwindcss.com/docs
- **JWT**: jwt.io
- **bcrypt**: www.npmjs.com/package/bcryptjs (package page includes usage docs)
- **Render**: render.com/docs
- **Vercel**: vercel.com/docs
- **Neon**: neon.tech/docs
- **Supabase**: supabase.com/docs
- **General full-stack curriculum**: freecodecamp.org

Official documentation changes less often and more reliably than
third-party tutorials \u2014 when in doubt, prefer the docs site over a random
blog post, especially for anything involving setup or security.
