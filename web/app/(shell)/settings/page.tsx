"use client";

/**
 * Settings — company, profile, departments, access and security.
 *
 * Tabs are permission-aware: organization admins get Members, full Company
 * statistics and the audit tail; members see their own profile, their
 * organization identity, read-only departments and access rules. Everything
 * below is real backend data — where the API does not support an action
 * (renaming the organization, changing your own password) the UI says so
 * instead of showing a dead control.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Building2,
  Eye,
  FileText,
  History,
  KeyRound,
  Lock,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  Users,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { AdminUser, AuditEntry, Department, Doc, Stats, Visibility } from "@/lib/types";
import {
  Badge,
  Btn,
  EmptyState,
  ErrorNote,
  formatBytes,
  formatDate,
  PageHeader,
  Panel,
} from "@/components/ui";

type Tab = "profile" | "company" | "departments" | "members" | "access" | "security";

const VISIBILITY_RULES: {
  key: Visibility;
  label: string;
  desc: string;
  tone: string;
}[] = [
  {
    key: "organization",
    label: "Organization-wide",
    desc: "Every authenticated employee in your company can read and query it.",
    tone: "bg-violet-50 text-violet-700 border-violet-200",
  },
  {
    key: "department",
    label: "Department",
    desc: "Only members of the document's own department (admin retains access).",
    tone: "bg-indigo-50 text-indigo-700 border-indigo-200",
  },
  {
    key: "selected_departments",
    label: "Selected departments",
    desc: "Exactly the departments chosen at upload time, nothing else.",
    tone: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
  {
    key: "restricted",
    label: "Restricted",
    desc: "A per-user allowlist plus the organization admin — nobody else.",
    tone: "bg-amber-50 text-amber-700 border-amber-200",
  },
];

export default function SettingsPage() {
  const { user, logout } = useAuth();
  const router = useRouter();
  const isAdmin = user?.role === "admin";
  const initialTab: Tab = isAdmin ? "company" : "profile";
  const [tab, setTab] = useState<Tab>(initialTab);

  const [depts, setDepts] = useState<Department[]>([]);
  const [docs, setDocs] = useState<Doc[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    if (!user) return;
    const base = Promise.all([
      api.get<Department[]>("/api/departments"),
      api.get<Doc[]>("/api/documents"),
    ]);
    const admin = isAdmin
      ? Promise.all([
          api.get<AdminUser[]>("/api/admin/users"),
          api.get<Stats>("/api/admin/stats"),
          api.get<AuditEntry[]>("/api/admin/audit"),
        ])
      : Promise.resolve([[], null, []] as [AdminUser[], Stats | null, AuditEntry[]]);

    Promise.all([base, admin])
      .then(([[d, doc], [u, s, a]]) => {
        setDepts(d);
        setDocs(doc);
        setUsers(u);
        setStats(s);
        setAudit(a);
        setError("");
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [user, isAdmin]);

  useEffect(load, [load]);

  if (!user) return null;

  const tabs: { id: Tab; label: string; icon: typeof UserRound }[] = [
    { id: "profile", label: "Profile", icon: UserRound },
    { id: "company", label: "Company", icon: Building2 },
    { id: "departments", label: "Departments", icon: Building2 },
    ...(isAdmin
      ? [{ id: "members" as Tab, label: "Members", icon: Users }]
      : []),
    { id: "access", label: "Document access", icon: Eye },
    ...(isAdmin ? [{ id: "security" as Tab, label: "Security", icon: ShieldCheck }] : []),
  ];

  const visibilityCounts = docs.reduce<Record<string, number>>((acc, d) => {
    acc[d.visibility] = (acc[d.visibility] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8">
      <PageHeader
        icon={SlidersHorizontal}
        title="Settings"
        subtitle={`Workspace settings for ${user.tenant_name} · signed in as ${user.username}`}
      />

      <ErrorNote>{error}</ErrorNote>

      {/* tabs */}
      <div className="mb-6 flex flex-wrap gap-1.5 border-b border-line pb-3">
        {tabs.map((t) => {
          const Icon = t.icon;
          const on = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition ${
                on
                  ? "bg-brand text-white shadow-[0_8px_20px_-14px_rgba(79,70,229,.9)]"
                  : "text-slate-600 hover:bg-panel-2 hover:text-slate-900"
              }`}
            >
              <Icon size={15} /> {t.label}
            </button>
          );
        })}
      </div>

      {loading && (
        <div className="space-y-4">
          <div className="h-40 animate-pulse rounded-2xl bg-panel-2" />
          <div className="h-40 animate-pulse rounded-2xl bg-panel-2" />
        </div>
      )}

      {/* ------------------------------------------------------------ profile */}
      {!loading && tab === "profile" && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Panel icon={UserRound} title="Your account" subtitle="As stored by the backend">
            <dl className="divide-y divide-line text-sm">
              {[
                ["Username", user.username],
                ["Role", user.role === "admin" ? "Organization admin" : "Member"],
                ["Department", user.department || "General"],
                ["Employee ID", user.employee_id || "Not assigned"],
                [
                  "Manager designation",
                  user.is_manager
                    ? "Yes — Team Workspace unlocked"
                    : "No — contact an organization admin",
                ],
              ].map(([k, v]) => (
                <div key={k} className="flex items-center justify-between gap-4 py-3 first:pt-0">
                  <dt className="text-muted">{k}</dt>
                  <dd className="text-right font-medium text-slate-800">{v}</dd>
                </div>
              ))}
            </dl>
          </Panel>

          <Panel icon={Lock} title="Security" subtitle="How your session works">
            <ul className="space-y-2.5 text-xs leading-relaxed text-slate-600">
              <li>• Your password is hashed with bcrypt on the server — it is never stored or sent in plain text.</li>
              <li>• Sessions use a signed JWT (8-hour expiry) stored in this browser and sent as a Bearer header.</li>
              <li>• Role and department come from the verified token on every request — the UI cannot override them.</li>
              <li>• Query telemetry stores only a SHA-256 hash of your question, never document content or API keys.</li>
            </ul>
            <div className="mt-4 flex flex-wrap gap-2">
              <Btn variant="secondary" onClick={() => router.push("/ask")}>
                Ask OmniRAG
              </Btn>
              <Btn variant="danger" onClick={logout}>
                <KeyRound size={15} /> Sign in from another device
              </Btn>
            </div>
            <p className="mt-3 text-[11px] text-slate-500">
              Password changes are not exposed by the current API — ask an organization admin
              if you need your password rotated.
            </p>
          </Panel>
        </div>
      )}

      {/* ------------------------------------------------------------ company */}
      {!loading && tab === "company" && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Panel icon={Building2} title="Organization" subtitle="Identity of your workspace">
            <dl className="divide-y divide-line text-sm">
              {[
                ["Name", user.tenant_name ?? "—"],
                ["Organization ID", user.tenant_id],
                ["Your department", user.department || "General"],
                ...(isAdmin && stats
                  ? ([
                      ["Employees", String(stats.users)],
                      ["Documents", String(stats.documents)],
                      ["Indexed passages", String(stats.chunks)],
                      ["Storage used", formatBytes(stats.storage ?? 0)],
                    ] as [string, string][])
                  : []),
              ].map(([k, v]) => (
                <div key={k} className="flex items-center justify-between gap-4 py-3 first:pt-0">
                  <dt className="text-muted">{k}</dt>
                  <dd className="max-w-[60%] truncate text-right font-medium text-slate-800">
                    {v}
                  </dd>
                </div>
              ))}
            </dl>
            <p className="mt-3 text-[11px] text-slate-500">
              Renaming the organization is not supported by the current API — no edit control is
              shown rather than a dead one.
            </p>
          </Panel>

          <Panel icon={Users} title="Members & roles" subtitle="Current role distribution">
            {isAdmin ? (
              <div className="space-y-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="text-muted">Organization admins</span>
                  <span className="font-semibold tabular-nums text-slate-800">
                    {users.filter((u) => u.role === "admin").length}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted">Members</span>
                  <span className="font-semibold tabular-nums text-slate-800">
                    {users.filter((u) => u.role === "member").length}
                  </span>
                </div>
                <div className="flex items-center justify-between">
                  <span className="text-muted">Designated managers</span>
                  <span className="font-semibold tabular-nums text-slate-800">
                    {users.filter((u) => u.is_manager).length}
                  </span>
                </div>
                <div className="border-t border-line pt-3">
                  <Btn variant="secondary" onClick={() => router.push("/admin")}>
                    Manage employees
                  </Btn>
                </div>
              </div>
            ) : (
              <p className="text-sm leading-relaxed text-slate-600">
                Role and membership management is restricted to organization admins. You are a{" "}
                <strong>Member</strong> of <strong>{user.department || "General"}</strong>.
              </p>
            )}
          </Panel>
        </div>
      )}

      {/* --------------------------------------------------------- departments */}
      {!loading && tab === "departments" && (
        <Panel
          icon={Building2}
          title="Departments"
          subtitle={`${depts.length} departments in ${user.tenant_name}`}
          action={
            isAdmin ? (
              <Btn variant="secondary" onClick={() => router.push("/departments")}>
                Manage departments
              </Btn>
            ) : undefined
          }
          bodyClassName="p-0"
        >
          <ul className="divide-y divide-line">
            {depts.map((d) => (
              <li key={d.id} className="flex items-center gap-3 px-5 py-3.5">
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-indigo-50 text-indigo-600">
                  <Building2 size={16} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-800">{d.name}</p>
                  <p className="truncate text-xs text-slate-500">
                    {d.code} · created {formatDate(d.created)}
                  </p>
                </div>
                <Badge tone="indigo">{d.members} members</Badge>
                <Badge tone="violet">{d.documents} docs</Badge>
              </li>
            ))}
          </ul>
        </Panel>
      )}

      {/* ------------------------------------------------------------- members */}
      {!loading && tab === "members" && isAdmin && (
        <Panel
          icon={Users}
          title="Members"
          subtitle="Read-only snapshot — change roles, departments and manager designations in Administration"
          action={
            <Btn variant="secondary" onClick={() => router.push("/admin")}>
              Open Administration
            </Btn>
          }
          bodyClassName="p-0"
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-left text-sm">
              <thead className="border-b border-line bg-panel-2 text-xs text-muted">
                <tr>
                  <th className="px-5 py-3 font-medium">User</th>
                  <th className="px-5 py-3 font-medium">Department</th>
                  <th className="px-5 py-3 font-medium">Role</th>
                  <th className="px-5 py-3 font-medium">Manager</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {users.map((u) => (
                  <tr key={u.id} className="transition hover:bg-panel-2">
                    <td className="px-5 py-3">
                      <p className="font-medium text-slate-800">{u.username}</p>
                      <p className="text-xs text-slate-500">
                        {u.employee_id ? `ID ${u.employee_id}` : "No employee ID"}
                      </p>
                    </td>
                    <td className="px-5 py-3 text-slate-600">{u.department}</td>
                    <td className="px-5 py-3">
                      <Badge tone={u.role === "admin" ? "amber" : "indigo"}>{u.role}</Badge>
                    </td>
                    <td className="px-5 py-3">
                      {u.is_manager ? (
                        <Badge tone="violet">Manager</Badge>
                      ) : (
                        <span className="text-xs text-slate-400">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {/* -------------------------------------------------------------- access */}
      {!loading && tab === "access" && (
        <div className="space-y-6">
          <Panel
            icon={Eye}
            title="Document access rules"
            subtitle="Enforced on the backend for every listing, retrieval, chat and download"
          >
            <div className="grid gap-3 sm:grid-cols-2">
              {VISIBILITY_RULES.map((v) => (
                <div key={v.key} className="rounded-xl border border-line p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${v.tone}`}>
                      {v.label}
                    </span>
                    <span className="text-xs font-semibold tabular-nums text-slate-700">
                      {visibilityCounts[v.key] ?? 0} docs
                    </span>
                  </div>
                  <p className="mt-2 text-xs leading-relaxed text-slate-600">{v.desc}</p>
                </div>
              ))}
            </div>
            <p className="mt-4 border-t border-line pt-3 text-[11px] leading-relaxed text-slate-500">
              Counts reflect documents you are authorized to see. Organization admins can edit
              any document's scope and allowlist from the Document Library.
            </p>
          </Panel>

          <Panel icon={FileText} title="Your accessible documents" subtitle="Live from /api/documents" bodyClassName="p-0">
            {docs.length === 0 ? (
              <EmptyState icon={FileText} title="No documents yet" hint="Documents you are authorized to read appear here." />
            ) : (
              <ul className="max-h-80 divide-y divide-line overflow-y-auto">
                {docs.map((d) => (
                  <li key={d.id} className="flex items-center gap-3 px-5 py-3">
                    <FileText size={15} className="shrink-0 text-brand-2" />
                    <span className="min-w-0 flex-1 truncate text-sm text-slate-700">{d.filename}</span>
                    <Badge tone="slate">{d.visibility}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>
      )}

      {/* ------------------------------------------------------------ security */}
      {!loading && tab === "security" && isAdmin && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Panel
            icon={ScrollText}
            title="Audit trail"
            subtitle="Last security-relevant events (including query text, admin-only)"
            action={
              <button
                onClick={() => router.push("/admin")}
                className="flex items-center gap-1 text-xs font-medium text-brand-2 hover:text-brand"
              >
                Full trail <History size={13} />
              </button>
            }
            bodyClassName="p-0"
          >
            {audit.length === 0 ? (
              <EmptyState icon={History} title="No events yet" />
            ) : (
              <ul className="max-h-96 divide-y divide-line overflow-y-auto">
                {audit.slice(0, 12).map((a, i) => (
                  <li key={i} className="px-5 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <Badge tone="slate">{a.action}</Badge>
                      <span className="text-[11px] text-slate-400">{formatDate(a.created)}</span>
                    </div>
                    <p className="mt-1 truncate text-xs text-slate-600" title={a.detail}>
                      {a.username} · {a.detail || "—"}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel icon={ShieldCheck} title="Security posture" subtitle="What the platform actually enforces">
            <ul className="space-y-2.5 text-xs leading-relaxed text-slate-600">
              <li>• Every API request is authorized from the verified JWT — tenant ID and role are never taken from the client.</li>
              <li>• Admin-only endpoints reject members with 403 regardless of what the UI shows; nav items are UX only.</li>
              <li>• Passwords are bcrypt-hashed; failed logins are rate-limited (5 attempts / 5 minutes).</li>
              <li>• Documents are filtered per-request by the single authorization service (scope + ACL), including retrieval and chat.</li>
              <li>• Retrieval prompts treat document contents as untrusted, with prompt-injection hardening in the answer/verifier prompts.</li>
              <li>• Query telemetry stores a SHA-256 hash only — no document content, no API keys.</li>
            </ul>
          </Panel>
        </div>
      )}
    </div>
  );
}
