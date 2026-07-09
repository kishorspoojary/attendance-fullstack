// ============================================================================
// The entire user interface — one login/registration flow, then one screen
// per role. New to React? A "component" is just a function that returns
// JSX (the HTML-looking syntax below) describing what to render. `useState`
// gives a component memory that survives between re-renders; calling its
// setter function schedules React to redraw.
//
// How data flows through this file, top to bottom:
//   App() holds the one source of truth: `state` (the whole backend
//   snapshot from api.getState()) and `me` (who's logged in). Every screen
//   below receives slices of that as props and calls `runAction` to make a
//   change — runAction always does the same three things: call the API,
//   re-fetch the whole snapshot, show a toast. See runAction's own comment
//   in App() for why it's built that way.
//
// Rough map of this file, in order:
//   1. Shared constants (STAGES, labels, date formatting)
//   2. Small reusable UI pieces (Card, Badge, Btn, Field, Select...)
//   3. Login / Registration / mandatory password-change screens
//   4. App() — the top-level component and its role-based router
//   5. One component per screen, grouped by who uses it
// ============================================================================
import { useState, useEffect, useCallback } from "react";
import {
  ClipboardCheck, ShieldCheck, GraduationCap, Bed, UserCog, ListChecks,
  Clock, CheckCircle2, AlertTriangle, ChevronDown, Plus, Trash2, Check, X,
  Phone, Bell, LogIn, LogOut, Users, LayoutDashboard, Loader2, Pencil,
  Undo2, Search, UserPlus, Snowflake, KeyRound, Building2,
} from "lucide-react";
import { api } from "./api.js";

/* ---------------------------------------------------------------- */
/* 1. Shared constants                                                */
/* ---------------------------------------------------------------- */
const todayStr = () => new Date().toISOString().slice(0, 10);

// The three approval stages, in order, mirrored from server/src/stages.js.
// (Duplicated rather than imported because the frontend and backend are
// separate projects that don't share code.) AO does not approve daily
// attendance — Coordinator is the last human stage.
const STAGES = [
  { key: "doApproved", label: "DO verified", pendingLabel: "Discipline Officer" },
  { key: "teacherApproved", label: "Teacher approved", pendingLabel: "Incharge Teacher" },
  { key: "coordinatorApproved", label: "Coordinator approved", pendingLabel: "Coordinator" },
];
function currentStageIndex(rec) {
  for (let i = 0; i < STAGES.length; i++) if (!rec[STAGES[i].key]) return i;
  return STAGES.length;
}
function priorStageKey(stageKey) {
  const idx = STAGES.findIndex((s) => s.key === stageKey);
  return idx > 0 ? STAGES[idx - 1].key : null;
}
function recordTag(rec) {
  const idx = currentStageIndex(rec);
  const published = idx === STAGES.length || rec.forcedPublish;
  if (!published) return { label: `Pending — ${STAGES[idx].pendingLabel}`, tone: "amber" };
  if (idx === STAGES.length) return { label: "Verified", tone: "emerald" };
  const missing = STAGES.slice(idx).map((s) => s.pendingLabel).join(", ");
  return { label: `Auto-passed — missing: ${missing}`, tone: "rose" };
}
function emptyRecord() {
  return {
    wardenAbsences: {}, laiAbsences: {}, headcount: null, doConfirmed: {}, doVerified: {},
    doApproved: null, teacherApproved: null, coordinatorApproved: null,
    forcedPublish: false, skippedStages: [], sentBack: null,
  };
}

const ROLE_LABELS = {
  PRINCIPAL: "Principal", AO: "AO", COORDINATOR: "Coordinator", DB_MANAGER: "Database Manager",
  WARDEN: "Warden", DO: "Discipline Officer", INCHARGE_TEACHER: "Incharge Teacher", LAI: "Local Attendance Incharge",
};
const DAILY_REASONS = ["Sick", "Not in room", "Other"];
const AWAY_REASON = "Went home";

// Every date shown as text (not inside a native <input type="date">, which
// renders however the browser/OS prefers) uses this dd/mm/yyyy format,
// per the requirement that dates display that way everywhere.
function formatDMY(isoDate) {
  if (!isoDate) return "—";
  const [y, m, d] = isoDate.slice(0, 10).split("-");
  return `${d}/${m}/${y}`;
}
function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/* ---------------------------------------------------------------- */
/* 2. Small reusable UI pieces                                        */
/* ---------------------------------------------------------------- */
const TONES = {
  slate: "bg-slate-100 text-slate-600 border-slate-200",
  emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
  rose: "bg-rose-50 text-rose-700 border-rose-200",
  amber: "bg-amber-50 text-amber-700 border-amber-200",
};
function Badge({ tone = "slate", children }) {
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONES[tone]}`}>{children}</span>;
}
function Card({ children, className = "" }) {
  return <div className={`rounded-2xl border border-slate-200 bg-white shadow-sm ${className}`}>{children}</div>;
}
function SectionTitle({ icon: Icon, title, subtitle }) {
  return (
    <div className="mb-4 flex items-start gap-3">
      {Icon && <div className="mt-0.5 grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#12324D] text-white"><Icon size={17} /></div>}
      <div>
        <h2 className="font-display text-lg font-semibold text-slate-900">{title}</h2>
        {subtitle && <p className="text-sm text-slate-500">{subtitle}</p>}
      </div>
    </div>
  );
}
function Btn({ children, onClick, variant = "primary", disabled, size = "md" }) {
  const base = "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition disabled:cursor-not-allowed disabled:opacity-40";
  const sizes = size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-2 text-sm";
  const variants = {
    primary: "bg-[#12324D] text-white hover:bg-[#0d2438]",
    success: "bg-emerald-600 text-white hover:bg-emerald-700",
    danger: "bg-rose-600 text-white hover:bg-rose-700",
    ghost: "bg-slate-100 text-slate-700 hover:bg-slate-200",
    outline: "border border-slate-300 text-slate-700 hover:bg-slate-50",
  };
  return <button className={`${base} ${sizes} ${variants[variant]} w-full sm:w-auto`} onClick={onClick} disabled={disabled}>{children}</button>;
}
function Field({ label, children }) {
  return <label className="block text-sm"><span className="mb-1 block font-medium text-slate-700">{label}</span>{children}</label>;
}
const inputCls = "w-full rounded-lg border border-slate-300 px-3 py-1.5 text-sm outline-none focus:border-[#12324D] focus:ring-1 focus:ring-[#12324D]";
function Select({ value, onChange, options, placeholder }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={inputCls}>
      <option value="">{placeholder || "Select..."}</option>
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}
function EmptyNote({ text }) {
  return <div className="rounded-xl border border-dashed border-slate-300 bg-white px-4 py-6 text-center text-sm text-slate-400">{text}</div>;
}
function groupBy(arr, fn) {
  return arr.reduce((acc, item) => { const k = fn(item); (acc[k] = acc[k] || []).push(item); return acc; }, {});
}
// A plain search box used on the screens with long student lists (Warden,
// LAI, Database Manager) — filtering happens client-side in each screen,
// this component just renders the input.
function SearchBox({ value, onChange, placeholder }) {
  return (
    <div className="relative mb-3">
      <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
      <input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder || "Search..."} className={`${inputCls} pl-8`} />
    </div>
  );
}
// Shown wherever a record carries an unresolved send-back aimed at the
// person viewing it — see attendance.js's /send-back route.
function SentBackBanner({ record }) {
  if (!record.sentBack) return null;
  return (
    <div className="mb-3 flex items-start gap-2 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
      <Undo2 size={15} className="mt-0.5 shrink-0" />
      <div><span className="font-medium">Sent back by {record.sentBack.fromName}:</span> {record.sentBack.reason}</div>
    </div>
  );
}
// A small inline "type a reason, then confirm" control used for send-back
// buttons everywhere, so it doesn't need its own modal component.
function SendBackButton({ onSend }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (!open) return <Btn size="sm" variant="outline" onClick={() => setOpen(true)}><Undo2 size={13} /> Send back</Btn>;
  return (
    <div className="flex w-full flex-col gap-2 sm:w-64">
      <input autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this being sent back?" className={inputCls} />
      <div className="flex gap-2">
        <Btn size="sm" variant="danger" disabled={!reason.trim()} onClick={() => { onSend(reason.trim()); setOpen(false); setReason(""); }}>Confirm send back</Btn>
        <Btn size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Btn>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* 3. Login, Registration, and mandatory password change              */
/* ---------------------------------------------------------------- */

// Shown before anyone's logged in. Defaults to the login form; a small
// link flips to registration for the one-time "first person to ever use
// this app" bootstrap. If someone mistakenly tries to register when a
// Principal already exists, the server just rejects it with a clear
// message — no separate check is needed here to decide which to show.
function AuthScreen({ onLoggedIn }) {
  const [mode, setMode] = useState("login"); // "login" | "register"
  return (
    <div className="grid min-h-screen place-items-center bg-slate-50 px-4" style={{ fontFamily: "Inter, system-ui, sans-serif" }}>
      <div className="w-full max-w-sm">
        <div className="mb-5 flex items-center gap-2.5 px-1">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-[#12324D] text-white"><ClipboardCheck size={17} /></div>
          <div className="font-display text-base font-semibold text-slate-900">Attendance & Hostel System</div>
        </div>
        {mode === "login" ? <LoginForm onLoggedIn={onLoggedIn} /> : <RegisterForm onLoggedIn={onLoggedIn} />}
        <p className="mt-4 text-center text-xs text-slate-400">
          {mode === "login" ? (
            <>First time setting up this app? <button className="font-medium text-[#12324D] underline" onClick={() => setMode("register")}>Register as Principal</button></>
          ) : (
            <>Already set up? <button className="font-medium text-[#12324D] underline" onClick={() => setMode("login")}>Log in instead</button></>
          )}
        </p>
      </div>
    </div>
  );
}

function LoginForm({ onLoggedIn }) {
  const [loginKey, setLoginKey] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(""); setBusy(true);
    try {
      const { token, user } = await api.login(loginKey.trim(), password);
      api.setToken(token);
      onLoggedIn(user);
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  };

  return (
    <Card className="p-6">
      <div className="space-y-3">
        <Field label="4-digit login key">
          <input className={inputCls} value={loginKey} maxLength={4} inputMode="numeric"
            onChange={(e) => setLoginKey(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && submit()} autoFocus placeholder="e.g. 4821" />
        </Field>
        <Field label="Password">
          <input type="password" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
        </Field>
      </div>
      {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}
      <div className="mt-4"><Btn onClick={submit} disabled={busy} variant="primary">{busy ? <Loader2 className="animate-spin" size={14} /> : <LogIn size={14} />} Log in</Btn></div>
    </Card>
  );
}

function RegisterForm({ onLoggedIn }) {
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);

  const submit = async () => {
    setError("");
    if (!name.trim()) return setError("Enter your name");
    if (password.length < 6) return setError("Password must be at least 6 characters");
    if (password !== confirm) return setError("Passwords don't match");
    setBusy(true);
    try {
      const { token, user } = await api.registerPrincipal(name.trim(), password);
      api.setToken(token);
      setCreated(user);
      setTimeout(() => onLoggedIn(user), 1200);
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  };

  if (created) {
    return (
      <Card className="p-6 text-center">
        <CheckCircle2 className="mx-auto mb-2 text-emerald-600" size={28} />
        <p className="font-medium text-slate-800">Registered! Your login key is <span className="font-display text-lg">{created.loginKey}</span></p>
        <p className="mt-1 text-xs text-slate-500">Write this down — you'll use it (with your password) to log in from now on. Taking you in...</p>
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <p className="mb-3 text-sm text-slate-500">This one-time step creates the Principal account. Every other account is created from inside the app after this.</p>
      <div className="space-y-3">
        <Field label="Your name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} autoFocus /></Field>
        <Field label="Choose a password"><input type="password" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <Field label="Confirm password"><input type="password" className={inputCls} value={confirm} onChange={(e) => setConfirm(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} /></Field>
      </div>
      {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}
      <div className="mt-4"><Btn onClick={submit} disabled={busy}>{busy ? <Loader2 className="animate-spin" size={14} /> : <UserPlus size={14} />} Register as Principal</Btn></div>
    </Card>
  );
}

// Blocks the rest of the app until a mandatory password change is done.
// Shown whenever me.mustChangePassword is true — true for every account
// until the person swaps out the shared default password for their own.
function ChangePasswordGate({ onDone, onLogout }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError("");
    if (newPassword.length < 6) return setError("New password must be at least 6 characters");
    if (newPassword !== confirm) return setError("Passwords don't match");
    setBusy(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      onDone();
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  };

  return (
    <div className="grid min-h-screen place-items-center bg-slate-50 px-4" style={{ fontFamily: "Inter, system-ui, sans-serif" }}>
      <Card className="w-full max-w-sm p-6">
        <div className="mb-4 flex items-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-amber-100 text-amber-700"><KeyRound size={17} /></div>
          <div>
            <p className="font-display text-base font-semibold text-slate-900">Set your own password</p>
            <p className="text-xs text-slate-500">You're still on the shared starting password — choose your own before continuing.</p>
          </div>
        </div>
        <div className="space-y-3">
          <Field label="Current password"><input type="password" className={inputCls} value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoFocus /></Field>
          <Field label="New password"><input type="password" className={inputCls} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} /></Field>
          <Field label="Confirm new password"><input type="password" className={inputCls} value={confirm} onChange={(e) => setConfirm(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} /></Field>
        </div>
        {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}
        <div className="mt-4 flex gap-2">
          <Btn onClick={submit} disabled={busy}>{busy ? <Loader2 className="animate-spin" size={14} /> : <KeyRound size={14} />} Set password</Btn>
          <Btn variant="ghost" onClick={onLogout}>Log out</Btn>
        </div>
      </Card>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* 4. App() — top-level component and role-based router               */
/* ---------------------------------------------------------------- */
export default function App() {
  const [state, setState] = useState(null);
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [authChecked, setAuthChecked] = useState(false);
  const [tab, setTab] = useState(null);
  const [toast, setToast] = useState(null);
  const [sessionMessage, setSessionMessage] = useState("");
  const date = todayStr();

  // The one function every mutation in this app goes through: call the
  // API, then re-fetch the ENTIRE snapshot (not just patch local state),
  // so every screen — not just the one you clicked in — reflects the
  // change. See HOW_IT_WORKS-style comment in api.js for why this is
  // simpler than trying to keep local state perfectly in sync by hand.
  const refresh = useCallback(async () => {
    try {
      const data = await api.getState();
      setState(data);
      setMe(data.me);
    } catch (e) {
      if (e.status || /logged in|expired|not active/i.test(e.message)) {
        api.clearToken(); setMe(null);
        setSessionMessage(e.message);
      }
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    if (api.hasToken()) refresh();
    else setLoading(false);
    setAuthChecked(true);
  }, [refresh]);

  const showToast = (msg, tone = "emerald") => { setToast({ msg, tone }); setTimeout(() => setToast(null), 2800); };

  const runAction = async (fn, successMsg) => {
    try {
      const result = await fn();
      await refresh();
      if (successMsg) showToast(successMsg);
      return result;
    } catch (e) {
      showToast(e.message, "rose");
      return null;
    }
  };

  if (!authChecked || loading) {
    return <div className="grid min-h-screen place-items-center text-slate-400"><Loader2 className="mr-2 animate-spin" size={18} /> Loading...</div>;
  }
  if (!me) {
    return (
      <div>
        {sessionMessage && <div className="bg-amber-100 px-4 py-2 text-center text-sm text-amber-800">{sessionMessage}</div>}
        <AuthScreen onLoggedIn={() => { setSessionMessage(""); refresh(); }} />
      </div>
    );
  }
  if (me.mustChangePassword) {
    return <ChangePasswordGate onDone={refresh} onLogout={() => { api.clearToken(); setMe(null); }} />;
  }

  const logout = () => { api.clearToken(); setMe(null); setState(null); };

  // Which sidebar tabs a person sees depends entirely on their role.
  const ROLE_TABS = {
    PRINCIPAL: [
      { id: "dashboard", label: "Daily report", icon: LayoutDashboard },
      { id: "leadership", label: "Leadership accounts", icon: UserPlus },
    ],
    AO: [
      { id: "approvals", label: "Master data approvals", icon: ShieldCheck },
      { id: "freeze", label: "Freeze / unfreeze", icon: Snowflake },
      { id: "hierarchy", label: "Hierarchy status", icon: Users },
    ],
    COORDINATOR: [
      { id: "coordinator", label: "Attendance approvals", icon: ListChecks },
      { id: "status", label: "Attendance status", icon: LayoutDashboard },
    ],
    DB_MANAGER: [
      { id: "students", label: "Students", icon: GraduationCap },
      { id: "structure", label: "Hostels & classes", icon: Building2 },
      { id: "assign", label: "Assign staff", icon: UserCog },
      { id: "createstaff", label: "Create staff account", icon: UserPlus },
      { id: "absentees", label: "View absentees", icon: ClipboardCheck },
      { id: "mychanges", label: "My requests", icon: Clock },
    ],
    WARDEN: [{ id: "warden", label: "Mark absentees", icon: Bed }],
    DO: [{ id: "do", label: "Verify & approve", icon: Phone }],
    INCHARGE_TEACHER: [
      { id: "teacher", label: "Approve lists", icon: ClipboardCheck },
      { id: "status", label: "Attendance status", icon: LayoutDashboard },
    ],
    LAI: [{ id: "lai", label: "Mark absentees", icon: GraduationCap }],
  };
  const tabs = ROLE_TABS[me.role] || [];
  const activeTab = tab && tabs.find((t) => t.id === tab) ? tab : tabs[0]?.id;

  return (
    <div className="min-h-screen w-full bg-slate-50 text-slate-800" style={{ fontFamily: "Inter, system-ui, sans-serif" }}>
      {/* Top bar */}
      <div className="sticky top-0 z-10 border-b border-slate-200 bg-[#0d2438] px-4 py-3 text-white sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-white/10"><ClipboardCheck size={16} /></div>
            <div>
              <div className="font-display text-[15px] font-semibold leading-tight">Attendance & Hostel System</div>
              <div className="text-[11px] text-white/60">{formatDMY(date)}</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-white/70 sm:inline">{me.name} · {ROLE_LABELS[me.role]} · Key {me.loginKey}</span>
            <button onClick={logout} className="flex items-center gap-1 rounded-lg border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/20">
              <LogOut size={13} /> Log out
            </button>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-4 p-3 sm:gap-5 sm:p-5 md:flex-row">
        {/* Sidebar — a horizontally-scrolling row on mobile, a column on larger screens */}
        {tabs.length > 1 && (
          <div className="flex shrink-0 gap-2 overflow-x-auto pb-1 md:w-56 md:flex-col md:overflow-visible">
            {tabs.map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`flex items-center gap-2 whitespace-nowrap rounded-xl px-3 py-2 text-left text-sm font-medium transition ${activeTab === t.id ? "bg-[#12324D] text-white" : "bg-white text-slate-600 hover:bg-slate-100 border border-slate-200"}`}>
                <t.icon size={15} /> {t.label}
              </button>
            ))}
          </div>
        )}
        <div className="min-w-0 flex-1">
          {!state ? (
            <div className="grid h-64 place-items-center text-slate-400"><Loader2 className="animate-spin" size={18} /></div>
          ) : (
            // The whole "router": exactly one of these renders, chosen by
            // matching `activeTab` against the id strings in ROLE_TABS above.
            <>
              {activeTab === "dashboard" && <PrincipalDashboard state={state} date={date} />}
              {activeTab === "leadership" && <LeadershipSetup state={state} runAction={runAction} />}
              {activeTab === "approvals" && <AOApprovals state={state} onApprove={(c) => runAction(() => api.approveChange(c.id), "Approved")} onReject={(c) => runAction(() => api.rejectChange(c.id, "Not approved"), "Rejected")} />}
              {activeTab === "freeze" && <AOFreezeAccounts state={state} runAction={runAction} />}
              {activeTab === "hierarchy" && <AOHierarchyStatus state={state} />}
              {activeTab === "coordinator" && <CoordinatorApprovals state={state} date={date} runAction={runAction} />}
              {activeTab === "status" && <PrincipalDashboard state={state} date={date} scopeFloorIds={me.role === "INCHARGE_TEACHER" ? me.floorIds : null} title="Attendance status" subtitle="Visible any time — not just when something is waiting on you." />}
              {activeTab === "students" && <StudentsAdmin state={state} runAction={runAction} />}
              {activeTab === "structure" && <StructureAdmin state={state} runAction={runAction} />}
              {activeTab === "assign" && <AssignAdmin state={state} runAction={runAction} />}
              {activeTab === "createstaff" && <CreateStaffAdmin state={state} runAction={runAction} />}
              {activeTab === "absentees" && <AbsenteesView state={state} />}
              {activeTab === "mychanges" && <MyChanges state={state} me={me} />}
              {activeTab === "warden" && <WardenScreen state={state} date={date} me={me} runAction={runAction} />}
              {activeTab === "do" && <DOScreen state={state} date={date} me={me} runAction={runAction} />}
              {activeTab === "teacher" && <ApprovalQueue state={state} date={date} runAction={runAction} stageKey="teacherApproved" requiredPriorKey="doApproved" roleLabel="Incharge Teacher" note="Lists appear once the Discipline Officer has verified them. Any Incharge Teacher on the floor can file this." />}
              {activeTab === "lai" && <LAIScreen state={state} date={date} me={me} runAction={runAction} />}
            </>
          )}
        </div>
      </div>

      {toast && <div className="fixed bottom-5 right-5 z-20"><Badge tone={toast.tone}>{toast.msg}</Badge></div>}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* 5a. Principal                                                      */
/* ---------------------------------------------------------------- */
function Stat({ label, value, tone = "slate" }) {
  return (
    <Card className="px-4 py-3">
      <div className={`font-display text-2xl font-bold ${tone === "emerald" ? "text-emerald-600" : tone === "rose" ? "text-rose-600" : "text-slate-800"}`}>{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </Card>
  );
}
function PrincipalDashboard({ state, date, scopeFloorIds, title, subtitle }) {
  const [viewDate, setViewDate] = useState(date);
  const day = state.attendance[viewDate] || {};
  const classesInScope = scopeFloorIds ? state.classes.filter((c) => scopeFloorIds.includes(c.collegeFloorId)) : state.classes;
  const rows = classesInScope.map((c) => ({ c, r: day[c.id] || emptyRecord() }));
  const published = rows.filter((x) => currentStageIndex(x.r) === STAGES.length || x.r.forcedPublish).length;
  const verified = rows.filter((x) => currentStageIndex(x.r) === STAGES.length).length;
  const autoPassed = rows.filter((x) => x.r.forcedPublish && currentStageIndex(x.r) < STAGES.length).length;
  const isToday = viewDate === date;
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <SectionTitle icon={LayoutDashboard} title={title || "Daily attendance report"} subtitle={subtitle || (isToday ? `Published straight to you once Coordinator approves — ${formatDMY(viewDate)}` : `Viewing history for ${formatDMY(viewDate)}`)} />
        <Field label="Date"><input type="date" max={date} className={inputCls} value={viewDate} onChange={(e) => setViewDate(e.target.value)} /></Field>
      </div>
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Classes" value={rows.length} />
        <Stat label="Published" value={published} />
        <Stat label="Verified" value={verified} tone="emerald" />
        <Stat label="Auto-passed" value={autoPassed} tone="rose" />
      </div>
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr><th className="px-4 py-2.5">Class</th><th className="px-4 py-2.5">Absent</th><th className="px-4 py-2.5">Status</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map(({ c, r }) => {
              const absentCount = new Set([...Object.keys(r.wardenAbsences || {}), ...Object.keys(r.laiAbsences || {})]).size;
              const tag = recordTag(r);
              return (
                <tr key={c.id}>
                  <td className="px-4 py-2.5 font-medium text-slate-800">{c.name}</td>
                  <td className="px-4 py-2.5 text-slate-600">{absentCount}</td>
                  <td className="px-4 py-2.5"><Badge tone={tag.tone}>{tag.label}</Badge></td>
                </tr>
              );
            })}
            {rows.length === 0 && <tr><td colSpan={3} className="px-4 py-6 text-center text-slate-400">No classes in this scope yet.</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

// Principal creates the AO / Coordinator / Database Manager accounts —
// "activating the system." Shows each newly generated key/password once,
// since that's the only moment the plain default password is ever visible.
function LeadershipSetup({ state, runAction }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("AO");
  const [justCreated, setJustCreated] = useState(null);
  const existing = state.staff.filter((s) => ["AO", "COORDINATOR", "DB_MANAGER"].includes(s.role));

  const submit = async () => {
    if (!name.trim()) return;
    const result = await runAction(() => api.createLeadership(name.trim(), role), "Account created");
    if (result) { setJustCreated(result); setName(""); }
  };

  return (
    <div>
      <SectionTitle icon={UserPlus} title="Leadership accounts" subtitle="Create the AO, Coordinator, and Database Manager accounts. Each starts on the shared default password and must change it on first login." />
      <Card className="mb-6 p-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Role">
            <select value={role} onChange={(e) => setRole(e.target.value)} className={inputCls}>
              <option value="AO">AO</option>
              <option value="COORDINATOR">Coordinator</option>
              <option value="DB_MANAGER">Database Manager</option>
            </select>
          </Field>
          <div className="flex items-end"><Btn onClick={submit}><Plus size={14} /> Create account</Btn></div>
        </div>
      </Card>
      {justCreated && (
        <Card className="mb-6 border-emerald-200 bg-emerald-50 p-4">
          <p className="text-sm text-emerald-800">
            Created <span className="font-medium">{justCreated.user.name}</span> ({ROLE_LABELS[justCreated.user.role]}) —
            login key <span className="font-display font-semibold">{justCreated.loginKey}</span>, password <span className="font-display font-semibold">{justCreated.defaultPassword}</span>.
            Hand these to them now — this is the only time the password is shown.
          </p>
        </Card>
      )}
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr><th className="px-4 py-2.5">Name</th><th className="px-4 py-2.5">Role</th><th className="px-4 py-2.5">Key</th><th className="px-4 py-2.5">Status</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {existing.map((s) => (
              <tr key={s.id}>
                <td className="px-4 py-2.5 font-medium text-slate-800">{s.name}</td>
                <td className="px-4 py-2.5 text-slate-600">{ROLE_LABELS[s.role]}</td>
                <td className="px-4 py-2.5 font-display text-slate-600">{s.loginKey}</td>
                <td className="px-4 py-2.5"><Badge tone={s.status === "ACTIVE" ? "emerald" : "rose"}>{s.status}</Badge></td>
              </tr>
            ))}
            {existing.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-slate-400">No leadership accounts yet.</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* 5b. AO                                                              */
/* ---------------------------------------------------------------- */
function AOApprovals({ state, onApprove, onReject }) {
  const pending = state.pendingChanges.filter((c) => c.status === "pending");
  return (
    <div>
      <SectionTitle icon={ShieldCheck} title="Master data approvals" subtitle="Every Database Manager change — including new staff accounts — is applied only after your approval." />
      {pending.length === 0 && <EmptyNote text="No pending changes right now." />}
      <div className="space-y-3">
        {pending.map((c) => (
          <Card key={c.id} className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="font-medium text-slate-800">{c.summary}</div>
                <div className="mt-0.5 text-xs text-slate-500">
                  Requested {formatDMY(c.createdAt)} {formatTime(c.createdAt)}
                  {c.type === "create_staff" && c.payload?.loginKey && <> · assigned key <span className="font-display">{c.payload.loginKey}</span></>}
                </div>
              </div>
              <div className="flex gap-2">
                <Btn size="sm" variant="success" onClick={() => onApprove(c)}><Check size={13} /> Approve</Btn>
                <Btn size="sm" variant="danger" onClick={() => onReject(c)}><X size={13} /> Reject</Btn>
              </div>
            </div>
          </Card>
        ))}
      </div>
      <div className="mt-8">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Recent decisions</p>
        <div className="space-y-2">
          {state.pendingChanges.filter((c) => c.status !== "pending").slice(0, 6).map((c) => (
            <div key={c.id} className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
              <span className="text-slate-600">{c.summary}</span>
              <Badge tone={c.status === "approved" ? "emerald" : "rose"}>{c.status}</Badge>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function AOFreezeAccounts({ state, runAction }) {
  const staff = state.staff.filter((s) => s.role !== "PRINCIPAL");
  return (
    <div>
      <SectionTitle icon={Snowflake} title="Freeze / unfreeze accounts" subtitle="Freezing pauses an account immediately — they can't log in again until you unfreeze them. Past work stays untouched." />
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr><th className="px-4 py-2.5">Name</th><th className="px-4 py-2.5">Role</th><th className="px-4 py-2.5">Status</th><th className="px-4 py-2.5"></th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {staff.map((s) => (
              <tr key={s.id}>
                <td className="px-4 py-2.5 font-medium text-slate-800">{s.name}</td>
                <td className="px-4 py-2.5 text-slate-600">{ROLE_LABELS[s.role]}</td>
                <td className="px-4 py-2.5"><Badge tone={s.status === "ACTIVE" ? "emerald" : s.status === "FROZEN" ? "rose" : "amber"}>{s.status}</Badge></td>
                <td className="px-4 py-2.5 text-right">
                  {s.status === "FROZEN" ? (
                    <Btn size="sm" variant="success" onClick={() => runAction(() => api.unfreezeUser(s.id), "Unfrozen")}>Unfreeze</Btn>
                  ) : s.status === "ACTIVE" ? (
                    <Btn size="sm" variant="danger" onClick={() => runAction(() => api.freezeUser(s.id), "Frozen")}><Snowflake size={12} /> Freeze</Btn>
                  ) : (
                    <span className="text-xs text-slate-400">n/a</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function AOHierarchyStatus({ state }) {
  const byRole = (role) => state.staff.filter((s) => s.role === role);
  const wardens = byRole("WARDEN"), dos = byRole("DO"), teachers = byRole("INCHARGE_TEACHER"), lais = byRole("LAI");

  const roomsWithoutWarden = state.hostelRooms.filter((r) => !wardens.some((w) => (w.roomIds || []).includes(r.id)));
  const floorsWithoutDO = state.collegeFloors.filter((f) => !dos.some((d) => (d.floorIds || []).includes(f.id)));
  const floorsWithoutTeacher = state.collegeFloors.filter((f) => !teachers.some((t) => (t.floorIds || []).includes(f.id)));
  const classesWithoutLAI = state.classes.filter((c) => !lais.some((l) => (l.classIds || []).includes(c.id)));
  const gaps = [
    ...roomsWithoutWarden.map((r) => `Room ${r.roomNo} has no Warden`),
    ...floorsWithoutDO.map((f) => `${f.name} has no Discipline Officer`),
    ...floorsWithoutTeacher.map((f) => `${f.name} has no Incharge Teacher`),
    ...classesWithoutLAI.map((c) => `${c.name} has no Local Attendance Incharge`),
    ...state.staff.filter((s) => s.status === "PENDING").map((s) => `${s.name} (${ROLE_LABELS[s.role]}) is waiting on approval`),
    ...state.staff.filter((s) => s.status === "FROZEN").map((s) => `${s.name} (${ROLE_LABELS[s.role]}) is frozen`),
  ];

  const Group = ({ label, list, describe }) => (
    <Card className="p-4">
      <p className="mb-3 text-sm font-semibold text-slate-700">{label}</p>
      <div className="space-y-2">
        {list.map((s) => (
          <div key={s.id} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm">
            <span className="font-medium text-slate-700">{s.name} {s.status !== "ACTIVE" && <Badge tone="amber">{s.status}</Badge>}</span>
            <span className="text-xs text-slate-500">{describe(s)}</span>
          </div>
        ))}
        {list.length === 0 && <p className="text-sm text-slate-400">None yet.</p>}
      </div>
    </Card>
  );

  return (
    <div>
      <SectionTitle icon={Users} title="Hierarchy status" subtitle="Who covers what, and any gaps in coverage." />
      {gaps.length > 0 && (
        <Card className="mb-5 border-amber-200 bg-amber-50 p-4">
          <div className="flex items-start gap-2 text-sm text-amber-800">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <div>
              <p className="font-medium">{gaps.length} thing(s) to review</p>
              <ul className="mt-1 list-inside list-disc text-amber-700">{gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
            </div>
          </div>
        </Card>
      )}
      <div className="grid gap-4 md:grid-cols-2">
        <Group label="Wardens" list={wardens} describe={(w) => `${(w.roomIds || []).length} room(s)`} />
        <Group label="Discipline Officers (pooled per floor)" list={dos} describe={(d) => `${(d.floorIds || []).length} floor(s)`} />
        <Group label="Incharge Teachers (pooled per floor)" list={teachers} describe={(t) => `${(t.floorIds || []).length} floor(s)`} />
        <Group label="Local Attendance Incharges" list={lais} describe={(l) => `${(l.classIds || []).length} class(es)`} />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* 5c. Shared approval queue (Incharge Teacher and Coordinator)       */
/* ---------------------------------------------------------------- */
function ApprovalQueue({ state, date, runAction, stageKey, requiredPriorKey, roleLabel, note }) {
  const day = state.attendance[date] || {};
  const withRecord = state.classes.map((c) => ({ c, r: day[c.id] || emptyRecord() }));
  const items = withRecord.filter(({ r }) => (requiredPriorKey ? !!r[requiredPriorKey] : true) && !r[stageKey]);
  const done = withRecord.filter(({ r }) => !!r[stageKey]);

  return (
    <div>
      <SectionTitle icon={ClipboardCheck} title={`${roleLabel} approval`} subtitle={note} />
      {items.length === 0 && <EmptyNote text="Nothing waiting on you right now." />}
      <div className="space-y-3">
        {items.map(({ c, r }) => {
          const absentees = Object.entries({ ...(r.wardenAbsences || {}), ...(r.laiAbsences || {}) }).map(([sid, meta]) => ({
            student: state.students.find((s) => s.id === sid),
            reason: r.doVerified?.[sid]?.reason || meta.reason,
          }));
          const away = state.students.filter((s) => s.classId === c.id && s.awayReason);
          const count = absentees.length + away.length;
          return (
            <Card key={c.id} className="p-4">
              <SentBackBanner record={r} />
              <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="font-medium text-slate-800">{c.name}</div>
                  <div className="text-xs text-slate-500">{count} absent · headcount {r.headcount ?? "—"}</div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Btn size="sm" variant="success" onClick={() => runAction(() => api.approveStage(date, c.id), "Approved")}><Check size={13} /> Approve</Btn>
                  <SendBackButton onSend={(reason) => runAction(() => api.sendBack(date, c.id, reason), "Sent back")} />
                </div>
              </div>
              {count > 0 && (
                <ul className="mt-2 space-y-1">
                  {absentees.map(({ student, reason }) => student && (
                    <li key={student.id} className="flex justify-between rounded bg-slate-50 px-2.5 py-1 text-xs text-slate-600">
                      <span>{student.name} ({student.roll})</span><span className="text-slate-400">{reason || "no reason recorded"}</span>
                    </li>
                  ))}
                  {away.map((s) => (
                    <li key={s.id} className="flex justify-between rounded bg-slate-50 px-2.5 py-1 text-xs text-slate-600">
                      <span>{s.name} ({s.roll})</span><span className="text-slate-400">Away — {s.awayReason}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          );
        })}
      </div>
      {done.length > 0 && (
        <div className="mt-8">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Already approved</p>
          <div className="space-y-2">
            {done.map(({ c, r }) => (
              <div key={c.id} className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600">
                <span>{c.name}</span>
                <span className="text-xs text-slate-400">{r[stageKey].byName} · {formatTime(r[stageKey].at)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// Coordinator is the last human stage now (AO no longer approves daily
// attendance), so the deadline cutoff control lives here.
function CoordinatorApprovals({ state, date, runAction }) {
  return (
    <div>
      <ApprovalQueue state={state} date={date} runAction={runAction} stageKey="coordinatorApproved" requiredPriorKey="teacherApproved" roleLabel="Coordinator" note="Lists appear here once the Incharge Teacher has filed them. Approving here publishes straight to the Principal's report." />
      <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4">
        <div className="flex items-start gap-2 text-sm text-amber-800">
          <Bell size={15} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">Deadline cutoff</p>
            <p className="mt-0.5 text-amber-700">Anything still waiting on a Teacher or your own approval past the cutoff gets published anyway, tagged "auto-passed." A list still stuck on the DO is never auto-passed — that verification has to actually happen.</p>
          </div>
        </div>
        <div className="mt-3"><Btn variant="outline" onClick={() => runAction(() => api.runCutoff(date), "Cutoff run")}><Clock size={14} /> Run cutoff now (demo)</Btn></div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* 5d. Database Manager                                               */
/* ---------------------------------------------------------------- */

// Hostel structure is three levels deep (Hostel -> HostelFloor -> Room), so
// anywhere a room needs a human-readable label, build it by walking back
// up through the two lookups rather than storing a flat string anywhere.
function roomLabel(state, roomId) {
  const room = state.hostelRooms.find((r) => r.id === roomId);
  if (!room) return "Unknown room";
  const floor = state.hostelFloors.find((f) => f.id === room.hostelFloorId);
  const hostel = floor && state.hostels.find((h) => h.id === floor.hostelId);
  return `${hostel?.name || "?"} / ${floor?.name || "?"} / Room ${room.roomNo}`;
}
function roomOptions(state) {
  return state.hostelRooms.map((r) => ({ value: r.id, label: roomLabel(state, r.id) }));
}

function StudentsAdmin({ state, runAction }) {
  const [name, setName] = useState(""); const [roll, setRoll] = useState("");
  const [classId, setClassId] = useState(""); const [roomId, setRoomId] = useState("");
  const [isLocal, setIsLocal] = useState(true);
  const [editing, setEditing] = useState(null);
  const [search, setSearch] = useState("");

  const submitAdd = () => {
    if (!name || !roll || !classId) return;
    runAction(() => api.proposeChange("add_student", `Add student ${name} (${roll})`, { name, roll, classId, roomId: roomId || null, isLocal }), "Sent to AO for approval");
    setName(""); setRoll(""); setClassId(""); setRoomId(""); setIsLocal(true);
  };
  const submitDelete = (s) => runAction(() => api.proposeChange("delete_student", `Delete student ${s.name} (${s.roll})`, { studentId: s.id }), "Sent to AO for approval");
  const submitEdit = () => {
    runAction(() => api.proposeChange("edit_student", `Edit student ${editing.name}`, { studentId: editing.id, changes: { name: editing.name, roll: editing.roll, classId: editing.classId, roomId: editing.roomId || null, isLocal: editing.isLocal } }), "Sent to AO for approval");
    setEditing(null);
  };

  const q = search.trim().toLowerCase();
  const filtered = !q ? state.students : state.students.filter((s) => {
    const cls = state.classes.find((c) => c.id === s.classId);
    return s.name.toLowerCase().includes(q) || s.roll.toLowerCase().includes(q) || cls?.name.toLowerCase().includes(q);
  });

  return (
    <div>
      <SectionTitle icon={GraduationCap} title="Students" subtitle="Changes are sent to the AO for approval before they take effect." />
      <Card className="mb-6 p-4">
        <p className="mb-3 text-sm font-semibold text-slate-700">Add a student</p>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Roll number"><input className={inputCls} value={roll} onChange={(e) => setRoll(e.target.value)} /></Field>
          <Field label="Class / batch"><Select value={classId} onChange={setClassId} options={state.classes.map((c) => ({ value: c.id, label: c.name }))} /></Field>
          <Field label="Hostel room (optional)"><Select value={roomId} onChange={(v) => { setRoomId(v); setIsLocal(!v); }} options={roomOptions(state)} /></Field>
        </div>
        <label className="mt-3 flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={isLocal} onChange={(e) => setIsLocal(e.target.checked)} />
          Local student (day scholar) — the Local Attendance Incharge handles them, not a Warden
        </label>
        <div className="mt-3"><Btn onClick={submitAdd}><Plus size={14} /> Send for AO approval</Btn></div>
      </Card>

      <SearchBox value={search} onChange={setSearch} placeholder="Search by name, roll number, or class..." />
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr><th className="px-4 py-2.5">Name</th><th className="px-4 py-2.5">Roll</th><th className="px-4 py-2.5">Class</th><th className="px-4 py-2.5">Tag</th><th className="px-4 py-2.5">Room</th><th className="px-4 py-2.5"></th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.map((s) => {
              const cls = state.classes.find((c) => c.id === s.classId);
              return (
                <tr key={s.id}>
                  <td className="px-4 py-2.5 font-medium text-slate-800">{s.name}</td>
                  <td className="px-4 py-2.5 text-slate-600">{s.roll}</td>
                  <td className="px-4 py-2.5 text-slate-600">{cls?.name}</td>
                  <td className="px-4 py-2.5"><Badge tone={s.isLocal ? "amber" : "slate"}>{s.isLocal ? "Local" : "Hostel"}</Badge></td>
                  <td className="px-4 py-2.5 text-slate-500">{s.roomId ? roomLabel(state, s.roomId) : "—"}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex justify-end gap-2">
                      <button onClick={() => setEditing({ ...s })} className="text-slate-400 hover:text-slate-700"><Pencil size={14} /></button>
                      <button onClick={() => submitDelete(s)} className="text-slate-400 hover:text-rose-600"><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && <tr><td colSpan={6} className="px-4 py-6 text-center text-slate-400">No matching students.</td></tr>}
          </tbody>
        </table>
      </Card>

      {editing && (
        <div className="fixed inset-0 z-30 grid place-items-center bg-slate-900/40 p-4">
          <Card className="w-full max-w-md p-5">
            <p className="mb-3 font-display text-base font-semibold text-slate-800">Edit student</p>
            <div className="space-y-3">
              <Field label="Name"><input className={inputCls} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
              <Field label="Roll number"><input className={inputCls} value={editing.roll} onChange={(e) => setEditing({ ...editing, roll: e.target.value })} /></Field>
              <Field label="Class / batch"><Select value={editing.classId} onChange={(v) => setEditing({ ...editing, classId: v })} options={state.classes.map((c) => ({ value: c.id, label: c.name }))} /></Field>
              <Field label="Room"><Select value={editing.roomId || ""} onChange={(v) => setEditing({ ...editing, roomId: v })} options={roomOptions(state)} /></Field>
              <label className="flex items-center gap-2 text-sm text-slate-700">
                <input type="checkbox" checked={editing.isLocal} onChange={(e) => setEditing({ ...editing, isLocal: e.target.checked })} />
                Local student (day scholar)
              </label>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <Btn variant="ghost" onClick={() => setEditing(null)}>Cancel</Btn>
              <Btn onClick={submitEdit}>Send for AO approval</Btn>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

// Hostel structure is three levels (Hostel -> Floor -> Room); college
// structure is two (CollegeFloor -> Class). Each level's dropdown is
// filtered by whatever's selected above it.
function StructureAdmin({ state, runAction }) {
  const [hostelName, setHostelName] = useState("");
  const [floorHostelId, setFloorHostelId] = useState(""); const [floorName, setFloorName] = useState("");
  const [roomHostelId, setRoomHostelId] = useState(""); const [roomFloorId, setRoomFloorId] = useState(""); const [roomNo, setRoomNo] = useState("");
  const [collegeFloorName, setCollegeFloorName] = useState("");
  const [classFloorId, setClassFloorId] = useState(""); const [className, setClassName] = useState("");

  const floorsForHostel = (hostelId) => state.hostelFloors.filter((f) => f.hostelId === hostelId);

  return (
    <div>
      <SectionTitle icon={Building2} title="Hostels & classes" subtitle="Add structure that students and staff can be assigned to. Start small — add more hostels, floors, and classes any time." />
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="p-4">
          <p className="mb-3 text-sm font-semibold text-slate-700">1. Add a hostel</p>
          <Field label="Hostel name"><input className={inputCls} value={hostelName} onChange={(e) => setHostelName(e.target.value)} /></Field>
          <div className="mt-3"><Btn onClick={() => { if (!hostelName) return; runAction(() => api.proposeChange("add_hostel", `Add hostel ${hostelName}`, { name: hostelName }), "Sent to AO for approval"); setHostelName(""); }}><Plus size={14} /> Send for AO approval</Btn></div>
        </Card>

        <Card className="p-4">
          <p className="mb-3 text-sm font-semibold text-slate-700">2. Add a floor to a hostel</p>
          <div className="space-y-3">
            <Field label="Hostel"><Select value={floorHostelId} onChange={setFloorHostelId} options={state.hostels.map((h) => ({ value: h.id, label: h.name }))} /></Field>
            <Field label="Floor name"><input className={inputCls} value={floorName} onChange={(e) => setFloorName(e.target.value)} /></Field>
          </div>
          <div className="mt-3"><Btn disabled={!floorHostelId || !floorName} onClick={() => { runAction(() => api.proposeChange("add_hostel_floor", `Add floor ${floorName}`, { name: floorName, hostelId: floorHostelId }), "Sent to AO for approval"); setFloorName(""); }}><Plus size={14} /> Send for AO approval</Btn></div>
        </Card>

        <Card className="p-4">
          <p className="mb-3 text-sm font-semibold text-slate-700">3. Add a room to a floor</p>
          <div className="space-y-3">
            <Field label="Hostel"><Select value={roomHostelId} onChange={(v) => { setRoomHostelId(v); setRoomFloorId(""); }} options={state.hostels.map((h) => ({ value: h.id, label: h.name }))} /></Field>
            <Field label="Floor"><Select value={roomFloorId} onChange={setRoomFloorId} options={floorsForHostel(roomHostelId).map((f) => ({ value: f.id, label: f.name }))} /></Field>
            <Field label="Room number"><input className={inputCls} value={roomNo} onChange={(e) => setRoomNo(e.target.value)} /></Field>
          </div>
          <div className="mt-3"><Btn disabled={!roomFloorId || !roomNo} onClick={() => { runAction(() => api.proposeChange("add_room", `Add room ${roomNo}`, { roomNo, hostelFloorId: roomFloorId }), "Sent to AO for approval"); setRoomNo(""); }}><Plus size={14} /> Send for AO approval</Btn></div>
        </Card>

        <Card className="p-4">
          <p className="mb-3 text-sm font-semibold text-slate-700">4. Add a college floor</p>
          <Field label="Floor name"><input className={inputCls} value={collegeFloorName} onChange={(e) => setCollegeFloorName(e.target.value)} /></Field>
          <div className="mt-3"><Btn disabled={!collegeFloorName} onClick={() => { runAction(() => api.proposeChange("add_college_floor", `Add college floor ${collegeFloorName}`, { name: collegeFloorName }), "Sent to AO for approval"); setCollegeFloorName(""); }}><Plus size={14} /> Send for AO approval</Btn></div>
        </Card>

        <Card className="p-4 md:col-span-2">
          <p className="mb-3 text-sm font-semibold text-slate-700">5. Add a class / batch to a college floor</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="College floor"><Select value={classFloorId} onChange={setClassFloorId} options={state.collegeFloors.map((f) => ({ value: f.id, label: f.name }))} /></Field>
            <Field label="Class / batch name"><input className={inputCls} value={className} onChange={(e) => setClassName(e.target.value)} /></Field>
          </div>
          <div className="mt-3"><Btn disabled={!classFloorId || !className} onClick={() => { runAction(() => api.proposeChange("add_class", `Add class ${className}`, { name: className, collegeFloorId: classFloorId }), "Sent to AO for approval"); setClassName(""); }}><Plus size={14} /> Send for AO approval</Btn></div>
        </Card>
      </div>

      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <Card className="p-4">
          <p className="mb-2 text-sm font-semibold text-slate-700">Current hostel structure</p>
          <ul className="space-y-1 text-sm text-slate-600">
            {state.hostelRooms.map((r) => <li key={r.id}>{roomLabel(state, r.id)}</li>)}
            {state.hostelRooms.length === 0 && <li className="text-slate-400">No rooms yet.</li>}
          </ul>
        </Card>
        <Card className="p-4">
          <p className="mb-2 text-sm font-semibold text-slate-700">Current classes</p>
          <ul className="space-y-1 text-sm text-slate-600">
            {state.classes.map((c) => {
              const floor = state.collegeFloors.find((f) => f.id === c.collegeFloorId);
              return <li key={c.id}>{c.name} ({floor?.name})</li>;
            })}
            {state.classes.length === 0 && <li className="text-slate-400">No classes yet.</li>}
          </ul>
        </Card>
      </div>
    </div>
  );
}

function AssignAdmin({ state, runAction }) {
  const wardens = state.staff.filter((s) => s.role === "WARDEN");
  const dos = state.staff.filter((s) => s.role === "DO");
  const teachers = state.staff.filter((s) => s.role === "INCHARGE_TEACHER");
  const lais = state.staff.filter((s) => s.role === "LAI");

  const [wardenId, setWardenId] = useState(""); const [wardenRooms, setWardenRooms] = useState([]);
  const [doId, setDoId] = useState(""); const [doFloors, setDoFloors] = useState([]);
  const [teacherId, setTeacherId] = useState(""); const [teacherFloors, setTeacherFloors] = useState([]);
  const [laiId, setLaiId] = useState(""); const [laiClasses, setLaiClasses] = useState([]);
  const toggle = (arr, val) => (arr.includes(val) ? arr.filter((v) => v !== val) : [...arr, val]);

  const CheckGroup = ({ options, selected, onToggle }) => (
    <div className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button key={o.value} onClick={() => onToggle(o.value)} className={`rounded-lg border px-2.5 py-1 text-xs font-medium ${selected.includes(o.value) ? "border-[#12324D] bg-[#12324D] text-white" : "border-slate-300 text-slate-600"}`}>{o.label}</button>
      ))}
      {options.length === 0 && <span className="text-xs text-slate-400">Nothing to choose from yet — add some first.</span>}
    </div>
  );

  return (
    <div>
      <SectionTitle icon={UserCog} title="Assign staff" subtitle="A Warden can cover several rooms. DOs and Incharge Teachers are pooled per floor — any one assigned can act." />
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="p-4">
          <p className="mb-3 text-sm font-semibold text-slate-700">Assign Warden to room(s)</p>
          <Field label="Warden"><Select value={wardenId} onChange={(v) => { setWardenId(v); setWardenRooms(state.staff.find((s) => s.id === v)?.roomIds || []); }} options={wardens.map((w) => ({ value: w.id, label: w.name }))} /></Field>
          <div className="mt-3"><CheckGroup options={roomOptions(state)} selected={wardenRooms} onToggle={(v) => setWardenRooms(toggle(wardenRooms, v))} /></div>
          <div className="mt-3"><Btn disabled={!wardenId} onClick={() => runAction(() => api.proposeChange("assign_warden", `Assign ${wardens.find((w) => w.id === wardenId)?.name} to ${wardenRooms.length} room(s)`, { staffId: wardenId, roomIds: wardenRooms }), "Sent to AO for approval")}>Send for AO approval</Btn></div>
        </Card>
        <Card className="p-4">
          <p className="mb-3 text-sm font-semibold text-slate-700">Assign Discipline Officer to floor(s)</p>
          <Field label="DO"><Select value={doId} onChange={(v) => { setDoId(v); setDoFloors(state.staff.find((s) => s.id === v)?.floorIds || []); }} options={dos.map((w) => ({ value: w.id, label: w.name }))} /></Field>
          <div className="mt-3"><CheckGroup options={state.collegeFloors.map((f) => ({ value: f.id, label: f.name }))} selected={doFloors} onToggle={(v) => setDoFloors(toggle(doFloors, v))} /></div>
          <div className="mt-3"><Btn disabled={!doId} onClick={() => runAction(() => api.proposeChange("assign_do", `Assign ${dos.find((w) => w.id === doId)?.name} as DO`, { staffId: doId, floorIds: doFloors }), "Sent to AO for approval")}>Send for AO approval</Btn></div>
        </Card>
        <Card className="p-4">
          <p className="mb-3 text-sm font-semibold text-slate-700">Assign Incharge Teacher to floor(s)</p>
          <Field label="Teacher"><Select value={teacherId} onChange={(v) => { setTeacherId(v); setTeacherFloors(state.staff.find((s) => s.id === v)?.floorIds || []); }} options={teachers.map((w) => ({ value: w.id, label: w.name }))} /></Field>
          <div className="mt-3"><CheckGroup options={state.collegeFloors.map((f) => ({ value: f.id, label: f.name }))} selected={teacherFloors} onToggle={(v) => setTeacherFloors(toggle(teacherFloors, v))} /></div>
          <div className="mt-3"><Btn disabled={!teacherId} onClick={() => runAction(() => api.proposeChange("assign_teacher", `Assign ${teachers.find((w) => w.id === teacherId)?.name} as Incharge Teacher`, { staffId: teacherId, floorIds: teacherFloors }), "Sent to AO for approval")}>Send for AO approval</Btn></div>
        </Card>
        <Card className="p-4">
          <p className="mb-3 text-sm font-semibold text-slate-700">Assign Local Attendance Incharge to class</p>
          <Field label="LAI"><Select value={laiId} onChange={(v) => { setLaiId(v); setLaiClasses(state.staff.find((s) => s.id === v)?.classIds || []); }} options={lais.map((w) => ({ value: w.id, label: w.name }))} /></Field>
          <div className="mt-3"><CheckGroup options={state.classes.map((c) => ({ value: c.id, label: c.name }))} selected={laiClasses} onToggle={(v) => setLaiClasses(toggle(laiClasses, v))} /></div>
          <div className="mt-3"><Btn disabled={!laiId} onClick={() => runAction(() => api.proposeChange("assign_lai", `Assign ${lais.find((w) => w.id === laiId)?.name} as LAI`, { staffId: laiId, classIds: laiClasses }), "Sent to AO for approval")}>Send for AO approval</Btn></div>
        </Card>
      </div>
    </div>
  );
}

// Replaces the old "activate an existing account" screen: the Database
// Manager now creates the account from scratch. It's sent to the AO as a
// PendingChange of type "create_staff", which already has its login key
// generated server-side (see routes/changes.js) by the time this returns.
function CreateStaffAdmin({ state, runAction }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("WARDEN");
  const [scope, setScope] = useState([]);
  const [justSent, setJustSent] = useState(null);
  const toggle = (arr, val) => (arr.includes(val) ? arr.filter((v) => v !== val) : [...arr, val]);

  const scopeOptions = role === "WARDEN" ? roomOptions(state)
    : role === "LAI" ? state.classes.map((c) => ({ value: c.id, label: c.name }))
    : state.collegeFloors.map((f) => ({ value: f.id, label: f.name })); // DO / INCHARGE_TEACHER

  const scopeField = role === "WARDEN" ? "roomIds" : role === "LAI" ? "classIds" : "floorIds";
  const scopeLabel = role === "WARDEN" ? "Room(s)" : role === "LAI" ? "Class(es)" : "Floor(s)";

  const submit = async () => {
    if (!name.trim()) return;
    const payload = { name: name.trim(), role, [scopeField]: scope };
    const result = await runAction(() => api.proposeChange("create_staff", `Create ${ROLE_LABELS[role]} account: ${name.trim()}`, payload), "Sent to AO for approval");
    if (result) { setJustSent({ name: name.trim(), role, key: result.change.payload.loginKey }); setName(""); setScope([]); }
  };

  const recent = state.pendingChanges.filter((c) => c.type === "create_staff").slice(0, 8);

  return (
    <div>
      <SectionTitle icon={UserPlus} title="Create a staff account" subtitle="Warden, Local Attendance Incharge, Discipline Officer, or Incharge Teacher. Sent to the AO for approval before it can log in." />
      <Card className="mb-6 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Role">
            <select value={role} onChange={(e) => { setRole(e.target.value); setScope([]); }} className={inputCls}>
              <option value="WARDEN">Warden</option>
              <option value="LAI">Local Attendance Incharge</option>
              <option value="DO">Discipline Officer</option>
              <option value="INCHARGE_TEACHER">Incharge Teacher</option>
            </select>
          </Field>
        </div>
        <div className="mt-3">
          <p className="mb-1.5 text-sm font-medium text-slate-700">{scopeLabel} (optional — can be assigned later)</p>
          <div className="flex flex-wrap gap-2">
            {scopeOptions.map((o) => (
              <button key={o.value} onClick={() => setScope(toggle(scope, o.value))} className={`rounded-lg border px-2.5 py-1 text-xs font-medium ${scope.includes(o.value) ? "border-[#12324D] bg-[#12324D] text-white" : "border-slate-300 text-slate-600"}`}>{o.label}</button>
            ))}
          </div>
        </div>
        <div className="mt-4"><Btn onClick={submit}><Plus size={14} /> Send for AO approval</Btn></div>
      </Card>

      {justSent && (
        <Card className="mb-6 border-emerald-200 bg-emerald-50 p-4">
          <p className="text-sm text-emerald-800">
            Sent <span className="font-medium">{justSent.name}</span> ({ROLE_LABELS[justSent.role]}) to the AO —
            their login key will be <span className="font-display font-semibold">{justSent.key}</span> once approved (password: the shared default).
          </p>
        </Card>
      )}

      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Recent requests</p>
      <div className="space-y-2">
        {recent.map((c) => (
          <div key={c.id} className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
            <span className="text-slate-700">{c.summary} {c.payload?.loginKey && <span className="font-display text-xs text-slate-400">(key {c.payload.loginKey})</span>}</span>
            <Badge tone={c.status === "approved" ? "emerald" : c.status === "rejected" ? "rose" : "amber"}>{c.status}</Badge>
          </div>
        ))}
        {recent.length === 0 && <EmptyNote text="No staff accounts created yet." />}
      </div>
    </div>
  );
}

// Read-only for the Database Manager: who's absent today, nothing else.
// Combines Warden/LAI-reported absentees with persistent "away" students.
function AbsenteesView({ state }) {
  const [viewDate, setViewDate] = useState(todayStr());
  const day = state.attendance[viewDate] || {};
  const rows = [];
  for (const c of state.classes) {
    const r = day[c.id] || emptyRecord();
    const ids = new Set([...Object.keys(r.wardenAbsences || {}), ...Object.keys(r.laiAbsences || {})]);
    state.students.filter((s) => s.classId === c.id && s.awayReason).forEach((s) => ids.add(s.id));
    for (const sid of ids) {
      const student = state.students.find((s) => s.id === sid);
      if (student) rows.push({ roll: student.roll, name: student.name, className: c.name });
    }
  }
  rows.sort((a, b) => a.className.localeCompare(b.className) || a.roll.localeCompare(b.roll));

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <SectionTitle icon={ClipboardCheck} title="View absentees" subtitle={`${formatDMY(viewDate)} — roll number, name, and class only.`} />
        <Field label="Date"><input type="date" max={todayStr()} className={inputCls} value={viewDate} onChange={(e) => setViewDate(e.target.value)} /></Field>
      </div>
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr><th className="px-4 py-2.5">Roll number</th><th className="px-4 py-2.5">Name</th><th className="px-4 py-2.5">Class</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="px-4 py-2.5 text-slate-600">{r.roll}</td>
                <td className="px-4 py-2.5 font-medium text-slate-800">{r.name}</td>
                <td className="px-4 py-2.5 text-slate-600">{r.className}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={3} className="px-4 py-6 text-center text-slate-400">No absentees recorded for this date.</td></tr>}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function MyChanges({ state, me }) {
  const mine = state.pendingChanges.filter((c) => c.requestedById === me.id);
  return (
    <div>
      <SectionTitle icon={Clock} title="My requests" subtitle="Everything you've sent to the AO." />
      {mine.length === 0 && <EmptyNote text="You haven't submitted anything yet." />}
      <div className="space-y-2">
        {mine.map((c) => (
          <div key={c.id} className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
            <span className="text-slate-700">{c.summary}</span>
            <Badge tone={c.status === "approved" ? "emerald" : c.status === "rejected" ? "rose" : "amber"}>{c.status}</Badge>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* 5e. Warden and LAI                                                  */
/* ---------------------------------------------------------------- */
function WardenScreen({ state, date, me, runAction }) {
  const rooms = me.roomIds || [];
  const allStudents = state.students.filter((s) => rooms.includes(s.roomId));
  const away = allStudents.filter((s) => s.awayReason);
  const present = allStudents.filter((s) => !s.awayReason);
  const [pickerFor, setPickerFor] = useState(null); // studentId currently choosing a reason
  const [search, setSearch] = useState("");

  const q = search.trim().toLowerCase();
  const visiblePresent = !q ? present : present.filter((s) => s.name.toLowerCase().includes(q) || s.roll.toLowerCase().includes(q));

  return (
    <div>
      <SectionTitle icon={Bed} title="Mark hostel absentees" subtitle={`Covering ${rooms.length} room(s) today — picking a reason marks a student absent.`} />

      {away.length > 0 && (
        <Card className="mb-4 border-amber-200 bg-amber-50 p-4">
          <p className="mb-2 text-sm font-semibold text-amber-800">Away — counted absent automatically until reported back</p>
          <div className="space-y-2">
            {away.map((s) => (
              <div key={s.id} className="flex items-center justify-between rounded-lg bg-white px-3 py-2 text-sm">
                <span className="text-slate-700">{s.name} <span className="text-xs text-slate-400">({s.roll}) — {s.awayReason} since {formatDMY(s.awaySince)}</span></span>
                <Btn size="sm" variant="outline" onClick={() => runAction(() => api.reportBack(s.id), "Marked as reported back")}>Mark reported</Btn>
              </div>
            ))}
          </div>
        </Card>
      )}

      {allStudents.length === 0 && <EmptyNote text="No students assigned to you yet." />}
      {allStudents.length > 0 && <SearchBox value={search} onChange={setSearch} placeholder="Search your students by name or roll number..." />}

      <div className="space-y-4">
        {Object.entries(groupBy(visiblePresent, (s) => s.classId)).map(([classId, list]) => {
          const cls = state.classes.find((c) => c.id === classId);
          const r = state.attendance[date]?.[classId] || emptyRecord();
          const locked = !!r.doApproved;
          const bucket = r.wardenAbsences || {};
          const sentBackHere = r.sentBack?.toStage === "warden_lai";
          return (
            <Card key={classId} className="p-4">
              {sentBackHere && <SentBackBanner record={r} />}
              <div className="mb-2 flex items-center justify-between">
                <p className="font-medium text-slate-800">{cls?.name}</p>
                {locked ? <Badge tone="emerald"><CheckCircle2 size={12} /> Verified by DO — no action needed</Badge> : <Badge tone="amber">Awaiting your input</Badge>}
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {list.map((s) => {
                  const entry = bucket[s.id];
                  const choosing = pickerFor === s.id;
                  return (
                    <div key={s.id} className={`rounded-lg border px-2.5 py-1.5 text-xs ${entry ? "border-rose-300 bg-rose-50" : "border-slate-200 bg-white"}`}>
                      <div className="flex items-center justify-between">
                        <div>
                          <span className="font-medium text-slate-700">{s.name}</span>
                          <span className="ml-1 text-slate-400">({s.roll})</span>
                        </div>
                        {!locked && (
                          <button onClick={() => setPickerFor(choosing ? null : s.id)} className="text-slate-400 hover:text-slate-700">
                            <ChevronDown size={13} className={choosing ? "rotate-180" : ""} />
                          </button>
                        )}
                      </div>
                      {entry ? (
                        <div className="mt-1 flex items-center justify-between text-rose-700">
                          <span>Absent — {entry.reason}</span>
                          {!locked && <button className="text-rose-400 hover:text-rose-700" onClick={() => runAction(() => api.setAbsence(date, classId, s.id, null))}><X size={12} /></button>}
                        </div>
                      ) : (
                        !locked && <div className="mt-1 text-slate-400">Present</div>
                      )}
                      {choosing && !locked && (
                        <div className="mt-2 flex flex-wrap gap-1.5 border-t border-slate-200 pt-2">
                          {DAILY_REASONS.map((reason) => (
                            <button key={reason} onClick={() => { runAction(() => api.setAbsence(date, classId, s.id, reason)); setPickerFor(null); }}
                              className="rounded-md border border-slate-300 px-2 py-0.5 text-[11px] text-slate-600 hover:bg-slate-100">{reason}</button>
                          ))}
                          <button onClick={() => { runAction(() => api.markAway(s.id, AWAY_REASON), "Marked away — counted absent until reported back"); setPickerFor(null); }}
                            className="rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700 hover:bg-amber-100">{AWAY_REASON}</button>
                        </div>
                      )}
                    </div>
                  );
                })}
                {list.length === 0 && <p className="text-sm text-slate-400 sm:col-span-2">No students match your search in this class.</p>}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function LAIScreen({ state, date, me, runAction }) {
  const classIds = me.classIds || [];
  // Only local students (day scholars) — hostellers in the same class are
  // the Warden's responsibility, not the LAI's, even if they share a class.
  const students = state.students.filter((s) => classIds.includes(s.classId) && s.isLocal && !s.awayReason);
  const [search, setSearch] = useState("");
  const q = search.trim().toLowerCase();
  const visible = !q ? students : students.filter((s) => s.name.toLowerCase().includes(q) || s.roll.toLowerCase().includes(q));

  return (
    <div>
      <SectionTitle icon={GraduationCap} title="Mark classroom absentees" subtitle="No reason needed here — the Discipline Officer will call home and record the reason." />
      {students.length === 0 && <EmptyNote text="No students assigned to you yet." />}
      {students.length > 0 && <SearchBox value={search} onChange={setSearch} placeholder="Search your students by name or roll number..." />}
      <div className="space-y-4">
        {Object.entries(groupBy(visible, (s) => s.classId)).map(([classId, list]) => {
          const cls = state.classes.find((c) => c.id === classId);
          const r = state.attendance[date]?.[classId] || emptyRecord();
          const locked = !!r.doApproved;
          const bucket = r.laiAbsences || {};
          const sentBackHere = r.sentBack?.toStage === "warden_lai";
          return (
            <Card key={classId} className="p-4">
              {sentBackHere && <SentBackBanner record={r} />}
              <div className="mb-2 flex items-center justify-between">
                <p className="font-medium text-slate-800">{cls?.name}</p>
                {locked ? <Badge tone="emerald"><CheckCircle2 size={12} /> Verified by DO — no action needed</Badge> : <Badge tone="amber">Awaiting your input</Badge>}
              </div>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {list.map((s) => {
                  const marked = !!bucket[s.id];
                  return (
                    <button key={s.id} disabled={locked}
                      onClick={() => runAction(() => api.setAbsence(date, classId, s.id, marked ? null : "pending"))}
                      className={`rounded-lg border px-2.5 py-1.5 text-left text-xs font-medium transition disabled:opacity-60 ${marked ? "border-rose-300 bg-rose-50 text-rose-700" : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"}`}>
                      {s.name}<div className="text-[10px] text-slate-400">{s.roll}</div>
                    </button>
                  );
                })}
                {list.length === 0 && <p className="text-sm text-slate-400 sm:col-span-3">No students match your search in this class.</p>}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* 5f. Discipline Officer                                              */
/* ---------------------------------------------------------------- */
function DoClassCard({ c, record, date, students, runAction }) {
  const [headcount, setHeadcount] = useState(record.headcount ?? "");
  const [subTab, setSubTab] = useState("confirm"); // "confirm" (Window 1) | "reasons" (Window 2)
  const combined = { ...(record.wardenAbsences || {}), ...(record.laiAbsences || {}) };
  const list = Object.entries(combined).map(([sid, meta]) => ({
    student: students.find((s) => s.id === sid), meta,
    confirmed: !!record.doConfirmed?.[sid],
    verified: record.doVerified?.[sid]?.reason || null,
  }));
  const away = students.filter((s) => s.classId === c.id && s.awayReason);
  const approved = !!record.doApproved;
  const headcountSaved = record.headcount != null;
  const confirmedCount = list.filter((i) => i.confirmed).length;
  const reasonedCount = list.filter((i) => i.verified).length;
  const allConfirmed = list.every((i) => i.confirmed);
  const allReasoned = list.every((i) => i.verified);

  const saveReason = (sid, reason) => runAction(() => api.verifyReason(date, c.id, sid, reason));

  return (
    <Card className="p-4">
      <SentBackBanner record={record} />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium text-slate-800">{c.name}</p>
        {approved ? <Badge tone="emerald"><CheckCircle2 size={12} /> Approved by {record.doApproved.byName}</Badge> : <Badge tone="amber">{!headcountSaved ? "Enter headcount to continue" : "In progress"}</Badge>}
      </div>

      <Field label="Headcount present">
        <div className="flex gap-2">
          <input type="number" min="0" disabled={approved} className={`${inputCls} w-28`} value={headcount} onChange={(e) => setHeadcount(e.target.value)} />
          {!approved && headcount !== "" && Number(headcount) !== record.headcount && (
            <Btn size="sm" variant="outline" onClick={() => runAction(() => api.setHeadcount(date, c.id, Number(headcount)))}>Save</Btn>
          )}
        </div>
      </Field>

      {!headcountSaved ? (
        <p className="mt-3 text-sm text-slate-400">The absentee list appears once you save today's headcount.</p>
      ) : (
        <>
          {away.length > 0 && (
            <div className="mt-3">
              <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">Already away — no action needed</p>
              <ul className="space-y-1">
                {away.map((s) => (
                  <li key={s.id} className="flex justify-between rounded-lg bg-slate-50 px-3 py-1.5 text-sm text-slate-600">
                    <span>{s.name} ({s.roll})</span><span className="text-xs text-slate-400">{s.awayReason} since {formatDMY(s.awaySince)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!approved && (
            <div className="mt-4 flex gap-2 border-b border-slate-200">
              <button onClick={() => setSubTab("confirm")} className={`px-3 py-2 text-sm font-medium ${subTab === "confirm" ? "border-b-2 border-[#12324D] text-[#12324D]" : "text-slate-500"}`}>
                1. Classroom check {list.length > 0 && <span className="ml-1 text-xs text-slate-400">({confirmedCount}/{list.length})</span>}
              </button>
              <button onClick={() => setSubTab("reasons")} className={`px-3 py-2 text-sm font-medium ${subTab === "reasons" ? "border-b-2 border-[#12324D] text-[#12324D]" : "text-slate-500"}`}>
                2. Call & confirm reasons {list.length > 0 && <span className="ml-1 text-xs text-slate-400">({reasonedCount}/{list.length})</span>}
              </button>
            </div>
          )}

          {list.length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">No fresh absentees reported for this class today.</p>
          ) : approved || subTab === "confirm" ? (
            <div className="mt-3 space-y-2">
              {!approved && <p className="text-xs text-slate-500">Right now, in the classroom — just confirm who's really absent. No calls needed for this part.</p>}
              {list.map(({ student, meta, confirmed }) => student && (
                <div key={student.id} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm">
                  <span className="text-slate-700">{student.name} <span className="text-xs text-slate-400">({student.roll}) — {meta.reason ? `Warden: ${meta.reason}` : "reported by LAI"}</span></span>
                  {approved ? (
                    confirmed && <Badge tone="emerald"><CheckCircle2 size={11} /> Confirmed</Badge>
                  ) : confirmed ? (
                    <div className="flex items-center gap-2">
                      <Badge tone="emerald"><CheckCircle2 size={11} /> Confirmed absent</Badge>
                      <button className="text-xs text-slate-400 underline hover:text-rose-600" onClick={() => runAction(() => api.correctPresence(date, c.id, student.id), "Marked present instead")}>Actually present?</button>
                    </div>
                  ) : (
                    <div className="flex gap-1.5">
                      <Btn size="sm" variant="success" onClick={() => runAction(() => api.confirmAbsent(date, c.id, student.id))}>Confirm absent</Btn>
                      <Btn size="sm" variant="outline" onClick={() => runAction(() => api.correctPresence(date, c.id, student.id), "Marked present")}>Actually present</Btn>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-3 space-y-2">
              <p className="text-xs text-slate-500">Later, after calling home or the Warden — record the actual reason for each confirmed absentee.</p>
              {list.filter((i) => i.confirmed).map(({ student, meta, verified }) => student && (
                <div key={student.id} className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-700">{student.name} <span className="text-xs text-slate-400">({student.roll}) — {meta.reason ? `Warden: ${meta.reason}` : "reported by LAI, no reason yet"}</span></span>
                    {verified && <Badge tone="emerald"><CheckCircle2 size={11} /> Verified</Badge>}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {DAILY_REASONS.map((reason) => (
                      <button key={reason} onClick={() => saveReason(student.id, reason)}
                        className={`rounded-md border px-2 py-0.5 text-[11px] ${verified === reason ? "border-emerald-400 bg-emerald-50 text-emerald-700" : "border-slate-300 text-slate-600 hover:bg-slate-100"}`}>
                        {reason}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {confirmedCount === 0 && <p className="text-sm text-slate-400">Nobody's been confirmed absent yet — do the classroom check first.</p>}
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Btn variant="success" disabled={approved || !allConfirmed || !allReasoned} onClick={() => runAction(() => api.approveStage(date, c.id), "Approved")}>
              <CheckCircle2 size={14} /> {!allConfirmed ? "Finish the classroom check first" : !allReasoned ? "Call & confirm reasons first" : "Approve list"}
            </Btn>
            {!approved && <SendBackButton onSend={(reason) => runAction(() => api.sendBack(date, c.id, reason), "Sent back to Warden/LAI")} />}
          </div>
        </>
      )}
    </Card>
  );
}

function DOScreen({ state, date, me, runAction }) {
  const floorClasses = state.classes.filter((c) => (me.floorIds || []).includes(c.collegeFloorId));
  const poolmates = state.staff.filter((s) => s.role === "DO" && s.id !== me.id && (s.floorIds || []).some((f) => (me.floorIds || []).includes(f)));
  return (
    <div>
      <SectionTitle icon={Phone} title="Verify & approve" subtitle="Two or more DOs can cover the same floor — split the classes between yourselves however works, or overlap freely; whoever approves a class first completes it for everyone." />
      {poolmates.length > 0 && <p className="mb-4 text-xs text-slate-400">Sharing this floor with: {poolmates.map((p) => p.name).join(", ")}</p>}
      <div className="space-y-4">
        {floorClasses.map((c) => (
          <DoClassCard key={c.id} c={c} record={state.attendance[date]?.[c.id] || emptyRecord()} date={date} students={state.students} runAction={runAction} />
        ))}
        {floorClasses.length === 0 && <EmptyNote text="No floor assigned to you yet." />}
      </div>
    </div>
  );
}
