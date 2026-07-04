import { useState, useEffect, useCallback } from "react";
import {
  Building2, ClipboardCheck, ShieldCheck, GraduationCap, Bed, UserCog, ListChecks,
  Clock, CheckCircle2, XCircle, AlertTriangle, ChevronDown, Plus, Trash2, Check, X,
  Phone, Bell, LogIn, LogOut, Users, LayoutDashboard, Loader2, Pencil,
} from "lucide-react";
import { api } from "./api.js";

const todayStr = () => new Date().toISOString().slice(0, 10);
const STAGES = [
  { key: "doApproved", label: "DO verified", pendingLabel: "Discipline Officer" },
  { key: "teacherApproved", label: "Teacher approved", pendingLabel: "Incharge Teacher" },
  { key: "coordinatorApproved", label: "Coordinator approved", pendingLabel: "Coordinator" },
  { key: "aoApproved", label: "AO approved", pendingLabel: "AO" },
];
function currentStageIndex(rec) {
  for (let i = 0; i < STAGES.length; i++) if (!rec[STAGES[i].key]) return i;
  return STAGES.length;
}
function recordTag(rec) {
  const idx = currentStageIndex(rec);
  const published = idx === STAGES.length || rec.forcedPublish;
  if (!published) return { label: `Pending \u2014 ${STAGES[idx].pendingLabel}`, tone: "amber" };
  if (idx === STAGES.length) return { label: "Verified", tone: "emerald" };
  const missing = STAGES.slice(idx).map((s) => s.pendingLabel).join(", ");
  return { label: `Auto-passed \u2014 missing: ${missing}`, tone: "rose" };
}
function emptyRecord() {
  return { wardenAbsences: {}, laiAbsences: {}, headcount: null, doApproved: null, teacherApproved: null, coordinatorApproved: null, aoApproved: null, forcedPublish: false, skippedStages: [] };
}

const ROLE_LABELS = {
  PRINCIPAL: "Principal", AO: "AO", COORDINATOR: "Coordinator", DB_MANAGER: "Database Manager",
  WARDEN: "Warden", DO: "Discipline Officer", INCHARGE_TEACHER: "Incharge Teacher", LAI: "Local Attendance Incharge",
};
const DAILY_REASONS = ["Sick", "Not in room", "Other"];
const AWAY_REASON = "Went home";

/* ---------------------------------------------------------------- */
/* UI atoms                                                           */
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
  return <button className={`${base} ${sizes} ${variants[variant]}`} onClick={onClick} disabled={disabled}>{children}</button>;
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

/* ---------------------------------------------------------------- */
/* Login screen                                                       */
/* ---------------------------------------------------------------- */
function Login({ onLoggedIn }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(""); setBusy(true);
    try {
      const { token, user } = await api.login(username, password);
      api.setToken(token);
      onLoggedIn(user);
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  };

  return (
    <div className="grid min-h-screen place-items-center bg-slate-50 px-4" style={{ fontFamily: "Inter, system-ui, sans-serif" }}>
      <Card className="w-full max-w-sm p-6">
        <div className="mb-5 flex items-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-[#12324D] text-white"><ClipboardCheck size={17} /></div>
          <div className="font-display text-base font-semibold text-slate-900">Attendance & Hostel System</div>
        </div>
        <div className="space-y-3">
          <Field label="Username">
            <input className={inputCls} value={username} onChange={(e) => setUsername(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} autoFocus />
          </Field>
          <Field label="Password">
            <input type="password" className={inputCls} value={password} onChange={(e) => setPassword(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
          </Field>
        </div>
        {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}
        <Btn onClick={submit} disabled={busy} variant="primary">{busy ? <Loader2 className="animate-spin" size={14} /> : <LogIn size={14} />} Log in</Btn>
        <p className="mt-4 text-xs text-slate-400">Demo accounts: principal, ao, coordinator, dbm, warden1, warden2, do1, do2, teacher1, teacher2, lai1, lai2 — password for all: <code>password123</code></p>
      </Card>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* App shell                                                          */
/* ---------------------------------------------------------------- */
export default function App() {
  const [state, setState] = useState(null);
  const [me, setMe] = useState(null);
  const [loading, setLoading] = useState(true);
  const [authChecked, setAuthChecked] = useState(false);
  const [tab, setTab] = useState(null);
  const [toast, setToast] = useState(null);
  const date = todayStr();

  const refresh = useCallback(async () => {
    try {
      const data = await api.getState();
      setState(data);
      setMe(data.me);
    } catch (e) {
      if (String(e.message).toLowerCase().includes("logged in") || String(e.message).toLowerCase().includes("expired")) {
        api.clearToken(); setMe(null);
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
      await fn();
      await refresh();
      if (successMsg) showToast(successMsg);
    } catch (e) {
      showToast(e.message, "rose");
    }
  };

  if (!authChecked || loading) {
    return <div className="grid min-h-screen place-items-center text-slate-400"><Loader2 className="mr-2 animate-spin" size={18} /> Loading...</div>;
  }
  if (!me) {
    return <Login onLoggedIn={() => refresh()} />;
  }

  const logout = () => { api.clearToken(); setMe(null); setState(null); };

  const ROLE_TABS = {
    PRINCIPAL: [{ id: "dashboard", label: "Daily report", icon: LayoutDashboard }],
    AO: [
      { id: "approvals", label: "Master data approvals", icon: ShieldCheck },
      { id: "final", label: "Final attendance approval", icon: ClipboardCheck },
      { id: "dashboard", label: "Daily report", icon: LayoutDashboard },
      { id: "hierarchy", label: "Hierarchy status", icon: Users },
    ],
    COORDINATOR: [
      { id: "coordinator", label: "Attendance approvals", icon: ListChecks },
      { id: "status", label: "Attendance status", icon: LayoutDashboard },
    ],
    DB_MANAGER: [
      { id: "students", label: "Students", icon: GraduationCap },
      { id: "rooms", label: "Hostel & classes", icon: Bed },
      { id: "assign", label: "Assign staff", icon: UserCog },
      { id: "activate", label: "Activate accounts", icon: Users },
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
      <div className="sticky top-0 z-10 border-b border-slate-200 bg-[#0d2438] px-5 py-3 text-white">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="grid h-8 w-8 place-items-center rounded-lg bg-white/10"><ClipboardCheck size={16} /></div>
            <div>
              <div className="font-display text-[15px] font-semibold leading-tight">Attendance & Hostel System</div>
              <div className="text-[11px] text-white/60">{new Date().toLocaleDateString([], { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="text-xs text-white/70">{me.name} · {ROLE_LABELS[me.role]}</span>
            <button onClick={logout} className="flex items-center gap-1 rounded-lg border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/20">
              <LogOut size={13} /> Log out
            </button>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-5 p-5 md:flex-row">
        {tabs.length > 1 && (
          <div className="flex shrink-0 gap-2 overflow-x-auto md:w-56 md:flex-col md:overflow-visible">
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
            <>
              {activeTab === "dashboard" && <PrincipalDashboard state={state} date={date} onCutoff={me.role === "AO" ? () => runAction(() => api.runCutoff(date), "Cutoff run") : null} />}
              {activeTab === "status" && <PrincipalDashboard state={state} date={date} onCutoff={null} scopeFloorIds={me.role === "INCHARGE_TEACHER" ? me.floorIds : null} title="Attendance status" subtitle="Visible any time — not just when something is waiting on you." />}
              {activeTab === "hierarchy" && <AOHierarchyStatus state={state} />}
              {activeTab === "approvals" && <AOApprovals state={state} onApprove={(c) => runAction(() => api.approveChange(c.id), "Approved")} onReject={(c) => runAction(() => api.rejectChange(c.id, "Not approved"), "Rejected")} />}
              {activeTab === "final" && <FinalApproval state={state} date={date} runAction={runAction} onCutoff={() => runAction(() => api.runCutoff(date), "Cutoff run")} />}
              {activeTab === "coordinator" && <ApprovalQueue state={state} date={date} runAction={runAction} stageKey="coordinatorApproved" requiredPriorKey="teacherApproved" roleLabel="Coordinator" note="Lists appear here once the Incharge Teacher has filed them." />}
              {activeTab === "students" && <StudentsAdmin state={state} runAction={runAction} />}
              {activeTab === "rooms" && <RoomsAdmin state={state} runAction={runAction} />}
              {activeTab === "assign" && <AssignAdmin state={state} runAction={runAction} />}
              {activeTab === "activate" && <ActivateAdmin state={state} runAction={runAction} />}
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
/* Principal / dashboard                                              */
/* ---------------------------------------------------------------- */
function Stat({ label, value, tone = "slate" }) {
  return (
    <Card className="px-4 py-3">
      <div className={`font-display text-2xl font-bold ${tone === "emerald" ? "text-emerald-600" : tone === "rose" ? "text-rose-600" : "text-slate-800"}`}>{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </Card>
  );
}
function PrincipalDashboard({ state, date, onCutoff, scopeFloorIds, title, subtitle }) {
  const [viewDate, setViewDate] = useState(date);
  const day = state.attendance[viewDate] || {};
  const classesInScope = scopeFloorIds ? state.classes.filter((c) => scopeFloorIds.includes(c.floorId)) : state.classes;
  const rows = classesInScope.map((c) => ({ c, r: day[c.id] || emptyRecord() }));
  const published = rows.filter((x) => currentStageIndex(x.r) === STAGES.length || x.r.forcedPublish).length;
  const verified = rows.filter((x) => currentStageIndex(x.r) === STAGES.length).length;
  const autoPassed = rows.filter((x) => x.r.forcedPublish && currentStageIndex(x.r) < STAGES.length).length;
  const isToday = viewDate === date;
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <SectionTitle icon={LayoutDashboard} title={title || "Daily attendance report"} subtitle={subtitle || (isToday ? `Target: fully approved and published by 11:00 AM \u2014 ${viewDate}` : `Viewing history for ${viewDate}`)} />
        <Field label="Date">
          <input type="date" max={date} className={inputCls} value={viewDate} onChange={(e) => setViewDate(e.target.value)} />
        </Field>
      </div>
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Classes" value={rows.length} />
        <Stat label="Published" value={published} />
        <Stat label="Verified" value={verified} tone="emerald" />
        <Stat label="Auto-passed" value={autoPassed} tone="rose" />
      </div>
      {onCutoff && isToday && <div className="mb-5"><Btn variant="ghost" onClick={onCutoff}><Clock size={14} /> Run 11:00 AM cutoff now (demo)</Btn></div>}
      <Card className="overflow-hidden">
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

/* ---------------------------------------------------------------- */
/* AO: hierarchy / assignment status                                  */
/* ---------------------------------------------------------------- */
function AOHierarchyStatus({ state }) {
  const byRole = (role) => state.staff.filter((s) => s.role === role);
  const wardens = byRole("WARDEN"), dos = byRole("DO"), teachers = byRole("INCHARGE_TEACHER"), lais = byRole("LAI");

  const roomsWithoutWarden = state.hostelRooms.filter((r) => !wardens.some((w) => (w.roomIds || []).includes(r.id)));
  const floorsWithoutDO = state.floors.filter((f) => !dos.some((d) => (d.floorIds || []).includes(f.id)));
  const floorsWithoutTeacher = state.floors.filter((f) => !teachers.some((t) => (t.floorIds || []).includes(f.id)));
  const classesWithoutLAI = state.classes.filter((c) => !lais.some((l) => (l.classIds || []).includes(c.id)));
  const gaps = [
    ...roomsWithoutWarden.map((r) => `${r.hostel} Room ${r.roomNo} has no Warden`),
    ...floorsWithoutDO.map((f) => `${f.name} has no Discipline Officer`),
    ...floorsWithoutTeacher.map((f) => `${f.name} has no Incharge Teacher`),
    ...classesWithoutLAI.map((c) => `${c.name} has no Local Attendance Incharge`),
    ...state.staff.filter((s) => s.active === false).map((s) => `${s.name} (${ROLE_LABELS[s.role]}) isn't activated yet`),
  ];

  const Group = ({ label, icon, list, describe }) => (
    <Card className="p-4">
      <p className="mb-3 text-sm font-semibold text-slate-700">{label}</p>
      <div className="space-y-2">
        {list.map((s) => (
          <div key={s.id} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm">
            <span className="font-medium text-slate-700">{s.name}{s.active === false && <Badge tone="amber"> not activated</Badge>}</span>
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
              <p className="font-medium">{gaps.length} gap(s) to review</p>
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
/* AO: master data approvals                                          */
/* ---------------------------------------------------------------- */
function AOApprovals({ state, onApprove, onReject }) {
  const pending = state.pendingChanges.filter((c) => c.status === "pending");
  return (
    <div>
      <SectionTitle icon={ShieldCheck} title="Master data approvals" subtitle="Every Database Manager change is applied only after your approval." />
      {pending.length === 0 && <EmptyNote text="No pending changes right now." />}
      <div className="space-y-3">
        {pending.map((c) => (
          <Card key={c.id} className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="font-medium text-slate-800">{c.summary}</div>
                <div className="mt-0.5 text-xs text-slate-500">Requested {new Date(c.createdAt).toLocaleString()}</div>
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

/* ---------------------------------------------------------------- */
/* Approval queue (shared by Teacher / Coordinator / AO-final)        */
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
              <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="font-medium text-slate-800">{c.name}</div>
                  <div className="text-xs text-slate-500">{count} absent · headcount {r.headcount ?? "\u2014"}</div>
                </div>
                <Btn size="sm" variant="success" onClick={() => runAction(() => api.approveStage(date, c.id), "Approved")}><Check size={13} /> Approve</Btn>
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
                <span className="text-xs text-slate-400">{r[stageKey].byName} · {new Date(r[stageKey].at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function FinalApproval({ state, date, runAction, onCutoff }) {
  return (
    <div>
      <ApprovalQueue state={state} date={date} runAction={runAction} stageKey="aoApproved" requiredPriorKey="coordinatorApproved" roleLabel="AO final" note="Last sign-off before the Principal's report is published." />
      <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4">
        <div className="flex items-start gap-2 text-sm text-amber-800">
          <Bell size={15} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">Deadline cutoff</p>
            <p className="mt-0.5 text-amber-700">Anything not fully approved by the cutoff is published anyway, tagged "auto-passed," and can still be completed afterward to clear the tag.</p>
          </div>
        </div>
        <div className="mt-3"><Btn variant="outline" onClick={onCutoff}><Clock size={14} /> Run cutoff now (demo)</Btn></div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* DB Manager screens                                                  */
/* ---------------------------------------------------------------- */
function StudentsAdmin({ state, runAction }) {
  const [name, setName] = useState(""); const [roll, setRoll] = useState("");
  const [classId, setClassId] = useState(""); const [roomId, setRoomId] = useState("");
  const [editing, setEditing] = useState(null);

  const submitAdd = () => {
    if (!name || !roll || !classId) return;
    runAction(() => api.proposeChange("add_student", `Add student ${name} (${roll})`, { name, roll, classId, roomId: roomId || null }), "Sent to AO for approval");
    setName(""); setRoll(""); setClassId(""); setRoomId("");
  };
  const submitDelete = (s) => runAction(() => api.proposeChange("delete_student", `Delete student ${s.name} (${s.roll})`, { studentId: s.id }), "Sent to AO for approval");
  const submitEdit = () => {
    runAction(() => api.proposeChange("edit_student", `Edit student ${editing.name}`, { studentId: editing.id, changes: { name: editing.name, roll: editing.roll, classId: editing.classId, roomId: editing.roomId || null } }), "Sent to AO for approval");
    setEditing(null);
  };

  return (
    <div>
      <SectionTitle icon={GraduationCap} title="Students" subtitle="Changes are sent to the AO for approval before they take effect." />
      <Card className="mb-6 p-4">
        <p className="mb-3 text-sm font-semibold text-slate-700">Add a student</p>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Roll number"><input className={inputCls} value={roll} onChange={(e) => setRoll(e.target.value)} /></Field>
          <Field label="Class"><Select value={classId} onChange={setClassId} options={state.classes.map((c) => ({ value: c.id, label: c.name }))} /></Field>
          <Field label="Hostel room (optional)"><Select value={roomId} onChange={setRoomId} options={state.hostelRooms.map((r) => ({ value: r.id, label: `${r.hostel} ${r.roomNo}` }))} /></Field>
        </div>
        <div className="mt-3"><Btn onClick={submitAdd}><Plus size={14} /> Send for AO approval</Btn></div>
      </Card>
      <Card className="overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr><th className="px-4 py-2.5">Name</th><th className="px-4 py-2.5">Roll</th><th className="px-4 py-2.5">Class</th><th className="px-4 py-2.5">Room</th><th className="px-4 py-2.5"></th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {state.students.map((s) => {
              const room = state.hostelRooms.find((r) => r.id === s.roomId);
              const cls = state.classes.find((c) => c.id === s.classId);
              return (
                <tr key={s.id}>
                  <td className="px-4 py-2.5 font-medium text-slate-800">{s.name}</td>
                  <td className="px-4 py-2.5 text-slate-600">{s.roll}</td>
                  <td className="px-4 py-2.5 text-slate-600">{cls?.name}</td>
                  <td className="px-4 py-2.5 text-slate-500">{room ? `${room.hostel} ${room.roomNo}` : "Day scholar"}</td>
                  <td className="px-4 py-2.5">
                    <div className="flex justify-end gap-2">
                      <button onClick={() => setEditing({ ...s })} className="text-slate-400 hover:text-slate-700"><Pencil size={14} /></button>
                      <button onClick={() => submitDelete(s)} className="text-slate-400 hover:text-rose-600"><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              );
            })}
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
              <Field label="Class"><Select value={editing.classId} onChange={(v) => setEditing({ ...editing, classId: v })} options={state.classes.map((c) => ({ value: c.id, label: c.name }))} /></Field>
              <Field label="Room"><Select value={editing.roomId || ""} onChange={(v) => setEditing({ ...editing, roomId: v })} options={state.hostelRooms.map((r) => ({ value: r.id, label: `${r.hostel} ${r.roomNo}` }))} /></Field>
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

function RoomsAdmin({ state, runAction }) {
  const [hostel, setHostel] = useState("Hostel Block A"); const [roomNo, setRoomNo] = useState("");
  const [floorId, setFloorId] = useState(state.floors[0]?.id || "");
  const [className, setClassName] = useState(""); const [classFloorId, setClassFloorId] = useState(state.floors[0]?.id || "");

  return (
    <div>
      <SectionTitle icon={Bed} title="Hostel rooms & classes" subtitle="Add structure that staff and students can be assigned to." />
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="p-4">
          <p className="mb-3 text-sm font-semibold text-slate-700">Add a hostel room</p>
          <div className="space-y-3">
            <Field label="Hostel"><input className={inputCls} value={hostel} onChange={(e) => setHostel(e.target.value)} /></Field>
            <Field label="Room number"><input className={inputCls} value={roomNo} onChange={(e) => setRoomNo(e.target.value)} /></Field>
            <Field label="Floor"><Select value={floorId} onChange={setFloorId} options={state.floors.map((f) => ({ value: f.id, label: f.name }))} /></Field>
          </div>
          <div className="mt-3"><Btn onClick={() => { if (!roomNo) return; runAction(() => api.proposeChange("add_room", `Add room ${hostel} ${roomNo}`, { hostel, roomNo, floorId }), "Sent to AO for approval"); setRoomNo(""); }}><Plus size={14} /> Send for AO approval</Btn></div>
        </Card>
        <Card className="p-4">
          <p className="mb-3 text-sm font-semibold text-slate-700">Add a class to a floor</p>
          <div className="space-y-3">
            <Field label="Class name"><input className={inputCls} value={className} onChange={(e) => setClassName(e.target.value)} /></Field>
            <Field label="Floor"><Select value={classFloorId} onChange={setClassFloorId} options={state.floors.map((f) => ({ value: f.id, label: f.name }))} /></Field>
          </div>
          <div className="mt-3"><Btn onClick={() => { if (!className) return; runAction(() => api.proposeChange("add_class", `Add class ${className}`, { name: className, floorId: classFloorId }), "Sent to AO for approval"); setClassName(""); }}><Plus size={14} /> Send for AO approval</Btn></div>
        </Card>
      </div>
      <div className="mt-6 grid gap-4 md:grid-cols-2">
        <Card className="p-4">
          <p className="mb-2 text-sm font-semibold text-slate-700">Current rooms</p>
          <ul className="space-y-1 text-sm text-slate-600">{state.hostelRooms.map((r) => <li key={r.id}>{r.hostel} — Room {r.roomNo}</li>)}</ul>
        </Card>
        <Card className="p-4">
          <p className="mb-2 text-sm font-semibold text-slate-700">Current classes</p>
          <ul className="space-y-1 text-sm text-slate-600">{state.classes.map((c) => <li key={c.id}>{c.name}</li>)}</ul>
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
    </div>
  );

  return (
    <div>
      <SectionTitle icon={UserCog} title="Assign staff" subtitle="A warden can cover several rooms. DOs and Incharge Teachers are pooled per floor — any one assigned can act." />
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="p-4">
          <p className="mb-3 text-sm font-semibold text-slate-700">Assign Warden to room(s)</p>
          <Field label="Warden"><Select value={wardenId} onChange={(v) => { setWardenId(v); setWardenRooms(state.staff.find((s) => s.id === v)?.roomIds || []); }} options={wardens.map((w) => ({ value: w.id, label: w.name }))} /></Field>
          <div className="mt-3"><CheckGroup options={state.hostelRooms.map((r) => ({ value: r.id, label: `${r.hostel} ${r.roomNo}` }))} selected={wardenRooms} onToggle={(v) => setWardenRooms(toggle(wardenRooms, v))} /></div>
          <div className="mt-3"><Btn onClick={() => wardenId && runAction(() => api.proposeChange("assign_warden", `Assign ${wardens.find((w) => w.id === wardenId)?.name} to ${wardenRooms.length} room(s)`, { staffId: wardenId, roomIds: wardenRooms }), "Sent to AO for approval")}>Send for AO approval</Btn></div>
        </Card>
        <Card className="p-4">
          <p className="mb-3 text-sm font-semibold text-slate-700">Assign Discipline Officer to floor(s)</p>
          <Field label="DO"><Select value={doId} onChange={(v) => { setDoId(v); setDoFloors(state.staff.find((s) => s.id === v)?.floorIds || []); }} options={dos.map((w) => ({ value: w.id, label: w.name }))} /></Field>
          <div className="mt-3"><CheckGroup options={state.floors.map((f) => ({ value: f.id, label: f.name }))} selected={doFloors} onToggle={(v) => setDoFloors(toggle(doFloors, v))} /></div>
          <div className="mt-3"><Btn onClick={() => doId && runAction(() => api.proposeChange("assign_do", `Assign ${dos.find((w) => w.id === doId)?.name} as DO`, { staffId: doId, floorIds: doFloors }), "Sent to AO for approval")}>Send for AO approval</Btn></div>
        </Card>
        <Card className="p-4">
          <p className="mb-3 text-sm font-semibold text-slate-700">Assign Incharge Teacher to floor(s)</p>
          <Field label="Teacher"><Select value={teacherId} onChange={(v) => { setTeacherId(v); setTeacherFloors(state.staff.find((s) => s.id === v)?.floorIds || []); }} options={teachers.map((w) => ({ value: w.id, label: w.name }))} /></Field>
          <div className="mt-3"><CheckGroup options={state.floors.map((f) => ({ value: f.id, label: f.name }))} selected={teacherFloors} onToggle={(v) => setTeacherFloors(toggle(teacherFloors, v))} /></div>
          <div className="mt-3"><Btn onClick={() => teacherId && runAction(() => api.proposeChange("assign_teacher", `Assign ${teachers.find((w) => w.id === teacherId)?.name} as Incharge Teacher`, { staffId: teacherId, floorIds: teacherFloors }), "Sent to AO for approval")}>Send for AO approval</Btn></div>
        </Card>
        <Card className="p-4">
          <p className="mb-3 text-sm font-semibold text-slate-700">Assign Local Attendance Incharge to class</p>
          <Field label="LAI"><Select value={laiId} onChange={(v) => { setLaiId(v); setLaiClasses(state.staff.find((s) => s.id === v)?.classIds || []); }} options={lais.map((w) => ({ value: w.id, label: w.name }))} /></Field>
          <div className="mt-3"><CheckGroup options={state.classes.map((c) => ({ value: c.id, label: c.name }))} selected={laiClasses} onToggle={(v) => setLaiClasses(toggle(laiClasses, v))} /></div>
          <div className="mt-3"><Btn onClick={() => laiId && runAction(() => api.proposeChange("assign_lai", `Assign ${lais.find((w) => w.id === laiId)?.name} as LAI`, { staffId: laiId, classIds: laiClasses }), "Sent to AO for approval")}>Send for AO approval</Btn></div>
        </Card>
      </div>
    </div>
  );
}

function ActivateAdmin({ state, runAction }) {
  const inactive = state.staff.filter((s) => s.active === false);
  return (
    <div>
      <SectionTitle icon={Users} title="Activate accounts" subtitle="Field-staff accounts stay locked until activated." />
      {inactive.length === 0 && <EmptyNote text="Everyone is already active." />}
      <div className="space-y-2">
        {inactive.map((s) => (
          <Card key={s.id} className="flex items-center justify-between p-3">
            <div><span className="font-medium text-slate-800">{s.name}</span> <span className="text-sm text-slate-500">— {ROLE_LABELS[s.role]}</span></div>
            <Btn size="sm" onClick={() => runAction(() => api.proposeChange("activate_staff", `Activate ${s.name} (${ROLE_LABELS[s.role]})`, { staffId: s.id }), "Sent to AO for approval")}>Request activation</Btn>
          </Card>
        ))}
      </div>
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
/* Warden: mark absentees with a reason, plus persistent "away" list  */
/* ---------------------------------------------------------------- */
function WardenScreen({ state, date, me, runAction }) {
  const rooms = me.roomIds || [];
  const allStudents = state.students.filter((s) => rooms.includes(s.roomId));
  const away = allStudents.filter((s) => s.awayReason);
  const present = allStudents.filter((s) => !s.awayReason);
  const [pickerFor, setPickerFor] = useState(null); // studentId currently choosing a reason

  return (
    <div>
      <SectionTitle icon={Bed} title="Mark hostel absentees" subtitle={`Covering ${rooms.length} room(s) today \u2014 picking a reason marks a student absent.`} />

      {away.length > 0 && (
        <Card className="mb-4 border-amber-200 bg-amber-50 p-4">
          <p className="mb-2 text-sm font-semibold text-amber-800">Away — counted absent automatically until reported back</p>
          <div className="space-y-2">
            {away.map((s) => (
              <div key={s.id} className="flex items-center justify-between rounded-lg bg-white px-3 py-2 text-sm">
                <span className="text-slate-700">{s.name} <span className="text-xs text-slate-400">({s.roll}) — {s.awayReason} since {s.awaySince}</span></span>
                <Btn size="sm" variant="outline" onClick={() => runAction(() => api.reportBack(s.id), "Marked as reported back")}>Mark reported</Btn>
              </div>
            ))}
          </div>
        </Card>
      )}

      {allStudents.length === 0 && <EmptyNote text="No students assigned to you yet." />}
      <div className="space-y-4">
        {Object.entries(groupBy(present, (s) => s.classId)).map(([classId, list]) => {
          const cls = state.classes.find((c) => c.id === classId);
          const r = state.attendance[date]?.[classId] || emptyRecord();
          const locked = !!r.doApproved;
          const bucket = r.wardenAbsences || {};
          return (
            <Card key={classId} className="p-4">
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
                          <button onClick={() => { runAction(() => api.markAway(s.id, AWAY_REASON), "Marked away \u2014 counted absent until reported back"); setPickerFor(null); }}
                            className="rounded-md border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] text-amber-700 hover:bg-amber-100">{AWAY_REASON}</button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* LAI: mark absentees, no reason \u2014 DO fills that in after a call */
/* ---------------------------------------------------------------- */
function LAIScreen({ state, date, me, runAction }) {
  const classIds = me.classIds || [];
  const students = state.students.filter((s) => classIds.includes(s.classId) && !s.awayReason);
  return (
    <div>
      <SectionTitle icon={GraduationCap} title="Mark classroom absentees" subtitle="No reason needed here — the Discipline Officer will call home and record the reason." />
      {students.length === 0 && <EmptyNote text="No students assigned to you yet." />}
      <div className="space-y-4">
        {Object.entries(groupBy(students, (s) => s.classId)).map(([classId, list]) => {
          const cls = state.classes.find((c) => c.id === classId);
          const r = state.attendance[date]?.[classId] || emptyRecord();
          const locked = !!r.doApproved;
          const bucket = r.laiAbsences || {};
          return (
            <Card key={classId} className="p-4">
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
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* DO screen: headcount \u2192 verify each reason \u2192 approve             */
/* ---------------------------------------------------------------- */
function DoClassCard({ c, record, date, students, runAction }) {
  const [headcount, setHeadcount] = useState(record.headcount ?? "");
  const [draftReasons, setDraftReasons] = useState({});
  const combined = { ...(record.wardenAbsences || {}), ...(record.laiAbsences || {}) };
  const list = Object.entries(combined).map(([sid, meta]) => ({
    student: students.find((s) => s.id === sid), meta,
    verified: record.doVerified?.[sid]?.reason || null,
  }));
  const away = students.filter((s) => s.classId === c.id && s.awayReason);
  const approved = !!record.doApproved;
  const headcountSaved = record.headcount != null;
  const allVerified = list.every((item) => item.verified);

  const saveReason = (sid, reason) => runAction(() => api.verifyReason(date, c.id, sid, reason));

  return (
    <Card className="p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="font-medium text-slate-800">{c.name}</p>
        {approved ? <Badge tone="emerald"><CheckCircle2 size={12} /> Approved by {record.doApproved.byName}</Badge> : <Badge tone="amber">{!headcountSaved ? "Enter headcount to continue" : "Needs reason verification"}</Badge>}
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
                    <span>{s.name} ({s.roll})</span><span className="text-xs text-slate-400">{s.awayReason} since {s.awaySince}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {list.length === 0 ? (
            <p className="mt-3 text-sm text-slate-400">No fresh absentees reported for this class today.</p>
          ) : (
            <div className="mt-3 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Verify each reason before approving</p>
              {list.map(({ student, meta, verified }) => student && (
                <div key={student.id} className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-700">{student.name} <span className="text-xs text-slate-400">({student.roll}) — {meta.reason ? `Warden: ${meta.reason}` : "reported by LAI, no reason yet"}</span></span>
                    {verified && <Badge tone="emerald"><CheckCircle2 size={11} /> Verified</Badge>}
                  </div>
                  {!approved && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {DAILY_REASONS.map((reason) => (
                        <button key={reason} onClick={() => saveReason(student.id, reason)}
                          className={`rounded-md border px-2 py-0.5 text-[11px] ${verified === reason ? "border-emerald-400 bg-emerald-50 text-emerald-700" : "border-slate-300 text-slate-600 hover:bg-slate-100"}`}>
                          {reason}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="mt-4">
            <Btn variant="success" disabled={approved || !allVerified} onClick={() => runAction(() => api.approveStage(date, c.id), "Approved")}>
              <CheckCircle2 size={14} /> {allVerified ? "Approve list" : "Verify all reasons first"}
            </Btn>
          </div>
        </>
      )}
    </Card>
  );
}
function DOScreen({ state, date, me, runAction }) {
  const floorClasses = state.classes.filter((c) => (me.floorIds || []).includes(c.floorId));
  const poolmates = state.staff.filter((s) => s.role === "DO" && s.id !== me.id && (s.floorIds || []).some((f) => (me.floorIds || []).includes(f)));
  return (
    <div>
      <SectionTitle icon={Phone} title="Verify & approve" subtitle="Two DOs cover this floor — whichever of you approves first completes it for both." />
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
