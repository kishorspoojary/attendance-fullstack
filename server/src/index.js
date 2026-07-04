import "dotenv/config";
import express from "express";
import cors from "cors";
import { authRouter } from "./routes/auth.js";
import { stateRouter } from "./routes/state.js";
import { changesRouter } from "./routes/changes.js";
import { attendanceRouter } from "./routes/attendance.js";
import { studentsRouter } from "./routes/students.js";

const app = express();
const origins = (process.env.CORS_ORIGIN || "http://localhost:5173").split(",").map((s) => s.trim());

app.use(cors({ origin: origins, credentials: true }));
app.use(express.json());

app.get("/api/health", (req, res) => res.json({ ok: true }));
app.use("/api/auth", authRouter);
app.use("/api", stateRouter);
app.use("/api", changesRouter);
app.use("/api", attendanceRouter);
app.use("/api", studentsRouter);

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server" });
});

const port = process.env.PORT || 4000;
app.listen(port, () => console.log(`Attendance API listening on port ${port}`));
