"use client";

/**
 * Administration — employee directory, roles & departments, company employee
 * IDs (invitations), and the audit trail. Admin-only; the backend rejects
 * every one of these endpoints for non-admins regardless of what the UI shows.
 */
import { useCallback, useEffect, useState } from "react";
import {
  ClipboardCopy,
  Crown,
  Download,
  IdCard,
  KeyRound,
  ScrollText,
  ShieldCheck,
  Trash2,
  UploadCloud,
  UserPlus,
  Users,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { AdminUser, AuditEntry, Department, Invite, Role, Stats } from "@/lib/types";
import { Badge, Btn, ErrorNote, Field, PageHeader, Panel, formatDate, inputCls } from "@/components/ui";

const STATS = [
  { key: "users", label: "Members", icon: Users },
  { key: "documents", label: "Documents", icon: ShieldCheck },
  { key: "queries", label: "Queries", icon: KeyRound },
  { key: "chunks", label: "Indexed Passages", icon: ScrollText },
] as const;

const ACTION_TONES: Record<string, "emerald" | "indigo" | "amber" | "red" | "slate"> = {
  login: "emerald",
  org_created: "indigo",
  user_joined: "emerald",
  user_updated: "indigo",
  user_deleted: "red",
  invite_created: "amber",
  doc_uploaded: "indigo",
  doc_downloaded: "slate",
  doc_deleted: "amber",
  doc_access_changed: "amber",
  dept_created: "slate",
  dept_deleted: "red",
  query: "slate",
  search: "indigo",
};

function agreementStatus(u: AdminUser): "Active" | "Expiring Soon" | "Expired" {
  if (!u.agreement_end) return "Active";
  const end = new Date(u.agreement_end);
  if (isNaN(end.getTime())) return "Active";
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  if (end < today) return "Expired";
  const soon = new Date(today);
  soon.setDate(soon.getDate() + 30);
  if (end <= soon) return "Expiring Soon";
  return "Active";
}
export default function AdminPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [stats, setStats] = useState<Stats | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [depts, setDepts] = useState<Department[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [issued, setIssued] = useState<string>("");
  const [emailNonce, setEmailNonce] = useState(0); // remount email cells after a rejected edit

  // invite form
  const [dept, setDept] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);

  // bulk onboarding (CSV)
  const [csvFile, setCsvFile] = useState<File | null>(null);
  const [csvBusy, setCsvBusy] = useState(false);
  const [csvError, setCsvError] = useState("");
  const [csvResult, setCsvResult] = useState<any>(null);

  const downloadTemplate = () => {
    window.location.href = "/api/admin/onboarding/template";
  };

  const importCsv = async () => {
    if (!csvFile) return;
    setCsvBusy(true);
    setCsvError("");
    setCsvResult(null);
    try {
      const fd = new FormData();
      fd.append("file", csvFile);
      const res = await api.upload<any>("/api/admin/onboarding/import", fd);
      setCsvResult(res);
      load();
    } catch (e) {
      setCsvError(e instanceof ApiError ? e.message : "Import failed");
    } finally {
      setCsvBusy(false);
    }
  };

  const load = useCallback(() => {
    if (!isAdmin) return;
    Promise.all([
      api.get<Stats>("/api/admin/stats"),
      api.get<AdminUser[]>("/api/admin/users"),
      api.get<Department[]>("/api/departments"),
      api.get<Invite[]>("/api/admin/invites"),
      api.get<AuditEntry[]>("/api/admin/audit"),
    ])
      .then(([s, u, d, i, a]) => {
        setStats(s);
        setUsers(u);
        setDepts(d);
        setInvites(i);
        setAudit(a);
        setError("");
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [isAdmin]);

  useEffect(load, [load]);

  if (!isAdmin) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-16 text-center">
        <p className="text-sm text-slate-500">
          Administration is restricted to organization admins.
        </p>
      </div>
    );
  }

  async function patchUser(
    id: string,
    body: { role?: Role; department?: string; is_manager?: boolean;
            employment_type?: string; agreement_start?: string | null; agreement_end?: string | null;
            full_name?: string | null },
  ) {
    try {
      await api.patch(`/api/admin/users/${id}`, body);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Update failed");
    }
  }

  async function removeUser(u: AdminUser) {
    if (!window.confirm(`Remove ${u.username} from the organization?`)) return;
    try {
      await api.del(`/api/admin/users/${u.id}`);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Delete failed");
    }
  }

  async function saveEmail(u: AdminUser, value: string) {
    const next = value.trim().toLowerCase();
    const prev = (u.email ?? "").trim().toLowerCase();
    if (next === prev) return; // no PATCH for a no-op blur
    try {
      await api.patch(`/api/admin/users/${u.id}`, { email: next || null });
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Email update failed");
      setEmailNonce((n) => n + 1); // reset the input back to the stored value
      load();
    }
  }

  async function issueId(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const inv = await api.post<Invite>("/api/admin/invites", {
        role,
        department: dept || depts[0]?.name || "",
        days,
      });
      setIssued(inv.code);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to issue ID");
    } finally {
      setBusy(false);
    }
  }

  const copy = (text: string) => void navigator.clipboard?.writeText(text).catch(() => {});

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-5 py-8 sm:px-8">
      <PageHeader
        icon={ShieldCheck}
        title="Administration"
        subtitle={`Manage organization members, roles, departments, employee IDs and the audit trail — all scoped to ${user?.tenant_name}`}
      />

      <ErrorNote>{error}</ErrorNote>

      {loading && stats === null && (
        <div className="panel flex items-center gap-3 px-5 py-4 text-xs text-slate-500">
          <span className="h-2 w-2 animate-ping rounded-full bg-brand-2" />
          Loading administration data…
        </div>
      )}

      {/* stats */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {STATS.map((s) => (
          <div key={s.key} className="panel flex items-center gap-3 p-4">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand/10 text-brand-2">
              <s.icon size={18} />
            </span>
            <div className="min-w-0">
              <p className="text-xl font-bold tabular-nums text-slate-900">
                {stats ? stats[s.key] : "—"}
              </p>
              <p className="truncate text-[11px] text-muted">{s.label}</p>
            </div>
          </div>
        ))}
      </div>

      {/* employee directory */}
      <Panel
        icon={Users}
        title="Employee Directory & Department Allocation"
        subtitle="Roles, departments and manager designations apply immediately on the backend"
        bodyClassName="p-0"
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1080px] text-left text-sm">
            <thead>
              <tr className="border-b border-line bg-panel-2 text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-5 py-3 font-medium">Employee</th>
                <th className="px-3 py-3 font-medium">Work email</th>
                <th className="px-3 py-3 font-medium">Employee ID</th>
                <th className="px-3 py-3 font-medium">Department</th>
                <th className="px-3 py-3 font-medium">Role</th>
                <th className="px-3 py-3 font-medium">Agreement</th>
                <th className="px-3 py-3 font-medium">Manager</th>
                <th className="px-3 py-3 font-medium">Joined</th>
                <th className="px-3 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {users.map((u) => (
                <tr key={u.id} className="transition hover:bg-panel-2/60">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <span className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-brand to-accent text-xs font-bold text-white">
                        {u.username.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="font-medium text-slate-900">
                        {u.username}
                        {u.id === user?.id && (
                          <span className="ml-1.5 text-[10px] text-slate-500">(You)</span>
                        )}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <input
                      key={`${u.id}:${u.email ?? ""}:${emailNonce}`}
                      defaultValue={u.email ?? ""}
                      placeholder="Set work email"
                      aria-label={`Work email for ${u.username}`}
                      onBlur={(e) => void saveEmail(u, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") e.currentTarget.blur();
                      }}
                      className="w-[210px] rounded-md border border-line-2 bg-white px-2 py-1.5 text-xs text-slate-700 outline-none focus:border-brand-2"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </td>
                  <td className="px-3 py-3">
                    <span className="rounded-md bg-indigo-50 px-2 py-1 font-mono text-[11px] text-indigo-700">
                      {u.employee_id || "—"}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <select
                      value={u.department}
                      onChange={(e) => void patchUser(u.id, { department: e.target.value })}
                      className="rounded-md border border-line-2 bg-white px-2 py-1.5 text-xs text-slate-700 outline-none focus:border-brand-2"
                    >
                      <option value="General">General</option>
                      {depts.map((d) => (
                        <option key={d.id} value={d.name}>
                          {d.name}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td className="px-3 py-3">
                    <select
                      value={u.role}
                      onChange={(e) => void patchUser(u.id, { role: e.target.value as Role })}
                      disabled={u.id === user?.id}
                      className="rounded-md border border-line-2 bg-white px-2 py-1.5 text-xs text-slate-700 outline-none focus:border-brand-2 disabled:opacity-50"
                    >
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                    </select>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex flex-col gap-1">
                      <Badge tone={agreementStatus(u) === "Expired" ? "red" : agreementStatus(u) === "Expiring Soon" ? "amber" : "emerald"}>
                        {agreementStatus(u)}
                      </Badge>
                      <select
                        value={u.employment_type ?? "full_time"}
                        onChange={(e) => void patchUser(u.id, { employment_type: e.target.value })}
                        className="rounded-md border border-line-2 bg-white px-2 py-1 text-[10px] text-slate-700 outline-none focus:border-brand-2"
                      >
                        <option value="full_time">Full-time</option>
                        <option value="contract">Contract</option>
                        <option value="intern">Intern</option>
                        <option value="fixed_term">Fixed-term</option>
                      </select>
                      <input
                        type="date"
                        defaultValue={u.agreement_end ?? ""}
                        onBlur={(e) => void patchUser(u.id, { agreement_end: e.target.value || null })}
                        className="rounded-md border border-line-2 bg-white px-2 py-1 text-[10px] text-slate-700 outline-none focus:border-brand-2"
                        title="Agreement end date"
                      />
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <button
                      onClick={() => void patchUser(u.id, { is_manager: !u.is_manager })}
                      title={
                        u.is_manager
                          ? "Revoke the manager designation"
                          : "Designate as department manager (Team Workspace only — no extra privileges)"
                      }
                      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-[11px] font-medium transition ${
                        u.is_manager
                          ? "border-violet-200 bg-violet-50 text-violet-700 hover:border-violet-300"
                          : "border-line-2 bg-white text-slate-500 hover:border-brand-2 hover:text-brand-2"
                      }`}
                    >
                      <Crown size={12} /> {u.is_manager ? "Manager" : "Set manager"}
                    </button>
                  </td>
                  <td className="px-3 py-3 text-xs text-slate-500">
                    {formatDate(u.created)}
                  </td>
                  <td className="px-3 py-3 text-right">
                    <button
                      onClick={() => void removeUser(u)}
                      disabled={u.id === user?.id}
                      title="Remove from organization"
                      className="rounded-lg p-2 text-slate-500 transition hover:bg-red-50 hover:text-red-600 disabled:opacity-30"
                    >
                      <Trash2 size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-line px-5 py-3 text-[11px] text-slate-500">
          The manager designation only unlocks the Team Workspace for that user — it grants no
          access to other departments, roles, invites or the audit trail, and can be revoked
          at any time.
        </p>
      </Panel>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* issue employee ID */}
        <Panel icon={IdCard} title="Issue Company Employee ID" subtitle="Onboard a new member into a department">
          <form onSubmit={issueId} className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Target Department">
                <select
                  className={inputCls}
                  value={dept}
                  onChange={(e) => setDept(e.target.value)}
                  required
                >
                  <option value="">Select…</option>
                  {depts.map((d) => (
                    <option key={d.id} value={d.name}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Role">
                <select
                  className={inputCls}
                  value={role}
                  onChange={(e) => setRole(e.target.value as Role)}
                >
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
              </Field>
            </div>
            <Field label="Expires in">
              <div className="flex gap-2">
                {[7, 14, 30].map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDays(d)}
                    className={`flex-1 rounded-lg border px-3 py-2 text-xs font-medium transition ${
                      days === d
                        ? "border-brand bg-brand text-white"
                        : "border-line-2 bg-white text-slate-500 hover:border-brand-2 hover:text-brand-2"
                    }`}
                  >
                    {d} days
                  </button>
                ))}
              </div>
            </Field>
            <Btn type="submit" loading={busy} className="w-full">
              <UserPlus size={15} /> Issue Employee ID
            </Btn>
            {issued && (
              <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5">
                <span className="font-mono text-sm font-semibold text-emerald-700">{issued}</span>
                <button
                  type="button"
                  onClick={() => copy(issued)}
                  className="flex items-center gap-1.5 text-xs text-emerald-600 hover:text-emerald-800"
                >
                  <ClipboardCopy size={13} /> Copy
                </button>
              </div>
            )}
          </form>
        </Panel>

        {/* issued IDs register */}
        <Panel icon={KeyRound} title="Issued IDs & Onboarding Register" bodyClassName="p-0">
          <div className="max-h-80 overflow-y-auto">
            <table className="w-full text-left text-sm">
              <thead className="sticky top-0 bg-panel">
                <tr className="border-b border-line text-[11px] uppercase tracking-wide text-slate-500">
                  <th className="px-5 py-3 font-medium">ID</th>
                  <th className="px-3 py-3 font-medium">Department</th>
                  <th className="px-3 py-3 font-medium">Status</th>
                  <th className="px-3 py-3 text-right font-medium">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {invites.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-5 py-6 text-center text-xs text-slate-500">
                      No employee IDs issued yet.
                    </td>
                  </tr>
                )}
                {invites.map((i) => (
                  <tr key={i.code} className="hover:bg-panel-2/40">
                    <td className="px-5 py-3 font-mono text-xs text-brand-2">{i.code}</td>
                    <td className="px-3 py-3 text-xs text-slate-400">{i.department || "—"}</td>
                    <td className="px-3 py-3">
                      {i.joined_by ? (
                        <Badge tone="emerald">Joined: {i.joined_by}</Badge>
                      ) : (
                        <Badge tone="amber">Pending Signup</Badge>
                      )}
                    </td>
                    <td className="px-3 py-3 text-right">
                      <button
                        onClick={() => copy(i.code)}
                        className="text-xs text-brand-2 hover:text-brand"
                      >
                        Copy ID
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>

      {/* audit trail */}
      {/* bulk onboarding */}
      <Panel icon={UploadCloud} title="Bulk Employee Onboarding (CSV)" subtitle="Issue employee IDs from a spreadsheet">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            <Btn variant="secondary" onClick={downloadTemplate}>
              <Download size={15} /> Download template
            </Btn>
            <input
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => setCsvFile(e.target.files?.[0] ?? null)}
              className="text-sm text-slate-600"
            />
            <Btn onClick={() => void importCsv()} loading={csvBusy} disabled={!csvFile}>
              <UploadCloud size={15} /> Import
            </Btn>
          </div>
          <ErrorNote>{csvError}</ErrorNote>
          {csvResult && (
            <div className="space-y-2 text-xs">
              <p className="text-slate-600">
                Total {csvResult.summary?.total ?? 0} · Created {csvResult.summary?.created ?? 0} ·
                Valid {csvResult.summary?.valid ?? 0} · Invalid {csvResult.summary?.invalid ?? 0} ·
                Duplicate {csvResult.summary?.duplicate ?? 0} · Existing {csvResult.summary?.existing ?? 0}
              </p>
              <div className="max-h-48 overflow-y-auto rounded-lg border border-line">
                <table className="w-full text-left text-xs">
                  <thead className="sticky top-0 bg-panel-2 text-[10px] uppercase tracking-wide text-slate-500">
                    <tr>
                      <th className="px-3 py-2">Row</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2">Employee ID</th>
                      <th className="px-3 py-2">Errors</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line">
                    {(csvResult.rows ?? []).map((r: any) => (
                      <tr key={r.row}>
                        <td className="px-3 py-2">{r.row}</td>
                        <td className="px-3 py-2">{r.status}</td>
                        <td className="px-3 py-2 font-mono">{r.code || r.employee_id || "—"}</td>
                        <td className="px-3 py-2 text-red-600">{(r.errors ?? []).join("; ")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </Panel>

      <Panel icon={ScrollText} title="Audit Trail" subtitle="Last 100 security-relevant events" bodyClassName="p-0">
        <div className="max-h-96 overflow-y-auto">
          <table className="w-full min-w-[560px] text-left text-sm">
            <thead className="sticky top-0 bg-panel">
              <tr className="border-b border-line text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-5 py-3 font-medium">Time</th>
                <th className="px-3 py-3 font-medium">Actor</th>
                <th className="px-3 py-3 font-medium">Action</th>
                <th className="px-3 py-3 font-medium">Details</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {audit.map((a, i) => (
                <tr key={i} className="hover:bg-panel-2/40">
                  <td className="whitespace-nowrap px-5 py-3 text-xs text-slate-500">
                    {formatDate(a.created)}
                  </td>
                  <td className="px-3 py-3 text-xs text-slate-700">{a.username}</td>
                  <td className="px-3 py-3">
                    <Badge tone={ACTION_TONES[a.action] ?? "slate"}>{a.action}</Badge>
                  </td>
                  <td className="max-w-[280px] truncate px-3 py-3 text-xs text-slate-500" title={a.detail}>
                    {a.detail || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
