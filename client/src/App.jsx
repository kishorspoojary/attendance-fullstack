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
  CalendarSearch, UserX, ListTree,
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
function ConfirmButton({ label, confirmLabel, variant = "danger", icon: Icon, onConfirm, disabled }) {
  const [open, setOpen] = useState(false);
  if (!open) return <Btn size="touch" variant={variant} disabled={disabled} onClick={() => setOpen(true)}>{Icon && <Icon size={12} />} {label}</Btn>;
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
      { id: "leadership", label: "Leadership accounts", icon: UserPlus },
    ],
    AO: [
      { id: "approvals", label: "Master data approvals", icon: ShieldCheck },
      { id: "freeze", label: "Freeze / unfreeze", icon: Snowflake },
      { id: "hierarchy", label: "Hierarchy status", icon: Users },
      { id: "viewstudents", label: "View students", icon: ListTree },
    ],
    COORDINATOR: [
      { id: "coordinator", label: "Attendance approvals", icon: ListChecks },
      { id: "status", label: "Attendance status", icon: LayoutDashboard },
    ],
    DB_MANAGER: [
      { id: "students", label: "Students", icon: GraduationCap },
      { id: "viewstudents", label: "View students", icon: ListTree },
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
              {activeTab === "dashboard" && <PrincipalDashboard state={state} date={date} />}
              {activeTab === "leadership" && <LeadershipSetup state={state} runAction={runAction} />}
              {activeTab === "approvals" && <AOApprovals state={state} runAction={runAction} />}
              {activeTab === "freeze" && <AOFreezeAccounts state={state} runAction={runAction} me={me} />}
              {activeTab === "hierarchy" && <AOHierarchyStatus state={state} />}
              {activeTab === "viewstudents" && <ViewStudents me={me} />}
              {activeTab === "coordinator" && <CoordinatorApprovals state={state} date={date} runAction={runAction} />}
              {activeTab === "status" && <PrincipalDashboard state={state} date={date} scopeFloorIds={me.role === "INCHARGE_TEACHER" ? me.floorIds : null} title="Attendance status" subtitle="Visible any time — not just when something is waiting on you." />}
              {activeTab === "students" && <StudentsAdmin state={state} runAction={runAction} />}
              {activeTab === "structure" && <StructureAdmin state={state} runAction={runAction} editBatch={editBatch} onDoneEditing={() => setEditBatch(null)} />}
              {activeTab === "assign" && <AssignAdmin state={state} runAction={runAction} />}
              {activeTab === "createstaff" && <CreateStaffAdmin state={state} runAction={runAction} />}
              {activeTab === "absentees" && <AbsenteesView state={state} />}
              {activeTab === "mychanges" && <MyChanges state={state} me={me} onEditBatch={(c) => { setEditBatch(c); setTab("structure"); }} />}
              {activeTab === "warden" && <WardenScreen state={state} date={date} me={me} runAction={runAction} />}
              {activeTab === "do" && <DOScreen state={state} date={date} me={me} runAction={runAction} />}
              {activeTab === "teacher" && <ApprovalQueue state={state} date={date} runAction={runAction} stageKey="teacherApproved" requiredPriorKey="doApproved" roleLabel="Incharge Teacher" note="Lists appear once the Discipline Officer has verified them. Any Incharge Teacher on the floor can file this." />}
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
              const tag = recordTag(r);
              return (
                <tr key={c.id}>
                  <td className="px-4 py-2.5 font-medium text-slate-800">{c.name}</td>
                  <td className="px-4 py-2.5 text-slate-600">{absentCount}</td>
                  <td className="px-4 py-2.5"><Badge tone={tag.tone}>{tag.label}</Badge></td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={3} className="px-4 py-10 text-center text-slate-400">
                  <CalendarSearch className="mx-auto mb-2" size={28} />
                  <div>No classes in this scope yet.</div>
                  <div className="mt-1 text-xs">Try a different date, or check back after the Coordinator publishes.</div>
                </td>
              </tr>
            )}
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
          {cf.classrooms?.length > 0 && <div className="ml-4 mt-1 text-xs text-slate-500">Classes: {cf.classrooms.join(", ")}</div>}
        </div>
      ))}
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

  const approve = async (c) => {
    const result = await runAction(() => api.approveChange(c.id), "Approved");
    if (result?.password) setNewStaffPassword({ name: c.payload?.name || "the new account", password: result.password });
  };
  const reject = (c) => runAction(() => api.rejectChange(c.id, "Not approved"), "Rejected");
  const sendBackBatch = (c, reason) => runAction(() => api.sendBackStructureBatch(c.id, reason), "Sent back for edits");

  const decisionTone = (status) => (status === "approved" ? "emerald" : status === "sent_back" ? "amber" : "rose");

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
                  <SendBackButton onSend={(reason) => sendBackBatch(c, reason)} />
                  <Btn size="sm" variant="success" onClick={() => approve(c)}><Check size={13} /> Approve all — create {pluralize(counts.total, "record")}</Btn>
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
                <div className="flex gap-2">
                  <Btn size="sm" variant="success" onClick={() => approve(c)}><Check size={13} /> Approve</Btn>
                  <Btn size="sm" variant="danger" onClick={() => reject(c)}><X size={13} /> Reject</Btn>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
      <div className="mt-8">
        <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Recent decisions</p>
        <div className="space-y-2">
          {state.pendingChanges.filter((c) => c.status !== "pending").slice(0, 6).map((c) => (
            <div key={c.id} className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm">
              <span className="text-slate-600">{c.type === "structure_batch" ? `Structure batch — ${c.summary}` : c.summary}</span>
              <Badge tone={decisionTone(c.status)}>{c.status.replace("_", " ")}</Badge>
            </div>
          ))}
        </div>
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
function Collapsible({ header, children, forceOpen }) {
  const [open, setOpen] = useState(false);
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
// their hostel dimension ("Boys Hostel A · Room 101") or a "Day scholar"
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
                      <td className="px-4 py-2">{s.hostelName ? `${s.hostelName} · Room ${s.roomNo}` : <Badge tone="amber">Day scholar</Badge>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
            <div className="space-y-2 md:hidden">
              {c.filteredStudents.map((s) => (
                <div key={s.id} className="rounded-lg border border-slate-200 p-3 text-sm">
                  <div className="flex items-center justify-between"><span className="font-medium text-slate-800">{s.name}</span><span className="text-xs text-slate-400">{s.roll}</span></div>
                  <div className="mt-1">{s.hostelName ? <span className="text-xs text-slate-500">{s.hostelName} · Room {s.roomNo}</span> : <Badge tone="amber">Day scholar</Badge>}</div>
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
  const [importBusy, setImportBusy] = useState(false);
  const [importResult, setImportResult] = useState(null);

  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // lets the same file be picked again after fixing it
    if (!file) return;
    setImportBusy(true); setImportResult(null);
    try {
      const result = await api.importStudents(file);
      setImportResult(result);
      if (result.addedCount > 0) await runAction(() => Promise.resolve(), `${result.addedCount} student(s) sent to AO for approval`);
    } catch (e2) {
      setImportResult({ addedCount: 0, warnings: [], errors: [e2.message] });
    }
    setImportBusy(false);
  };

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

      <Card className="mb-6 p-4">
        <p className="mb-1 text-sm font-semibold text-slate-700">Add many at once with Excel</p>
        <p className="mb-3 text-xs text-slate-500">Download the template, fill it in (it includes a reference sheet with the exact class and room names already in the system), then upload it back. Everything you upload still goes to the AO for approval, just as one request instead of many.</p>
        <div className="flex flex-wrap gap-2">
          <Btn variant="outline" onClick={() => api.downloadStudentTemplate()}><FileDown size={14} /> Download template</Btn>
          <Btn variant="outline" onClick={() => api.exportStudents()}><FileDown size={14} /> Export current list</Btn>
          <label className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-[#12324D] px-3.5 py-2 text-sm font-medium text-white hover:bg-[#0d2438]">
            {importBusy ? <Loader2 className="animate-spin" size={14} /> : <FileUp size={14} />} Upload filled sheet
            <input type="file" accept=".xlsx" className="hidden" onChange={handleUpload} disabled={importBusy} />
          </label>
        </div>
        {importResult && (
          <div className="mt-3 space-y-2 text-sm">
            {importResult.addedCount > 0 && <p className="text-emerald-700">{importResult.addedCount} student(s) ready, pending AO approval.</p>}
            {importResult.warnings?.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-amber-800">
                {importResult.warnings.map((w, i) => <p key={i}>{w}</p>)}
              </div>
            )}
            {importResult.errors?.length > 0 && (
              <div className="rounded-lg border border-rose-200 bg-rose-50 p-2 text-rose-800">
                {importResult.errors.map((e, i) => <p key={i}>{e}</p>)}
              </div>
            )}
          </div>
        )}
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
      _id: uid(), existingCollegeFloorId: cf.existingCollegeFloorId || null, name: cf.name || "", classrooms: [...(cf.classrooms || [])],
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
      <div className="mt-3"><ListChipInput items={floor.classrooms} onChange={(classrooms) => onChange({ ...floor, classrooms })} placeholder="Class/batch name, comma separated" /></div>
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
          <button onClick={onDoneEditing} className="text-xs font-medium text-amber-700 underline underline-offset-2">Cancel edit</button>
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
            label={submitting ? "Sending..." : isEditing ? "Resend for AO approval" : "Send all for AO approval"}
            confirmLabel="Confirm"
            variant="primary"
            icon={Check}
            disabled={counts.total === 0 || submitting}
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
  const [busy, setBusy] = useState(false);
  const toggle = (arr, val) => (arr.includes(val) ? arr.filter((v) => v !== val) : [...arr, val]);

  const scopeOptions = role === "WARDEN" ? roomOptions(state)
    : role === "LAI" ? state.classes.map((c) => ({ value: c.id, label: c.name }))
    : state.collegeFloors.map((f) => ({ value: f.id, label: f.name })); // DO / INCHARGE_TEACHER

  const scopeField = role === "WARDEN" ? "roomIds" : role === "LAI" ? "classIds" : "floorIds";
  const scopeLabel = role === "WARDEN" ? "Room(s)" : role === "LAI" ? "Class(es)" : "Floor(s)";

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
        <div className="flex flex-wrap items-end gap-2">
          <Field label="Date"><input type="date" max={todayStr()} className={inputCls} value={viewDate} onChange={(e) => setViewDate(e.target.value)} /></Field>
          <Btn variant="outline" onClick={() => api.exportAbsentees(viewDate)}><FileDown size={14} /> Download Excel</Btn>
        </div>
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

function myChangeTone(status) {
  return status === "approved" ? "emerald" : status === "rejected" ? "rose" : status === "sent_back" ? "amber" : "amber";
}
function MyChanges({ state, me, onEditBatch }) {
  const mine = state.pendingChanges.filter((c) => c.requestedById === me.id);
  return (
    <div>
      <SectionTitle icon={Clock} title="My requests" subtitle="Everything you've sent to the AO." />
      {mine.length === 0 && <EmptyNote text="You haven't submitted anything yet." />}
      <div className="space-y-2">
        {mine.map((c) => {
          const isBatch = c.type === "structure_batch";
          return (
            <div key={c.id} className={`rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm ${isBatch && c.status === "sent_back" ? "border-amber-200" : ""}`}>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-700">{isBatch ? `Structure batch — ${c.summary}` : c.summary}</span>
                <Badge tone={myChangeTone(c.status)}>{c.status.replace("_", " ")}</Badge>
              </div>
              {isBatch && c.status === "sent_back" && (
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 px-2.5 py-2">
                  <p className="text-xs text-amber-800"><span className="font-medium">AO's reason:</span> {c.reason}</p>
                  <Btn size="sm" variant="outline" onClick={() => onEditBatch(c)}><Pencil size={12} /> Edit and resubmit</Btn>
                </div>
              )}
            </div>
          );
        })}
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
