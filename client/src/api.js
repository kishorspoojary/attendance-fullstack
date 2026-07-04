const BASE = import.meta.env.VITE_API_URL || "http://localhost:4000";

function getToken() {
  return localStorage.getItem("attendance_token") || "";
}

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

export const api = {
  login: (username, password) => request("/auth/login", { method: "POST", body: { username, password } }),
  me: () => request("/auth/me"),
  getState: () => request("/state"),
  proposeChange: (type, summary, payload) => request("/changes", { method: "POST", body: { type, summary, payload } }),
  approveChange: (id) => request(`/changes/${id}/approve`, { method: "POST" }),
  rejectChange: (id, reason) => request(`/changes/${id}/reject`, { method: "POST", body: { reason } }),
  setAbsence: (date, classId, studentId, reason) => request(`/attendance/${date}/${classId}/absence`, { method: "POST", body: { studentId, reason: reason || null } }),
  verifyReason: (date, classId, studentId, reason) => request(`/attendance/${date}/${classId}/reason`, { method: "POST", body: { studentId, reason } }),
  setHeadcount: (date, classId, headcount) => request(`/attendance/${date}/${classId}/headcount`, { method: "POST", body: { headcount } }),
  approveStage: (date, classId) => request(`/attendance/${date}/${classId}/approve`, { method: "POST" }),
  runCutoff: (date) => request(`/attendance/${date}/cutoff`, { method: "POST" }),
  markAway: (studentId, reason) => request(`/students/${studentId}/mark-away`, { method: "POST", body: { reason } }),
  reportBack: (studentId) => request(`/students/${studentId}/report-back`, { method: "POST" }),
  setToken: (token) => localStorage.setItem("attendance_token", token),
  clearToken: () => localStorage.removeItem("attendance_token"),
  hasToken: () => !!getToken(),
};
