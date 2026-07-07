// ============================================================================
// The server's entry point — this is the file `npm start` actually runs.
//
// All it does is: set up Express, tell it which route files handle which
// URL prefixes, and start listening for requests on a port. The real logic
// lives in the imported route files (routes/*.js) — this file is just wiring.
// ============================================================================
import "dotenv/config"; // loads variables from a local .env file into process.env
import express from "express";
import cors from "cors";
import { authRouter } from "./routes/auth.js";
import { stateRouter } from "./routes/state.js";
import { changesRouter } from "./routes/changes.js";
import { attendanceRouter } from "./routes/attendance.js";
import { studentsRouter } from "./routes/students.js";
import { usersRouter } from "./routes/users.js";

const app = express();

// CORS ("Cross-Origin Resource Sharing") controls which websites are allowed
// to call this API from a browser. Without this, a browser would block the
// frontend (running on a different port/domain) from talking to us at all.
// CORS_ORIGIN is a comma-separated list so you can allow both your local dev
// URL and your deployed frontend URL at once.
const origins = (process.env.CORS_ORIGIN || "http://localhost:5173").split(",").map((s) => s.trim());
app.use(cors({ origin: origins, credentials: true }));

// Lets Express automatically parse incoming JSON request bodies into
// regular JavaScript objects, available as req.body in every route handler.
app.use(express.json());

app.get("/api/health", (req, res) => res.json({ ok: true })); // quick "is the server up" check

// Each router below is a mini bundle of related routes (see each file for
// its own list). Mounting them all under "/api" means, e.g., the "/login"
// route inside authRouter actually becomes "/api/auth/login".
app.use("/api/auth", authRouter);
app.use("/api", stateRouter);
app.use("/api", changesRouter);
app.use("/api", attendanceRouter);
app.use("/api", studentsRouter);
app.use("/api", usersRouter);

// A catch-all error handler. If any route handler throws an unexpected
// error (a bug, a database hiccup, etc.), Express routes it here instead of
// crashing the whole server or leaking a raw stack trace to the browser.
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server" });
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Attendance API listening on port ${port}`));
