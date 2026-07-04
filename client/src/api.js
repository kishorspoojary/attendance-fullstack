// ============================================================================
// The ONLY file in the frontend that talks to the network. Every component
// in App.jsx calls one of the functions in the `api` object below instead
// of calling `fetch` directly — that way, if the backend's URLs ever change,
// there's exactly one file to update.
//
// VITE_API_URL is set in client/.env — it points at wherever the backend is
// running (localhost while developing, your Render URL once deployed).
// ============================================================================
const BASE = import.meta.env.VITE_API_URL || "http://localhost:4000";

// The login token (a JWT — see server/src/auth.js) is saved in the browser's
// localStorage, so refreshing the page or closing the tab doesn't log you
// out. It's just a string; we don't need to understand its contents here,
// only pass it along.
function getToken() {
  return localStorage.getItem("attendance_token") || "";
}

// A small wrapper around the browser's built-in `fetch`, shared by every
// function below. It: builds the full URL, attaches the login token as an
// Authorization header (if we have one), turns the JS object we're sending
// into a JSON string, and turns the JSON response back into a JS object.
// If the server responded with an error status, it throws — which means
// every caller can just `await` and use a normal try/catch.
async function request(path, options = {}) {
  const res = await fetch(`${BASE}/api${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong");
  return data;
}

// Every network call the app makes, in one place. Each of these lines
// corresponds directly to one route in server/src/routes/*.js — e.g.
// `approveStage` below calls the same URL that attendance.js's
// `/attendance/:date/:classId/approve` route handles.
export const api = {
  login: (username, password) => request("/auth/login", { method: "POST", body: { username, password } }),
  me: () => request("/auth/me"),
  getState: () => request("/state"), // fetches the entire app snapshot; see routes/state.js
  proposeChange: (type, summary, payload) => request("/changes", { method: "POST", body: { type, summary, payload } }),
  approveChange: (id) => request(`/changes/${id}/approve`, { method: "POST" }),
  rejectChange: (id, reason) => request(`/changes/${id}/reject`, { method: "POST", body: { reason } }),
  setAbsence: (date, classId, studentId, reason) => request(`/attendance/${date}/${classId}/absence`, { method: "POST", body: { studentId, reason: reason || null } }),
  verifyReason: (date, classId, studentId, reason) => request(`/attendance/${date}/${classId}/reason`, { method: "POST", body: { studentId, reason } }),
  setHeadcount: (date, classId, headcount) => request(`/attendance/${date}/${classId}/headcount`, { method: "POST", body: { headcount } }),
  approveStage: (date, classId) => request(`/attendance/${date}/${classId}/approve`, { method: "POST" }), // server figures out *which* stage from your role
  runCutoff: (date) => request(`/attendance/${date}/cutoff`, { method: "POST" }),
  markAway: (studentId, reason) => request(`/students/${studentId}/mark-away`, { method: "POST", body: { reason } }),
  reportBack: (studentId) => request(`/students/${studentId}/report-back`, { method: "POST" }),
  setToken: (token) => localStorage.setItem("attendance_token", token),
  clearToken: () => localStorage.removeItem("attendance_token"),
  hasToken: () => !!getToken(),
};
