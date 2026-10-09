"use client";

/**
 * Administration — employee directory, roles & departments, company employee
 * IDs (invitations), and the audit trail. Admin-only; the backend rejects
 * every one of these endpoints for non-admins regardless of what the UI shows.
 */
import { useCallback, useEffect, useState } from "react";
import {
  ClipboardCopy,
  IdCard,
  KeyRound,
  ScrollText,
  ShieldCheck,
  Trash2,
  UserPlus,
  Users,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { AdminUser, AuditEntry, Department, Invite, Role, Stats } from "@/lib/types";
import { Badge, Btn, ErrorNote, Field, Panel, formatDate, inputCls } from "@/components/ui";

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
  doc_deleted: "amber",
  doc_access_changed: "amber",
  dept_created: "slate",
  dept_deleted: "red",
  query: "slate",
};

export default function AdminPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  const [stats, setStats] = useState<Stats | null>(null);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [depts, setDepts] = useState<Department[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [error, setError] = useState("");
  const [issued, setIssued] = useState<string>("");

  // invite form
  const [dept, setDept] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);

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
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load"));
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

  async function patchUser(id: string, body: { role?: Role; department?: string }) {
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

  const copy = (text: string) => void navigator.clipboard?.writeText(text);

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-5 py-8 sm:px-8">
      <div>
        <h1 className="text-xl font-bold text-white">Administration</h1>
        <p className="mt-1 text-sm text-muted">
          Manage organization members, roles, departments, employee IDs and the
          audit trail — all scoped to {user?.tenant_name}.
        </p>
      </div>

      <ErrorNote>{error}</ErrorNote>

      {/* stats */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        {STATS.map((s) => (
          <div key={s.key} className="panel flex items-center gap-3 p-4">
            <span className="grid h-10 w-10 place-items-center rounded-xl bg-brand/15 text-brand-2">
              <s.icon size={18} />
            </span>
            <div className="min-w-0">
              <p className="text-xl font-bold text-white">
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
        subtitle="Roles and departments apply immediately on the backend"
        bodyClassName="p-0"
      >
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-sm">
            <thead>
              <tr className="border-b border-line text-[11px] uppercase tracking-wide text-slate-500">
                <th className="px-5 py-3 font-medium">Employee</th>
                <th className="px-3 py-3 font-medium">Employee ID</th>
                <th className="px-3 py-3 font-medium">Department</th>
                <th className="px-3 py-3 font-medium">Role</th>
                <th className="px-3 py-3 font-medium">Joined</th>
                <th className="px-3 py-3 text-right font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {users.map((u) => (
                <tr key={u.id} className="transition hover:bg-panel-2/40">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-3">
                      <span className="grid h-8 w-8 place-items-center rounded-full bg-gradient-to-br from-brand to-accent text-xs font-bold text-white">
                        {u.username.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="font-medium text-white">
                        {u.username}
                        {u.id === user?.id && (
                          <span className="ml-1.5 text-[10px] text-slate-500">(You)</span>
                        )}
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-3">
                    <span className="rounded-md bg-indigo-500/15 px-2 py-1 font-mono text-[11px] text-indigo-300">
                      {u.employee_id || "—"}
                    </span>
                  </td>
                  <td className="px-3 py-3">
                    <select
                      value={u.department}
                      onChange={(e) => void patchUser(u.id, { department: e.target.value })}
                      className="rounded-md border border-line bg-ink-2 px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-brand-2"
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
                      className="rounded-md border border-line bg-ink-2 px-2 py-1.5 text-xs text-slate-200 outline-none focus:border-brand-2 disabled:opacity-50"
                    >
                      <option value="member">Member</option>
                      <option value="admin">Admin</option>
                    </select>
                  </td>
                  <td className="px-3 py-3 text-xs text-slate-500">
                    {formatDate(u.created)}
                  </td>
                  <td className="px-3 py-3 text-right">
                    <button
                      onClick={() => void removeUser(u)}
                      disabled={u.id === user?.id}
                      title="Remove from organization"
                      className="rounded-lg p-2 text-slate-500 transition hover:bg-red-500/10 hover:text-red-400 disabled:opacity-30"
                    >
                      <Trash2 size={15} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
                        : "border-line bg-ink-2 text-slate-400 hover:text-white"
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
              <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5">
                <span className="font-mono text-sm font-semibold text-emerald-300">{issued}</span>
                <button
                  type="button"
                  onClick={() => copy(issued)}
                  className="flex items-center gap-1.5 text-xs text-emerald-200 hover:text-white"
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
                    <td className="px-5 py-3 font-mono text-xs text-indigo-300">{i.code}</td>
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
                        className="text-xs text-indigo-400 hover:text-indigo-300"
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
                  <td className="px-3 py-3 text-xs text-slate-300">{a.username}</td>
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
