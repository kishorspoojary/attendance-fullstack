# How this app works (for beginners)

This doc explains the big picture before you go read code. Skim it once,
then use it as a reference while you look at the actual files — each file
also has its own comments.

## 1. The three pieces, and why they're separate

Every app like this has three moving parts that talk to each other:

```
  Browser                Backend (server)              Database
┌───────────┐  HTTP    ┌───────────────────┐  SQL    ┌─────────────┐
│   React    │ ───────▶ │  Express + Prisma │ ──────▶ │   Postgres   │
│  (client)  │ ◀─────── │      (server)      │ ◀────── │ (the actual  │
└───────────┘  JSON     └───────────────────┘  rows    │ stored data) │
                                                         └─────────────┘
```

- **The database** (`server/prisma/schema.prisma`) is just organized
  storage — tables of students, staff, attendance records, etc. It has no
  logic of its own; it only stores and retrieves rows.
- **The backend / server** (everything in `server/`) is the only thing
  allowed to talk to the database directly. It exposes a set of URLs
  (an "API") that the frontend can call, like
  `POST /api/attendance/2026-07-04/10A/approve`. Each URL runs some code,
  maybe reads/writes the database, and sends back an answer as JSON.
  This is also where rules live — e.g. "only a DO can approve this," "you
  can't approve twice." Putting rules here (not in the browser) matters
  because anyone can tamper with what a browser sends; the server is the
  one place we can actually trust.
- **The frontend / client** (everything in `client/`) is what actually
  renders in your browser — buttons, tables, forms. It has zero access to
  the database. Every time it needs data, or wants to change something, it
  sends an HTTP request to the backend and waits for a JSON reply.

## 2. What happens when you click a button (a full example)

Say a Discipline Officer clicks **"Verified — approve list"**. Here's the
whole round trip:

1. **Browser**: `App.jsx`'s `DoClassCard` component runs
   `api.approveStage(date, classId)`.
2. **`client/src/api.js`**: turns that into a real network request:
   `POST http://localhost:4000/api/attendance/2026-07-04/10A/approve`,
   with the user's login token attached in a header so the server knows
   who's asking.
3. **Network**: the request travels to the server (could be on the same
   laptop, or across the internet if deployed).
4. **`server/src/index.js`**: Express (the server framework) sees the URL
   matches a route and hands it to the matching handler function.
5. **`server/src/auth.js`**: before the handler even runs,
   `requireAuth` checks the login token is valid, and `requireRole(...)`
   checks the user is allowed to do this (e.g. must be a DO).
6. **`server/src/routes/attendance.js`**: the actual handler function runs —
   checks the headcount was entered, checks every absentee has a verified
   reason, then asks Prisma to update that row in the database.
7. **`server/src/db.js` / Prisma**: translates that into real SQL and sends
   it to Postgres.
8. **Database**: updates the row, confirms it worked.
9. The success travels back up the same chain: Prisma → route handler →
   Express → HTTP response → `api.js` → back to the component.
10. **Browser**: the component calls `refresh()`, which re-fetches the
    whole app's data with `GET /api/state`, so everyone's screen reflects
    the new approval.

Every single button, form, and toggle in this app follows that same
pattern: **click → api.js sends a request → a route handler on the server
checks permissions and touches the database → the frontend refetches and
re-renders.**

## 3. Key concepts you'll see everywhere

**Frontend (React)**
- A **component** is just a JavaScript function that returns some JSX
  (HTML-looking syntax) describing what to show. `App.jsx` has dozens of
  small components (`Card`, `Badge`, `WardenScreen`, ...) that combine like
  Lego blocks.
- `useState(initialValue)` gives a component a piece of memory that
  persists between renders — e.g. `const [headcount, setHeadcount] =
  useState("")` remembers what's typed in a box. Calling `setHeadcount(x)`
  updates it and makes React redraw that part of the screen.
- `useEffect(() => { ... }, [deps])` runs some code automatically when the
  component first appears, or when something in `deps` changes. We use it
  once, in `App.jsx`, to load data as soon as the page opens.
- **Props** are just the arguments passed into a component, e.g.
  `<DoClassCard c={classroom} record={record} />` — `c` and `record` are
  props.

**Backend (Express + Prisma)**
- **Express** is a library for writing servers: you register a URL pattern
  and a function, and it calls your function whenever a matching request
  arrives. `app.post("/api/auth/login", handlerFn)` is a full example.
- **Middleware** is a function that runs *before* your main handler, to do
  shared setup or checks — our `requireAuth` and `requireRole` in
  `auth.js` are middleware: they check the login token / role and either
  let the request continue or stop it with an error.
- **Prisma** is an ORM (Object-Relational Mapper) — it lets us write
  `prisma.student.create({ data: {...} })` in JavaScript instead of
  writing raw SQL (`INSERT INTO "Student" ...`). `schema.prisma` is where
  we describe what tables/columns exist; Prisma generates the matching
  JavaScript functions automatically.
- **JWT (JSON Web Token)** is how the server remembers who's logged in
  without a database lookup on every request. When you log in, the server
  creates a signed token containing your user id and role, and the
  browser sends it back on every future request (see `auth.js`).

## 4. Where to actually start reading

If you're going file by file, this order builds understanding gradually:

1. `server/prisma/schema.prisma` — the shape of all the data. Read this
   first; everything else operates on these tables.
2. `server/src/seed.js` — creates sample rows in every table. Seeing
   realistic data makes the schema concrete.
3. `server/src/auth.js` — how login and permission-checking work.
4. `server/src/routes/attendance.js` — the most important business logic:
   the whole daily approval chain.
5. `client/src/api.js` — the frontend's only doorway to the backend; short
   and mechanical, good to skim.
6. `client/src/App.jsx` — start at the top (`AttendanceApp`/`export default
   function App`) and follow the render calls downward into
   `WardenScreen`, `DOScreen`, etc.

## 5. Glossary

| Term | Meaning here |
|---|---|
| API / endpoint | A specific URL the server responds to, e.g. `/api/students` |
| Route / route handler | The function that runs for a given endpoint |
| Middleware | Code that runs before a route handler (checks, logging, etc.) |
| ORM | A library that lets you query a database using code instead of SQL |
| Schema / migration | The defined shape of the database, and the process of applying changes to it |
| JWT / token | A signed piece of text proving who's logged in |
| Component | A reusable piece of UI in React |
| State | Data a component remembers and can update, causing a re-render |
| Props | Data passed into a component from its parent |
| JSON | The plain-text format used to send data between frontend and backend |
