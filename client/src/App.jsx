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
  Undo2, Search, UserPlus, Snowflake, KeyRound, Building2, FileDown, FileUp,
  CalendarSearch, UserX, ListTree, BookUser, ArrowRightLeft,
  TrendingUp, TrendingDown, Minus, Home, ArrowLeft, ClipboardList,
} from "lucide-react";
import { api } from "./api.js";
import { isAlwaysVisibleDecision } from "./recency.js";

/* ---------------------------------------------------------------- */
/* 1. Shared constants                                                */
/* ---------------------------------------------------------------- */
const todayStr = () => new Date().toISOString().slice(0, 10);
// Shifts a "YYYY-MM-DD" string by `delta` days (negative goes back). Goes
// through a real UTC Date rather than string math, so month/year boundaries
// are handled correctly and local timezone can't shift the result a day off.
function shiftDateStr(dateStr, delta) {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

// The two approval stages, in order, mirrored from server/src/stages.js.
// (Duplicated rather than imported because the frontend and backend are
// separate projects that don't share code.) AO does not approve daily
// attendance, and neither does Coordinator anymore — Lecturer is the last
// human stage. AttendanceRecord.coordinatorApproved still exists as a real
// field (genuine historical data from the old three-stage pipeline) but
// isn't part of this array and nothing here reads or writes it — see
// stages.js's comment for why old fully-approved records still read
// correctly as published without it.
const STAGES = [
  { key: "doApproved", label: "DO verified", pendingLabel: "Discipline Officer" },
  { key: "teacherApproved", label: "Lecturer approved", pendingLabel: "Lecturer" },
];
function currentStageIndex(rec) {
  for (let i = 0; i < STAGES.length; i++) if (!rec[STAGES[i].key]) return i;
  return STAGES.length;
}
function priorStageKey(stageKey) {
  const idx = STAGES.findIndex((s) => s.key === stageKey);
  return idx > 0 ? STAGES[idx - 1].key : null;
}
// Per-classroom-per-session status for the floor status board (Coordinator's
// and Lecturer's "status" tab, AttendanceStatusBoard below). Finer-grained than
// a plain stage index: idx===0 alone spans everything from "nobody's
// touched this yet" to "DO has everything they need and just hasn't clicked
// approve," which is too coarse for a board someone checks throughout the
// day. Every state here is derived from fields the pipeline already
// writes — nothing new is tracked.
function classroomStatus(rec) {
  const combined = { ...(rec.wardenAbsences || {}), ...(rec.laiAbsences || {}) };
  const ids = Object.keys(combined);
  const hasAbsentees = ids.length > 0;
  const idx = currentStageIndex(rec);
  const sentBack = !!rec.sentBack;

  if (rec.forcedPublish && idx < STAGES.length) {
    const missing = STAGES.slice(idx).map((s) => s.pendingLabel).join(", ");
    return { key: "auto_passed", label: `Auto-passed — missing: ${missing}`, tone: "rose" };
  }
  if (idx === STAGES.length) return { key: "published", label: "Published", tone: "emerald" };
  if (idx === STAGES.length - 1) return { key: "awaiting_lecturer", label: sentBack ? "Sent back to you" : "Awaiting you", tone: sentBack ? "rose" : "blue" };

  // idx === 0 — everything before the DO's own approval, broken down further.
  if (!hasAbsentees && rec.headcount == null) return { key: "not_started", label: "Not started", tone: "slate" };
  const allConfirmed = !hasAbsentees || ids.every((sid) => rec.doConfirmed?.[sid]);
  const allVerified = !hasAbsentees || ids.every((sid) => rec.doVerified?.[sid]);
  if (rec.headcount != null && allConfirmed && allVerified) {
    return { key: "awaiting_do", label: "Ready for DO approval", tone: "amber" };
  }
  return { key: "marking", label: sentBack ? "Sent back — being redone" : "Marking in progress", tone: sentBack ? "rose" : "slate" };
}
function emptyRecord() {
  return {
    wardenAbsences: {}, laiAbsences: {}, headcount: null, doConfirmed: {}, doVerified: {},
    doApproved: null, teacherApproved: null, coordinatorApproved: null,
    forcedPublish: false, skippedStages: [], sentBack: null,
  };
}

// Every classroom now has two independent AttendanceRecords per day (see
// schema.prisma's Session enum) — state.attendance[date][classId] and GET
// /attendance's rangeData.data[date] are both keyed classId -> session ->
// record. No screen has session-switching UI yet, so every read in this
// phase is pinned to MORNING via this one default — see stages.js's
// comment in App.jsx (this same file) on why session-aware history/streak
// logic is deliberately deferred to a later phase.
const DEFAULT_SESSION = "MORNING";

// Resolves a classId -> session -> record map down to a plain
// classId -> record map for one session (MORNING unless overridden).
function sessionScoped(byClassId, session = DEFAULT_SESSION) {
  const day = {};
  for (const classId of Object.keys(byClassId || {})) {
    const rec = byClassId[classId]?.[session];
    if (rec) day[classId] = rec;
  }
  return day;
}

const ROLE_LABELS = {
  PRINCIPAL: "Principal", AO: "AO", COORDINATOR: "Coordinator", DB_MANAGER: "Database Manager",
  WARDEN: "Warden", DO: "Discipline Officer", LECTURER: "Lecturer", LAI: "Local Attendance Incharge",
};
// Mirrors server/src/constants.js's LEADERSHIP_ROLES — reset-password and
// offboard are only backed by the server for these three roles, so the
// client needs the same list to decide which rows get those buttons.
const LEADERSHIP_ROLES = ["AO", "COORDINATOR", "DB_MANAGER"];
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
// Time-of-day greeting shown to every account right after logging in —
// purely based on the device's local clock, so "morning" means the
// user's morning wherever they are.
function greetingText() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 17) return "Good afternoon";
  return "Good evening";
}

/* ---------------------------------------------------------------- */
/* 2. Small reusable UI pieces                                        */
/* ---------------------------------------------------------------- */
const TONES = {
  slate: "bg-slate-100 text-slate-600 border-slate-200",
  emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
  rose: "bg-rose-50 text-rose-700 border-rose-200",
  amber: "bg-amber-50 text-amber-700 border-amber-200",
  blue: "bg-blue-50 text-blue-700 border-blue-200",
};
function Badge({ tone = "slate", children }) {
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONES[tone]}`}>{children}</span>;
}
function Card({ children, className = "" }) {
  return <div className={`rounded-2xl border border-slate-200 bg-white shadow-sm ${className}`}>{children}</div>;
}
// A real dialog overlay, for actions consequential enough that the
// lightweight inline ConfirmButton isn't enough friction — e.g. Offboard.
// Clicking the backdrop or the X closes it without side effects.
function Modal({ title, onClose, children }) {
  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-slate-900/40 p-4" onClick={onClose}>
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-4 flex items-center justify-between gap-3">
          <h3 className="font-display text-base font-semibold text-slate-900">{title}</h3>
          <button onClick={onClose} className="shrink-0 text-slate-400 hover:text-slate-600" aria-label="Close">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
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
  // "touch": same compact text as "sm", but a guaranteed ~40px tap height —
  // for row actions people tap on a phone (account freeze/reset/offboard),
  // as opposed to "sm"'s denser rows of inline text-only actions.
  const sizes = size === "touch" ? "min-h-[40px] px-3.5 py-2 text-xs" : size === "sm" ? "px-2.5 py-1 text-xs" : "px-3.5 py-2 text-sm";
  const variants = {
    primary: "bg-[#12324D] text-white hover:bg-[#0d2438]",
    success: "bg-emerald-600 text-white hover:bg-emerald-700",
    danger: "bg-rose-600 text-white hover:bg-rose-700",
    ghost: "bg-slate-100 text-slate-700 hover:bg-slate-200",
    outline: "border border-slate-300 text-slate-700 hover:bg-slate-50",
    dangerOutline: "border border-rose-200 text-rose-600 hover:bg-rose-50",
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
// A small inline "click, then confirm" control for actions that need a
// yes/no guard but not a reason — freeze/unfreeze accounts, etc. Same
// no-modal-component approach as SendBackButton below.
// `busy`: true while onConfirm's request is in flight. Clicking "Confirm"
// closes the confirm step immediately (setOpen(false) doesn't wait for
// onConfirm to resolve), so the busy spinner has to live on the collapsed
// button, not the confirm step — that's also naturally where a double-click
// would otherwise land.
function ConfirmButton({ label, confirmLabel, variant = "danger", icon: Icon, onConfirm, disabled, busy }) {
  const [open, setOpen] = useState(false);
  const isDisabled = disabled || busy;
  if (!open) {
    return (
      <Btn size="touch" variant={variant} disabled={isDisabled} onClick={() => setOpen(true)}>
        {busy ? <Loader2 className="animate-spin" size={12} /> : Icon && <Icon size={12} />} {busy ? "..." : label}
      </Btn>
    );
  }
  return (
    <div className="inline-flex flex-wrap items-center gap-3">
      <span className="text-xs text-slate-500">Are you sure?</span>
      <Btn size="touch" variant={variant} onClick={() => { onConfirm(); setOpen(false); }}>{confirmLabel || "Confirm"}</Btn>
      <Btn size="touch" variant="ghost" onClick={() => setOpen(false)}>Cancel</Btn>
    </div>
  );
}
// Two-step Offboard flow: pick a successor (existing same-role account, or
// create a new one inline), see exactly what will happen, then type the
// outgoing account's exact name to actually confirm — more friction than
// ConfirmButton on purpose, since this freezes someone's account for good
// until a Principal/AO manually unfreezes it.
function OffboardModal({ target, candidates, runAction, onClose, onDone }) {
  const [mode, setMode] = useState(candidates.length > 0 ? "existing" : "new");
  const [successorId, setSuccessorId] = useState(candidates[0]?.id || "");
  const [newName, setNewName] = useState("");
  const [step, setStep] = useState("select"); // "select" | "confirm"
  const [typedName, setTypedName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const roleLabel = ROLE_LABELS[target.role];
  const successorName = mode === "existing" ? candidates.find((c) => c.id === successorId)?.name : newName.trim();
  const canContinue = mode === "existing" ? !!successorId : newName.trim().length > 0;
  const canConfirm = typedName === target.name && !busy;

  const goToConfirm = () => { setError(""); setStep("confirm"); };
  const goBack = () => { setError(""); setStep("select"); };

  // Calls the API directly (rather than through runAction) so a failure's
  // exact message can be shown inline in the modal instead of just the
  // corner toast — runAction swallows errors internally and returns null,
  // which is enough for the routine Freeze/Reset-key actions but not here.
  // On success it hands the already-resolved result to runAction purely to
  // reuse its refresh()+toast() side effects, with no extra network call.
  const submit = async () => {
    if (!canConfirm) return;
    setBusy(true);
    setError("");
    const payload = mode === "existing" ? { successorId } : { newAccount: { name: newName.trim() } };
    try {
      const result = await api.offboardUser(target.id, payload);
      await runAction(() => Promise.resolve(result), "Offboarded");
      onDone(result);
    } catch (e) {
      setError(e.message || "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={`Offboard ${target.name}`} onClose={onClose}>
      {step === "select" ? (
        <div className="space-y-4">
          <p className="text-sm text-slate-500">{target.name} ({roleLabel}) will be frozen and can't log in again until manually unfrozen. Choose who takes over first.</p>
          <div className="space-y-2">
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="radio" checked={mode === "existing"} onChange={() => setMode("existing")} disabled={candidates.length === 0} />
              Existing {roleLabel} account
            </label>
            {mode === "existing" && (
              candidates.length > 0 ? (
                <select className={`${inputCls} ml-6 w-[calc(100%-1.5rem)]`} value={successorId} onChange={(e) => setSuccessorId(e.target.value)}>
                  {candidates.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              ) : <p className="pl-6 text-xs text-slate-400">No other active {roleLabel} accounts exist yet.</p>
            )}
            <label className="flex items-center gap-2 text-sm text-slate-700">
              <input type="radio" checked={mode === "new"} onChange={() => setMode("new")} />
              Create a new account
            </label>
            {mode === "new" && (
              <div className="ml-6 space-y-1.5">
                <input autoFocus={candidates.length === 0} className={inputCls} placeholder="New account's name" value={newName} onChange={(e) => setNewName(e.target.value)} />
                <p className="text-xs text-slate-500">Role: <span className="font-medium text-slate-700">{roleLabel}</span> (fixed — matches the account being offboarded)</p>
              </div>
            )}
          </div>
          <div className="flex justify-end gap-2">
            <Btn size="touch" variant="ghost" onClick={onClose}>Cancel</Btn>
            <Btn size="touch" onClick={goToConfirm} disabled={!canContinue}>Continue</Btn>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
            <p className="mb-1 font-medium">This will:</p>
            <ul className="list-disc space-y-0.5 pl-4">
              <li>{mode === "new" ? <>Create a new {roleLabel} account for <span className="font-medium">{successorName}</span></> : <><span className="font-medium">{successorName}</span> becomes the acting {roleLabel}</>}</li>
              <li>Freeze <span className="font-medium">{target.name}</span>'s account — they won't be able to log in again until unfrozen</li>
            </ul>
          </div>
          {error && <p className="text-sm text-rose-600">{error}</p>}
          <Field label={`Type "${target.name}" to confirm`}>
            <input autoFocus className={inputCls} value={typedName} onChange={(e) => setTypedName(e.target.value)} />
          </Field>
          <div className="flex justify-end gap-2">
            <Btn size="touch" variant="ghost" onClick={goBack}>Back</Btn>
            <Btn size="touch" variant="danger" onClick={submit} disabled={!canConfirm}>
              {busy ? <Loader2 className="animate-spin" size={14} /> : <UserX size={14} />} Offboard {target.name}
            </Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}
// Freeze/Unfreeze, Reset password, and Offboard for one account row — shared
// between the Principal's Leadership screen and the AO's Freeze screen so
// the button set, visibility rules, and layout aren't duplicated across
// both. showResetPassword/showOffboard let each caller restrict those two to
// leadership rows only (the backend rejects them for field staff anyway).
// layout="row" is the desktop table's single right-aligned line with a
// divider before Offboard; layout="stack" is the mobile card's vertical
// arrangement, every button full-width via Btn's own w-full default.
function AccountActions({ s, runAction, showResetPassword, showOffboard, onResetPassword, onOffboard, layout = "row" }) {
  // PENDING/REJECTED field-staff rows (not yet AO-approved, or declined)
  // get neither button — freezing only makes sense once an account can
  // actually log in in the first place.
  const freezeBtn = s.status === "FROZEN" ? (
    <ConfirmButton label="Unfreeze" confirmLabel="Unfreeze" variant="success" onConfirm={() => runAction(() => api.unfreezeUser(s.id), "Unfrozen")} />
  ) : s.status === "ACTIVE" ? (
    <ConfirmButton label="Freeze" confirmLabel="Freeze" icon={Snowflake} onConfirm={() => runAction(() => api.freezeUser(s.id), "Frozen")} />
  ) : (
    <span className="text-xs text-slate-400">n/a</span>
  );
  const resetBtn = showResetPassword && <ConfirmButton label="Reset password" confirmLabel="Reset password" variant="outline" icon={KeyRound} onConfirm={() => onResetPassword(s)} />;
  const offboardBtn = showOffboard && s.status === "ACTIVE" && (
    <Btn size="touch" variant="dangerOutline" onClick={() => onOffboard(s)}><UserX size={12} /> Offboard</Btn>
  );

  if (layout === "row") {
    return (
      <div className="flex flex-nowrap items-center justify-end gap-2">
        {freezeBtn}
        {resetBtn}
        {offboardBtn && <span className="mx-0.5 h-5 w-px shrink-0 bg-slate-200" aria-hidden="true" />}
        {offboardBtn}
      </div>
    );
  }
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap gap-2">{freezeBtn}{resetBtn}</div>
      {offboardBtn}
    </div>
  );
}
// Holds the state and handlers behind Reset password and Offboard — shared
// by any screen that renders AccountActions, so both screens dismiss/refresh
// the same way instead of each re-implementing it.
function useAccountLifecycle(runAction) {
  const [resetResult, setResetResult] = useState(null); // { name, password }
  const [offboarding, setOffboarding] = useState(null); // account currently in the Offboard modal, or null
  const [offboardResult, setOffboardResult] = useState(null); // { role, successorName, creds }

  const resetPassword = async (s) => {
    const result = await runAction(() => api.resetPassword(s.id), "Password reset");
    if (result) setResetResult({ name: s.name, password: result.password });
  };

  const handleOffboardDone = (result) => {
    const role = ROLE_LABELS[offboarding.role];
    setOffboarding(null);
    if (result.successorCreds) {
      setOffboardResult({ role, successorName: result.successor.name, creds: result.successorCreds });
    }
  };

  return { resetResult, setResetResult, offboarding, setOffboarding, offboardResult, setOffboardResult, resetPassword, handleOffboardDone };
}
// The two dismissible amber banners shown after a Reset password or
// Offboard (with a newly-created successor) — same visual pattern in both
// places. loginKey is safe to show alongside the password since it's a
// permanent, non-secret identifier, not part of the credential being reset.
function AccountLifecycleBanners({ resetResult, onDismissReset, offboardResult, onDismissOffboard }) {
  return (
    <>
      {resetResult && (
        <Card className="mb-6 border-amber-200 bg-amber-50 p-4">
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm text-amber-800">
              New password for <span className="font-medium">{resetResult.name}</span>: <span className="font-display font-semibold">{resetResult.password}</span> —
              share this securely. This is the only time it will be shown — write it down now.
            </p>
            <button onClick={onDismissReset} className="mt-0.5 shrink-0 text-amber-400 hover:text-amber-600" aria-label="Dismiss">
              <X size={16} />
            </button>
          </div>
        </Card>
      )}
      {offboardResult && (
        <Card className="mb-6 border-amber-200 bg-amber-50 p-4">
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm text-amber-800">
              New {offboardResult.role} account created for <span className="font-medium">{offboardResult.successorName}</span> —
              key <span className="font-display font-semibold">{offboardResult.creds.loginKey}</span>, password <span className="font-display font-semibold">{offboardResult.creds.password}</span>.
              Must be changed on first login. This won't be shown again.
            </p>
            <button onClick={onDismissOffboard} className="mt-0.5 shrink-0 text-amber-400 hover:text-amber-600" aria-label="Dismiss">
              <X size={16} />
            </button>
          </div>
        </Card>
      )}
    </>
  );
}
// A small inline "type a reason, then confirm" control used for send-back
// buttons everywhere, so it doesn't need its own modal component. `busy` and
// `disabled` are distinct: busy means THIS card's send-back is in flight
// (shows a spinner), disabled means some OTHER action on the same card is
// in flight (no spinner, just grayed out) — see AOApprovals' ApprovalActions.
function SendBackButton({ onSend, busy, disabled }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  if (!open) {
    return (
      <Btn size="sm" variant="outline" disabled={busy || disabled} onClick={() => setOpen(true)}>
        {busy ? <Loader2 className="animate-spin" size={13} /> : <Undo2 size={13} />} {busy ? "..." : "Send back"}
      </Btn>
    );
  }
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

// Shown before anyone's logged in. Checks once whether a Principal already
// exists to decide the default: straight to Registration for a fresh install
// (nothing else can be done yet anyway), straight to Login afterward. A link
// still lets either screen flip to the other on demand.
function AuthScreen({ onLoggedIn }) {
  const [mode, setMode] = useState(null); // "login" | "register", null while we check which to default to
  const [principalExists, setPrincipalExists] = useState(true); // drives whether the "Register as Principal" link is even offered
  useEffect(() => {
    api.principalExists()
      .then(({ exists }) => { setPrincipalExists(exists); setMode(exists ? "login" : "register"); })
      .catch(() => { setPrincipalExists(true); setMode("login"); }); // if the check itself fails, login is the safer default
  }, []);

  if (mode === null) {
    return (
      <div className="grid min-h-screen place-items-center bg-slate-50 text-slate-400">
        <Loader2 className="animate-spin" size={20} />
      </div>
    );
  }

  return (
    <div className="grid min-h-screen place-items-center bg-slate-50 px-4" style={{ fontFamily: "Inter, system-ui, sans-serif" }}>
      <div className="w-full max-w-sm">
        <div className="mb-5 flex items-center gap-2.5 px-1">
          <div className="grid h-9 w-9 place-items-center rounded-xl bg-[#12324D] text-white"><ClipboardCheck size={17} /></div>
          <div className="font-display text-base font-semibold text-slate-900">Vigil</div>
        </div>
        {mode === "login" ? <LoginForm onLoggedIn={onLoggedIn} /> : <RegisterForm onLoggedIn={onLoggedIn} />}
        {mode === "login" && !principalExists && (
          <p className="mt-4 text-center text-xs text-slate-400">
            First time setting up this app? <button className="font-medium text-[#12324D] underline" onClick={() => setMode("register")}>Register as Principal</button>
          </p>
        )}
        {mode === "register" && (
          <p className="mt-4 text-center text-xs text-slate-400">
            Already set up? <button className="font-medium text-[#12324D] underline" onClick={() => setMode("login")}>Log in instead</button>
          </p>
        )}
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

// Blocks the rest of the app until a mandatory password setup is done.
// Shown whenever me.mustSetPassword is true — a fresh account on its temp
// password, or one that just had its password reset. Deliberately no
// current-password field: the temp password isn't a secret worth verifying,
// it's the thing being replaced (see /auth/set-password's own comment).
function SetPasswordGate({ onDone, onLogout }) {
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
      await api.setPassword(newPassword, confirm);
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
            <p className="text-xs text-slate-500">You're still on a temporary password — choose your own before continuing.</p>
          </div>
        </div>
        <div className="space-y-3">
          <Field label="New password"><input type="password" className={inputCls} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoFocus /></Field>
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

// Self-service password change, reachable any time from the top bar by any
// logged-in role — unlike SetPasswordGate above, this always requires the
// current password and never blocks the rest of the app.
function ChangePasswordModal({ onClose }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async () => {
    setError("");
    if (newPassword.length < 6) return setError("New password must be at least 6 characters");
    if (newPassword !== confirm) return setError("Passwords don't match");
    setBusy(true);
    try {
      await api.changePassword(currentPassword, newPassword, confirm);
      setDone(true);
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  };

  return (
    <Modal title="Change password" onClose={onClose}>
      {done ? (
        <div className="space-y-4 text-center">
          <CheckCircle2 className="mx-auto text-emerald-600" size={28} />
          <p className="text-sm text-slate-600">Password changed.</p>
          <Btn size="touch" onClick={onClose}>Done</Btn>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="space-y-3">
            <Field label="Current password"><input type="password" className={inputCls} value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoFocus /></Field>
            <Field label="New password"><input type="password" className={inputCls} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} /></Field>
            <Field label="Confirm new password"><input type="password" className={inputCls} value={confirm} onChange={(e) => setConfirm(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} /></Field>
          </div>
          {error && <p className="text-sm text-rose-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <Btn size="touch" variant="ghost" onClick={onClose}>Cancel</Btn>
            <Btn size="touch" onClick={submit} disabled={busy}>{busy ? <Loader2 className="animate-spin" size={14} /> : <KeyRound size={14} />} Change password</Btn>
          </div>
        </div>
      )}
    </Modal>
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
  // Greeting banner: shown once per session (page load / fresh login),
  // dismissible with the X. Not persisted anywhere — reappearing next
  // time they open the app is the point.
  const [showGreeting, setShowGreeting] = useState(true);
  const [showChangePassword, setShowChangePassword] = useState(false);
  // The structure_batch PendingChange row currently reopened for editing —
  // set by MyChanges's "Edit and resubmit" button, cleared once StructureAdmin
  // submits or the Database Manager cancels. Lives here (not inside
  // StructureAdmin) because it's set from one tab and consumed by another.
  const [editBatch, setEditBatch] = useState(null);
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
  if (me.mustSetPassword) {
    return <SetPasswordGate onDone={refresh} onLogout={() => { api.clearToken(); setMe(null); }} />;
  }

  const logout = () => { api.clearToken(); setMe(null); setState(null); };

  // Which sidebar tabs a person sees depends entirely on their role.
  const ROLE_TABS = {
    PRINCIPAL: [
      { id: "dashboard", label: "Daily report", icon: LayoutDashboard },
      { id: "classwise", label: "Classwise report", icon: ClipboardList },
      { id: "leadership", label: "Leadership accounts", icon: UserPlus },
      { id: "staffdirectory", label: "Staff directory", icon: BookUser },
    ],
    AO: [
      { id: "approvals", label: "Master data approvals", icon: ShieldCheck },
      { id: "freeze", label: "Freeze / unfreeze", icon: Snowflake },
      { id: "hierarchy", label: "Hierarchy status", icon: Users },
      { id: "staffdirectory", label: "Staff directory", icon: BookUser },
      { id: "viewstudents", label: "View students", icon: ListTree },
    ],
    COORDINATOR: [
      { id: "coordinator", label: "Attendance approvals", icon: ListChecks },
      { id: "status", label: "Attendance status", icon: LayoutDashboard },
      { id: "classwise", label: "Classwise report", icon: ClipboardList },
      { id: "staffdirectory", label: "Staff directory", icon: BookUser },
    ],
    // Daily tasks first, setup/admin tasks last — reordered from the
    // original creation order after live use showed absentees/View
    // students/Manage students/My requests are what a Database Manager
    // reaches for most days, while Hostels & classes / Assign staff /
    // Create staff account are mostly one-time-setup screens. "students"
    // keeps its id (route/state key) but is now labeled "Manage students" —
    // it's about entering/maintaining records, distinct from the read-only
    // "View students" browse page right above it.
    DB_MANAGER: [
      { id: "absentees", label: "View absentees", icon: ClipboardCheck },
      { id: "viewstudents", label: "View students", icon: ListTree },
      { id: "students", label: "Manage students", icon: GraduationCap },
      { id: "mychanges", label: "My requests", icon: Clock },
      { id: "structure", label: "Hostels & classes", icon: Building2 },
      { id: "assign", label: "Assign staff", icon: UserCog },
      { id: "createstaff", label: "Create staff account", icon: UserPlus },
    ],
    WARDEN: [{ id: "warden", label: "Mark absentees", icon: Bed }],
    DO: [{ id: "do", label: "Verify & approve", icon: Phone }],
    LECTURER: [
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
              <div className="font-display text-[15px] font-semibold leading-tight">Vigil</div>
              <div className="text-[11px] text-white/60">{formatDMY(date)}</div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden text-xs text-white/70 sm:inline">{me.name} · {ROLE_LABELS[me.role]} · Key {me.loginKey}</span>
            <button onClick={() => setShowChangePassword(true)} className="flex items-center gap-1 rounded-lg border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/20">
              <KeyRound size={13} /> Change password
            </button>
            <button onClick={logout} className="flex items-center gap-1 rounded-lg border border-white/15 bg-white/10 px-3 py-1.5 text-xs font-medium text-white hover:bg-white/20">
              <LogOut size={13} /> Log out
            </button>
          </div>
        </div>
      </div>

      {/* Greeting banner — every account sees this after logging in, with a
          time-of-day greeting and who they're logged in as. Dismissible;
          comes back on the next login/page load. */}
      {showGreeting && (
        <div className="border-b border-slate-200 bg-white px-4 py-3 sm:px-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="font-display text-base font-semibold text-slate-800">
                {greetingText()}, {me.name.split(" ")[0]}! 👋
              </p>
              <p className="text-xs text-slate-500">
                You're logged in as {ROLE_LABELS[me.role]} · {formatDMY(date)}
              </p>
            </div>
            <button onClick={() => setShowGreeting(false)} className="mt-0.5 text-slate-300 hover:text-slate-500" aria-label="Dismiss greeting">
              <X size={16} />
            </button>
          </div>
        </div>
      )}

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
              {activeTab === "dashboard" && <PrincipalHeroDashboard state={state} date={date} />}
              {activeTab === "classwise" && <ClasswiseAbsenteeReport state={state} />}
              {activeTab === "leadership" && <LeadershipSetup state={state} runAction={runAction} />}
              {activeTab === "approvals" && <AOApprovals state={state} runAction={runAction} />}
              {activeTab === "freeze" && <AOFreezeAccounts state={state} runAction={runAction} me={me} />}
              {activeTab === "hierarchy" && <AOHierarchyStatus state={state} />}
              {activeTab === "staffdirectory" && <StaffDirectory />}
              {activeTab === "viewstudents" && <ViewStudents me={me} />}
              {activeTab === "coordinator" && <CoordinatorApprovals state={state} date={date} runAction={runAction} />}
              {activeTab === "status" && <AttendanceStatusBoard state={state} date={date} scopeFloorIds={me.role === "LECTURER" ? me.floorIds : null} title="Attendance status" subtitle="Visible any time — not just when something is waiting on you." />}
              {activeTab === "students" && <StudentsAdmin state={state} runAction={runAction} />}
              {activeTab === "structure" && <StructureAdmin state={state} runAction={runAction} editBatch={editBatch} onDoneEditing={() => setEditBatch(null)} />}
              {activeTab === "assign" && <AssignAdmin state={state} runAction={runAction} />}
              {activeTab === "createstaff" && <CreateStaffAdmin state={state} runAction={runAction} />}
              {activeTab === "absentees" && <AbsenteesView state={state} />}
              {activeTab === "mychanges" && <MyChanges state={state} me={me} runAction={runAction} onEditBatch={(c) => { setEditBatch(c); setTab("structure"); }} />}
              {activeTab === "warden" && <WardenScreen state={state} date={date} me={me} runAction={runAction} />}
              {activeTab === "do" && <DOScreen state={state} date={date} me={me} runAction={runAction} />}
              {activeTab === "teacher" && <LecturerApprovals state={state} date={date} me={me} runAction={runAction} />}
              {activeTab === "lai" && <LAIScreen state={state} date={date} me={me} runAction={runAction} />}
            </>
          )}
        </div>
      </div>

      {toast && <div className="fixed bottom-5 right-5 z-20"><Badge tone={toast.tone}>{toast.msg}</Badge></div>}
      {showChangePassword && <ChangePasswordModal onClose={() => setShowChangePassword(false)} />}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* 5a. Principal                                                      */
/* ---------------------------------------------------------------- */
// Background + text pairing per tone — deliberately not built on top of
// Card, since Card hardcodes bg-white/border-slate-200 and mixing that with
// a tone's own background class would leave two conflicting utility
// classes on the same element with no reliable winner.
const STAT_TONES = {
  slate: "bg-white border-slate-200 text-slate-800",
  blue: "bg-blue-50 border-blue-100 text-blue-700",
  emerald: "bg-emerald-50 border-emerald-100 text-emerald-700",
  rose: "bg-rose-50 border-rose-100 text-rose-700",
  amber: "bg-amber-50 border-amber-100 text-amber-700",
};
function Stat({ label, value, tone = "slate" }) {
  const cls = STAT_TONES[tone] || STAT_TONES.slate;
  return (
    <div className={`rounded-2xl border px-4 py-3 shadow-sm ${cls}`}>
      <div className="font-display text-2xl font-bold">{value}</div>
      <div className="text-xs text-slate-500">{label}</div>
    </div>
  );
}
// Bucket thresholds for the Principal hero dashboard's segmented attendance
// bar. Colors reuse the app's existing tone vocabulary (emerald/amber/rose —
// see TONES/STAT_TONES above) rather than inventing a new palette.
function attendanceBucket(pct) {
  if (pct >= 90) return "emerald";
  if (pct >= 75) return "amber";
  return "rose";
}
const BUCKET_ORDER = ["emerald", "amber", "rose"];
const BUCKET_RANGE_LABEL = { emerald: "≥90%", amber: "75-89%", rose: "<75%" };
const BUCKET_BAR_CLASS = { emerald: "bg-emerald-500", amber: "bg-amber-400", rose: "bg-rose-500" };
const BUCKET_DOT_CLASS = { emerald: "bg-emerald-500", amber: "bg-amber-400", rose: "bg-rose-500" };

// Per-class attendance % for one date — presentCount/roster, reusing the
// same "union of wardenAbsences/laiAbsences keys" absentee count
// AttendanceStatusBoard already uses. Away students (Student.awayReason)
// count against the rate like an absence would, but stay out of
// absentCount/the "Absent" label — resolveAbsenceReason's warden/LAI-first
// precedence means a student already in the absentee set is never also
// counted as away here. Classes with no students enrolled are left out
// entirely: there's no percentage to report for an empty roster.
function classAttendanceForDate(state, classesInScope, day) {
  return classesInScope
    .map((c) => {
      const r = day[c.id] || emptyRecord();
      const absentIds = new Set([...Object.keys(r.wardenAbsences || {}), ...Object.keys(r.laiAbsences || {})]);
      const absentCount = absentIds.size;
      const roster = state.students.filter((s) => s.classId === c.id).length;
      if (roster === 0) return null;
      const awayCount = state.students.filter((s) => s.classId === c.id && s.awayReason && !absentIds.has(s.id)).length;
      const presentCount = roster - absentCount - awayCount;
      const pct = (presentCount / roster) * 100;
      return { c, r, absentCount, awayCount, presentCount, roster, pct, bucket: attendanceBucket(pct) };
    })
    .filter(Boolean);
}

// Proportional-width horizontal bar, one segment per bucket, plus a legend
// with counts. `rows` is classAttendanceForDate's output (roster > 0 only).
function SegmentedAttendanceBar({ rows }) {
  const total = rows.length;
  const counts = { emerald: 0, amber: 0, rose: 0 };
  rows.forEach((r) => counts[r.bucket]++);
  return (
    <div>
      <div className="flex h-3 w-full overflow-hidden rounded-full bg-slate-100">
        {BUCKET_ORDER.map((b) => counts[b] > 0 && (
          <div key={b} className={BUCKET_BAR_CLASS[b]} style={{ width: `${(counts[b] / total) * 100}%` }} />
        ))}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-slate-500">
        {BUCKET_ORDER.map((b) => (
          <span key={b} className="flex items-center gap-1.5">
            <span className={`h-2 w-2 rounded-full ${BUCKET_DOT_CLASS[b]}`} />
            {counts[b]} class{counts[b] === 1 ? "" : "es"} <span className="text-slate-400">{BUCKET_RANGE_LABEL[b]}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

// The Principal's home view — a mobile-first "hero" dashboard (institution
// attendance %, trend, segmented class breakdown, and a "needs attention"
// feed), built up over several steps. Deliberately a separate component from
// AttendanceStatusBoard below, which stays in place for the Lecturer's "status"
// tab (a different, floor-scoped, table-based view).
// Institution-wide % across a set of already-computed per-class rows
// (classAttendanceForDate's output) — sum presentCount and roster across
// every class, rather than averaging each class's own %, so a large class
// influences the headline number more than a small one.
function aggregatePct(rows) {
  if (rows.length === 0) return null;
  const totalRoster = rows.reduce((n, r) => n + r.roster, 0);
  const totalPresent = rows.reduce((n, r) => n + r.presentCount, 0);
  if (totalRoster === 0) return null;
  return (totalPresent / totalRoster) * 100;
}

// Same aggregation, but for a comparison day (yesterday) fetched separately
// from GET /attendance — deliberately stricter than classAttendanceForDate
// above: a class with NO record at all for that date is left out of the
// total rather than treated as "0 absent" (emptyRecord()'s convention,
// which every other screen in the app already uses for TODAY's own data).
// Filling in a missing record as a perfect day would be misleading
// specifically for a backing comparison day nobody is actively working on
// — if nothing was marked, there's nothing to compare against, not a 100%.
function aggregatePctFromRecordedOnly(state, classesInScope, day) {
  let totalRoster = 0, totalPresent = 0, classesCounted = 0;
  for (const c of classesInScope) {
    const r = day[c.id];
    if (!r) continue;
    const roster = state.students.filter((s) => s.classId === c.id).length;
    if (roster === 0) continue;
    const absentIds = new Set([...Object.keys(r.wardenAbsences || {}), ...Object.keys(r.laiAbsences || {})]);
    const awayCount = state.students.filter((s) => s.classId === c.id && s.awayReason && !absentIds.has(s.id)).length;
    const presentCount = roster - absentIds.size - awayCount;
    totalRoster += roster;
    totalPresent += presentCount;
    classesCounted++;
  }
  if (classesCounted === 0 || totalRoster === 0) return null;
  return (totalPresent / totalRoster) * 100;
}

// Large numeral + trend arrow. `delta` is in percentage points (today's %
// minus yesterday's), or null if yesterday has no usable data to compare
// against (nothing recorded, or today itself has no classes to report on).
// Mobile-first: numeral and trend stack by default (a narrow phone screen
// is the primary target), and only sit side by side once there's room —
// the reverse of this file's usual "flex-wrap as a fallback" convention,
// which was fine for admin screens built desktop-first but isn't right for
// the first genuinely mobile-first view in the app.
function HeroAttendanceNumber({ pct, delta, loadingTrend }) {
  const rounded = pct == null ? "—" : Math.round(pct);
  const TrendIcon = delta == null ? Minus : delta > 0 ? TrendingUp : delta < 0 ? TrendingDown : Minus;
  const trendTone = delta == null ? "text-slate-400" : delta > 0 ? "text-emerald-600" : delta < 0 ? "text-rose-600" : "text-slate-400";
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
      <div>
        <div className="font-display text-6xl font-bold text-slate-800">{rounded === "—" ? rounded : `${rounded}%`}</div>
        <p className="mt-1 text-xs text-slate-400">Institution-wide, today</p>
      </div>
      <div className={`flex items-center gap-1.5 text-sm font-medium ${trendTone}`}>
        {loadingTrend ? (
          <Loader2 className="animate-spin text-slate-300" size={16} />
        ) : (
          <>
            <TrendIcon size={18} />
            <span>{delta == null ? "No data for yesterday" : `${delta > 0 ? "+" : ""}${delta}% from yesterday`}</span>
          </>
        )}
      </div>
    </div>
  );
}

// How many trailing days to fetch for a streak scan of a given threshold —
// enough margin (3 extra days) beyond the threshold itself that a streak
// right at the line gets its exact length, while one still unbroken at the
// oldest fetched date gets flagged `capped` (see computeAbsenceStreaks)
// rather than silently under-reported. windowStartDate ends up
// `minDays + 2` days before viewDate, an inclusive span of `minDays + 3`
// days — this is the same margin the original 5-day/7-day pair used
// (7 = 5 + 2), just derived instead of hand-picked per threshold.
function streakWindowDays(minDays) {
  return minDays + 2;
}

const LONG_LEAVE_MIN_DAYS = 5; // Principal's institution-wide long-leave threshold
const LONG_LEAVE_WINDOW_DAYS = streakWindowDays(LONG_LEAVE_MIN_DAYS);
const FLOOR_STREAK_MIN_DAYS = 3; // Lecturer's tighter, floor-scoped early-warning threshold
const FLOOR_STREAK_WINDOW_DAYS = streakWindowDays(FLOOR_STREAK_MIN_DAYS);

// A student counts as absent for a class/date when they're absent in
// EVERY session that has a record that day — not "at least one." A
// student absent in only one session (came back after being marked absent,
// or left partway through the day) shouldn't read as a full absent day for
// streak purposes. A date with no record in any session is still
// ambiguous (returns null) — see computeAbsenceStreaks' own comment on why
// that breaks the streak rather than being treated as a skippable gap.
// This generalizes the old MORNING-only shortcut rather than replacing it:
// when only MORNING has a record yet (checking "today" before the
// afternoon session has happened), it reduces to exactly that behavior.
function absentAllDay(dayRecords, studentId) {
  const sessions = Object.keys(dayRecords || {});
  if (sessions.length === 0) return null;
  return sessions.every((s) => {
    const rec = dayRecords[s];
    return !!rec.wardenAbsences?.[studentId] || !!rec.laiAbsences?.[studentId];
  });
}

// Scans a fetched attendance window (GET /attendance's {[date]: {[classId]:
// {[session]: record}}} shape) for students on a `minDays`+ consecutive-day
// absence streak ending at `viewDate` — i.e. currently, actively absent,
// not a past streak that already resolved. Walks backward one calendar day
// at a time; a day with no record in any session for the student's class
// breaks the streak immediately, per this feature's design decision: "no
// record" means nobody marked attendance that day, which is ambiguous, not
// proof of presence, and must never be treated as a skippable gap. Shared
// by the Principal's 5-day institution-wide view and the Lecturer's 3-day
// floor-scoped one — same scan, different threshold and a different slice
// of students the caller passes in (all of them, or just one floor's).
//
// Deliberately scans only wardenAbsences/laiAbsences, never
// Student.awayReason/awaySince — those are a different, disjoint concept: a
// manually-declared, open-ended leave that never generates daily
// AttendanceRecord entries at all (WardenScreen shows "away" students in
// their own banner and never asks a Warden to mark them absent day to day —
// see WardenScreen's `away`/`present` split). A student who's actively
// "away" for 6 days will NOT show up here, since they were never entered
// into any day's absence map. Flagged back to the requester as a gap worth
// a separate, much cheaper alert type (no date range needed — it's already
// on Student) rather than folded into this scan.
//
// Also uses the student's CURRENT classId to look up every historical
// date, since there's no historical class-membership snapshot anywhere in
// this schema (a pre-existing limitation, not new to this function).
function computeAbsenceStreaks(students, viewDate, attendanceWindow, windowStartDate, minDays) {
  const results = [];
  for (const student of students) {
    const absentToday = absentAllDay(attendanceWindow[viewDate]?.[student.classId], student.id);
    if (!absentToday) continue;

    let streak = 0;
    let capped = false;
    let d = viewDate;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const wasAbsent = absentAllDay(attendanceWindow[d]?.[student.classId], student.id);
      if (!wasAbsent) break; // no record, or present — either way breaks the streak
      streak++;
      if (d === windowStartDate) { capped = true; break; } // can't see further back than what was fetched
      d = shiftDateStr(d, -1);
    }

    if (streak >= minDays) results.push({ student, streak, capped });
  }
  return results.sort((a, b) => b.streak - a.streak);
}

// Inclusive day count from awaySince through refDate (the day they left
// counts as day 1). Student.awayReason/awaySince is a live, un-dated
// status with no history of its own (see computeAbsenceStreaks' own
// comment on this) — so this is only meaningful measured against the
// actual current date, never an arbitrary viewDate the Principal might be
// browsing back to.
function daysAway(awaySince, refDate) {
  const diff = Math.round((Date.parse(`${refDate}T00:00:00Z`) - Date.parse(`${awaySince}T00:00:00Z`)) / 86400000);
  return diff + 1;
}

// Per-type icon + tone. Streak severity isn't a separate field — with the
// fetch window fixed at LONG_LEAVE_WINDOW_DAYS (7, i.e. an 8-day span),
// `capped` only ever happens at exactly 8 days, so "8+/capped" and
// "capped === true" are the same condition; no extra threshold needed.
const FEED_ICON = { class: AlertTriangle, streak: Clock, away: Home };
const FEED_TONE_CLASS = {
  rose: "bg-rose-100 text-rose-600",
  amber: "bg-amber-100 text-amber-600",
  blue: "bg-blue-100 text-blue-600",
};

// Combines three attendance-only sources into one flat "needs attention"
// feed — no approval-pipeline items (pending Lecturer approval, etc.),
// per the decision that this view stays attendance-only. Away-student
// alerts only fire once someone's been away 5+ days (the same long-leave
// tier as the absence-streak alerts), so a one-day home visit doesn't
// trigger a notice — and only when actually viewing today, since away
// status has no historical record to browse back to.
function buildAttentionFeed(state, realToday, classRows, longLeaveStreaks, isToday) {
  const items = [];

  longLeaveStreaks.forEach(({ student, streak, capped }) => {
    items.push({
      key: `streak-${student.id}`, type: "streak", tone: capped ? "rose" : "amber",
      text: `${student.name} — ${streak}${capped ? "+" : ""} days absent`,
      subtext: capped ? "Capped at window edge — may be longer than shown" : streak === LONG_LEAVE_MIN_DAYS ? "Just crossed the long-leave threshold" : "Ongoing absence, no gap in the past week",
      classId: student.classId,
    });
  });

  classRows.filter((r) => r.bucket === "rose").sort((a, b) => a.pct - b.pct).forEach((r) => {
    items.push({
      key: `class-${r.c.id}`, type: "class", tone: "rose",
      text: `${r.c.name} at ${Math.round(r.pct)}%`,
      subtext: "Below the 75% attendance threshold",
      classId: r.c.id,
    });
  });

  if (isToday) {
    state.students
      .filter((s) => s.awayReason && daysAway(s.awaySince, realToday) >= LONG_LEAVE_MIN_DAYS)
      .sort((a, b) => daysAway(b.awaySince, realToday) - daysAway(a.awaySince, realToday))
      .forEach((s) => {
        items.push({
          key: `away-${s.id}`, type: "away", tone: "blue",
          text: `${s.name} — ${daysAway(s.awaySince, realToday)} days away (${s.awayReason})`,
          subtext: `On leave since ${formatDMY(s.awaySince)}`,
          classId: s.classId,
        });
      });
  }

  return items;
}

// Every item already carries the classId of the class it's about (a
// student-level streak/away alert is still "about" that student's class),
// so every item is tappable — onSelectClass jumps to that class's
// full-screen detail view.
function AttentionFeed({ items, onSelectClass }) {
  if (items.length === 0) return <EmptyNote text="Nothing needs your attention right now." />;
  return (
    <ul className="space-y-2.5">
      {items.map((item) => {
        const Icon = FEED_ICON[item.type];
        return (
          <li key={item.key}>
            <button
              type="button"
              onClick={() => onSelectClass(item.classId)}
              className="flex w-full items-start gap-3 rounded-lg bg-slate-50 px-3 py-2.5 text-left text-sm text-slate-700 hover:bg-slate-100 active:bg-slate-200"
            >
              <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${FEED_TONE_CLASS[item.tone]}`}><Icon size={15} /></span>
              <span className="min-w-0">
                <span className="block font-medium text-slate-800">{item.text}</span>
                <span className="mt-0.5 block text-xs text-slate-400">{item.subtext}</span>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// "Jump to a class" — filters state.classes by name, live dropdown of up
// to 6 matches; selecting one calls onSelect(classId) and clears the query.
function ClassSearchBox({ classes, onSelect }) {
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const matches = q ? classes.filter((c) => c.name.toLowerCase().includes(q)).slice(0, 6) : [];

  return (
    <div>
      <div className="relative">
        <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Jump to a class..."
          className={`${inputCls} py-2.5 pl-9`}
        />
      </div>
      {q && (
        matches.length > 0 ? (
          <ul className="mt-1.5 divide-y divide-slate-100 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
            {matches.map((c) => (
              <li key={c.id}>
                <button type="button" onClick={() => { onSelect(c.id); setQuery(""); }} className="flex w-full items-center justify-between px-3 py-2 text-left text-sm text-slate-700 hover:bg-slate-50">
                  <span>{c.name}</span>
                  {c.year != null && <span className="text-xs text-slate-400">Year {c.year}</span>}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1.5 text-xs text-slate-400">No classes match "{query}".</p>
        )
      )}
    </div>
  );
}

const STUDENT_HISTORY_DAYS = 7;

// Last STUDENT_HISTORY_DAYS days (oldest to newest, ending at viewDate) as
// {date, status}, status one of "present" | "absent" | "none" — "none"
// means no attendance record at all for this student's class that date,
// kept distinct from both present and absent (not folded into either),
// same ambiguous-gap treatment computeAbsenceStreaks already applies to
// the streak scan. Reads state.attendance directly — already the full,
// unfiltered history (see GET /state) — no fetch needed. Scoped to
// DEFAULT_SESSION (MORNING) — see that constant's comment; a day with only
// an afternoon record shows as "none" here for now.
function studentDayHistory(state, student, viewDate) {
  const days = [];
  for (let i = STUDENT_HISTORY_DAYS - 1; i >= 0; i--) {
    const date = shiftDateStr(viewDate, -i);
    const record = state.attendance[date]?.[student.classId]?.[DEFAULT_SESSION];
    const status = !record ? "none" : (record.wardenAbsences?.[student.id] || record.laiAbsences?.[student.id]) ? "absent" : "present";
    days.push({ date, status });
  }
  return days;
}

// All-time %: present days / days with any record, scanning state.attendance
// in full (through viewDate — a date beyond what's being viewed shouldn't
// count toward "as of now"), the same way. Days with no record for this
// class are excluded from the denominator entirely, not counted as present
// or absent — per the same design decision as the streak scan. Scoped to
// DEFAULT_SESSION (MORNING), same phase-1 simplification as studentDayHistory.
function studentAllTimeStats(state, student, viewDate) {
  let present = 0, withRecord = 0;
  for (const date of Object.keys(state.attendance)) {
    if (date > viewDate) continue;
    const record = state.attendance[date]?.[student.classId]?.[DEFAULT_SESSION];
    if (!record) continue;
    withRecord++;
    if (!(record.wardenAbsences?.[student.id] || record.laiAbsences?.[student.id])) present++;
  }
  return { present, withRecord, pct: withRecord > 0 ? (present / withRecord) * 100 : null };
}

const HISTORY_SQUARE_CLASS = { present: "bg-emerald-500", absent: "bg-rose-500", none: "bg-slate-200" };

// Full-screen (not an in-place expand) single-day roster view for one
// class, reached via the search box or a feed item tap, closed via the
// back button. Deliberately single-day only — no trend, no history, same
// scope boundary as the rest of this dashboard. Reuses
// classAttendanceForDate for the summary row's math (not rebuilt) and the
// existing resolveAbsenceReason helper (also used by AbsenteesView) for
// each student's reason text, rather than inventing a third way to derive
// it.
//
// "Absent" here means the same thing it means for the segmented bar:
// a wardenAbsences/laiAbsences entry for that date. An actively "away"
// student has neither (see computeAbsenceStreaks' comment on why), so
// they're shown in the roster with their own "Away" status rather than
// folded into "Absent" — keeping this screen's summary numbers consistent
// with the dashboard's segmented bar instead of introducing a second,
// slightly different definition of "absent" that would make the two
// disagree on the same class.
function ClassDetailView({ state, classId, viewDate, isToday, onBack }) {
  const cls = state.classes.find((c) => c.id === classId);
  const day = sessionScoped(state.attendance[viewDate]);
  const record = day[classId] || emptyRecord();
  const [row] = classAttendanceForDate(state, cls ? [cls] : [], day);

  // Roster-local search — scoped to this class only, separate from the
  // dashboard's "jump to a class" search. Search only filters/dims the
  // list; it never expands a row on its own (a query like "a" would match
  // both "Aarav" and "Diya", expanding both at once — search and expand
  // are deliberately independent). Expand is a separate tap-to-toggle
  // state, one row at a time, that works whether or not a search is active.
  const [rosterQuery, setRosterQuery] = useState("");
  const rq = rosterQuery.trim().toLowerCase();
  const [expandedStudentId, setExpandedStudentId] = useState(null);

  const roster = state.students
    .filter((s) => s.classId === classId)
    .map((s) => {
      const isAbsent = !!record.wardenAbsences?.[s.id] || !!record.laiAbsences?.[s.id];
      const { reason, isAway } = resolveAbsenceReason(s.id, record, s);
      return { student: s, isAbsent, isAway, reason };
    })
    .sort((a, b) => a.student.roll.localeCompare(b.student.roll));

  return (
    <div className="mx-auto w-full max-w-md sm:max-w-lg">
      <button type="button" onClick={onBack} className="mb-3 flex items-center gap-1.5 text-sm font-medium text-slate-500 hover:text-slate-800">
        <ArrowLeft size={15} /> Back to dashboard
      </button>

      <div className="mb-4">
        <h2 className="font-display text-xl font-semibold text-slate-900">{cls?.name || "Unknown class"}</h2>
        <p className="text-sm text-slate-500">{isToday ? `Today — ${formatDMY(viewDate)}` : `Viewing history for ${formatDMY(viewDate)}`}</p>
      </div>

      {!cls ? (
        <EmptyNote text="This class no longer exists." />
      ) : (
        <>
          <Card className="mb-5 p-5">
            {!row ? (
              <EmptyNote text="No students enrolled in this class." />
            ) : (
              <div className="grid grid-cols-3 gap-3">
                <Stat label="Present" value={row.presentCount} tone="emerald" />
                <Stat label="Absent" value={row.absentCount} tone="rose" />
                <Stat label="Rate" value={`${Math.round(row.pct)}%`} tone={row.bucket} />
              </div>
            )}
            {roster.some((r) => r.isAway) && (
              <p className="mt-3 text-xs text-slate-400">Away students appear in the roster below with their own status, but aren't counted in "Absent" above — that count matches the segmented bar on the dashboard.</p>
            )}
          </Card>

          <Card className="p-5">
            <p className="mb-4 text-sm font-semibold text-slate-700">Roster ({roster.length})</p>
            {roster.length > 0 && (
              <div className="relative mb-3">
                <Search size={15} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  value={rosterQuery}
                  onChange={(e) => setRosterQuery(e.target.value)}
                  placeholder="Search this class by name or roll..."
                  className={`${inputCls} py-2.5 pl-9`}
                />
              </div>
            )}
            {roster.length === 0 ? (
              <EmptyNote text="No students enrolled in this class." />
            ) : (
              <ul className="space-y-2">
                {/* Matches sort to the top (stable, so ties keep roster
                    order) while search is active; clearing the search
                    returns to plain roster order. Dimming stays as-is —
                    only the ordering changes. */}
                {(rq
                  ? [...roster].sort((a, b) => {
                      const aMatch = a.student.name.toLowerCase().includes(rq) || a.student.roll.toLowerCase().includes(rq);
                      const bMatch = b.student.name.toLowerCase().includes(rq) || b.student.roll.toLowerCase().includes(rq);
                      return (bMatch ? 1 : 0) - (aMatch ? 1 : 0);
                    })
                  : roster
                ).map(({ student, isAbsent, isAway, reason }) => {
                  const status = isAway ? { label: "Away", tone: "blue" } : isAbsent ? { label: "Absent", tone: "rose" } : { label: "Present", tone: "emerald" };
                  const matches = !!rq && (student.name.toLowerCase().includes(rq) || student.roll.toLowerCase().includes(rq));
                  const faded = !!rq && !matches;
                  const expanded = expandedStudentId === student.id;
                  const allTime = expanded ? studentAllTimeStats(state, student, viewDate) : null;
                  return (
                    <li key={student.id} className={`rounded-lg bg-slate-50 text-sm transition-opacity ${faded ? "opacity-40" : ""}`}>
                      <button
                        type="button"
                        onClick={() => setExpandedStudentId(expanded ? null : student.id)}
                        className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left hover:bg-slate-100"
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-1.5">
                            <span className="font-medium text-slate-800">{student.name}</span>
                            <span className="text-xs text-slate-400">({student.roll})</span>
                          </div>
                          {(isAbsent || isAway) && reason !== "—" && <p className="mt-0.5 text-xs text-slate-500">{reason}</p>}
                        </div>
                        <div className="flex shrink-0 items-center gap-1.5">
                          <Badge tone="slate">{student.isLocal ? "Day scholar" : "Hosteller"}</Badge>
                          <Badge tone={status.tone}>{status.label}</Badge>
                        </div>
                      </button>
                      {expanded && (
                        <div className="border-t border-slate-200 px-3 pb-2.5 pt-2.5">
                          <div className="flex items-center gap-1">
                            {studentDayHistory(state, student, viewDate).map((d) => (
                              <span key={d.date} title={`${formatDMY(d.date)}: ${d.status}`} className={`h-3.5 w-3.5 shrink-0 rounded-sm ${HISTORY_SQUARE_CLASS[d.status]}`} />
                            ))}
                            <span className="ml-1 text-[10px] text-slate-400">last {STUDENT_HISTORY_DAYS} days</span>
                          </div>
                          <p className="mt-1.5 text-xs text-slate-500">
                            {allTime.withRecord > 0 ? `${Math.round(allTime.pct)}% all-time (${allTime.present}/${allTime.withRecord} days with a record)` : "No attendance history yet"}
                          </p>
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

function PrincipalHeroDashboard({ state, date }) {
  const [viewDate, setViewDate] = useState(date);
  const [selectedClassId, setSelectedClassId] = useState(null);
  const day = sessionScoped(state.attendance[viewDate]);
  const classRows = classAttendanceForDate(state, state.classes, day);
  const isToday = viewDate === date;
  const todayPct = aggregatePct(classRows);

  // One fetch covers both the trend arrow (needs yesterday) and the
  // long-leave scan (needs a trailing week) — the streak window already
  // contains the trend's single comparison day, so there's no reason to
  // make two round trips for two overlapping date ranges.
  const compareDate = shiftDateStr(viewDate, -1);
  const windowStartDate = shiftDateStr(viewDate, -LONG_LEAVE_WINDOW_DAYS);
  const [rangeData, setRangeData] = useState({ loading: true, data: {} });

  useEffect(() => {
    let cancelled = false;
    setRangeData({ loading: true, data: {} });
    api.getAttendanceRange(windowStartDate, viewDate)
      .then((resp) => { if (!cancelled) setRangeData({ loading: false, data: resp.attendance || {} }); })
      .catch(() => { if (!cancelled) setRangeData({ loading: false, data: {} }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowStartDate, viewDate]);

  const compareDay = sessionScoped(rangeData.data[compareDate]);
  const compareHasData = Object.keys(compareDay).length > 0;
  const yesterdayPct = compareHasData ? aggregatePctFromRecordedOnly(state, state.classes, compareDay) : null;
  const delta = todayPct != null && yesterdayPct != null ? Math.round(todayPct) - Math.round(yesterdayPct) : null;

  const longLeaveStreaks = rangeData.loading ? [] : computeAbsenceStreaks(state.students, viewDate, rangeData.data, windowStartDate, LONG_LEAVE_MIN_DAYS);
  const feedItems = buildAttentionFeed(state, date, classRows, longLeaveStreaks, isToday);

  if (selectedClassId) {
    return (
      <ClassDetailView
        state={state}
        classId={selectedClassId}
        viewDate={viewDate}
        isToday={isToday}
        onBack={() => setSelectedClassId(null)}
      />
    );
  }

  return (
    // Capped width, not full-bleed: on a narrow phone this simply fills the
    // screen as normal, but on a wider viewport it stays a single
    // phone-proportioned column instead of stretching a giant numeral and
    // a lot of empty space across a desktop-width content area — this view
    // is designed for mobile first, not adapted from a desktop layout.
    <div className="mx-auto w-full max-w-md sm:max-w-lg">
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <SectionTitle icon={LayoutDashboard} title="Attendance" subtitle={isToday ? `Today — ${formatDMY(viewDate)}` : `Viewing history for ${formatDMY(viewDate)}`} />
        <Field label="Date"><input type="date" max={date} className={`${inputCls} py-2.5 sm:w-auto`} value={viewDate} onChange={(e) => setViewDate(e.target.value)} /></Field>
      </div>

      <Card className="mb-5 p-5">
        <HeroAttendanceNumber pct={todayPct} delta={delta} loadingTrend={rangeData.loading} />
      </Card>

      <Card className="mb-5 p-5">
        <p className="mb-4 text-sm font-semibold text-slate-700">Classes by attendance</p>
        <div className="mb-4">
          <ClassSearchBox classes={state.classes} onSelect={setSelectedClassId} />
        </div>
        {classRows.length === 0 ? (
          <EmptyNote text="No classes with students yet." />
        ) : (
          <SegmentedAttendanceBar rows={classRows} />
        )}
      </Card>

      <Card className="p-5">
        <div className="mb-4 flex items-center gap-2">
          <p className="text-sm font-semibold text-slate-700">Needs your attention</p>
          {feedItems.length > 0 && <Badge tone="rose">{feedItems.length}</Badge>}
        </div>
        {rangeData.loading ? <p className="text-xs text-slate-400">Loading...</p> : <AttentionFeed items={feedItems} onSelectClass={setSelectedClassId} />}
      </Card>
    </div>
  );
}

function AttendanceStatusBoard({ state, date, scopeFloorIds, title, subtitle }) {
  const [viewDate, setViewDate] = useState(date);
  const [session, setSession] = useState(DEFAULT_SESSION);
  const day = sessionScoped(state.attendance[viewDate], session);
  const classesInScope = scopeFloorIds ? state.classes.filter((c) => scopeFloorIds.includes(c.collegeFloorId)) : state.classes;
  const rows = classesInScope.map((c) => ({ c, r: day[c.id] || emptyRecord() }));
  const published = rows.filter((x) => currentStageIndex(x.r) === STAGES.length || x.r.forcedPublish).length;
  const verified = rows.filter((x) => currentStageIndex(x.r) === STAGES.length).length;
  const autoPassed = rows.filter((x) => x.r.forcedPublish && currentStageIndex(x.r) < STAGES.length).length;

  // Floor-scoped early-warning streak watch, tighter threshold than the
  // Principal's institution-wide 5-day one (PrincipalHeroDashboard) — only
  // for a Lecturer's own floor (scopeFloorIds present). Coordinator's
  // unscoped rendering of this same component skips it; the Principal's
  // own 5-day view already covers institution-wide ground at a coarser bar.
  const floorStreakWindowStart = shiftDateStr(viewDate, -FLOOR_STREAK_WINDOW_DAYS);
  const [floorStreakData, setFloorStreakData] = useState({ loading: true, data: {} });
  useEffect(() => {
    if (!scopeFloorIds) return;
    let cancelled = false;
    setFloorStreakData({ loading: true, data: {} });
    api.getAttendanceRange(floorStreakWindowStart, viewDate)
      .then((resp) => { if (!cancelled) setFloorStreakData({ loading: false, data: resp.attendance || {} }); })
      .catch(() => { if (!cancelled) setFloorStreakData({ loading: false, data: {} }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scopeFloorIds, floorStreakWindowStart, viewDate]);
  const floorStreaks = !scopeFloorIds || floorStreakData.loading
    ? []
    : computeAbsenceStreaks(
        state.students.filter((s) => classesInScope.some((c) => c.id === s.classId)),
        viewDate, floorStreakData.data, floorStreakWindowStart, FLOOR_STREAK_MIN_DAYS,
      );

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <SectionTitle icon={LayoutDashboard} title={title} subtitle={subtitle} />
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Date"><input type="date" max={date} className={inputCls} value={viewDate} onChange={(e) => setViewDate(e.target.value)} /></Field>
        </div>
      </div>
      <div className="mb-4 inline-flex rounded-lg border border-slate-300 bg-white p-0.5">
        {SESSION_TABS.map((s) => (
          <button key={s.key} onClick={() => setSession(s.key)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${session === s.key ? "bg-[#12324D] text-white" : "text-slate-600 hover:bg-slate-100"}`}>
            {s.label}
          </button>
        ))}
      </div>
      <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Classes" value={rows.length} />
        <Stat label="Published" value={published} tone="blue" />
        <Stat label="Verified" value={verified} tone="emerald" />
        <Stat label="Auto-passed" value={autoPassed} tone={autoPassed > 0 ? "rose" : "slate"} />
      </div>
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr><th className="px-4 py-2.5">Class</th><th className="px-4 py-2.5">Absent</th><th className="px-4 py-2.5">Status</th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map(({ c, r }) => {
              const absentCount = new Set([...Object.keys(r.wardenAbsences || {}), ...Object.keys(r.laiAbsences || {})]).size;
              const status = classroomStatus(r);
              return (
                <tr key={c.id}>
                  <td className="px-4 py-2.5 font-medium text-slate-800">{c.name}</td>
                  <td className="px-4 py-2.5 text-slate-600">{absentCount}</td>
                  <td className="px-4 py-2.5"><Badge tone={status.tone}>{status.label}</Badge></td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-10 text-center text-slate-400">
                  <CalendarSearch className="mx-auto mb-2" size={28} />
                  <div>No classes in this scope yet.</div>
                  <div className="mt-1 text-xs">Try a different date, or check back after a Lecturer publishes it.</div>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </Card>
      {scopeFloorIds && (
        <Card className="mt-5 p-4">
          <p className="mb-3 text-sm font-semibold text-slate-700">Long-leave watch (3+ days)</p>
          {floorStreakData.loading ? (
            <p className="text-xs text-slate-400">Loading...</p>
          ) : floorStreaks.length === 0 ? (
            <EmptyNote text="Nobody on your floor has an ongoing 3+ day absence streak." />
          ) : (
            <ul className="space-y-1.5">
              {floorStreaks.map(({ student, streak, capped }) => (
                <li key={student.id} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-sm">
                  <span className="text-slate-700">{student.name} <span className="text-xs text-slate-400">({student.roll})</span></span>
                  <Badge tone={capped ? "rose" : "amber"}>{streak}{capped ? "+" : ""} days absent</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
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
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const existing = state.staff.filter((s) => ["AO", "COORDINATOR", "DB_MANAGER"].includes(s.role));
  const activeCount = existing.filter((s) => s.status === "ACTIVE").length;
  const q = query.trim().toLowerCase();
  const filtered = q ? existing.filter((s) => s.name.toLowerCase().includes(q) || ROLE_LABELS[s.role].toLowerCase().includes(q)) : existing;
  const lifecycle = useAccountLifecycle(runAction);

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const result = await runAction(() => api.createLeadership(name.trim(), role), "Account created");
    setBusy(false);
    if (result) { setJustCreated(result); setName(""); }
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <SectionTitle icon={UserPlus} title="Leadership accounts" subtitle="Create the AO, Coordinator, and Database Manager accounts. Each gets its own temp password, shown once, and must set their own on first login." />
        <Badge tone="slate">{existing.length} account{existing.length === 1 ? "" : "s"}, {activeCount} active</Badge>
      </div>
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
          <div className="flex items-end"><Btn onClick={submit} disabled={busy}>{busy ? <Loader2 className="animate-spin" size={14} /> : <Plus size={14} />} Create account</Btn></div>
        </div>
      </Card>
      {justCreated && (
        <Card className="mb-6 border-emerald-200 bg-emerald-50 p-4">
          <p className="text-sm text-emerald-800">
            Created <span className="font-medium">{justCreated.user.name}</span> ({ROLE_LABELS[justCreated.user.role]}) —
            login key <span className="font-display font-semibold">{justCreated.loginKey}</span>, password <span className="font-display font-semibold">{justCreated.password}</span>.
            Hand these to them now — this is the only time the password is shown.
          </p>
        </Card>
      )}
      <AccountLifecycleBanners
        resetResult={lifecycle.resetResult}
        onDismissReset={() => lifecycle.setResetResult(null)}
        offboardResult={lifecycle.offboardResult}
        onDismissOffboard={() => lifecycle.setOffboardResult(null)}
      />
      <SearchBox value={query} onChange={setQuery} placeholder="Search by name or role..." />

      {/* Table on md+ screens, one stacked card per account below that —
          a table's columns get too cramped to be usable on a phone. */}
      <Card className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr><th className="px-4 py-2.5">Name</th><th className="px-4 py-2.5">Role</th><th className="px-4 py-2.5">Key</th><th className="px-4 py-2.5">Status</th><th className="px-4 py-2.5"></th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filtered.map((s) => (
              <tr key={s.id}>
                <td className="px-4 py-2.5 font-medium text-slate-800">{s.name}</td>
                <td className="px-4 py-2.5 text-slate-600">{ROLE_LABELS[s.role]}</td>
                <td className="px-4 py-2.5 text-slate-600 font-display">{s.loginKey}</td>
                <td className="px-4 py-2.5"><Badge tone={s.status === "ACTIVE" ? "emerald" : "rose"}>{s.status === "ACTIVE" ? "Active" : "Frozen"}</Badge></td>
                <td className="px-4 py-2.5">
                  <AccountActions s={s} runAction={runAction} showResetPassword showOffboard onResetPassword={lifecycle.resetPassword} onOffboard={lifecycle.setOffboarding} layout="row" />
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-6 text-center text-slate-400">{existing.length === 0 ? "No leadership accounts yet." : "No accounts match your search."}</td></tr>
            )}
          </tbody>
        </table>
      </Card>

      <div className="space-y-3 md:hidden">
        {filtered.map((s) => (
          <Card key={s.id} className="p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-medium text-slate-800">{s.name}</div>
                <div className="text-xs text-slate-500">{ROLE_LABELS[s.role]}</div>
              </div>
              <Badge tone={s.status === "ACTIVE" ? "emerald" : "rose"}>{s.status === "ACTIVE" ? "Active" : "Frozen"}</Badge>
            </div>
            <div className="mt-3 flex items-center justify-between text-sm text-slate-500">
              <span>Key: <span className="font-display">{s.loginKey}</span></span>
            </div>
            <div className="mt-3">
              <AccountActions s={s} runAction={runAction} showResetPassword showOffboard onResetPassword={lifecycle.resetPassword} onOffboard={lifecycle.setOffboarding} layout="stack" />
            </div>
          </Card>
        ))}
        {filtered.length === 0 && (
          <EmptyNote text={existing.length === 0 ? "No leadership accounts yet." : "No accounts match your search."} />
        )}
      </div>

      {lifecycle.offboarding && (
        <OffboardModal
          target={lifecycle.offboarding}
          candidates={existing.filter((a) => a.role === lifecycle.offboarding.role && a.id !== lifecycle.offboarding.id && a.status === "ACTIVE")}
          runAction={runAction}
          onClose={() => lifecycle.setOffboarding(null)}
          onDone={lifecycle.handleOffboardDone}
        />
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* 5b. AO                                                              */
/* ---------------------------------------------------------------- */
// Best-effort "where does this live" breadcrumb for a single-item pending
// change — e.g. add_room -> ["Boys Hostel A", "Ground Floor"], rendered as
// "→ Boys Hostel A → Ground Floor" next to the change's summary. Only the
// types with a real parent chain return anything; top-level creates
// (add_hostel, create_staff, ...) and structure_batch (which gets its own
// full tree — see StructureBatchTree) return an empty array.
function pendingChangeParentPath(state, c) {
  const p = c.payload || {};
  const hostelName = (id) => state.hostels.find((h) => h.id === id)?.name;
  switch (c.type) {
    case "add_hostel_floor":
      return [hostelName(p.hostelId)].filter(Boolean);
    case "add_room": {
      const floor = state.hostelFloors.find((f) => f.id === p.hostelFloorId);
      return [floor && hostelName(floor.hostelId), floor?.name].filter(Boolean);
    }
    case "add_class":
      return [state.collegeFloors.find((f) => f.id === p.collegeFloorId)?.name].filter(Boolean);
    case "assign_warden":
    case "assign_do":
    case "assign_teacher":
    case "assign_lai":
      return [state.staff.find((s) => s.id === p.staffId)?.name].filter(Boolean);
    case "add_student": {
      const cls = state.classes.find((cl) => cl.id === p.classId);
      const parts = [cls?.name];
      const room = p.roomId && state.hostelRooms.find((r) => r.id === p.roomId);
      const floor = room && state.hostelFloors.find((f) => f.id === room.hostelFloorId);
      if (floor) parts.push(hostelName(floor.hostelId), floor.name, room.roomNo);
      return parts.filter(Boolean);
    }
    case "edit_student":
    case "delete_student": {
      const student = state.students.find((s) => s.id === p.studentId);
      const cls = student && state.classes.find((cl) => cl.id === student.classId);
      return [cls?.name].filter(Boolean);
    }
    default:
      return [];
  }
}
function ParentPath({ state, change }) {
  const path = pendingChangeParentPath(state, change);
  if (path.length === 0) return null;
  return <p className="mt-0.5 text-xs text-slate-400">→ {path.join(" → ")}</p>;
}

// Read-only tree view of a structure_batch payload — the same shape
// StructureAdmin's builder produces, rendered flat for the AO to review.
// Existing parents (referenced by id, not created) are muted with an
// "existing" tag, same convention as the builder itself.
function StructureBatchTree({ payload }) {
  return (
    <div className="mt-2 space-y-2 rounded-lg border border-slate-100 bg-slate-50/60 p-3 text-sm">
      {(payload.hostels || []).map((h, i) => (
        <div key={`h${i}`}>
          <div className="flex items-center gap-2 font-medium text-slate-700">
            {h.name || "(unnamed hostel)"} {h.existingHostelId && <Badge tone="slate">existing</Badge>}
          </div>
          {(h.floors || []).length > 0 && (
            <div className="ml-4 mt-1 space-y-1 border-l border-slate-200 pl-3">
              {h.floors.map((f, j) => (
                <div key={`f${j}`}>
                  <div className="flex items-center gap-2 text-slate-600">
                    {f.name || "(unnamed floor)"} {f.existingFloorId && <Badge tone="slate">existing</Badge>}
                  </div>
                  {f.rooms?.length > 0 && <div className="text-xs text-slate-500">Rooms: {f.rooms.join(", ")}</div>}
                </div>
              ))}
            </div>
          )}
        </div>
      ))}
      {(payload.collegeFloors || []).map((cf, i) => (
        <div key={`cf${i}`}>
          <div className="flex items-center gap-2 font-medium text-slate-700">
            {cf.name || "(unnamed college floor)"} {cf.existingCollegeFloorId && <Badge tone="slate">existing</Badge>}
          </div>
          {cf.classrooms?.length > 0 && (
            <div className="ml-4 mt-1 text-xs text-slate-500">
              Classes: {cf.classrooms.map((c) => (typeof c === "string" ? c : c.year ? `${c.name} (Year ${c.year})` : c.name)).join(", ")}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// A compact "Hostel / 001" label for one payload student's room —
// deliberately shorter than roomLabel() (which also includes the floor
// name), since this is used inline next to a roll+name on an approval card,
// not as a standalone lookup line. Path strings stay number-only (no "Room "
// prefix) — a bare room number reads fine once it's already inside a
// hostel/floor path.
function studentHostelRoomLabel(state, roomId) {
  const room = state.hostelRooms.find((r) => r.id === roomId);
  if (!room) return null;
  const floor = state.hostelFloors.find((f) => f.id === room.hostelFloorId);
  const hostel = floor && state.hostels.find((h) => h.id === floor.hostelId);
  return `${hostel?.name || "?"} / ${room.roomNo}`;
}
// One line of {roll, name, classId, roomId, isLocal} — the shape both
// add_student's payload and each entry of bulk_add_students' payload.students
// already have. `showClass` is only turned on for add_student (a single
// card with no other line naming the class); bulk_add_students already
// states its class in the change's own summary line, so repeating it per
// row there would be noise.
function StudentAddDetail({ state, s, showClass }) {
  const cls = showClass ? state.classes.find((c) => c.id === s.classId) : null;
  const hostelRoom = !s.isLocal ? studentHostelRoomLabel(state, s.roomId) : null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
      <span className="font-display text-slate-500">{s.roll}</span>
      <span className="font-medium text-slate-800">{s.name}</span>
      {cls && <span className="text-slate-500">{cls.name}</span>}
      {s.isLocal ? <Badge tone="amber">Day scholar</Badge> : <span className="text-slate-500">{hostelRoom || "Room not set"}</span>}
    </div>
  );
}

// The 2-day recency rule itself (isAlwaysVisibleDecision) lives in
// recency.js, imported above — pulled out of this file so it's directly
// testable from a plain Node script without a JSX-aware loader, the same
// reasoning as structureBatch.js and excel.js's validateImportRows.
// A small "Show N older decisions" toggle shared by both lists below.
function ShowOlderToggle({ olderCount, shown, onShow }) {
  if (shown || olderCount === 0) return null;
  return (
    <button onClick={onShow} className="mt-2 text-xs font-medium text-slate-500 underline underline-offset-2 hover:text-slate-700">
      Show {pluralize(olderCount, "older decision")}
    </button>
  );
}

// Approve / Reject / Send back for one pending card, with a busy state
// scoped to that card: whichever button was clicked shows a spinner, its
// siblings on the SAME card just gray out (no spinner) — other cards stay
// fully interactable. Also blocks double-click as a duplicate-creation
// vector, since the clicked button disables itself the instant it's clicked.
// `busy` is { id, action } | null, shared across every card by AOApprovals
// (only one action can plausibly be in flight from one person clicking).
function ApprovalActions({ c, busy, onApprove, onReject, onSendBack, approveLabel }) {
  const cardBusy = busy?.id === c.id;
  const isApproving = cardBusy && busy.action === "approve";
  const isRejecting = cardBusy && busy.action === "reject";
  const isSendingBack = cardBusy && busy.action === "sendback";
  return (
    <>
      {onSendBack && <SendBackButton onSend={(reason) => onSendBack(c, reason)} busy={isSendingBack} disabled={cardBusy && !isSendingBack} />}
      <div className="flex gap-2">
        <Btn size="sm" variant="success" disabled={cardBusy} onClick={() => onApprove(c)}>
          {isApproving ? <Loader2 className="animate-spin" size={13} /> : <Check size={13} />} {isApproving ? "..." : approveLabel || "Approve"}
        </Btn>
        {onReject && (
          <Btn size="sm" variant="danger" disabled={cardBusy} onClick={() => onReject(c)}>
            {isRejecting ? <Loader2 className="animate-spin" size={13} /> : <X size={13} />} {isRejecting ? "..." : "Reject"}
          </Btn>
        )}
      </div>
    </>
  );
}

// One row of a sync_class_students change's "Edited" section — {studentId,
// roll, name, changes: {field: {old, new}}} from routes/excel.js's
// diffAndValidateRoster. `changes` only ever holds the fields that actually
// differ (name / hostelOrDay / room), each already resolved to display
// strings server-side.
function SyncEditDetail({ e }) {
  return (
    <div>
      <div><span className="font-display text-slate-500">{e.roll}</span> <span className="font-medium text-slate-800">{e.name}</span></div>
      <div className="ml-4 mt-0.5 space-y-0.5 text-xs">
        {Object.entries(e.changes).map(([field, { old, new: next }]) => (
          <div key={field} className="text-slate-500">{field}: <span className="text-slate-400 line-through">{old}</span> → <span className="font-medium text-slate-700">{next}</span></div>
        ))}
      </div>
    </div>
  );
}

function AOApprovals({ state, runAction }) {
  const pending = state.pendingChanges.filter((c) => c.status === "pending");
  // Only ever set for an approved create_staff change — that's the only
  // type whose approval generates a temp password (see applyChange.js). The
  // Database Manager already saw the loginKey at proposal time; this is the
  // one moment the password itself exists in plaintext, so it's shown once
  // here to whichever AO clicked approve, then gone.
  const [newStaffPassword, setNewStaffPassword] = useState(null); // { name, password }
  const [showOlderDecisions, setShowOlderDecisions] = useState(false);
  // { id, action } | null — which pending change's Approve/Reject/Send back
  // is currently in flight; see ApprovalActions above for how this both
  // shows a spinner on the clicked button and blocks a double-click.
  const [busy, setBusy] = useState(null);
  const withBusy = async (id, action, fn) => {
    setBusy({ id, action });
    try { return await fn(); } finally { setBusy(null); }
  };

  const approve = (c) => withBusy(c.id, "approve", async () => {
    const result = await runAction(() => api.approveChange(c.id), "Approved");
    if (result?.password) setNewStaffPassword({ name: c.payload?.name || "the new account", password: result.password });
  });
  const reject = (c) => withBusy(c.id, "reject", () => runAction(() => api.rejectChange(c.id, "Not approved"), "Rejected"));
  const sendBackBatch = (c, reason) => withBusy(c.id, "sendback", () => runAction(() => api.sendBackStructureBatch(c.id, reason), "Sent back for edits"));
  const sendBackStudentChange = (c, reason) => withBusy(c.id, "sendback", () => runAction(() => api.sendBackChange(c.id, reason), "Sent back for edits"));

  const decisionTone = (status) => (status === "approved" ? "emerald" : status === "sent_back" ? "amber" : "rose");

  const decided = state.pendingChanges.filter((c) => c.status !== "pending");
  const visibleDecided = showOlderDecisions ? decided : decided.filter(isAlwaysVisibleDecision);

  return (
    <div>
      <SectionTitle icon={ShieldCheck} title="Master data approvals" subtitle="Every Database Manager change — including new staff accounts and structure batches — is applied only after your approval." />
      {newStaffPassword && (
        <Card className="mb-6 border-amber-200 bg-amber-50 p-4">
          <div className="flex items-start justify-between gap-3">
            <p className="text-sm text-amber-800">
              Temp password for <span className="font-medium">{newStaffPassword.name}</span>: <span className="font-display font-semibold">{newStaffPassword.password}</span> —
              share this securely, along with the login key the Database Manager already has. This is the only time it will be shown — write it down now.
            </p>
            <button onClick={() => setNewStaffPassword(null)} className="mt-0.5 shrink-0 text-amber-400 hover:text-amber-600" aria-label="Dismiss">
              <X size={16} />
            </button>
          </div>
        </Card>
      )}
      {pending.length === 0 && <EmptyNote text="No pending changes right now." />}
      <div className="space-y-3">
        {pending.map((c) => {
          if (c.type === "structure_batch") {
            const counts = structureBatchCounts(c.payload);
            return (
              <Card key={c.id} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="mb-1"><Badge tone="blue">Structure batch</Badge></div>
                    <div className="font-medium text-slate-800">New hostel structure — {c.summary}</div>
                    <div className="mt-0.5 text-xs text-slate-500">Requested by {state.staff.find((s) => s.id === c.requestedById)?.name || "someone"} · {formatDMY(c.createdAt)} {formatTime(c.createdAt)}</div>
                  </div>
                </div>
                <StructureBatchTree payload={c.payload} />
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <ApprovalActions c={c} busy={busy} onApprove={approve} onSendBack={sendBackBatch} approveLabel={`Approve all — create ${pluralize(counts.total, "record")}`} />
                </div>
              </Card>
            );
          }
          if (c.type === "bulk_add_students") {
            return (
              <Card key={c.id} className="p-4">
                <Collapsible header={<span className="font-medium text-slate-800">{c.summary}</span>}>
                  <div className="space-y-1.5 border-l-2 border-slate-100 pl-3">
                    {c.payload.students.map((s, i) => <StudentAddDetail key={i} state={state} s={s} />)}
                  </div>
                </Collapsible>
                <div className="mt-1 text-xs text-slate-500">Requested {formatDMY(c.createdAt)} {formatTime(c.createdAt)}</div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <ApprovalActions c={c} busy={busy} onApprove={approve} onReject={reject} onSendBack={sendBackStudentChange} />
                </div>
              </Card>
            );
          }
          if (c.type === "add_student") {
            return (
              <Card key={c.id} className="p-4">
                <div className="font-medium text-slate-800">{c.summary}</div>
                <div className="mt-1"><StudentAddDetail state={state} s={c.payload} showClass /></div>
                <div className="mt-1 text-xs text-slate-500">Requested {formatDMY(c.createdAt)} {formatTime(c.createdAt)}</div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <ApprovalActions c={c} busy={busy} onApprove={approve} onReject={reject} onSendBack={sendBackStudentChange} />
                </div>
              </Card>
            );
          }
          if (c.type === "move_student") {
            const p = c.payload;
            return (
              <Card key={c.id} className="p-4">
                <div className="mb-1"><Badge tone="blue">Move student</Badge></div>
                <div className="font-medium text-slate-800">{c.summary}</div>
                {(p.placeAfterStudentId || p.placeAtEnd) && (
                  <div className="mt-1 text-xs text-slate-500">
                    Position: {p.placeAtEnd ? "moved to the end of the destination class" : `placed after ${state.students.find((s) => s.id === p.placeAfterStudentId)?.name || "another student"}`}
                  </div>
                )}
                <div className="mt-1 text-xs text-slate-500">Requested {formatDMY(c.createdAt)} {formatTime(c.createdAt)}</div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <ApprovalActions c={c} busy={busy} onApprove={approve} onReject={reject} onSendBack={sendBackStudentChange} />
                </div>
              </Card>
            );
          }
          if (c.type === "move_students_batch") {
            const p = c.payload;
            const destClassName = state.classes.find((cl) => cl.id === p.newClassId)?.name || "?";
            return (
              <Card key={c.id} className="p-4">
                <div className="mb-1"><Badge tone="blue">Batch move</Badge></div>
                <Collapsible header={<span className="font-medium text-slate-800">{c.summary}</span>}>
                  <div className="space-y-1 border-l-2 border-slate-100 pl-3 text-sm">
                    {p.moves.map((m) => (
                      <div key={m.studentId}>
                        <span className="font-display text-slate-500">{m.roll}</span> <span className="font-medium text-slate-800">{m.name}</span>{" "}
                        <span className="text-slate-400">— {state.classes.find((cl) => cl.id === m.oldClassId)?.name || "?"} → {destClassName}</span>
                      </div>
                    ))}
                  </div>
                </Collapsible>
                <div className="mt-1 text-xs text-slate-500">Requested {formatDMY(c.createdAt)} {formatTime(c.createdAt)}</div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <ApprovalActions c={c} busy={busy} onApprove={approve} onReject={reject} onSendBack={sendBackStudentChange} />
                </div>
              </Card>
            );
          }
          if (c.type === "sync_class_students") {
            const p = c.payload;
            return (
              <Card key={c.id} className="p-4">
                <div className="mb-1 flex flex-wrap gap-2">
                  <Badge tone="blue">Roster sync</Badge>
                  {p.removals.length > 0 && <Badge tone="rose">Includes removals</Badge>}
                </div>
                <Collapsible header={<span className="font-medium text-slate-800">{c.summary}</span>}>
                  <div className="space-y-3 border-l-2 border-slate-100 pl-3">
                    {p.adds.length > 0 && (
                      <div>
                        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-emerald-600">Added ({p.adds.length})</p>
                        <div className="space-y-1.5">{p.adds.map((s, i) => <StudentAddDetail key={i} state={state} s={s} />)}</div>
                      </div>
                    )}
                    {p.removals.length > 0 && (
                      <div>
                        <p className="mb-1 flex items-center gap-1 text-xs font-semibold uppercase tracking-wide text-rose-600"><AlertTriangle size={12} /> Removed ({p.removals.length})</p>
                        <div className="space-y-1 text-sm">
                          {p.removals.map((r) => (
                            <div key={r.studentId} className="flex items-center gap-2 text-rose-700">
                              <span className="font-display">{r.roll}</span><span>{r.name}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    {p.edits.length > 0 && (
                      <div>
                        <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-amber-600">Edited ({p.edits.length})</p>
                        <div className="space-y-2 text-sm">{p.edits.map((e) => <SyncEditDetail key={e.studentId} e={e} />)}</div>
                      </div>
                    )}
                    {p.orderChanged && <p className="text-xs italic text-slate-500">Order updated to match the sheet.</p>}
                  </div>
                </Collapsible>
                <div className="mt-1 text-xs text-slate-500">Requested {formatDMY(c.createdAt)} {formatTime(c.createdAt)}</div>
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <ApprovalActions c={c} busy={busy} onApprove={approve} onReject={reject} onSendBack={sendBackStudentChange} />
                </div>
              </Card>
            );
          }
          return (
            <Card key={c.id} className="p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <div className="font-medium text-slate-800">{c.summary}</div>
                  <ParentPath state={state} change={c} />
                  <div className="mt-0.5 text-xs text-slate-500">
                    Requested {formatDMY(c.createdAt)} {formatTime(c.createdAt)}
                    {c.type === "create_staff" && c.payload?.loginKey && <> · assigned key <span className="font-display">{c.payload.loginKey}</span></>}
                  </div>
                </div>
                <ApprovalActions c={c} busy={busy} onApprove={approve} onReject={reject} />
              </div>
            </Card>
          );
        })}
      </div>
      <div className="mt-8">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Recent decisions</p>
        <div className="space-y-2">
          {visibleDecided.map((c) => (
            <div key={c.id} className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
              <span className="text-slate-600">{c.type === "structure_batch" ? `Structure batch — ${c.summary}` : c.summary}</span>
              <Badge tone={decisionTone(c.status)}>{c.status.replace("_", " ")}</Badge>
            </div>
          ))}
          {visibleDecided.length === 0 && <p className="text-sm text-slate-400">Nothing yet.</p>}
        </div>
        <ShowOlderToggle olderCount={decided.length - visibleDecided.length} shown={showOlderDecisions} onShow={() => setShowOlderDecisions(true)} />
      </div>
    </div>
  );
}

function AOFreezeAccounts({ state, runAction, me }) {
  const staff = state.staff.filter((s) => s.role !== "PRINCIPAL" && s.id !== me.id);
  const lifecycle = useAccountLifecycle(runAction);
  return (
    <div>
      <SectionTitle icon={Snowflake} title="Freeze / unfreeze accounts" subtitle="Freezing pauses an account immediately — they can't log in again until you unfreeze them. Past work stays untouched." />
      <AccountLifecycleBanners
        resetResult={lifecycle.resetResult}
        onDismissReset={() => lifecycle.setResetResult(null)}
        offboardResult={lifecycle.offboardResult}
        onDismissOffboard={() => lifecycle.setOffboardResult(null)}
      />
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr><th className="px-4 py-2.5">Name</th><th className="px-4 py-2.5">Role</th><th className="px-4 py-2.5">Status</th><th className="px-4 py-2.5"></th></tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {staff.map((s) => {
              // Reset password and Offboard are only backed by the server
              // for leadership roles (AO/Coordinator/DB Manager) — field
              // staff rows keep just Freeze/Unfreeze.
              const isLeadership = LEADERSHIP_ROLES.includes(s.role);
              return (
                <tr key={s.id}>
                  <td className="px-4 py-2.5 font-medium text-slate-800">{s.name}</td>
                  <td className="px-4 py-2.5 text-slate-600">{ROLE_LABELS[s.role]}</td>
                  <td className="px-4 py-2.5"><Badge tone={s.status === "ACTIVE" ? "emerald" : s.status === "FROZEN" ? "rose" : "amber"}>{s.status}</Badge></td>
                  <td className="px-4 py-2.5">
                    <AccountActions
                      s={s}
                      runAction={runAction}
                      showResetPassword={isLeadership}
                      showOffboard={isLeadership}
                      onResetPassword={lifecycle.resetPassword}
                      onOffboard={lifecycle.setOffboarding}
                      layout="row"
                    />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      {lifecycle.offboarding && (
        <OffboardModal
          target={lifecycle.offboarding}
          candidates={state.staff.filter((a) => a.role === lifecycle.offboarding.role && a.id !== lifecycle.offboarding.id && a.status === "ACTIVE")}
          runAction={runAction}
          onClose={() => lifecycle.setOffboarding(null)}
          onDone={lifecycle.handleOffboardDone}
        />
      )}
    </div>
  );
}

function AOHierarchyStatus({ state }) {
  const byRole = (role) => state.staff.filter((s) => s.role === role);
  const wardens = byRole("WARDEN"), dos = byRole("DO"), teachers = byRole("LECTURER"), lais = byRole("LAI");

  const hostelFloorsWithoutWarden = state.hostelFloors.filter((f) => !wardens.some((w) => (w.floorIds || []).includes(f.id)));
  const floorsWithoutDO = state.collegeFloors.filter((f) => !dos.some((d) => (d.floorIds || []).includes(f.id)));
  const floorsWithoutTeacher = state.collegeFloors.filter((f) => !teachers.some((t) => (t.floorIds || []).includes(f.id)));
  const classesWithoutLAI = state.classes.filter((c) => !lais.some((l) => (l.classIds || []).includes(c.id)));
  const gaps = [
    ...hostelFloorsWithoutWarden.map((f) => `${f.name} has no Warden`),
    ...floorsWithoutDO.map((f) => `${f.name} has no Discipline Officer`),
    ...floorsWithoutTeacher.map((f) => `${f.name} has no Lecturer`),
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
        <Group label="Wardens (pooled per floor)" list={wardens} describe={(w) => `${(w.floorIds || []).length} floor(s)`} />
        <Group label="Discipline Officers (pooled per floor)" list={dos} describe={(d) => `${(d.floorIds || []).length} floor(s)`} />
        <Group label="Lecturers (pooled per floor)" list={teachers} describe={(t) => `${(t.floorIds || []).length} floor(s)`} />
        <Group label="Local Attendance Incharges" list={lais} describe={(l) => `${(l.classIds || []).length} class(es)`} />
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* 5b2. Shared: browse students (Database Manager and AO, read-only)  */
/* ---------------------------------------------------------------- */

// Wording differs only for the Database Manager, who has somewhere to act
// on it (the Students / Hostels & classes tabs) — the AO doesn't have those
// tabs, so pointing them there would be a dead end.
function emptyStudentsMsg(role, kind) {
  const isDbManager = role === "DB_MANAGER";
  const MSGS = {
    college_no_structure: isDbManager ? "No classes yet — add some in Hostels & classes." : "No classes have been set up yet.",
    college_no_students: isDbManager ? "No students yet — add some on the Students page." : "No students have been added yet.",
    hostel_no_structure: isDbManager ? "No hostels yet — add some in Hostels & classes." : "No hostel structure has been set up yet.",
    hostel_no_students: isDbManager ? "No students yet — add some on the Students page." : "No students have been added yet.",
  };
  return MSGS[kind];
}

// One collapsible row, used at every level of both views (class section,
// hostel, floor, room, day-scholar class group). `forceOpen` lets an active
// search expand every level automatically so matches aren't hidden behind a
// manual toggle the user never touched.
// `forceOpen` pins the section open and un-collapsible (used for search
// auto-expand — the user shouldn't be able to hide a match). `defaultOpen`
// just seeds the initial state (used where a list should start expanded,
// e.g. absentees, but stay individually collapsible).
function Collapsible({ header, children, forceOpen, defaultOpen }) {
  const [open, setOpen] = useState(!!defaultOpen);
  const isOpen = forceOpen || open;
  return (
    <div>
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 text-left">
        <ChevronDown size={15} className={`shrink-0 text-slate-400 transition-transform ${isOpen ? "" : "-rotate-90"}`} />
        {header}
      </button>
      {isOpen && <div className="mt-2">{children}</div>}
    </div>
  );
}

// Roll/name (+ class, for the hostel view's room occupants) rows — table on
// md+ screens, one card per student below that, same pattern as everywhere
// else in the app.
function StudentRows({ students, showClass }) {
  return (
    <>
      <Card className="hidden overflow-x-auto md:block">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr><th className="px-4 py-2">Roll</th><th className="px-4 py-2">Name</th>{showClass && <th className="px-4 py-2">Class</th>}</tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {students.map((s) => (
              <tr key={s.id}>
                <td className="px-4 py-2 text-slate-600">{s.roll}</td>
                <td className="px-4 py-2 font-medium text-slate-800">{s.name}</td>
                {showClass && <td className="px-4 py-2 text-slate-600">{s.className || "—"}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <div className="space-y-2 md:hidden">
        {students.map((s) => (
          <div key={s.id} className="rounded-lg border border-slate-200 p-3 text-sm">
            <div className="flex items-center justify-between"><span className="font-medium text-slate-800">{s.name}</span><span className="text-xs text-slate-400">{s.roll}</span></div>
            {showClass && <div className="mt-1 text-xs text-slate-500">{s.className || "—"}</div>}
          </div>
        ))}
      </div>
    </>
  );
}

// College view: classes as collapsible sections; each student row shows
// their hostel dimension ("Boys Hostel A · 101") or a "Day scholar"
// pill — driven off whether the endpoint resolved a room, not the isLocal
// flag, so it stays correct even for the rare student where the two disagree.
function CollegeStudentsView({ classes, query, role }) {
  const q = query.trim().toLowerCase();
  const matches = (s) => !q || s.name.toLowerCase().includes(q) || s.roll.toLowerCase().includes(q);

  if (classes.length === 0) return <EmptyNote text={emptyStudentsMsg(role, "college_no_structure")} />;
  const totalStudents = classes.reduce((n, c) => n + c.count, 0);
  if (totalStudents === 0) return <EmptyNote text={emptyStudentsMsg(role, "college_no_students")} />;

  const visible = classes
    .map((c) => ({ ...c, filteredStudents: c.students.filter(matches) }))
    .filter((c) => !q || c.filteredStudents.length > 0);
  if (visible.length === 0) return <EmptyNote text="No students match your search." />;

  return (
    <div className="space-y-3">
      {visible.map((c) => (
        <Card key={c.id} className="p-3">
          <Collapsible
            forceOpen={!!q}
            header={
              <div className="flex flex-1 items-center justify-between gap-2">
                <span className="font-medium text-slate-800">{c.name}</span>
                <Badge tone="slate">{pluralize(c.count, "student")}</Badge>
              </div>
            }
          >
            <Card className="hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  <tr><th className="px-4 py-2">Roll</th><th className="px-4 py-2">Name</th><th className="px-4 py-2">Hostel dimension</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {c.filteredStudents.map((s) => (
                    <tr key={s.id}>
                      <td className="px-4 py-2 text-slate-600">{s.roll}</td>
                      <td className="px-4 py-2 font-medium text-slate-800">{s.name}</td>
                      <td className="px-4 py-2">{s.hostelName ? `${s.hostelName} · ${s.roomNo}` : <Badge tone="amber">Day scholar</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <div className="space-y-2 md:hidden">
              {c.filteredStudents.map((s) => (
                <div key={s.id} className="rounded-lg border border-slate-200 p-3 text-sm">
                  <div className="flex items-center justify-between"><span className="font-medium text-slate-800">{s.name}</span><span className="text-xs text-slate-400">{s.roll}</span></div>
                  <div className="mt-1">{s.hostelName ? <span className="text-xs text-slate-500">{s.hostelName} · {s.roomNo}</span> : <Badge tone="amber">Day scholar</Badge>}</div>
                </div>
              ))}
            </div>
          </Collapsible>
        </Card>
      ))}
    </div>
  );
}

// Hostel view: Hostel -> Floor -> Room -> occupants, all counts as returned
// by the endpoint (never re-derived here), plus a separate day-scholars
// section grouped by class since day scholars have no room to nest under.
function HostelStudentsView({ hostels, dayScholars, query, role }) {
  const q = query.trim().toLowerCase();
  const matches = (s) => !q || s.name.toLowerCase().includes(q) || s.roll.toLowerCase().includes(q);

  const totalStudents = hostels.reduce((n, h) => n + h.count, 0) + dayScholars.reduce((n, d) => n + d.count, 0);
  if (hostels.length === 0 && dayScholars.length === 0) return <EmptyNote text={emptyStudentsMsg(role, "hostel_no_structure")} />;
  if (totalStudents === 0) return <EmptyNote text={emptyStudentsMsg(role, "hostel_no_students")} />;

  const filteredHostels = hostels
    .map((h) => ({
      ...h,
      floors: h.floors
        .map((f) => ({
          ...f,
          rooms: f.rooms
            .map((r) => ({ ...r, filteredOccupants: r.occupants.filter(matches) }))
            .filter((r) => !q || r.filteredOccupants.length > 0),
        }))
        .filter((f) => !q || f.rooms.length > 0),
    }))
    .filter((h) => !q || h.floors.length > 0);

  const filteredDayScholars = dayScholars
    .map((d) => ({ ...d, filteredStudents: d.students.filter(matches) }))
    .filter((d) => !q || d.filteredStudents.length > 0);

  if (q && filteredHostels.length === 0 && filteredDayScholars.length === 0) return <EmptyNote text="No students match your search." />;

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        {hostels.length === 0 ? (
          <EmptyNote text={emptyStudentsMsg(role, "hostel_no_structure")} />
        ) : (
          filteredHostels.map((h) => (
            <Card key={h.id} className="p-3">
              <Collapsible
                forceOpen={!!q}
                header={
                  <div className="flex flex-1 flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-slate-800">{h.name} <span className="font-normal text-slate-400">· {pluralize(h.floors.length, "floor")}</span></span>
                    <Badge tone="slate">{pluralize(h.count, "student")}</Badge>
                  </div>
                }
              >
                <div className="space-y-2 border-l-2 border-slate-100 pl-3">
                  {h.floors.map((f) => (
                    <Collapsible
                      key={f.id}
                      forceOpen={!!q}
                      header={
                        <div className="flex flex-1 items-center justify-between gap-2">
                          <span className="text-sm font-medium text-slate-700">{f.name}</span>
                          <Badge tone="slate">{pluralize(f.count, "student")}</Badge>
                        </div>
                      }
                    >
                      <div className="space-y-2 border-l-2 border-slate-100 pl-3">
                        {f.rooms.map((r) => (
                          <Collapsible
                            key={r.id}
                            forceOpen={!!q}
                            header={
                              <div className="flex flex-1 items-center justify-between gap-2">
                                <span className="text-sm text-slate-600">Room {r.roomNo}</span>
                                <Badge tone="slate">{pluralize(r.count, "student")}</Badge>
                              </div>
                            }
                          >
                            {r.filteredOccupants.length === 0 ? <p className="text-xs text-slate-400">No occupants.</p> : <StudentRows students={r.filteredOccupants} showClass />}
                          </Collapsible>
                        ))}
                        {f.rooms.length === 0 && <p className="text-xs text-slate-400">No rooms with matches.</p>}
                      </div>
                    </Collapsible>
                  ))}
                </div>
              </Collapsible>
            </Card>
          ))
        )}
      </div>

      <div>
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Day scholars</p>
        {dayScholars.length === 0 ? (
          <EmptyNote text="No day scholars." />
        ) : (
          <div className="space-y-2">
            {filteredDayScholars.map((d) => (
              <Card key={d.classId || "unassigned"} className="p-3">
                <Collapsible
                  forceOpen={!!q}
                  header={
                    <div className="flex flex-1 items-center justify-between gap-2">
                      <span className="font-medium text-slate-800">{d.className}</span>
                      <Badge tone="slate">{pluralize(d.count, "student")}</Badge>
                    </div>
                  }
                >
                  <StudentRows students={d.filteredStudents} />
                </Collapsible>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// One floor's line: "Boys Hostel A — Floor 1 · 3 students" for a Warden
// (f.hostelName present — a hostel floor's bare name is ambiguous across
// hostels), or "College Floor 1 · 3 students" for a DO/Lecturer (no
// hostelName — a CollegeFloor isn't nested under a second parent the same
// way, so no prefix is needed). Zero students reads as a calm, neutral
// fact ("no students currently"), not styled as a problem — an empty floor
// is a normal state, not something wrong with the assignment.
function FloorLine({ floor }) {
  return (
    <span className="text-slate-500">
      {floor.hostelName && <>{floor.hostelName} — </>}{floor.name} · {floor.count > 0 ? pluralize(floor.count, "student") : "no students currently"}
    </span>
  );
}

// One row: name, login key, status pill, assignment in plain language.
// `kind` picks how to read the assignment out of `person`, since the
// backend sends three different shapes (floors+count for Warden/DO/
// Lecturer, a shared dayScholarCount for LAI, nothing at all for
// leadership) rather than forcing one shape on all of them — see
// server/src/routes/staffDirectory.js. Multiple floors get one line each
// (matches how a multi-item detail list reads elsewhere in this app, e.g.
// SyncEditDetail's field-by-field breakdown) plus a total, rather than one
// long comma-joined line that gets hard to parse once each floor also
// carries its own hostel name and count.
function StaffDirectoryRow({ person, kind }) {
  const statusTone = person.status === "ACTIVE" ? "emerald" : person.status === "FROZEN" ? "rose" : person.status === "PENDING" ? "amber" : "slate";
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium text-slate-800">{person.name}</span>
          <span className="font-display text-xs text-slate-400">Key {person.loginKey}</span>
          <Badge tone={statusTone}>{person.status}</Badge>
        </div>
        <div className="mt-0.5 text-xs">
          {kind === "leadership" ? (
            <span className="italic text-slate-400">Fixed role — no assignment</span>
          ) : kind === "lai" ? (
            <span className="text-slate-500">All day scholars — college-wide ({pluralize(person.dayScholarCount, "student")})</span>
          ) : person.assignmentStatus === "none" ? (
            // Calm amber, not rose — a fresh account with nothing assigned
            // yet is a normal, expected state (awaiting the AO's assignment
            // step), not an error. Distinct from leadership's fully-neutral
            // "Fixed role" text above, which has nothing to assign at all.
            <span className="font-medium text-amber-700">Not yet assigned — awaiting floor assignment</span>
          ) : person.floors.length === 1 ? (
            <FloorLine floor={person.floors[0]} />
          ) : (
            <div className="space-y-0.5">
              {person.floors.map((f) => <div key={f.id}><FloorLine floor={f} /></div>)}
              <div className="font-medium text-slate-600">{pluralize(person.totalCount, "student")} total</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// One role's collapsible group — renders nothing if `people` is missing or
// empty, which is what makes this same component work unmodified for
// Coordinator's lecturers-only payload (every other group's data is simply
// absent from that response, not an empty array to special-case).
function StaffDirectoryGroup({ title, icon: Icon, people, kind }) {
  if (!people || people.length === 0) return null;
  const unassignedCount = kind === "floors" ? people.filter((p) => p.assignmentStatus === "none").length : 0;
  return (
    <Card className="mb-3 p-3">
      <Collapsible
        header={
          <div className="flex flex-1 flex-wrap items-center gap-2">
            <Icon size={15} className="text-slate-400" />
            <span className="font-medium text-slate-800">{title}</span>
            <Badge tone="slate">{pluralize(people.length, "person", "people")}</Badge>
            {unassignedCount > 0 && <Badge tone="amber">{unassignedCount} not yet assigned</Badge>}
          </div>
        }
      >
        <div className="space-y-1.5 border-l-2 border-slate-100 pl-3">
          {people.map((p) => <StaffDirectoryRow key={p.id} person={p} kind={kind} />)}
        </div>
      </Collapsible>
    </Card>
  );
}

// Read-only assignment visibility for leadership to review coverage —
// distinct from Leadership Accounts (account administration: freeze/reset/
// offboard), which this does not replace or touch. AO and Principal get
// every group; Coordinator's request comes back with only `lecturers`
// populated (enforced server-side, not hidden client-side) — the exact same
// rendering below handles both since each StaffDirectoryGroup just renders
// nothing for a group that isn't in the response.
function StaffDirectory() {
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await api.getStaffDirectory();
        if (!cancelled) setData(result);
      } catch (e) {
        if (!cancelled) setError(e.message || "Couldn't load the staff directory");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div>
      <SectionTitle icon={BookUser} title="Staff directory" subtitle="Who's assigned where, and their current workload. Read-only." />
      {error && <p className="text-sm text-rose-600">{error}</p>}
      {!error && !data && <div className="grid h-40 place-items-center text-slate-400"><Loader2 className="animate-spin" size={18} /></div>}
      {data && (
        <>
          <StaffDirectoryGroup title="Wardens" icon={Bed} people={data.wardens} kind="floors" />
          <StaffDirectoryGroup title="Local Attendance Incharges" icon={GraduationCap} people={data.lais} kind="lai" />
          <StaffDirectoryGroup title="Discipline Officers" icon={Phone} people={data.dos} kind="floors" />
          <StaffDirectoryGroup title="Lecturers" icon={ClipboardCheck} people={data.lecturers} kind="floors" />
          <StaffDirectoryGroup title="Leadership" icon={ShieldCheck} people={data.leadership} kind="leadership" />
          {["wardens", "lais", "dos", "lecturers", "leadership"].every((k) => !data[k] || data[k].length === 0) && <EmptyNote text="No staff yet." />}
        </>
      )}
    </div>
  );
}

// Both endpoints are fetched once up front (not re-fetched on toggle) so
// flipping between College view and Hostel view is instant.
function ViewStudents({ me }) {
  const [view, setView] = useState("college");
  const [query, setQuery] = useState("");
  const [data, setData] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [byClass, byHostel] = await Promise.all([api.getStudentsByClass(), api.getStudentsByHostel()]);
        if (!cancelled) setData({ classes: byClass.classes, hostels: byHostel.hostels, dayScholars: byHostel.dayScholars });
      } catch (e) {
        if (!cancelled) setError(e.message || "Couldn't load students");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return (
    <div>
      <SectionTitle icon={ListTree} title="View students" subtitle="Browse by class, or drill down through the hostel structure. Read-only." />
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="inline-flex rounded-lg border border-slate-300 bg-white p-0.5">
          <button onClick={() => setView("college")} className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${view === "college" ? "bg-[#12324D] text-white" : "text-slate-600 hover:bg-slate-100"}`}>College view</button>
          <button onClick={() => setView("hostel")} className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${view === "hostel" ? "bg-[#12324D] text-white" : "text-slate-600 hover:bg-slate-100"}`}>Hostel view</button>
        </div>
      </div>
      <SearchBox value={query} onChange={setQuery} placeholder="Search by name or roll number..." />
      {error && <p className="text-sm text-rose-600">{error}</p>}
      {!error && !data && <div className="grid h-40 place-items-center text-slate-400"><Loader2 className="animate-spin" size={18} /></div>}
      {data && (view === "college" ? (
        <CollegeStudentsView classes={data.classes} query={query} role={me.role} />
      ) : (
        <HostelStudentsView hostels={data.hostels} dayScholars={data.dayScholars} query={query} role={me.role} />
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* 5c. Lecturer's approval queue                                      */
/* ---------------------------------------------------------------- */
// Coordinator used to share this component (stageKey="coordinatorApproved")
// before the redesign that made them an institution-wide observer only —
// see CoordinatorObserverView instead, a separate read-only component built
// for that. This one is Lecturer-only now, but scopeFloorIds stays a real
// prop rather than being hardcoded away, since nothing about approving
// one's own floor's classes was Coordinator-specific to begin with.
function ApprovalQueue({ state, date, runAction, stageKey, requiredPriorKey, roleLabel, note, scopeFloorIds, me }) {
  const day = sessionScoped(state.attendance[date]);
  // Scoped to the caller's own assigned floor(s) — same scoping pattern as
  // AttendanceStatusBoard's "status" tab, which this queue sits right next to.
  const classesInScope = scopeFloorIds ? state.classes.filter((c) => scopeFloorIds.includes(c.collegeFloorId)) : state.classes;
  const withRecord = classesInScope.map((c) => ({ c, r: day[c.id] || emptyRecord() }));
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
            {done.map(({ c, r }) => {
              // Optional cross-verification: a second Lecturer on the same
              // floor can voluntarily co-sign a class teacherApproved
              // already covers — never required, never gates anything
              // downstream. Only offered to a Lecturer who isn't the
              // original approver, on a class not already co-signed.
              const canCoSign = stageKey === "teacherApproved" && me?.role === "LECTURER" && r.teacherApproved?.by !== me.id && !r.teacherCoSignedBy;
              return (
                <div key={c.id} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span>{c.name}</span>
                    <span className="text-xs text-slate-400">{r[stageKey].byName} · {formatTime(r[stageKey].at)}</span>
                  </div>
                  {stageKey === "teacherApproved" && r.teacherCoSignedBy && (
                    <div className="mt-1 text-xs text-blue-600">Co-signed by {r.teacherCoSignedBy.byName} · {formatTime(r.teacherCoSignedBy.at)}</div>
                  )}
                  {canCoSign && (
                    <div className="mt-1.5">
                      <Btn size="sm" variant="outline" onClick={() => runAction(() => api.coSign(date, c.id), "Co-signed")}>Co-sign</Btn>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// Coordinator's institution-wide, read-only view of the DO -> Lecturer
// approval queue. Replaces the old ApprovalQueue-based approve/send-back
// capability now that Coordinator only observes (see stages.js) — same
// items/done split ApprovalQueue already uses for Lecturer's own queue
// (doApproved set, teacherApproved not vs. teacherApproved set), same
// per-class card content (absentees + reasons, away students, headcount,
// sentBack banner), just no action buttons, and no floor scoping since
// Coordinator isn't floor-bound. Deliberately a separate component from
// ApprovalQueue rather than a readOnly prop bolted onto it — ApprovalQueue
// is live infrastructure for Lecturer's actual approve flow, not something
// to touch for an additive, Coordinator-only view. Same MORNING-only
// session default ApprovalQueue already has — not fixed here, a
// pre-existing simplification, not new to this component.
function CoordinatorObserverView({ state, date }) {
  const day = sessionScoped(state.attendance[date]);
  const withRecord = state.classes.map((c) => ({ c, r: day[c.id] || emptyRecord() }));
  const awaitingLecturer = withRecord.filter(({ r }) => !!r.doApproved && !r.teacherApproved);
  const lecturerApproved = withRecord.filter(({ r }) => !!r.teacherApproved);

  const renderCard = ({ c, r }) => {
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
          {r.teacherApproved && (
            <div className="text-right text-xs text-slate-400">
              <div>Approved by {r.teacherApproved.byName} · {formatTime(r.teacherApproved.at)}</div>
              {r.teacherCoSignedBy && <div className="text-blue-600">Co-signed by {r.teacherCoSignedBy.byName}</div>}
            </div>
          )}
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
  };

  return (
    <div>
      <SectionTitle icon={ClipboardCheck} title="Attendance activity" subtitle="Read-only, institution-wide — Coordinator no longer approves individual classes." />
      <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Awaiting Lecturer</p>
      {awaitingLecturer.length === 0 ? (
        <EmptyNote text="Nothing waiting on a Lecturer right now." />
      ) : (
        <div className="space-y-3">{awaitingLecturer.map(renderCard)}</div>
      )}
      <p className="mb-2 mt-8 text-xs font-semibold uppercase tracking-wide text-slate-400">Lecturer approved</p>
      {lecturerApproved.length === 0 ? (
        <EmptyNote text="No classes approved by a Lecturer yet." />
      ) : (
        <div className="space-y-3">{lecturerApproved.map(renderCard)}</div>
      )}
    </div>
  );
}

// Coordinator no longer approves daily attendance — Lecturer is the last
// human stage now (see stages.js) — but still owns the deadline cutoff
// below, a deadline-override tool rather than a stage approval.
function CoordinatorApprovals({ state, date, runAction }) {
  return (
    <div>
      <CoordinatorObserverView state={state} date={date} />
      <div className="mt-6 rounded-xl border border-amber-200 bg-amber-50 p-4">
        <div className="flex items-start gap-2 text-sm text-amber-800">
          <Bell size={15} className="mt-0.5 shrink-0" />
          <div>
            <p className="font-medium">Deadline cutoff</p>
            <p className="mt-0.5 text-amber-700">Anything still waiting on a Teacher approval past the cutoff gets published anyway, tagged "auto-passed." A list still stuck on the DO is never auto-passed — that verification has to actually happen.</p>
          </div>
        </div>
        <div className="mt-3"><Btn variant="outline" onClick={() => runAction(() => api.runCutoff(date), "Cutoff run")}><Clock size={14} /> Run cutoff now (demo)</Btn></div>
      </div>
    </div>
  );
}

// Local "HH:MM" for comparing against a floor's dailyDeadline — UX-only
// (enables/disables the cutoff button); the server re-validates
// authoritatively and is the real gate, same "HH:MM strings sort like the
// real value" trick as the backend's own nowHHMM.
function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// One floor's optional deadline: set/clear it, and once it's passed, a
// button to force-publish anything on this floor still waiting on a
// Teacher approval — this app has no scheduler, so the deadline never
// fires anything by itself, it only unlocks this button for a human to
// click. Never bypasses the DO stage, same rule as Coordinator's
// institution-wide cutoff in CoordinatorApprovals.
function FloorDeadlineCard({ floor, date, runAction }) {
  const [time, setTime] = useState(floor.dailyDeadline || "");
  const passed = !!floor.dailyDeadline && nowHHMM() >= floor.dailyDeadline;
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
      <div className="flex items-start gap-2 text-sm text-amber-800">
        <Bell size={15} className="mt-0.5 shrink-0" />
        <div className="flex-1">
          <p className="font-medium">{floor.name} — deadline</p>
          <p className="mt-0.5 text-amber-700">Optional. Once it passes, you can force-publish anything on this floor still waiting on a Teacher approval — never bypasses the DO stage.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input type="time" className={`${inputCls} w-32`} value={time} onChange={(e) => setTime(e.target.value)} />
            <Btn size="sm" variant="outline" onClick={() => runAction(() => api.setFloorDeadline(floor.id, time || null), time ? "Deadline set" : "Deadline cleared")}>Save</Btn>
            {floor.dailyDeadline && (
              <Btn size="sm" variant="outline" onClick={() => { setTime(""); runAction(() => api.setFloorDeadline(floor.id, null), "Deadline cleared"); }}>Clear</Btn>
            )}
          </div>
        </div>
      </div>
      {floor.dailyDeadline && (
        <div className="mt-3">
          <Btn variant="outline" disabled={!passed} onClick={() => runAction(() => api.runFloorCutoff(date, floor.id), "Cutoff run for this floor")}>
            <Clock size={14} /> {passed ? "Run cutoff for this floor now" : `Unlocks at ${floor.dailyDeadline}`}
          </Btn>
        </div>
      )}
    </div>
  );
}

// Lecturer's own approval tab: their floor-scoped queue (the fix — see
// ApprovalQueue's scopeFloorIds), plus one deadline card per floor they
// cover (a Lecturer can be pooled across more than one, per the modeling
// note at the top of schema.prisma).
function LecturerApprovals({ state, date, me, runAction }) {
  const floors = (me.floorIds || [])
    .map((fid) => state.collegeFloors.find((f) => f.id === fid))
    .filter(Boolean);
  return (
    <div>
      <ApprovalQueue state={state} date={date} runAction={runAction} stageKey="teacherApproved" requiredPriorKey="doApproved" roleLabel="Lecturer" note="Lists appear once the Discipline Officer has verified them. Any Lecturer on the floor can file this." scopeFloorIds={me.floorIds} me={me} />
      {floors.length > 0 && (
        <div className="mt-6 space-y-3">
          {floors.map((floor) => (
            <FloorDeadlineCard key={floor.id} floor={floor} date={date} runAction={runAction} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* 5d. Database Manager                                               */
/* ---------------------------------------------------------------- */

// Hostel structure is three levels deep (Hostel -> HostelFloor -> Room), so
// anywhere a room needs a human-readable label, build it by walking back
// up through the two lookups rather than storing a flat string anywhere.
// Number-only at the end — no "Room " prefix — once it's inside a path.
function roomLabel(state, roomId) {
  const room = state.hostelRooms.find((r) => r.id === roomId);
  if (!room) return "Unknown room";
  const floor = state.hostelFloors.find((f) => f.id === room.hostelFloorId);
  const hostel = floor && state.hostels.find((h) => h.id === floor.hostelId);
  return `${hostel?.name || "?"} / ${floor?.name || "?"} / ${room.roomNo}`;
}
function roomOptions(state) {
  return state.hostelRooms.map((r) => ({ value: r.id, label: roomLabel(state, r.id) }));
}
// Wardens are assigned whole hostel floors (pooled — see schema.prisma's
// IMPORTANT MODELING NOTE), not individual rooms — same "hostel / floor"
// disambiguation as roomLabel, since two different hostels can share a
// floor name (e.g. both have a "Ground Floor").
function hostelFloorLabel(state, floorId) {
  const floor = state.hostelFloors.find((f) => f.id === floorId);
  if (!floor) return "Unknown floor";
  const hostel = state.hostels.find((h) => h.id === floor.hostelId);
  return `${hostel?.name || "?"} / ${floor.name}`;
}
function hostelFloorOptions(state) {
  return state.hostelFloors.map((f) => ({ value: f.id, label: hostelFloorLabel(state, f.id) }));
}
function hostelIdForRoom(state, roomId) {
  const room = state.hostelRooms.find((r) => r.id === roomId);
  const floor = room && state.hostelFloors.find((f) => f.id === room.hostelFloorId);
  return floor?.hostelId || "";
}
function roomsForHostel(state, hostelId) {
  return state.hostelRooms.filter((r) => state.hostelFloors.find((f) => f.id === r.hostelFloorId)?.hostelId === hostelId);
}

const DAY_SCHOLAR_VALUE = "DAY_SCHOLAR";
// The merged "Day scholar or hostel" choice used by both the manual Add
// form and the Edit modal — one select instead of a checkbox + a room
// dropdown spanning every hostel, so picking a hostel narrows the room
// choices to just that hostel's rooms (matches the per-class Excel
// template's same C/D column split — see server/src/routes/excel.js).
function HostelOrDayFields({ state, hostelOrDay, roomId, onHostelOrDayChange, onRoomChange }) {
  return (
    <>
      <Field label="Day scholar / hostel">
        <select className={inputCls} value={hostelOrDay} onChange={(e) => onHostelOrDayChange(e.target.value)}>
          <option value="">Select...</option>
          <option value={DAY_SCHOLAR_VALUE}>Day scholar</option>
          {state.hostels.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
        </select>
      </Field>
      {hostelOrDay && hostelOrDay !== DAY_SCHOLAR_VALUE && (
        <Field label="Room">
          <Select value={roomId} onChange={onRoomChange} options={roomsForHostel(state, hostelOrDay).map((r) => ({ value: r.id, label: r.roomNo }))} />
        </Field>
      )}
    </>
  );
}

// Where to insert a moved student within the destination class's roster —
// mirrors server/src/seqOrder.js's computeSingleMoveOrder exactly: "top"
// sends neither field (that function's own default), "end" sends
// placeAtEnd, "after" sends placeAfterStudentId. `destStudents` is the
// destination class's CURRENT roster, already seq-ordered, with the
// student being moved excluded (they can't be placed relative to
// themselves) — same list either way, since a same-class move and a
// cross-class move both reorder against "everyone else already there."
const POSITION_TOP = "top", POSITION_END = "end", POSITION_AFTER = "after";
function MovePositionField({ destStudents, positionMode, onPositionModeChange, placeAfterStudentId, onPlaceAfterChange }) {
  return (
    <>
      <Field label="Position in destination class">
        <select className={inputCls} value={positionMode} onChange={(e) => onPositionModeChange(e.target.value)}>
          <option value={POSITION_TOP}>Top of the class</option>
          <option value={POSITION_END}>Bottom of the class</option>
          {destStudents.length > 0 && <option value={POSITION_AFTER}>After a specific student...</option>}
        </select>
      </Field>
      {positionMode === POSITION_AFTER && (
        <Field label="Place after">
          <Select value={placeAfterStudentId} onChange={onPlaceAfterChange} options={destStudents.map((s) => ({ value: s.id, label: `${s.roll} — ${s.name}` }))} />
        </Field>
      )}
    </>
  );
}

// Single-student move: change class / hostel room / day-scholar status /
// roster position, in any combination, in one form — mirrors the Edit
// modal's shape (same HostelOrDayFields) plus the position picker above.
// Defaults every field to the student's CURRENT values so an untouched
// submit is a pure position-only move rather than accidentally clearing
// their room. Goes through api.moveStudent -> AO approval, same as every
// other student change (see server/src/routes/studentMove.js).
function MoveStudentModal({ state, student, runAction, onClose }) {
  const [classId, setClassId] = useState(student.classId);
  const [hostelOrDay, setHostelOrDay] = useState(student.isLocal ? DAY_SCHOLAR_VALUE : hostelIdForRoom(state, student.roomId));
  const [roomId, setRoomId] = useState(student.roomId || "");
  const [positionMode, setPositionMode] = useState(POSITION_TOP);
  const [placeAfterStudentId, setPlaceAfterStudentId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Destination class's current roster (seq order, as state.students
  // already arrives — see StudentsAdmin's own comment on that ordering),
  // minus the student being moved.
  const destStudents = state.students.filter((s) => s.classId === classId && s.id !== student.id);

  const submit = async () => {
    setError("");
    if (!hostelOrDay) return setError("Choose a room, or mark this student as a day scholar.");
    if (hostelOrDay !== DAY_SCHOLAR_VALUE && !roomId) return setError("Choose a room in that hostel.");
    if (positionMode === POSITION_AFTER && !placeAfterStudentId) return setError("Choose which student to place this after.");

    const becomeDayScholar = hostelOrDay === DAY_SCHOLAR_VALUE;
    const body = {
      newClassId: classId,
      becomeDayScholar,
      newRoomId: becomeDayScholar ? null : roomId,
      placeAfterStudentId: positionMode === POSITION_AFTER ? placeAfterStudentId : null,
      placeAtEnd: positionMode === POSITION_END,
    };
    setBusy(true);
    const result = await runAction(() => api.moveStudent(student.id, body), "Sent to AO for approval");
    setBusy(false);
    if (result) onClose();
  };

  return (
    <Modal title={`Move ${student.name}`} onClose={busy ? () => {} : onClose}>
      <div className="space-y-3">
        <Field label="Destination class"><Select value={classId} onChange={(v) => { setClassId(v); setPositionMode(POSITION_TOP); setPlaceAfterStudentId(""); }} options={state.classes.map((c) => ({ value: c.id, label: c.name }))} /></Field>
        <HostelOrDayFields state={state} hostelOrDay={hostelOrDay} roomId={roomId} onHostelOrDayChange={(v) => { setHostelOrDay(v); setRoomId(""); }} onRoomChange={setRoomId} />
        <MovePositionField destStudents={destStudents} positionMode={positionMode} onPositionModeChange={setPositionMode} placeAfterStudentId={placeAfterStudentId} onPlaceAfterChange={setPlaceAfterStudentId} />
      </div>
      {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Btn variant="ghost" onClick={onClose} disabled={busy}>Cancel</Btn>
        <Btn onClick={submit} disabled={busy}>{busy ? <Loader2 className="animate-spin" size={14} /> : <ArrowRightLeft size={14} />} {busy ? "Sending..." : "Send for AO approval"}</Btn>
      </div>
    </Modal>
  );
}

// The shared room/day-scholar control for a BATCH move — same three-way
// shape as HostelOrDayFields' single-student version, plus a fourth
// leading option ("keep each student's own") that HostelOrDayFields has no
// equivalent for, since a single move always resolves to one concrete
// destination while a batch's whole point is that this dimension is
// OPTIONAL and shared — see routes/studentMove.js's changingRoomForAll.
const KEEP_CURRENT_VALUE = "KEEP_CURRENT";
function BatchRoomField({ state, value, roomId, onValueChange, onRoomChange }) {
  return (
    <>
      <Field label="Room / day-scholar status for all selected">
        <select className={inputCls} value={value} onChange={(e) => onValueChange(e.target.value)}>
          <option value={KEEP_CURRENT_VALUE}>Keep each student's own room / status</option>
          <option value={DAY_SCHOLAR_VALUE}>Day scholar (all)</option>
          {state.hostels.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
        </select>
      </Field>
      {value && value !== KEEP_CURRENT_VALUE && value !== DAY_SCHOLAR_VALUE && (
        <Field label="Room">
          <Select value={roomId} onChange={onRoomChange} options={roomsForHostel(state, value).map((r) => ({ value: r.id, label: r.roomNo }))} />
        </Field>
      )}
    </>
  );
}

// Batch move: same class for everyone, optionally the same room/day-scholar
// status too. No position control here — a batch always appends to the end
// of the destination class's roster (see routes/studentMove.js's comment on
// why: no per-student placeAfterStudentId makes sense for a whole group at
// once), unlike the single move above.
function BulkMoveModal({ state, studentIds, runAction, onClose }) {
  const students = state.students.filter((s) => studentIds.includes(s.id));
  const [classId, setClassId] = useState("");
  const [roomMode, setRoomMode] = useState(KEEP_CURRENT_VALUE); // KEEP_CURRENT_VALUE | DAY_SCHOLAR_VALUE | a hostel id
  const [roomId, setRoomId] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError("");
    if (!classId) return setError("Choose a destination class.");
    if (roomMode !== KEEP_CURRENT_VALUE && roomMode !== DAY_SCHOLAR_VALUE && !roomId) return setError("Choose a room in that hostel.");

    const changingRoomForAll = roomMode !== KEEP_CURRENT_VALUE;
    const becomeDayScholar = roomMode === DAY_SCHOLAR_VALUE;
    const body = {
      studentIds,
      newClassId: classId,
      becomeDayScholar: changingRoomForAll ? becomeDayScholar : undefined,
      newRoomId: changingRoomForAll && !becomeDayScholar ? roomId : undefined,
    };
    setBusy(true);
    const result = await runAction(() => api.moveStudentsBatch(body), `Sent ${pluralize(studentIds.length, "student")} to AO for approval`);
    setBusy(false);
    if (result) onClose();
  };

  return (
    <Modal title={`Move ${pluralize(students.length, "student")}`} onClose={busy ? () => {} : onClose}>
      <div className="max-h-32 space-y-0.5 overflow-y-auto rounded-lg border border-slate-100 bg-slate-50/60 p-2 text-xs text-slate-600">
        {students.map((s) => <div key={s.id}>{s.roll} — {s.name}</div>)}
      </div>
      <div className="mt-3 space-y-3">
        <Field label="Destination class"><Select value={classId} onChange={setClassId} options={state.classes.map((c) => ({ value: c.id, label: c.name }))} /></Field>
        <BatchRoomField state={state} value={roomMode} roomId={roomId} onValueChange={(v) => { setRoomMode(v); setRoomId(""); }} onRoomChange={setRoomId} />
      </div>
      {error && <p className="mt-3 text-sm text-rose-600">{error}</p>}
      <div className="mt-4 flex justify-end gap-2">
        <Btn variant="ghost" onClick={onClose} disabled={busy}>Cancel</Btn>
        <Btn onClick={submit} disabled={busy}>{busy ? <Loader2 className="animate-spin" size={14} /> : <ArrowRightLeft size={14} />} {busy ? "Sending..." : "Send for AO approval"}</Btn>
      </div>
    </Modal>
  );
}

// A student can have at most one UNRESOLVED (pending or sent_back) edit or
// delete outstanding at a time. This is the AUTHORITATIVE guard — derived
// from state.pendingChanges, the same data the server itself checks (see
// routes/changes.js's findPendingStudentLock, which this deliberately
// mirrors rather than imports — frontend and backend are separate
// projects, same tradeoff as STAGES/recency.js elsewhere in this file) —
// because the window that actually matters is the whole time a change sits
// pending awaiting an AO's decision (minutes to days), not the brief moment
// a request is in flight. A local busy flag alone can't cover that: it
// resets the instant the request settles, well before an AO ever acts on
// it, which is exactly how 123a17c's deletingIds-only guard still let a
// second delete through once a refetch had already come back.
// A pending/sent_back sync_class_students change (see routes/excel.js's
// diffAndValidateRoster) also locks any student its edits or removals
// reference — adds don't count, since those rows aren't existing students
// yet. Mirrors routes/changes.js's server-side findPendingStudentLock.
const STUDENT_LOCK_TYPES = ["edit_student", "delete_student", "move_student"];
function findPendingStudentLock(pendingChanges, studentId) {
  for (const c of pendingChanges) {
    if (c.status !== "pending" && c.status !== "sent_back") continue;
    if (STUDENT_LOCK_TYPES.includes(c.type) && c.payload?.studentId === studentId) return c;
    if (c.type === "sync_class_students") {
      if (c.payload?.edits?.some((e) => e.studentId === studentId)) return c;
      if (c.payload?.removals?.some((r) => r.studentId === studentId)) return c;
    }
    if (c.type === "move_students_batch") {
      if (c.payload?.moves?.some((m) => m.studentId === studentId)) return c;
    }
  }
  return null;
}
// Global (college-wide) duplicate-roll check, mirroring the server's
// findRollOwner (server/src/studentApproval.js) — roll numbers are unique
// across the whole college, not scoped to a class, so this checks the
// FULL state.students list with no classId filter. Used by both the
// manual Add and Edit forms' client-side pre-checks; returns the class
// name of whichever student already has that roll, or null.
function findDuplicateRollOwner(state, roll, excludeStudentId) {
  const rollKey = roll.trim().toLowerCase();
  const dup = state.students.find((s) => s.id !== excludeStudentId && s.roll.trim().toLowerCase() === rollKey);
  if (!dup) return null;
  return state.classes.find((c) => c.id === dup.classId)?.name || "another class";
}
function describePendingStudentLock(lock, studentId) {
  if (!lock) return null;
  if (lock.type === "delete_student") return "delete";
  if (lock.type === "edit_student") return "edit";
  if (lock.type === "move_student" || lock.type === "move_students_batch") return "move";
  if (lock.type === "sync_class_students") {
    return lock.payload?.removals?.some((r) => r.studentId === studentId) ? "sync removal" : "sync edit";
  }
  return "edit";
}
function PendingLockBadge({ lock, studentId }) {
  const label = describePendingStudentLock(lock, studentId);
  if (!label) return null;
  return <span className="text-xs font-medium text-amber-600">Pending: {label}</span>;
}

// The edit/delete icon pair for one Manage Students row. `lock` (a
// PendingChange row, or null — see findPendingStudentLock above) is the
// real, server-agreed guard and disables both icons for as long as it's
// non-null, regardless of which type it is: an edit locks delete, a delete
// locks edit, AND a delete locks a second delete. `deletingIds` (still a
// Set of ids with a delete request in flight) and `isEditingBusy` are kept
// on top purely as defense-in-depth for the split second before a propose
// call's response — and the refetch after it — lands and state.pendingChanges
// actually reflects the new lock; they're not what makes the real repro
// (click delete, wait several seconds, click delete again) impossible.
function StudentRowActions({ s, lock, deletingIds, isEditingBusy, onEdit, onMove, onDelete }) {
  const deleting = deletingIds.has(s.id);
  const rowBusy = !!lock || deleting || isEditingBusy;
  return (
    <>
      <button onClick={onEdit} disabled={rowBusy} className="text-slate-400 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-slate-400"><Pencil size={14} /></button>
      <button onClick={onMove} disabled={rowBusy} className="text-slate-400 hover:text-slate-700 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-slate-400"><ArrowRightLeft size={14} /></button>
      <button onClick={onDelete} disabled={rowBusy} className="text-slate-400 hover:text-rose-600 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:text-slate-400">
        {deleting ? <Loader2 className="animate-spin" size={14} /> : <Trash2 size={14} />}
      </button>
    </>
  );
}

function StudentsAdmin({ state, runAction }) {
  const [name, setName] = useState(""); const [roll, setRoll] = useState("");
  const [classId, setClassId] = useState("");
  const [hostelOrDay, setHostelOrDay] = useState(""); const [roomId, setRoomId] = useState("");
  const [addError, setAddError] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [showManualAdd, setShowManualAdd] = useState(false);
  const [editing, setEditing] = useState(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState("");
  const [moving, setMoving] = useState(null); // student currently in the single-Move modal, or null
  // Bulk move: which student ids are checked (spans whatever's currently
  // visible — a class group's own "select all" only ever touches its OWN
  // students, but nothing clears a different group's selection, so in
  // principle a batch could span groups; the Move button next to each
  // group only ever sends THAT group's selected ids, never the full set).
  const [selectedIds, setSelectedIds] = useState(() => new Set());
  const [bulkMoveIds, setBulkMoveIds] = useState(null); // string[] | null — set while the bulk Move modal is open
  const toggleSelected = (id) => setSelectedIds((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleGroupSelected = (groupStudents) => {
    // Locked students (already mid-flight on some other change) can't be
    // selected at all — same lock that disables their row actions.
    const selectableIds = groupStudents.filter((s) => !findPendingStudentLock(state.pendingChanges, s.id)).map((s) => s.id);
    const allSelected = selectableIds.length > 0 && selectableIds.every((id) => selectedIds.has(id));
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const id of selectableIds) { if (allSelected) next.delete(id); else next.add(id); }
      return next;
    });
  };
  // Student ids with a delete request currently in flight — guards the
  // per-row icons the same way ApprovalActions guards AO's card buttons:
  // the clicked (delete) icon shows a spinner, its sibling (edit) on the
  // SAME row just disables, and a rapid double-click can only ever fire one
  // request (the button disables synchronously, before the network call
  // even starts, not after it resolves).
  const [deletingIds, setDeletingIds] = useState(() => new Set());
  const [search, setSearch] = useState("");
  const [excelClassId, setExcelClassId] = useState("");
  const [importBusy, setImportBusy] = useState(false);
  const [importResult, setImportResult] = useState(null);
  // Set only when the server comes back asking to confirm a diff that
  // includes removals (see routes/excel.js's dry-run/confirm flow) — holds
  // the exact File so "Continue" can resend it with confirm=true without
  // making the Database Manager re-pick it.
  const [pendingSyncConfirm, setPendingSyncConfirm] = useState(null); // { file, diff } | null
  const [syncConfirmBusy, setSyncConfirmBusy] = useState(false);

  const excelClassName = state.classes.find((c) => c.id === excelClassId)?.name || "";

  const runUpload = async (file, confirm) => {
    try {
      const result = await api.importStudents(file, confirm);
      if (result.needsConfirmation) {
        setPendingSyncConfirm({ file, diff: result.diff });
        return;
      }
      setPendingSyncConfirm(null);
      setImportResult(result); // { change, diff }
      await runAction(() => Promise.resolve(), `${result.change.summary} — pending AO approval`);
    } catch (e2) {
      setPendingSyncConfirm(null);
      setImportResult({ error: e2.message, errors: e2.errors || [] }); // e2.errors: per-row list — see api.js's uploadFile
    }
  };
  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // lets the same file be picked again after fixing it
    if (!file) return;
    setImportBusy(true); setImportResult(null);
    await runUpload(file, false);
    setImportBusy(false);
  };
  const confirmSyncRemovals = async () => {
    const { file } = pendingSyncConfirm;
    setSyncConfirmBusy(true);
    await runUpload(file, true);
    setSyncConfirmBusy(false);
  };

  // Both submitAdd and submitEdit stay open (busy, disabled) until the
  // request resolves, and only reset/close on success — runAction returns
  // null on a caught failure (it already toasted the message), so the form
  // stays filled in to fix and retry rather than losing what was typed.
  const submitAdd = async () => {
    setAddError("");
    if (!name.trim() || !roll.trim() || !classId || !hostelOrDay) {
      return setAddError("Fill in name, roll number, class, and whether they're a day scholar or hosteller.");
    }
    if (hostelOrDay !== DAY_SCHOLAR_VALUE && !roomId) return setAddError("Choose a room in that hostel.");
    const dupClassName = findDuplicateRollOwner(state, roll, null);
    if (dupClassName) return setAddError(`Roll number "${roll.trim()}" already exists (currently in ${dupClassName}).`);

    const isLocal = hostelOrDay === DAY_SCHOLAR_VALUE;
    setAddBusy(true);
    const result = await runAction(() => api.proposeChange("add_student", `Add student ${name} (${roll})`, { name: name.trim(), roll: roll.trim(), classId, roomId: isLocal ? null : roomId, isLocal }), "Sent to AO for approval");
    setAddBusy(false);
    if (result) { setName(""); setRoll(""); setClassId(""); setHostelOrDay(""); setRoomId(""); }
  };
  const submitDelete = async (s) => {
    setDeletingIds((prev) => new Set(prev).add(s.id));
    await runAction(() => api.proposeChange("delete_student", `Delete student ${s.name} (${s.roll})`, { studentId: s.id }), "Sent to AO for approval");
    setDeletingIds((prev) => { const next = new Set(prev); next.delete(s.id); return next; });
  };
  const openEdit = (s) => { setEditError(""); setEditing({ ...s, hostelOrDay: s.isLocal ? DAY_SCHOLAR_VALUE : hostelIdForRoom(state, s.roomId) }); };
  const submitEdit = async () => {
    setEditError("");
    const dupClassName = findDuplicateRollOwner(state, editing.roll, editing.id);
    if (dupClassName) return setEditError(`Roll number "${editing.roll.trim()}" already exists (currently in ${dupClassName}).`);

    const isLocal = editing.hostelOrDay === DAY_SCHOLAR_VALUE;
    setEditBusy(true);
    const result = await runAction(() => api.proposeChange("edit_student", `Edit student ${editing.name}`, { studentId: editing.id, changes: { name: editing.name, roll: editing.roll, classId: editing.classId, roomId: isLocal ? null : editing.roomId || null, isLocal } }), "Sent to AO for approval");
    setEditBusy(false);
    if (result) setEditing(null);
  };

  // Grouped by class (same shape/behavior as ViewStudents' college view —
  // search matches name/roll only, not class name, and auto-expands
  // whichever groups contain a match) rather than one flat table, since a
  // school-sized roster (thousands of students) in one ungrouped table
  // doesn't scale. Students whose class no longer resolves (defensive —
  // nothing in this app should produce that, but nothing prevents it at the
  // schema level either) land in a trailing "Unassigned" group instead of
  // silently vanishing. Order within each group is whatever order
  // state.students already arrived in (server-side seq order — see
  // schema.prisma's comment on Student.seq); only the GROUPS themselves are
  // sorted, by class name.
  const q = search.trim().toLowerCase();
  const matchesSearch = (s) => !q || s.name.toLowerCase().includes(q) || s.roll.toLowerCase().includes(q);
  const groupsMap = new Map();
  for (const s of state.students) {
    const cls = state.classes.find((c) => c.id === s.classId);
    const key = cls ? cls.id : "__unassigned";
    if (!groupsMap.has(key)) groupsMap.set(key, { id: key, name: cls ? cls.name : "Unassigned", students: [] });
    groupsMap.get(key).students.push(s);
  }
  const groups = [...groupsMap.values()].sort((a, b) => (a.id === "__unassigned" ? 1 : b.id === "__unassigned" ? -1 : a.name.localeCompare(b.name)));
  const visibleGroups = groups
    .map((g) => ({ ...g, filteredStudents: g.students.filter(matchesSearch) }))
    .filter((g) => !q || g.filteredStudents.length > 0);

  return (
    <div>
      <SectionTitle icon={GraduationCap} title="Manage students" subtitle="Changes are sent to the AO for approval before they take effect." />

      <Card className="mb-6 p-4">
        <p className="mb-1 text-sm font-semibold text-slate-700">Add many at once with Excel</p>
        <p className="mb-3 text-xs text-slate-500">Templates are generated per class, with a dropdown for "Day scholar" vs. an approved hostel name so that column can't be mistyped. Everything you upload still goes to the AO for approval, just as one request instead of many.</p>
        <div className="mb-3 max-w-xs"><Field label="Class"><Select value={excelClassId} onChange={setExcelClassId} options={state.classes.map((c) => ({ value: c.id, label: c.name }))} /></Field></div>
        {state.classes.length === 0 ? (
          <p className="text-xs text-amber-600">Add classes first in Hostels & classes.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            <Btn variant="outline" disabled={!excelClassId} onClick={() => api.downloadStudentTemplate(excelClassId, excelClassName)}><FileDown size={14} /> Download template</Btn>
            <Btn variant="outline" disabled={!excelClassId} onClick={() => api.exportStudents(excelClassId, excelClassName)}><FileDown size={14} /> Export current list</Btn>
            <label className={`inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium text-white ${importBusy ? "cursor-not-allowed bg-slate-300" : "cursor-pointer bg-[#12324D] hover:bg-[#0d2438]"}`}>
              {importBusy ? <Loader2 className="animate-spin" size={14} /> : <FileUp size={14} />} Upload filled sheet
              <input type="file" accept=".xlsx" className="hidden" onChange={handleUpload} disabled={importBusy} />
            </label>
          </div>
        )}
        {importResult && (
          importResult.errors?.length > 0 ? (
            <div className="mt-3 rounded-lg border border-rose-200 bg-rose-50 p-3">
              <p className="mb-2 text-sm font-medium text-rose-800">{importResult.error} Nothing was imported — fix these and re-upload.</p>
              <div className="max-h-56 space-y-1 overflow-y-auto rounded bg-white/70 p-2 text-xs text-rose-700">
                {importResult.errors.map((e, i) => <p key={i}>{e}</p>)}
              </div>
            </div>
          ) : importResult.change ? (
            <p className="mt-3 text-sm text-emerald-700">{importResult.change.summary} — pending AO approval.</p>
          ) : importResult.error ? (
            <p className="mt-3 text-sm text-rose-600">{importResult.error}</p>
          ) : null
        )}
      </Card>

      {pendingSyncConfirm && (
        <Modal title={`Confirm removals — ${pendingSyncConfirm.diff.className}`} onClose={() => !syncConfirmBusy && setPendingSyncConfirm(null)}>
          <div className="space-y-3">
            <p className="text-sm text-slate-700">
              This will remove {pluralize(pendingSyncConfirm.diff.removals.length, "student")} from {pendingSyncConfirm.diff.className}. They'll be deleted once an AO approves this sync.
            </p>
            <div className="max-h-48 space-y-1 overflow-y-auto rounded-lg border border-rose-200 bg-rose-50 p-2 text-sm text-rose-800">
              {pendingSyncConfirm.diff.removals.map((r) => (
                <div key={r.studentId}><span className="font-display">{r.roll}</span> {r.name}</div>
              ))}
            </div>
            {(pendingSyncConfirm.diff.adds.length > 0 || pendingSyncConfirm.diff.edits.length > 0 || pendingSyncConfirm.diff.orderChanged) && (
              <p className="text-xs text-slate-500">
                This sheet also{pendingSyncConfirm.diff.adds.length > 0 && ` adds ${pluralize(pendingSyncConfirm.diff.adds.length, "student")}`}
                {pendingSyncConfirm.diff.adds.length > 0 && pendingSyncConfirm.diff.edits.length > 0 && ","}
                {pendingSyncConfirm.diff.edits.length > 0 && ` edits ${pluralize(pendingSyncConfirm.diff.edits.length, "student")}`}
                {pendingSyncConfirm.diff.orderChanged && `${pendingSyncConfirm.diff.adds.length > 0 || pendingSyncConfirm.diff.edits.length > 0 ? " and" : ""} updates the roster order`}.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Btn variant="ghost" onClick={() => setPendingSyncConfirm(null)} disabled={syncConfirmBusy}>Cancel</Btn>
              <Btn variant="danger" onClick={confirmSyncRemovals} disabled={syncConfirmBusy}>
                {syncConfirmBusy ? <Loader2 className="animate-spin" size={14} /> : <Trash2 size={14} />} {syncConfirmBusy ? "Sending..." : "Continue — remove them"}
              </Btn>
            </div>
          </div>
        </Modal>
      )}

      <Card className="mb-6 p-4">
        <button onClick={() => setShowManualAdd((v) => !v)} className="flex w-full items-center justify-between text-left">
          <p className="text-sm font-semibold text-slate-700">Add one student without Excel</p>
          <ChevronDown size={16} className={`shrink-0 text-slate-400 transition-transform ${showManualAdd ? "" : "-rotate-90"}`} />
        </button>
        {showManualAdd && (
          <div className="mt-3">
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="Roll number"><input className={inputCls} value={roll} onChange={(e) => setRoll(e.target.value)} /></Field>
              <Field label="Name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></Field>
              <Field label="Class / batch"><Select value={classId} onChange={setClassId} options={state.classes.map((c) => ({ value: c.id, label: c.name }))} /></Field>
              <HostelOrDayFields state={state} hostelOrDay={hostelOrDay} roomId={roomId} onHostelOrDayChange={(v) => { setHostelOrDay(v); setRoomId(""); }} onRoomChange={setRoomId} />
            </div>
            {addError && <p className="mt-3 text-sm text-rose-600">{addError}</p>}
            <div className="mt-3"><Btn onClick={submitAdd} disabled={addBusy}>{addBusy ? <Loader2 className="animate-spin" size={14} /> : <Plus size={14} />} {addBusy ? "Sending..." : "Send for AO approval"}</Btn></div>
          </div>
        )}
      </Card>

      <SearchBox value={search} onChange={setSearch} placeholder="Search by name or roll number..." />
      {visibleGroups.length === 0 ? (
        <EmptyNote text={q ? "No students match your search." : "No students yet."} />
      ) : (
        <div className="space-y-3">
          {visibleGroups.map((g) => {
            const selectableStudents = g.filteredStudents.filter((s) => !findPendingStudentLock(state.pendingChanges, s.id));
            const groupSelectedIds = g.filteredStudents.filter((s) => selectedIds.has(s.id)).map((s) => s.id);
            const allGroupSelected = selectableStudents.length > 0 && selectableStudents.every((s) => selectedIds.has(s.id));
            return (
            <Card key={g.id} className="p-3">
              {/* Selection toolbar lives OUTSIDE Collapsible's header — that
                  header renders inside a <button> (see Collapsible above),
                  so a checkbox/button here would be an invalid nested
                  interactive element. */}
              {selectableStudents.length > 0 && (
                <div className="mb-2 flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 pb-2">
                  <label className="flex items-center gap-2 text-xs text-slate-500">
                    <input type="checkbox" checked={allGroupSelected} onChange={() => toggleGroupSelected(selectableStudents)} />
                    Select all in {g.name}
                  </label>
                  {groupSelectedIds.length > 0 && (
                    <Btn size="sm" variant="outline" onClick={() => setBulkMoveIds(groupSelectedIds)}>
                      <ArrowRightLeft size={12} /> Move {pluralize(groupSelectedIds.length, "student")}
                    </Btn>
                  )}
                </div>
              )}
              <Collapsible
                forceOpen={!!q}
                header={
                  <div className="flex flex-1 items-center justify-between gap-2">
                    <span className="font-medium text-slate-800">{g.name}</span>
                    <Badge tone="slate">{pluralize(g.students.length, "student")}</Badge>
                  </div>
                }
              >
                <Card className="hidden overflow-x-auto md:block">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                      <tr><th className="px-4 py-2"></th><th className="px-4 py-2">Roll</th><th className="px-4 py-2">Name</th><th className="px-4 py-2">Tag</th><th className="px-4 py-2">Room</th><th className="px-4 py-2"></th></tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {g.filteredStudents.map((s) => {
                        const lock = findPendingStudentLock(state.pendingChanges, s.id);
                        return (
                          <tr key={s.id}>
                            <td className="px-4 py-2"><input type="checkbox" checked={selectedIds.has(s.id)} disabled={!!lock} onChange={() => toggleSelected(s.id)} /></td>
                            <td className="px-4 py-2 text-slate-600">{s.roll}</td>
                            <td className="px-4 py-2">
                              <div className="font-medium text-slate-800">{s.name}</div>
                              <PendingLockBadge lock={lock} studentId={s.id} />
                            </td>
                            <td className="px-4 py-2"><Badge tone={s.isLocal ? "amber" : "slate"}>{s.isLocal ? "Local" : "Hostel"}</Badge></td>
                            <td className="px-4 py-2 text-slate-500">{s.roomId ? roomLabel(state, s.roomId) : "—"}</td>
                            <td className="px-4 py-2">
                              <div className="flex justify-end gap-2">
                                <StudentRowActions
                                  s={s}
                                  lock={lock}
                                  deletingIds={deletingIds}
                                  isEditingBusy={editing?.id === s.id && editBusy}
                                  onEdit={() => openEdit(s)}
                                  onMove={() => setMoving(s)}
                                  onDelete={() => submitDelete(s)}
                                />
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </Card>
                <div className="space-y-2 md:hidden">
                  {g.filteredStudents.map((s) => {
                    const lock = findPendingStudentLock(state.pendingChanges, s.id);
                    return (
                    <div key={s.id} className="rounded-lg border border-slate-200 p-3 text-sm">
                      <div className="flex items-center justify-between">
                        <label className="flex items-center gap-2">
                          <input type="checkbox" checked={selectedIds.has(s.id)} disabled={!!lock} onChange={() => toggleSelected(s.id)} />
                          <span className="font-display text-xs text-slate-400">{s.roll}</span>
                        </label>
                        <div className="flex gap-2">
                          <StudentRowActions
                            s={s}
                            lock={lock}
                            deletingIds={deletingIds}
                            isEditingBusy={editing?.id === s.id && editBusy}
                            onEdit={() => openEdit(s)}
                            onMove={() => setMoving(s)}
                            onDelete={() => submitDelete(s)}
                          />
                        </div>
                      </div>
                      <div className="mt-1 font-medium text-slate-800">{s.name}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-2">
                        <Badge tone={s.isLocal ? "amber" : "slate"}>{s.isLocal ? "Local" : "Hostel"}</Badge>
                        <span className="text-xs text-slate-500">{s.roomId ? roomLabel(state, s.roomId) : "—"}</span>
                        <PendingLockBadge lock={lock} studentId={s.id} />
                      </div>
                    </div>
                    );
                  })}
                </div>
              </Collapsible>
            </Card>
            );
          })}
        </div>
      )}

      {editing && (
        <div className="fixed inset-0 z-30 grid place-items-center bg-slate-900/40 p-4">
          <Card className="w-full max-w-md p-5">
            <p className="mb-3 font-display text-base font-semibold text-slate-800">Edit student</p>
            <div className="space-y-3">
              <Field label="Roll number"><input className={inputCls} value={editing.roll} onChange={(e) => setEditing({ ...editing, roll: e.target.value })} /></Field>
              <Field label="Name"><input className={inputCls} value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} /></Field>
              <Field label="Class / batch"><Select value={editing.classId} onChange={(v) => setEditing({ ...editing, classId: v })} options={state.classes.map((c) => ({ value: c.id, label: c.name }))} /></Field>
              <HostelOrDayFields state={state} hostelOrDay={editing.hostelOrDay} roomId={editing.roomId || ""} onHostelOrDayChange={(v) => setEditing({ ...editing, hostelOrDay: v, roomId: "" })} onRoomChange={(v) => setEditing({ ...editing, roomId: v })} />
            </div>
            {editError && <p className="mt-3 text-sm text-rose-600">{editError}</p>}
            <div className="mt-4 flex justify-end gap-2">
              <Btn variant="ghost" onClick={() => { setEditing(null); setEditError(""); }} disabled={editBusy}>Cancel</Btn>
              <Btn onClick={submitEdit} disabled={editBusy}>{editBusy ? <Loader2 className="animate-spin" size={14} /> : null} {editBusy ? "Sending..." : "Send for AO approval"}</Btn>
            </div>
          </Card>
        </div>
      )}
      {moving && <MoveStudentModal state={state} student={moving} runAction={runAction} onClose={() => setMoving(null)} />}
      {bulkMoveIds && (
        <BulkMoveModal
          state={state}
          studentIds={bulkMoveIds}
          runAction={runAction}
          onClose={() => {
            setSelectedIds((prev) => { const next = new Set(prev); bulkMoveIds.forEach((id) => next.delete(id)); return next; });
            setBulkMoveIds(null);
          }}
        />
      )}
    </div>
  );
}

// Hostel structure is three levels (Hostel -> Floor -> Room); college
// structure is two (CollegeFloor -> Class). Each level's dropdown is
// filtered by whatever's selected above it.
/* ---------------------------------------------------------------- */
/* Structure batches — draft-tree helpers, shared with AOApprovals    */
/* below (structureBatchCounts) and MyChanges (the edit/resubmit flow) */
/* ---------------------------------------------------------------- */
let structureDraftIdSeq = 0;
const uid = () => `d${structureDraftIdSeq++}`;

function pluralize(count, word, pluralWord) {
  return `${count} ${count === 1 ? word : pluralWord || `${word}s`}`;
}

// "001-010" -> ["001",...,"010"] (zero-padded to match the first number's
// width); plain comma-separated entries pass through unchanged. Anything
// that isn't a clean numeric range (letters, single values, malformed
// ranges) is left as its own literal entry rather than rejected — room and
// class labels aren't always numeric.
function expandListInput(raw) {
  const tokens = raw.split(",").map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const t of tokens) {
    const m = t.match(/^(\d+)\s*-\s*(\d+)$/);
    if (m) {
      const start = parseInt(m[1], 10), end = parseInt(m[2], 10), width = m[1].length;
      if (end >= start && end - start < 500) {
        for (let n = start; n <= end; n++) out.push(String(n).padStart(width, "0"));
        continue;
      }
    }
    out.push(t);
  }
  return out;
}

// PendingChange.payload -> local draft tree (adds a React-key-only `_id` to
// every hostel/floor/college-floor entry; rooms/classrooms are plain string
// arrays). Used both for a brand-new draft and to prefill the builder when
// resuming a sent-back batch.
function payloadToDraft(payload) {
  return {
    hostels: (payload?.hostels || []).map((h) => ({
      _id: uid(), existingHostelId: h.existingHostelId || null, name: h.name || "",
      floors: (h.floors || []).map((f) => ({
        _id: uid(), existingFloorId: f.existingFloorId || null, name: f.name || "", rooms: [...(f.rooms || [])],
      })),
    })),
    collegeFloors: (payload?.collegeFloors || []).map((cf) => ({
      _id: uid(), existingCollegeFloorId: cf.existingCollegeFloorId || null, name: cf.name || "",
      // Classrooms used to be plain strings (pre-year-field batches still
      // sitting in the queue as sent-back structure_batch changes) — normalize
      // either shape to {name, year} so the draft only ever deals with one.
      classrooms: (cf.classrooms || []).map((c) => (typeof c === "string" ? { name: c, year: null } : { name: c.name, year: c.year ?? null })),
    })),
  };
}
// Draft tree -> the payload shape the API expects (strips `_id`, and each
// entry carries either its name or its existing-parent id, never both).
function draftToPayload(draft) {
  return {
    hostels: draft.hostels.map((h) => ({
      ...(h.existingHostelId ? { existingHostelId: h.existingHostelId } : { name: h.name }),
      floors: h.floors.map((f) => ({
        ...(f.existingFloorId ? { existingFloorId: f.existingFloorId } : { name: f.name }),
        rooms: f.rooms,
      })),
    })),
    collegeFloors: draft.collegeFloors.map((cf) => ({
      ...(cf.existingCollegeFloorId ? { existingCollegeFloorId: cf.existingCollegeFloorId } : { name: cf.name }),
      classrooms: cf.classrooms,
    })),
  };
}
// How many rows a batch will actually CREATE — existing parents referenced
// by id don't count, only the new hostels/floors/rooms/college
// floors/classrooms in it. Mirrors server/src/structureBatch.js's counting
// exactly (frontend and backend are separate projects, so this is
// deliberately duplicated rather than imported — see the STAGES comment
// near the top of this file for the same tradeoff elsewhere).
function structureBatchCounts(payload) {
  let hostels = 0, floors = 0, rooms = 0, collegeFloors = 0, classrooms = 0;
  for (const h of payload?.hostels || []) {
    if (!h.existingHostelId) hostels++;
    for (const f of h.floors || []) {
      if (!f.existingFloorId) floors++;
      rooms += (f.rooms || []).length;
    }
  }
  for (const cf of payload?.collegeFloors || []) {
    if (!cf.existingCollegeFloorId) collegeFloors++;
    classrooms += (cf.classrooms || []).length;
  }
  return { hostels, floors, rooms, collegeFloors, classrooms, total: hostels + floors + rooms + collegeFloors + classrooms };
}

// A chip list + text input shared by rooms (under a floor) and classrooms
// (under a college floor) — comma lists and numeric ranges expand live via
// expandListInput, previewed before they're actually added.
function ListChipInput({ items, onChange, placeholder }) {
  const [text, setText] = useState("");
  const preview = text.trim() ? expandListInput(text) : [];
  const commit = () => {
    if (preview.length === 0) return;
    const seen = new Set(items.map((i) => i.toLowerCase()));
    const additions = preview.filter((p) => { const k = p.toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
    if (additions.length) onChange([...items, ...additions]);
    setText("");
  };
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((v) => (
          <span key={v} className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
            {v}
            <button onClick={() => onChange(items.filter((i) => i !== v))} className="text-slate-400 hover:text-rose-600" aria-label={`Remove ${v}`}><X size={11} /></button>
          </span>
        ))}
        {items.length === 0 && <span className="text-xs text-slate-400">None yet</span>}
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <input value={text} onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }}
          placeholder={placeholder} className={`${inputCls} text-xs`} />
        <Btn size="sm" variant="outline" onClick={commit} disabled={preview.length === 0}><Plus size={12} /></Btn>
      </div>
      {preview.length > 0 && <p className="mt-1 text-[11px] text-slate-400">Will add: {preview.join(", ")}</p>}
    </div>
  );
}

// Class/batch entry for a college floor draft — unlike rooms (a single
// string is enough), a class needs a name plus an optional year, so it
// gets its own chip input rather than reusing ListChipInput. Year is
// deliberately optional and non-blocking: not every class is organized by
// year, and the DB Manager shouldn't be forced to pick one to add a class.
function ClassroomChipInput({ items, onChange }) {
  const [name, setName] = useState("");
  const [year, setYear] = useState("");

  const commit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (items.some((c) => c.name.toLowerCase() === trimmed.toLowerCase())) { setName(""); setYear(""); return; }
    onChange([...items, { name: trimmed, year: year ? Number(year) : null }]);
    setName(""); setYear("");
  };

  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((c, i) => (
          <span key={`${c.name}-${i}`} className="inline-flex items-center gap-1.5 rounded-md bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
            {c.name}
            <Badge tone={c.year ? "blue" : "slate"}>{c.year ? `Year ${c.year}` : "no year"}</Badge>
            <button onClick={() => onChange(items.filter((_, idx) => idx !== i))} className="text-slate-400 hover:text-rose-600" aria-label={`Remove ${c.name}`}><X size={11} /></button>
          </span>
        ))}
        {items.length === 0 && <span className="text-xs text-slate-400">None yet</span>}
      </div>
      <div className="mt-1.5 flex items-center gap-1.5">
        <input value={name} onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); commit(); } }}
          placeholder="Class/batch name" className={`${inputCls} text-xs`} />
        <select value={year} onChange={(e) => setYear(e.target.value)} className={`${inputCls} w-auto text-xs`} aria-label="Year (optional)">
          <option value="">No year</option>
          <option value="1">Year 1</option>
          <option value="2">Year 2</option>
        </select>
        <Btn size="sm" variant="outline" onClick={commit} disabled={!name.trim()}><Plus size={12} /></Btn>
      </div>
    </div>
  );
}

function FloorDraftRow({ floor, onChange, onRemove }) {
  const isExisting = !!floor.existingFloorId;
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50/60 p-2.5">
      <div className="flex items-center justify-between gap-2">
        {isExisting ? (
          <div className="flex items-center gap-2"><span className="text-sm font-medium text-slate-600">{floor.name}</span><Badge tone="slate">existing</Badge></div>
        ) : (
          <input className={`${inputCls} max-w-[14rem]`} value={floor.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="New floor name" />
        )}
        <button onClick={onRemove} className="shrink-0 rounded p-1 text-slate-400 hover:bg-rose-50 hover:text-rose-600" aria-label="Remove floor"><Trash2 size={13} /></button>
      </div>
      <div className="mt-2"><ListChipInput items={floor.rooms} onChange={(rooms) => onChange({ rooms })} placeholder="Room no. e.g. 001-010 or 101,102" /></div>
    </div>
  );
}

function HostelDraftCard({ hostel, allHostelFloors, onChange, onRemove }) {
  const [open, setOpen] = useState(true);
  const isExisting = !!hostel.existingHostelId;
  const roomCount = hostel.floors.reduce((n, f) => n + f.rooms.length, 0);
  const existingFloorOptions = isExisting
    ? allHostelFloors.filter((f) => f.hostelId === hostel.existingHostelId && !hostel.floors.some((df) => df.existingFloorId === f.id))
    : [];

  const addNewFloor = () => onChange({ ...hostel, floors: [...hostel.floors, { _id: uid(), existingFloorId: null, name: "", rooms: [] }] });
  const addExistingFloor = (floorId) => {
    const f = allHostelFloors.find((x) => x.id === floorId);
    if (f) onChange({ ...hostel, floors: [...hostel.floors, { _id: uid(), existingFloorId: f.id, name: f.name, rooms: [] }] });
  };
  const updateFloor = (fid, patch) => onChange({ ...hostel, floors: hostel.floors.map((f) => (f._id === fid ? { ...f, ...patch } : f)) });
  const removeFloor = (fid) => onChange({ ...hostel, floors: hostel.floors.filter((f) => f._id !== fid) });

  return (
    <Card className="p-3">
      <div className="flex items-start justify-between gap-2">
        <button onClick={() => setOpen((o) => !o)} className="flex flex-1 items-center gap-2 text-left">
          <ChevronDown size={15} className={`mt-0.5 shrink-0 text-slate-400 transition-transform ${open ? "" : "-rotate-90"}`} />
          <div className="min-w-0 flex-1">
            {isExisting ? (
              <div className="flex items-center gap-2"><span className="truncate text-sm font-semibold text-slate-700">{hostel.name}</span><Badge tone="slate">existing</Badge></div>
            ) : (
              <input className={`${inputCls} max-w-xs`} value={hostel.name} onClick={(e) => e.stopPropagation()} onChange={(e) => onChange({ ...hostel, name: e.target.value })} placeholder="New hostel name" />
            )}
            <p className="mt-0.5 text-xs text-slate-400">{pluralize(hostel.floors.length, "floor")} · {pluralize(roomCount, "room")}</p>
          </div>
        </button>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          <Btn size="sm" variant="outline" onClick={addNewFloor}><Plus size={11} /> Floor</Btn>
          {existingFloorOptions.length > 0 && (
            <select className="rounded-lg border border-slate-300 px-2 py-1 text-xs text-slate-600" value=""
              onChange={(e) => { if (e.target.value) addExistingFloor(e.target.value); e.target.value = ""; }}>
              <option value="">+ Existing floor...</option>
              {existingFloorOptions.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          )}
          <button onClick={onRemove} className="rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" aria-label="Remove hostel"><Trash2 size={14} /></button>
        </div>
      </div>
      {open && (
        <div className="mt-3 space-y-2 border-l-2 border-slate-100 pl-3">
          {hostel.floors.map((f) => <FloorDraftRow key={f._id} floor={f} onChange={(patch) => updateFloor(f._id, patch)} onRemove={() => removeFloor(f._id)} />)}
          {hostel.floors.length === 0 && <p className="text-xs text-slate-400">No floors yet — add one.</p>}
        </div>
      )}
    </Card>
  );
}

function CollegeFloorDraftCard({ floor, onChange, onRemove }) {
  const isExisting = !!floor.existingCollegeFloorId;
  return (
    <Card className="p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {isExisting ? (
            <div className="flex items-center gap-2"><span className="text-sm font-semibold text-slate-700">{floor.name}</span><Badge tone="slate">existing</Badge></div>
          ) : (
            <input className={`${inputCls} max-w-xs`} value={floor.name} onChange={(e) => onChange({ ...floor, name: e.target.value })} placeholder="New college floor name" />
          )}
          <p className="mt-0.5 text-xs text-slate-400">{pluralize(floor.classrooms.length, "class", "classes")}</p>
        </div>
        <button onClick={onRemove} className="shrink-0 rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600" aria-label="Remove college floor"><Trash2 size={14} /></button>
      </div>
      <div className="mt-3"><ClassroomChipInput items={floor.classrooms} onChange={(classrooms) => onChange({ ...floor, classrooms })} /></div>
    </Card>
  );
}

// Replaces the old "one form per item" screen: the whole hostel/floor/room
// and college-floor/classroom structure is drafted locally as a tree and
// sent to the AO as a single structure_batch PendingChange — see
// server/src/structureBatch.js for how it's validated and applied.
// editBatch/onDoneEditing let MyChanges reopen this prefilled with a
// sent-back batch's payload (see the "Edit and resubmit" button there).
function StructureAdmin({ state, runAction, editBatch, onDoneEditing }) {
  const [draft, setDraft] = useState(() => (editBatch ? payloadToDraft(editBatch.payload) : { hostels: [], collegeFloors: [] }));
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => { if (editBatch) setDraft(payloadToDraft(editBatch.payload)); }, [editBatch?.id]);

  const isEditing = !!editBatch;
  const payload = draftToPayload(draft);
  const counts = structureBatchCounts(payload);

  const addNewHostel = () => setDraft((d) => ({ ...d, hostels: [...d.hostels, { _id: uid(), existingHostelId: null, name: "", floors: [] }] }));
  const addExistingHostel = (hostelId) => {
    const h = state.hostels.find((x) => x.id === hostelId);
    if (h) setDraft((d) => ({ ...d, hostels: [...d.hostels, { _id: uid(), existingHostelId: h.id, name: h.name, floors: [] }] }));
  };
  const updateHostel = (hid, next) => setDraft((d) => ({ ...d, hostels: d.hostels.map((h) => (h._id === hid ? next : h)) }));
  const removeHostel = (hid) => setDraft((d) => ({ ...d, hostels: d.hostels.filter((h) => h._id !== hid) }));

  const addNewCollegeFloor = () => setDraft((d) => ({ ...d, collegeFloors: [...d.collegeFloors, { _id: uid(), existingCollegeFloorId: null, name: "", classrooms: [] }] }));
  const addExistingCollegeFloor = (floorId) => {
    const f = state.collegeFloors.find((x) => x.id === floorId);
    if (f) setDraft((d) => ({ ...d, collegeFloors: [...d.collegeFloors, { _id: uid(), existingCollegeFloorId: f.id, name: f.name, classrooms: [] }] }));
  };
  const updateCollegeFloor = (fid, next) => setDraft((d) => ({ ...d, collegeFloors: d.collegeFloors.map((f) => (f._id === fid ? next : f)) }));
  const removeCollegeFloor = (fid) => setDraft((d) => ({ ...d, collegeFloors: d.collegeFloors.filter((f) => f._id !== fid) }));

  const existingHostelOptions = state.hostels.filter((h) => !draft.hostels.some((dh) => dh.existingHostelId === h.id));
  const existingCollegeFloorOptions = state.collegeFloors.filter((f) => !draft.collegeFloors.some((df) => df.existingCollegeFloorId === f.id));

  const submit = async () => {
    setError("");
    setSubmitting(true);
    try {
      const result = isEditing ? await api.editStructureBatch(editBatch.id, payload) : await api.submitStructureBatch(payload);
      await runAction(() => Promise.resolve(result), isEditing ? "Resent for AO approval" : "Sent for AO approval");
      setDraft({ hostels: [], collegeFloors: [] });
      if (isEditing) onDoneEditing();
    } catch (e) {
      setError(e.message || "Something went wrong");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div>
      <SectionTitle icon={Building2} title="Hostels & classes" subtitle="Build out the structure, then send it all to the AO for one approval. Nothing is created until then." />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <Badge tone="amber">Draft — not sent yet</Badge>
        <p className="text-xs text-slate-500">Add hostels, floors, and rooms freely. Nothing is created until the AO approves the whole batch.</p>
      </div>

      {isEditing && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <div><span className="font-medium">Editing a batch the AO sent back:</span> {editBatch.reason}</div>
          <button onClick={onDoneEditing} disabled={submitting} className="text-xs font-medium text-amber-700 underline underline-offset-2 disabled:opacity-40">Cancel edit</button>
        </div>
      )}

      {error && <p className="mb-3 text-sm text-rose-600">{error}</p>}

      <div className="space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Hostels</p>
        {draft.hostels.map((h) => (
          <HostelDraftCard key={h._id} hostel={h} allHostelFloors={state.hostelFloors} onChange={(next) => updateHostel(h._id, next)} onRemove={() => removeHostel(h._id)} />
        ))}
        {draft.hostels.length === 0 && <EmptyNote text="No hostels in this draft yet." />}
      </div>

      <div className="mt-6 space-y-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">College floors</p>
        {draft.collegeFloors.map((f) => (
          <CollegeFloorDraftCard key={f._id} floor={f} onChange={(next) => updateCollegeFloor(f._id, next)} onRemove={() => removeCollegeFloor(f._id)} />
        ))}
        {draft.collegeFloors.length === 0 && <EmptyNote text="No college floors in this draft yet." />}
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-slate-200 pt-4">
        <Btn variant="outline" onClick={addNewHostel}><Plus size={14} /> Add hostel</Btn>
        {existingHostelOptions.length > 0 && (
          <select className={`${inputCls} w-auto`} value="" onChange={(e) => { if (e.target.value) addExistingHostel(e.target.value); e.target.value = ""; }}>
            <option value="">+ Add floors/rooms to existing hostel...</option>
            {existingHostelOptions.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
          </select>
        )}
        <Btn variant="outline" onClick={addNewCollegeFloor}><Plus size={14} /> Add college floor</Btn>
        {existingCollegeFloorOptions.length > 0 && (
          <select className={`${inputCls} w-auto`} value="" onChange={(e) => { if (e.target.value) addExistingCollegeFloor(e.target.value); e.target.value = ""; }}>
            <option value="">+ Add classes to existing college floor...</option>
            {existingCollegeFloorOptions.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
        )}
        <div className="ml-auto">
          <ConfirmButton
            label={isEditing ? "Resend for AO approval" : "Send all for AO approval"}
            confirmLabel="Confirm"
            variant="primary"
            icon={Check}
            disabled={counts.total === 0}
            busy={submitting}
            onConfirm={submit}
          />
        </div>
      </div>
      {counts.total > 0 && <p className="mt-2 text-right text-xs text-slate-400">Will create {pluralize(counts.total, "record")}: {[
        counts.hostels && pluralize(counts.hostels, "hostel"),
        counts.floors && pluralize(counts.floors, "floor"),
        counts.rooms && pluralize(counts.rooms, "room"),
        counts.collegeFloors && pluralize(counts.collegeFloors, "college floor"),
        counts.classrooms && pluralize(counts.classrooms, "class", "classes"),
      ].filter(Boolean).join(", ")}</p>}

      <div className="mt-8 grid gap-4 md:grid-cols-2">
        <Card className="p-4">
          <p className="mb-2 text-sm font-semibold text-slate-700">Already-approved hostel structure</p>
          <ul className="space-y-1 text-sm text-slate-600">
            {state.hostelRooms.map((r) => <li key={r.id}>{roomLabel(state, r.id)}</li>)}
            {state.hostelRooms.length === 0 && <li className="text-slate-400">No rooms yet.</li>}
          </ul>
        </Card>
        <Card className="p-4">
          <p className="mb-2 text-sm font-semibold text-slate-700">Already-approved classes</p>
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
  const teachers = state.staff.filter((s) => s.role === "LECTURER");
  const lais = state.staff.filter((s) => s.role === "LAI");

  const [wardenId, setWardenId] = useState(""); const [wardenFloors, setWardenFloors] = useState([]);
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
      <SectionTitle icon={UserCog} title="Assign staff" subtitle="Wardens, DOs, and Lecturers are all pooled per floor — any one assigned can act." />
      <div className="grid gap-4 md:grid-cols-2">
        <Card className="p-4">
          <p className="mb-3 text-sm font-semibold text-slate-700">Assign Warden to floor(s)</p>
          <Field label="Warden"><Select value={wardenId} onChange={(v) => { setWardenId(v); setWardenFloors(state.staff.find((s) => s.id === v)?.floorIds || []); }} options={wardens.map((w) => ({ value: w.id, label: w.name }))} /></Field>
          <div className="mt-3"><CheckGroup options={hostelFloorOptions(state)} selected={wardenFloors} onToggle={(v) => setWardenFloors(toggle(wardenFloors, v))} /></div>
          <div className="mt-3"><Btn disabled={!wardenId} onClick={() => runAction(() => api.proposeChange("assign_warden", `Assign ${wardens.find((w) => w.id === wardenId)?.name} to ${wardenFloors.length} floor(s)`, { staffId: wardenId, floorIds: wardenFloors }), "Sent to AO for approval")}>Send for AO approval</Btn></div>
        </Card>
        <Card className="p-4">
          <p className="mb-3 text-sm font-semibold text-slate-700">Assign Discipline Officer to floor(s)</p>
          <Field label="DO"><Select value={doId} onChange={(v) => { setDoId(v); setDoFloors(state.staff.find((s) => s.id === v)?.floorIds || []); }} options={dos.map((w) => ({ value: w.id, label: w.name }))} /></Field>
          <div className="mt-3"><CheckGroup options={state.collegeFloors.map((f) => ({ value: f.id, label: f.name }))} selected={doFloors} onToggle={(v) => setDoFloors(toggle(doFloors, v))} /></div>
          <div className="mt-3"><Btn disabled={!doId} onClick={() => runAction(() => api.proposeChange("assign_do", `Assign ${dos.find((w) => w.id === doId)?.name} as DO`, { staffId: doId, floorIds: doFloors }), "Sent to AO for approval")}>Send for AO approval</Btn></div>
        </Card>
        <Card className="p-4">
          <p className="mb-3 text-sm font-semibold text-slate-700">Assign Lecturer to floor(s)</p>
          <Field label="Lecturer"><Select value={teacherId} onChange={(v) => { setTeacherId(v); setTeacherFloors(state.staff.find((s) => s.id === v)?.floorIds || []); }} options={teachers.map((w) => ({ value: w.id, label: w.name }))} /></Field>
          <div className="mt-3"><CheckGroup options={state.collegeFloors.map((f) => ({ value: f.id, label: f.name }))} selected={teacherFloors} onToggle={(v) => setTeacherFloors(toggle(teacherFloors, v))} /></div>
          <div className="mt-3"><Btn disabled={!teacherId} onClick={() => runAction(() => api.proposeChange("assign_teacher", `Assign ${teachers.find((w) => w.id === teacherId)?.name} as Lecturer`, { staffId: teacherId, floorIds: teacherFloors }), "Sent to AO for approval")}>Send for AO approval</Btn></div>
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
  const [busy, setBusy] = useState(false);
  const toggle = (arr, val) => (arr.includes(val) ? arr.filter((v) => v !== val) : [...arr, val]);

  const scopeOptions = role === "WARDEN" ? hostelFloorOptions(state)
    : role === "LAI" ? state.classes.map((c) => ({ value: c.id, label: c.name }))
    : state.collegeFloors.map((f) => ({ value: f.id, label: f.name })); // DO / LECTURER

  // Warden and DO/LECTURER both use floorIds now (a different floor type
  // depending on role — see schema.prisma's IMPORTANT MODELING NOTE); only
  // LAI's classIds is a genuinely different field.
  const scopeField = role === "LAI" ? "classIds" : "floorIds";
  const scopeLabel = role === "LAI" ? "Class(es)" : "Floor(s)";

  const submit = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    const payload = { name: name.trim(), role, [scopeField]: scope };
    const result = await runAction(() => api.proposeChange("create_staff", `Create ${ROLE_LABELS[role]} account: ${name.trim()}`, payload), "Sent to AO for approval");
    setBusy(false);
    if (result) { setJustSent({ name: name.trim(), role, key: result.change.payload.loginKey }); setName(""); setScope([]); }
  };

  const recent = state.pendingChanges.filter((c) => c.type === "create_staff").slice(0, 8);

  return (
    <div>
      <SectionTitle icon={UserPlus} title="Create a staff account" subtitle="Warden, Local Attendance Incharge, Discipline Officer, or Lecturer. Sent to the AO for approval before it can log in." />
      <Card className="mb-6 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <Field label="Role">
            <select value={role} onChange={(e) => { setRole(e.target.value); setScope([]); }} className={inputCls}>
              <option value="WARDEN">Warden</option>
              <option value="LAI">Local Attendance Incharge</option>
              <option value="DO">Discipline Officer</option>
              <option value="LECTURER">Lecturer</option>
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
        <div className="mt-4"><Btn onClick={submit} disabled={busy}>{busy ? <Loader2 className="animate-spin" size={14} /> : <Plus size={14} />} Send for AO approval</Btn></div>
      </Card>

      {justSent && (
        <Card className="mb-6 border-emerald-200 bg-emerald-50 p-4">
          <p className="text-sm text-emerald-800">
            Sent <span className="font-medium">{justSent.name}</span> ({ROLE_LABELS[justSent.role]}) to the AO —
            their login key will be <span className="font-display font-semibold">{justSent.key}</span> once approved. The AO will get a one-time temp password to hand over at that point.
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
// Resolves why one student is on the absentee list, from whichever of the
// three sources actually has it: a Warden's reason (wardenAbsences), an
// LAI's entry (laiAbsences — schema.prisma notes LAI never sets a reason,
// so this is always "—"), or the persistent away flag (Student.awayReason —
// "Went home" and similar; doesn't touch today's record at all, see
// constants.js). At most one of these applies to a given student on a given
// day, so the first match wins.
function resolveAbsenceReason(studentId, record, student) {
  const wardenEntry = record.wardenAbsences?.[studentId];
  if (wardenEntry) return { reason: wardenEntry.reason || "—", isAway: false };
  if (record.laiAbsences?.[studentId]) return { reason: "—", isAway: false };
  if (student.awayReason) return { reason: student.awayReason, isAway: true };
  return { reason: "—", isAway: false };
}

function AbsenteesView({ state }) {
  const [viewDate, setViewDate] = useState(todayStr());
  const day = sessionScoped(state.attendance[viewDate]);

  // Grouped by class, same Collapsible pattern as everywhere else, but
  // expanded by default (defaultOpen, not forceOpen — still individually
  // collapsible) since scanning the whole day's list is the entire point
  // of this page, unlike Manage students/View students where most classes
  // are collapsed noise until you search.
  const groups = state.classes
    .map((c) => {
      const r = day[c.id] || emptyRecord();
      const ids = new Set([...Object.keys(r.wardenAbsences || {}), ...Object.keys(r.laiAbsences || {})]);
      state.students.filter((s) => s.classId === c.id && s.awayReason).forEach((s) => ids.add(s.id));
      const students = [...ids]
        .map((sid) => state.students.find((s) => s.id === sid))
        .filter(Boolean)
        .map((s) => ({ ...s, ...resolveAbsenceReason(s.id, r, s) }));
      return { id: c.id, name: c.name, students };
    })
    .filter((g) => g.students.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <SectionTitle icon={ClipboardCheck} title="View absentees" subtitle={`${formatDMY(viewDate)} — grouped by class, with reason where recorded.`} />
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Date"><input type="date" max={todayStr()} className={inputCls} value={viewDate} onChange={(e) => setViewDate(e.target.value)} /></Field>
          <Btn variant="outline" onClick={() => api.exportAbsentees(viewDate)}><FileDown size={14} /> Download Excel</Btn>
        </div>
      </div>
      {groups.length === 0 ? (
        <EmptyNote text="No absentees recorded for this date." />
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <Card key={g.id} className="p-3">
              <Collapsible
                defaultOpen
                header={
                  <div className="flex flex-1 items-center justify-between gap-2">
                    <span className="font-medium text-slate-800">{g.name}</span>
                    <Badge tone="amber">{g.students.length} absent</Badge>
                  </div>
                }
              >
                <Card className="hidden overflow-x-auto md:block">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                      <tr><th className="px-4 py-2">Roll</th><th className="px-4 py-2">Name</th><th className="px-4 py-2">Reason</th></tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {g.students.map((s) => (
                        <tr key={s.id}>
                          <td className="px-4 py-2 text-slate-600">{s.roll}</td>
                          <td className="px-4 py-2 font-medium text-slate-800">{s.name}</td>
                          <td className="px-4 py-2 text-slate-600">{s.reason}{s.isAway && <span className="ml-1.5 text-xs text-slate-400">(away)</span>}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
                <div className="space-y-2 md:hidden">
                  {g.students.map((s) => (
                    <div key={s.id} className="rounded-lg border border-slate-200 p-3 text-sm">
                      <div className="flex items-center justify-between"><span className="font-medium text-slate-800">{s.name}</span><span className="text-xs text-slate-400">{s.roll}</span></div>
                      <div className="mt-1 text-xs text-slate-500">{s.reason}{s.isAway && <span className="ml-1.5 text-slate-400">(away)</span>}</div>
                    </div>
                  ))}
                </div>
              </Collapsible>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

// Date-range, per-class absentee breakdown for Principal/Coordinator —
// aggregates GET /attendance's existing range shape (same endpoint
// PrincipalHeroDashboard's trend/streak fetch already uses; no new backend
// work needed) rather than a new day-by-day list. Same grouped/collapsible
// visual pattern as AbsenteesView (DB Manager's single-day view) — each
// class's collapsible content is a per-student absence tally across the
// range instead of one day's raw list. Session-aware via the same
// sessionScoped-adjacent toggle used everywhere since Phase 1/2 (here
// applied per-record inline, since the aggregation walks every date in the
// range rather than one already-resolved day).
const CLASSWISE_DEFAULT_RANGE_DAYS = 6; // inclusive span of 7 days (today-6..today) — a default "past week" view

function ClasswiseAbsenteeReport({ state }) {
  const today = todayStr();
  const [from, setFrom] = useState(shiftDateStr(today, -CLASSWISE_DEFAULT_RANGE_DAYS));
  const [to, setTo] = useState(today);
  const [session, setSession] = useState(DEFAULT_SESSION);
  const [rangeData, setRangeData] = useState({ loading: true, data: {} });
  const validRange = from <= to;

  useEffect(() => {
    if (!validRange) return;
    let cancelled = false;
    setRangeData({ loading: true, data: {} });
    api.getAttendanceRange(from, to)
      .then((resp) => { if (!cancelled) setRangeData({ loading: false, data: resp.attendance || {} }); })
      .catch(() => { if (!cancelled) setRangeData({ loading: false, data: {} }); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to, validRange]);

  // Per class: every student absent on any date in range (this session),
  // and how many of the range's recorded days they were absent on — the
  // range equivalent of AbsenteesView's single-day per-student list.
  const groups = state.classes
    .map((c) => {
      const roster = state.students.filter((s) => s.classId === c.id);
      const tally = new Map(); // studentId -> count
      let daysWithRecord = 0;
      for (const date of Object.keys(rangeData.data)) {
        const record = rangeData.data[date]?.[c.id]?.[session];
        if (!record) continue;
        daysWithRecord++;
        const absentIds = new Set([...Object.keys(record.wardenAbsences || {}), ...Object.keys(record.laiAbsences || {})]);
        absentIds.forEach((sid) => tally.set(sid, (tally.get(sid) || 0) + 1));
      }
      const students = [...tally.entries()]
        .map(([sid, count]) => ({ student: roster.find((s) => s.id === sid), count }))
        .filter((x) => x.student)
        .sort((a, b) => b.count - a.count || a.student.roll.localeCompare(b.student.roll));
      const totalAbsences = students.reduce((n, x) => n + x.count, 0);
      const possible = roster.length * daysWithRecord;
      const pct = possible > 0 ? ((possible - totalAbsences) / possible) * 100 : null;
      return { id: c.id, name: c.name, daysWithRecord, students, totalAbsences, pct };
    })
    .filter((g) => g.students.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <SectionTitle icon={ClipboardList} title="Classwise absentee report" subtitle="Per-class absence tally over a date range." />
        <div className="flex flex-wrap items-end gap-2">
          <Field label="From"><input type="date" max={to} className={inputCls} value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><input type="date" max={today} className={inputCls} value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>
      </div>
      <div className="mb-4 inline-flex rounded-lg border border-slate-300 bg-white p-0.5">
        {SESSION_TABS.map((s) => (
          <button key={s.key} onClick={() => setSession(s.key)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${session === s.key ? "bg-[#12324D] text-white" : "text-slate-600 hover:bg-slate-100"}`}>
            {s.label}
          </button>
        ))}
      </div>
      {!validRange ? (
        <p className="text-sm text-rose-600">"From" must be on or before "To".</p>
      ) : rangeData.loading ? (
        <div className="grid h-40 place-items-center text-slate-400"><Loader2 className="animate-spin" size={18} /></div>
      ) : groups.length === 0 ? (
        <EmptyNote text="No absentees recorded in this range." />
      ) : (
        <div className="space-y-3">
          {groups.map((g) => (
            <Card key={g.id} className="p-3">
              <Collapsible
                header={
                  <div className="flex flex-1 flex-wrap items-center justify-between gap-2">
                    <span className="font-medium text-slate-800">{g.name}</span>
                    <div className="flex items-center gap-2">
                      {g.pct != null && <span className="text-xs text-slate-400">{Math.round(g.pct)}% present</span>}
                      <Badge tone="amber">{g.totalAbsences} absence{g.totalAbsences === 1 ? "" : "s"}</Badge>
                    </div>
                  </div>
                }
              >
                <Card className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                      <tr><th className="px-4 py-2">Roll</th><th className="px-4 py-2">Name</th><th className="px-4 py-2">Times absent</th></tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {g.students.map(({ student, count }) => (
                        <tr key={student.id}>
                          <td className="px-4 py-2 text-slate-600">{student.roll}</td>
                          <td className="px-4 py-2 font-medium text-slate-800">{student.name}</td>
                          <td className="px-4 py-2 text-slate-600">{count} / {g.daysWithRecord}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              </Collapsible>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function myChangeTone(status) {
  return status === "approved" ? "emerald" : status === "rejected" ? "rose" : status === "sent_back" ? "amber" : "amber";
}

// {roll, name, classId, roomId, isLocal} (add_student's payload, or one
// entry of bulk_add_students' payload.students) -> a row this modal's table
// can edit, using the same hostelId-or-DAY_SCHOLAR_VALUE convention as
// HostelOrDayFields above so the "which room options apply" logic
// (roomsForHostel) is shared rather than reimplemented.
function studentPayloadRowToEditable(state, s) {
  return {
    _id: uid(),
    roll: s.roll,
    name: s.name,
    hostelChoice: s.isLocal ? DAY_SCHOLAR_VALUE : (hostelIdForRoom(state, s.roomId) || DAY_SCHOLAR_VALUE),
    roomId: s.isLocal ? "" : (s.roomId || ""),
  };
}
// Lets the Database Manager fix a sent-back add_student/bulk_add_students
// change in place — no need to re-upload Excel over one bad row. Submits
// the same {roll, name, hostelOrDay, roomNo} row shape the Excel importer
// uses; the server re-runs the identical validateImportRows rules (see
// routes/changes.js's PUT /changes/:id), so a fix here can never be looser
// than what a fresh upload would accept.
function EditStudentChangeModal({ state, change, onClose, runAction }) {
  const isBulk = change.type === "bulk_add_students";
  const [rows, setRows] = useState(() =>
    isBulk ? change.payload.students.map((s) => studentPayloadRowToEditable(state, s)) : [studentPayloadRowToEditable(state, change.payload)]
  );
  const [errors, setErrors] = useState([]);
  const [busy, setBusy] = useState(false);

  const classId = isBulk ? change.payload.students[0]?.classId : change.payload.classId;
  const className = state.classes.find((c) => c.id === classId)?.name || "?";

  const updateRow = (id, patch) => setRows((rs) => rs.map((r) => (r._id === id ? { ...r, ...patch } : r)));
  const removeRow = (id) => setRows((rs) => rs.filter((r) => r._id !== id));

  const submit = async () => {
    setErrors([]);
    setBusy(true);
    const rowsPayload = rows.map((r) => ({
      roll: r.roll,
      name: r.name,
      hostelOrDay: r.hostelChoice === DAY_SCHOLAR_VALUE ? "Day scholar" : (state.hostels.find((h) => h.id === r.hostelChoice)?.name || ""),
      roomNo: r.hostelChoice === DAY_SCHOLAR_VALUE ? "" : (state.hostelRooms.find((rm) => rm.id === r.roomId)?.roomNo || ""),
    }));
    try {
      const result = await api.editChange(change.id, rowsPayload);
      await runAction(() => Promise.resolve(result), "Resent for AO approval");
      onClose();
    } catch (e) {
      setErrors(e.errors?.length > 0 ? e.errors : [e.message]);
    }
    setBusy(false);
  };

  return (
    <Modal title={isBulk ? `Edit student batch — ${className}` : "Edit student"} onClose={onClose}>
      <div className="space-y-3">
        <p className="text-xs text-slate-500">Class: <span className="font-medium text-slate-700">{className}</span> (fixed — this edits the rows, not which class they belong to)</p>
        {errors.length > 0 && (
          <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-rose-200 bg-rose-50 p-2 text-xs text-rose-700">
            {errors.map((e, i) => <p key={i}>{e}</p>)}
          </div>
        )}
        <div className="max-h-[50vh] space-y-2 overflow-y-auto">
          {rows.map((r) => (
            <div key={r._id} className="grid grid-cols-2 gap-2 rounded-lg border border-slate-100 p-2.5 sm:grid-cols-[1fr_1.3fr_1.3fr_1fr_auto]">
              <Field label="Roll"><input className={inputCls} value={r.roll} onChange={(e) => updateRow(r._id, { roll: e.target.value })} /></Field>
              <Field label="Name"><input className={inputCls} value={r.name} onChange={(e) => updateRow(r._id, { name: e.target.value })} /></Field>
              <Field label="Day scholar / hostel">
                <select className={inputCls} value={r.hostelChoice} onChange={(e) => updateRow(r._id, { hostelChoice: e.target.value, roomId: "" })}>
                  <option value={DAY_SCHOLAR_VALUE}>Day scholar</option>
                  {state.hostels.map((h) => <option key={h.id} value={h.id}>{h.name}</option>)}
                </select>
              </Field>
              {r.hostelChoice !== DAY_SCHOLAR_VALUE ? (
                <Field label="Room"><Select value={r.roomId} onChange={(v) => updateRow(r._id, { roomId: v })} options={roomsForHostel(state, r.hostelChoice).map((rm) => ({ value: rm.id, label: rm.roomNo }))} /></Field>
              ) : <div />}
              {isBulk && (
                <button onClick={() => removeRow(r._id)} className="self-end justify-self-end rounded p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600 sm:mb-1.5" aria-label="Remove row"><Trash2 size={14} /></button>
              )}
            </div>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Btn variant="ghost" onClick={onClose} disabled={busy}>Cancel</Btn>
          <Btn onClick={submit} disabled={busy || rows.length === 0}>{busy ? <Loader2 className="animate-spin" size={14} /> : <Check size={14} />} {busy ? "Sending..." : "Resend for AO approval"}</Btn>
        </div>
      </div>
    </Modal>
  );
}

function MyChanges({ state, me, runAction, onEditBatch }) {
  const mine = state.pendingChanges.filter((c) => c.requestedById === me.id);
  const [showOlderMine, setShowOlderMine] = useState(false);
  const [editingChange, setEditingChange] = useState(null);
  const visibleMine = showOlderMine ? mine : mine.filter(isAlwaysVisibleDecision);

  return (
    <div>
      <SectionTitle icon={Clock} title="My requests" subtitle="Everything you've sent to the AO." />
      {mine.length === 0 && <EmptyNote text="You haven't submitted anything yet." />}
      <div className="space-y-2">
        {visibleMine.map((c) => {
          const isBatch = c.type === "structure_batch";
          const isStudentChange = c.type === "add_student" || c.type === "bulk_add_students";
          const isSyncChange = c.type === "sync_class_students";
          const isMoveChange = c.type === "move_student" || c.type === "move_students_batch";
          const sentBack = c.status === "sent_back";
          return (
            <div key={c.id} className={`rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm ${(isBatch || isStudentChange || isSyncChange || isMoveChange) && sentBack ? "border-amber-200" : ""}`}>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-700">{isBatch ? `Structure batch — ${c.summary}` : c.summary}</span>
                <Badge tone={myChangeTone(c.status)}>{c.status.replace("_", " ")}</Badge>
              </div>
              {isBatch && sentBack && (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 px-2.5 py-2">
                  <p className="text-xs text-amber-800"><span className="font-medium">AO's reason:</span> {c.reason}</p>
                  <Btn size="sm" variant="outline" onClick={() => onEditBatch(c)}><Pencil size={12} /> Edit and resubmit</Btn>
                </div>
              )}
              {isStudentChange && sentBack && (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 px-2.5 py-2">
                  <p className="text-xs text-amber-800"><span className="font-medium">AO's reason:</span> {c.reason}</p>
                  <Btn size="sm" variant="outline" onClick={() => setEditingChange(c)}><Pencil size={12} /> Edit and resubmit</Btn>
                </div>
              )}
              {isSyncChange && sentBack && (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 px-2.5 py-2">
                  <p className="text-xs text-amber-800">
                    <span className="font-medium">AO's reason:</span> {c.reason} — a roster sync isn't edited in place: download a fresh export, fix it in Excel, and re-upload to resubmit.
                  </p>
                  <Btn
                    size="sm"
                    variant="outline"
                    onClick={() => api.exportStudents(c.payload.classId, state.classes.find((cl) => cl.id === c.payload.classId)?.name || "class")}
                  >
                    <FileDown size={12} /> Download current export
                  </Btn>
                </div>
              )}
              {isMoveChange && sentBack && (
                <div className="mt-2 rounded-lg bg-amber-50 px-2.5 py-2">
                  <p className="text-xs text-amber-800">
                    <span className="font-medium">AO's reason:</span> {c.reason} — a move isn't edited in place: redo it from Manage students once you've decided what to change.
                  </p>
                </div>
              )}
            </div>
          );
        })}
        {visibleMine.length === 0 && mine.length > 0 && <p className="text-sm text-slate-400">Nothing recent — everything's older than 2 days.</p>}
      </div>
      <ShowOlderToggle olderCount={mine.length - visibleMine.length} shown={showOlderMine} onShow={() => setShowOlderMine(true)} />
      {editingChange && <EditStudentChangeModal state={state} change={editingChange} runAction={runAction} onClose={() => setEditingChange(null)} />}
    </div>
  );
}

/* ---------------------------------------------------------------- */
/* 5e. Warden and LAI                                                  */
/* ---------------------------------------------------------------- */
function WardenScreen({ state, date, me, runAction }) {
  // A Warden's students are every hosteller in any room on one of their
  // assigned hostel floors (me.floorIds) — resolved via state.hostelRooms
  // since Student only carries roomId, not the floor it's on.
  const myFloorIds = me.floorIds || [];
  const myRoomIds = new Set(state.hostelRooms.filter((r) => myFloorIds.includes(r.hostelFloorId)).map((r) => r.id));
  const allStudents = state.students.filter((s) => myRoomIds.has(s.roomId));
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
          const r = state.attendance[date]?.[classId]?.[DEFAULT_SESSION] || emptyRecord();
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
          const r = state.attendance[date]?.[classId]?.[DEFAULT_SESSION] || emptyRecord();
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
function DoClassCard({ c, record, date, session, students, runAction }) {
  const [headcount, setHeadcount] = useState(record.headcount ?? "");
  const [subTab, setSubTab] = useState("confirm"); // "confirm" (Window 1) | "reasons" (Window 2)
  const combined = { ...(record.wardenAbsences || {}), ...(record.laiAbsences || {}) };
  const list = Object.entries(combined).map(([sid, meta]) => ({
    student: students.find((s) => s.id === sid), meta,
    confirmed: !!record.doConfirmed?.[sid],
    verified: record.doVerified?.[sid]?.reason || null,
    // Auto-carried from the morning session's already-verified reason (see
    // /confirm's server-side logic) rather than a fresh call this session —
    // shown distinctly so the DO/Lecturer/Coordinator don't read it as a
    // new phone call that happened this afternoon.
    carriedFromMorning: !!record.doVerified?.[sid]?.carriedFromMorning,
  }));
  const away = students.filter((s) => s.classId === c.id && s.awayReason);
  const approved = !!record.doApproved;
  const headcountSaved = record.headcount != null;
  const confirmedCount = list.filter((i) => i.confirmed).length;
  const reasonedCount = list.filter((i) => i.verified).length;
  const allConfirmed = list.every((i) => i.confirmed);
  const allReasoned = list.every((i) => i.verified);

  const saveReason = (sid, reason) => runAction(() => api.verifyReason(date, c.id, sid, reason, session));

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
            <Btn size="sm" variant="outline" onClick={() => runAction(() => api.setHeadcount(date, c.id, Number(headcount), session))}>Save</Btn>
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
                      <button className="text-xs text-slate-400 underline hover:text-rose-600" onClick={() => runAction(() => api.correctPresence(date, c.id, student.id, session), "Marked present instead")}>Actually present?</button>
                    </div>
                  ) : (
                    <div className="flex gap-1.5">
                      <Btn size="sm" variant="success" onClick={() => runAction(() => api.confirmAbsent(date, c.id, student.id, session))}>Confirm absent</Btn>
                      <Btn size="sm" variant="outline" onClick={() => runAction(() => api.correctPresence(date, c.id, student.id, session), "Marked present")}>Actually present</Btn>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-3 space-y-2">
              <p className="text-xs text-slate-500">Later, after calling home or the Warden — record the actual reason for each confirmed absentee.</p>
              {list.filter((i) => i.confirmed).map(({ student, meta, verified, carriedFromMorning }) => student && (
                <div key={student.id} className="rounded-lg bg-slate-50 px-3 py-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span className="text-slate-700">{student.name} <span className="text-xs text-slate-400">({student.roll}) — {meta.reason ? `Warden: ${meta.reason}` : "reported by LAI, no reason yet"}</span></span>
                    {verified && (
                      carriedFromMorning
                        ? <Badge tone="blue">Same as this morning — no call needed</Badge>
                        : <Badge tone="emerald"><CheckCircle2 size={11} /> Verified</Badge>
                    )}
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
            <Btn variant="success" disabled={approved || !allConfirmed || !allReasoned} onClick={() => runAction(() => api.approveStage(date, c.id, session), "Approved")}>
              <CheckCircle2 size={14} /> {!allConfirmed ? "Finish the classroom check first" : !allReasoned ? "Call & confirm reasons first" : "Approve list"}
            </Btn>
            {!approved && <SendBackButton onSend={(reason) => runAction(() => api.sendBack(date, c.id, reason, session), "Sent back to Warden/LAI")} />}
          </div>
        </>
      )}
    </Card>
  );
}

// MORNING/AFTERNOON, in this order everywhere a DO picks a session — the
// order a real day happens in, not alphabetical.
const SESSION_TABS = [
  { key: "MORNING", label: "Morning" },
  { key: "AFTERNOON", label: "Afternoon" },
];

function DOScreen({ state, date, me, runAction }) {
  const floorClasses = state.classes.filter((c) => (me.floorIds || []).includes(c.collegeFloorId));
  const poolmates = state.staff.filter((s) => s.role === "DO" && s.id !== me.id && (s.floorIds || []).some((f) => (me.floorIds || []).includes(f)));
  const [session, setSession] = useState(DEFAULT_SESSION);
  return (
    <div>
      <SectionTitle icon={Phone} title="Verify & approve" subtitle="Two or more DOs can cover the same floor — split the classes between yourselves however works, or overlap freely; whoever approves a class first completes it for everyone." />
      {poolmates.length > 0 && <p className="mb-4 text-xs text-slate-400">Sharing this floor with: {poolmates.map((p) => p.name).join(", ")}</p>}
      <div className="mb-4 inline-flex rounded-lg border border-slate-300 bg-white p-0.5">
        {SESSION_TABS.map((s) => (
          <button key={s.key} onClick={() => setSession(s.key)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${session === s.key ? "bg-[#12324D] text-white" : "text-slate-600 hover:bg-slate-100"}`}>
            {s.label}
          </button>
        ))}
      </div>
      <div className="space-y-4">
        {floorClasses.map((c) => (
          <DoClassCard key={`${c.id}-${session}`} c={c} record={state.attendance[date]?.[c.id]?.[session] || emptyRecord()} date={date} session={session} students={state.students} runAction={runAction} />
        ))}
        {floorClasses.length === 0 && <EmptyNote text="No floor assigned to you yet." />}
      </div>
    </div>
  );
}
