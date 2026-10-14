"use client";

/**
 * Dashboard — the role-aware home of the workspace.
 *
 * Admins get the Organization Overview (real /api/admin/stats + audit +
 * documents); members get a personal overview built from the exact same
 * authorized data every member can already read. No fabricated metrics:
 * every number below comes from a backend response.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  ArrowRight,
  BookOpenCheck,
  Building2,
  FileText,
  FolderOpen,
  HardDrive,
  History,
  MessageSquareText,
  Plus,
  ScrollText,
  UploadCloud,
  Users,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { AuditEntry, Conversation, Department, Doc, Stats } from "@/lib/types";
import {
  Badge,
  Bars,
  Btn,
  EmptyState,
  ErrorNote,
  formatBytes,
  formatDate,
  PageHeader,
  Panel,
  QuickAction,
  StatCard,
} from "@/components/ui";

const SUGGESTIONS = [
  "What is the parental leave policy?",
  "How many casual leave days do employees get?",
  "Summarize the deployment security standard.",
  "What are the approval steps for production deployments?",
];

const ACTIVITY_TONES: Record<string, "emerald" | "indigo" | "amber" | "red" | "slate"> = {
  doc_uploaded: "indigo",
  doc_downloaded: "slate",
  doc_deleted: "red",
  doc_access_changed: "amber",
  user_joined: "emerald",
  login: "emerald",
  query: "slate",
  search: "indigo",
};

function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-xl bg-panel-2 ${className}`} />;
}

export default function DashboardPage() {
  const { user } = useAuth();
  const router = useRouter();
  const isAdmin = user?.role === "admin";

  const [docs, setDocs] = useState<Doc[]>([]);
  const [depts, setDepts] = useState<Department[]>([]);
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    const memberCalls = Promise.all([
      api.get<Doc[]>("/api/documents"),
      api.get<Department[]>("/api/departments"),
      api.get<Conversation[]>("/api/conversations"),
    ]);
    const adminCalls = isAdmin
      ? Promise.all([
          api.get<Stats>("/api/admin/stats"),
          api.get<AuditEntry[]>("/api/admin/audit"),
        ])
      : Promise.resolve([null, []] as [Stats | null, AuditEntry[]]);

    Promise.all([memberCalls, adminCalls])
      .then(([[d, dp, cv], [st, au]]) => {
        setDocs(d);
        setDepts(dp);
        setConvs(cv);
        setStats(st);
        setAudit(au);
        setError("");
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, [isAdmin]);

  useEffect(load, [load]);

  if (!user) return null;

  const myDept = user.department || "General";
  const passages = docs.reduce((n, d) => n + (d.chunks || 0), 0);
  const myDeptRow = depts.find((d) => d.name === myDept);
  const isManager = Boolean(user.is_manager);
  const isHr = user.department === "Human Resources";

  /* ---------------------------------------------------------------- loading */
  if (loading) {
    return (
      <div className="mx-auto max-w-6xl space-y-6 px-5 py-8 sm:px-8">
        <Skeleton className="h-16 w-72" />
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24" />
          ))}
        </div>
        <div className="grid gap-6 lg:grid-cols-3">
          <Skeleton className="h-64 lg:col-span-2" />
          <Skeleton className="h-64" />
        </div>
      </div>
    );
  }

  /* ----------------------------------------------------------------- admin */
  if (isAdmin) {
    const byDept = [...depts]
      .map((d) => ({ label: d.name, value: d.documents }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 6);
    const recent = docs.slice(0, 5);
    const activity = audit.slice(0, 7);

    return (
      <div className="mx-auto max-w-6xl space-y-6 px-5 py-8 sm:px-8">
        <PageHeader
          icon={Building2}
          title="Organization Overview"
          subtitle={`${user.tenant_name} · everything below is scoped to your organization`}
          actions={
            <>
              <Btn variant="secondary" onClick={() => (router.push("/library"))}>
                <UploadCloud size={15} /> Upload document
              </Btn>
              <Btn onClick={() => (router.push("/ask"))}>
                <MessageSquareText size={15} /> Ask OmniRAG
              </Btn>
            </>
          }
        />

        <ErrorNote>{error}</ErrorNote>

        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          <StatCard icon={FileText} label="Company documents" value={stats ? stats.documents : "—"} tone="indigo" />
          <StatCard icon={Users} label="Employees" value={stats ? stats.users : "—"} tone="violet" />
          <StatCard icon={Building2} label="Departments" value={depts.length} tone="emerald" />
          <StatCard
            icon={HardDrive}
            label="Storage used"
            value={stats && stats.storage !== undefined ? formatBytes(stats.storage) : "—"}
            hint={stats ? `${stats.chunks} indexed passages` : undefined}
            tone="amber"
          />
        </div>

        <div className="grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <Panel icon={Activity} title="Documents by department" subtitle="Live counts across your organization">
              {byDept.length === 0 ? (
                <EmptyState icon={FolderOpen} title="No departments yet" />
              ) : (
                <Bars data={byDept} />
              )}
            </Panel>

            <Panel
              icon={FileText}
              title="Recent documents"
              subtitle="Newest uploads across all departments"
              action={
                <button
                  onClick={() => (router.push("/library"))}
                  className="flex items-center gap-1 text-xs font-medium text-brand-2 hover:text-brand"
                >
                  Open library <ArrowRight size={13} />
                </button>
              }
              bodyClassName="p-0"
            >
              {recent.length === 0 ? (
                <EmptyState
                  icon={UploadCloud}
                  title="No documents yet"
                  hint="Upload the first document to make company knowledge queryable."
                  action={
                    <Btn onClick={() => (router.push("/library"))}>
                      <UploadCloud size={15} /> Upload document
                    </Btn>
                  }
                />
              ) : (
                <ul className="divide-y divide-line">
                  {recent.map((d) => (
                    <li key={d.id} className="flex items-center gap-3 px-5 py-3.5">
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-indigo-50 text-indigo-600">
                        <FileText size={16} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-slate-800" title={d.filename}>
                          {d.filename}
                        </p>
                        <p className="truncate text-xs text-slate-500">
                          {d.department || "Organization-wide"} · {d.chunks} passages
                        </p>
                      </div>
                      <span className="shrink-0 text-xs text-slate-400">{formatDate(d.created)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>
          </div>

          <div className="space-y-6">
            <Panel icon={Plus} title="Quick actions">
              <div className="space-y-2.5">
                <QuickAction icon={UploadCloud} label="Upload document" hint="PDF, DOCX, TXT, MD…" href="/library" tone="indigo" />
                <QuickAction icon={MessageSquareText} label="Ask OmniRAG" hint="Grounded answers with citations" href="/ask" tone="violet" />
                <QuickAction icon={Building2} label="Manage departments" hint={`${depts.length} in your organization`} href="/departments" tone="emerald" />
                <QuickAction icon={Users} label="Manage employees" hint="Roles, IDs and audit trail" href="/admin" tone="amber" />
              </div>
            </Panel>

            <Panel icon={ScrollText} title="Recent activity" subtitle="Security-relevant events" bodyClassName="p-0">
              {activity.length === 0 ? (
                <EmptyState icon={History} title="No activity yet" />
              ) : (
                <ul className="divide-y divide-line">
                  {activity.map((a, i) => (
                    <li key={i} className="flex items-start gap-3 px-5 py-3">
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge tone={ACTIVITY_TONES[a.action] ?? "slate"}>{a.action}</Badge>
                          <span className="text-xs text-slate-500">{a.username}</span>
                        </div>
                        <p className="mt-1 truncate text-xs text-slate-600" title={a.detail}>
                          {a.detail || "—"}
                        </p>
                      </div>
                      <span className="shrink-0 text-[11px] text-slate-400">
                        {formatDate(a.created)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="border-t border-line px-5 py-3 text-center">
                <button
                  onClick={() => (router.push("/admin"))}
                  className="text-xs font-medium text-brand-2 hover:text-brand"
                >
                  View full audit trail →
                </button>
              </div>
            </Panel>
          </div>
        </div>
      </div>
    );
  }

  /* --------------------------------------------------------------- member */
  return (
    <div className="mx-auto max-w-6xl space-y-6 px-5 py-8 sm:px-8">
      <PageHeader
        icon={Users}
        title={`Welcome back, ${user.username}`}
        subtitle={`${user.tenant_name} · ${myDept} · your view is limited to what you are authorized to access`}
        actions={
          <Btn onClick={() => (router.push("/ask"))}>
            <MessageSquareText size={15} /> Ask OmniRAG
          </Btn>
        }
      />

      <ErrorNote>{error}</ErrorNote>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={FileText} label="Documents you can access" value={docs.length} tone="indigo" />
        <StatCard icon={ScrollText} label="Indexed passages" value={passages} tone="violet" />
        <StatCard icon={History} label="Your conversations" value={convs.length} tone="emerald" />
        <StatCard
          icon={Users}
          label="Members in your department"
          value={myDeptRow ? myDeptRow.members : "—"}
          hint={myDept}
          tone="amber"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Panel icon={BookOpenCheck} title="Suggested questions" subtitle="Start with what your colleagues ask most">
            <div className="grid gap-2.5 sm:grid-cols-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => (router.push(`/ask?q=${encodeURIComponent(s)}`))}
                  className="flex items-center gap-3 rounded-xl border border-line bg-white px-4 py-3 text-left text-sm text-slate-700 transition hover:border-brand-2 hover:bg-panel-2"
                >
                  <BookOpenCheck size={16} className="shrink-0 text-brand-2" />
                  <span className="min-w-0 truncate">{s}</span>
                </button>
              ))}
            </div>
          </Panel>

          <Panel
            icon={History}
            title="Recent conversations"
            subtitle="Isolated to your account"
            action={
              <button
                onClick={() => (router.push("/ask"))}
                className="flex items-center gap-1 text-xs font-medium text-brand-2 hover:text-brand"
              >
                Open chat <ArrowRight size={13} />
              </button>
            }
            bodyClassName="p-0"
          >
            {convs.length === 0 ? (
              <EmptyState
                icon={MessageSquareText}
                title="No conversations yet"
                hint="Ask your first question about the documents you can access."
                action={
                  <Btn onClick={() => (router.push("/ask"))}>
                    <MessageSquareText size={15} /> Ask OmniRAG
                  </Btn>
                }
              />
            ) : (
              <ul className="divide-y divide-line">
                {convs.slice(0, 5).map((c) => (
                  <li key={c.id}>
                    <button
                      onClick={() => (router.push(`/ask?c=${c.id}`))}
                      className="flex w-full items-center gap-3 px-5 py-3.5 text-left transition hover:bg-panel-2"
                    >
                      <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-violet-50 text-violet-600">
                        <MessageSquareText size={16} />
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm font-medium text-slate-800">
                        {c.title || "Untitled query"}
                      </span>
                      <span className="shrink-0 text-xs text-slate-400">{formatDate(c.created)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="space-y-6">
          <Panel icon={Plus} title="Quick actions">
            <div className="space-y-2.5">
              <QuickAction icon={MessageSquareText} label="Ask OmniRAG" hint="Answers from your documents" href="/ask" tone="violet" />
              <QuickAction icon={FolderOpen} label="Browse documents" hint={`${docs.length} accessible`} href="/library" tone="indigo" />
              <QuickAction icon={Building2} label="Your department" hint={myDept} href="/departments" tone="emerald" />
            </div>
          </Panel>

          {(isManager || isHr) && (
            <Panel
              icon={isManager ? Users : Building2}
              title={isManager ? "Team workspace" : "HR workspace"}
              subtitle={
                isManager
                  ? `You are designated to lead ${myDept}`
                  : "Policy library and HR questions"
              }
            >
              <div className="space-y-2.5">
                <QuickAction
                  icon={isManager ? Users : Building2}
                  label={isManager ? "Open Team Workspace" : "Open HR Workspace"}
                  href={isManager ? "/team" : "/hr"}
                  tone="violet"
                />
                <p className="text-[11px] leading-relaxed text-slate-500">
                  {isManager
                    ? "The team workspace shows only your department's already-authorized data — the designation grants no extra privileges."
                    : "HR documents are visible only according to your existing department and document permissions."}
                </p>
              </div>
            </Panel>
          )}

          <Panel icon={FolderOpen} title="Your access at a glance">
            <ul className="space-y-2.5 text-sm text-slate-600">
              <li className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2">
                  <FileText size={14} className="text-brand-2" /> Documents
                </span>
                <span className="font-semibold tabular-nums text-slate-800">{docs.length}</span>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2">
                  <Building2 size={14} className="text-accent" /> Department
                </span>
                <span className="font-medium text-slate-800">{myDept}</span>
              </li>
              <li className="flex items-center justify-between gap-3">
                <span className="flex items-center gap-2">
                  <ShieldRoleIcon /> Role
                </span>
                <Badge tone={isAdmin ? "amber" : "indigo"}>
                  {isAdmin ? "Admin" : isManager ? "Member · Manager" : "Member"}
                </Badge>
              </li>
            </ul>
            <p className="mt-3 border-t border-line pt-3 text-[11px] leading-relaxed text-slate-500">
              Organization-wide, department, shared and restricted documents are filtered
              on the backend for every request — you only ever see what you are allowed to.
            </p>
          </Panel>
        </div>
      </div>
    </div>
  );
}

/** Small role glyph for the access panel (kept local to this page). */
function ShieldRoleIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-emerald-600"
      aria-hidden
    >
      <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
    </svg>
  );
}
