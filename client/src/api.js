// ============================================================================
// Every network call the frontend makes, in one place. Nothing else in this
// app calls fetch() directly — every component goes through the `api`
// object below, so there's exactly one spot that knows how to attach the
// login token and handle a failed request.
// ============================================================================
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
  if (!res.ok) {
    const err = new Error(data.error || "Something went wrong");
    err.status = data.status; // e.g. "PENDING" / "FROZEN" / "REJECTED", set by requireAuth
    throw err;
  }
  return data;
}

// Excel downloads (template/export) return a file, not JSON — fetch as a
// blob and trigger a normal browser "Save As" via a throwaway link, rather
// than trying to squeeze this through the JSON-shaped `request()` above.
async function downloadFile(path, filename) {
  const res = await fetch(`${BASE}/api${path}`, { headers: { Authorization: `Bearer ${getToken()}` } });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || "Download failed");
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

// File upload needs multipart/form-data, which is a completely different
// request shape than every other call in this file — no JSON body, and the
// browser sets the Content-Type (with the right boundary) itself as long as
// we don't set one ourselves.
async function uploadFile(path, file) {
  const formData = new FormData();
  formData.append("file", file);
  const res = await fetch(`${BASE}/api${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${getToken()}` },
    body: formData,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Upload failed");
  return data;
}

export const api = {
  // ---- Registration & leadership (Principal only) ----
  principalExists: () => request("/auth/principal-exists"),
  registerPrincipal: (name, password) => request("/auth/register-principal", { method: "POST", body: { name, password } }),
  createLeadership: (name, role) => request("/auth/leadership", { method: "POST", body: { name, role } }),

  // ---- Login & session ----
  login: (loginKey, password) => request("/auth/login", { method: "POST", body: { loginKey, password } }),
  me: () => request("/auth/me"),
  changePassword: (currentPassword, newPassword) => request("/auth/change-password", { method: "POST", body: { currentPassword, newPassword } }),

  // ---- Whole-app snapshot ----
  getState: () => request("/state"),

  // ---- Master-data change proposals (Database Manager -> AO) ----
  proposeChange: (type, summary, payload) => request("/changes", { method: "POST", body: { type, summary, payload } }),
  approveChange: (id) => request(`/changes/${id}/approve`, { method: "POST" }),
  rejectChange: (id, reason) => request(`/changes/${id}/reject`, { method: "POST", body: { reason } }),

  // ---- Daily attendance workflow ----
  setAbsence: (date, classId, studentId, reason) => request(`/attendance/${date}/${classId}/absence`, { method: "POST", body: { studentId, reason: reason || null } }),
  confirmAbsent: (date, classId, studentId) => request(`/attendance/${date}/${classId}/confirm`, { method: "POST", body: { studentId } }),
  correctPresence: (date, classId, studentId) => request(`/attendance/${date}/${classId}/correct-presence`, { method: "POST", body: { studentId } }),
  verifyReason: (date, classId, studentId, reason) => request(`/attendance/${date}/${classId}/reason`, { method: "POST", body: { studentId, reason } }),
  setHeadcount: (date, classId, headcount) => request(`/attendance/${date}/${classId}/headcount`, { method: "POST", body: { headcount } }),
  approveStage: (date, classId) => request(`/attendance/${date}/${classId}/approve`, { method: "POST" }),
  sendBack: (date, classId, reason) => request(`/attendance/${date}/${classId}/send-back`, { method: "POST", body: { reason } }),
  runCutoff: (date) => request(`/attendance/${date}/cutoff`, { method: "POST" }),

  // ---- Persistent "away" status (Warden only) ----
  markAway: (studentId, reason) => request(`/students/${studentId}/mark-away`, { method: "POST", body: { reason } }),
  reportBack: (studentId) => request(`/students/${studentId}/report-back`, { method: "POST" }),

  // ---- Account freeze (AO only) ----
  freezeUser: (id) => request(`/users/${id}/freeze`, { method: "POST" }),
  unfreezeUser: (id) => request(`/users/${id}/unfreeze`, { method: "POST" }),

  // ---- Excel template / import / export (Database Manager only) ----
  downloadStudentTemplate: () => downloadFile("/excel/students/template", "student-import-template.xlsx"),
  exportStudents: () => downloadFile("/excel/students/export", "students-export.xlsx"),
  importStudents: (file) => uploadFile("/excel/students/import", file),
  exportAbsentees: (date) => downloadFile(`/excel/absentees/export?date=${date}`, `absentees-${date}.xlsx`),

  // ---- Local token storage ----
  setToken: (token) => localStorage.setItem("attendance_token", token),
  clearToken: () => localStorage.removeItem("attendance_token"),
  hasToken: () => !!getToken(),
};
