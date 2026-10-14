"use client";

/**
 * HR Workspace — a department-scoped space for Human Resources members.
 *
 * Gating: available to members of the "Human Resources" department (and to
 * organization admins, who already see everything). It introduces NO new
 * privileges — the document list below is the caller's existing authorized
 * set filtered to HR-relevant scopes; uploads stay admin-only exactly as the
 * backend enforces. Policy shortcuts are suggested questions, not claims
 * about document contents.
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  BookOpenCheck,
  Building2,
  FileText,
  FolderOpen,
  HeartPulse,
  Lock,
  MessageSquareText,
  ShieldAlert,
  UploadCloud,
  Users,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Department, Doc } from "@/lib/types";
import {
  Badge,
  Btn,
  EmptyState,
  ErrorNote,
  formatDate,
  PageHeader,
  Panel,
  QuickAction,
  StatCard,
} from "@/components/ui";

/** Suggested HR questions — prompts, shown regardless of what is indexed. */
const HR_QUESTIONS = [
  "What is the parental leave policy?",
  "How many casual leave days do employees get?",
  "What does the attendance policy say about remote work?",
  "What is included in the employee handbook?",
  "How does the onboarding process work?",
  "What benefits are offered to full-time employees?",
];

export default function HrPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [docs, setDocs] = useState<Doc[]>([]);
  const [depts, setDepts] = useState<Department[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  const load = useCallback(() => {
    Promise.all([api.get<Doc[]>("/api/documents"), api.get<Department[]>("/api/departments")])
      .then(([d, dp]) => {
        setDocs(d);
        setDepts(dp);
        setError("");
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  if (!user) return null;

  // UX gate only — the documents themselves are authorized on the backend.
  const isHr = user.department === "Human Resources";
  const isAdmin = user.role === "admin";
  const allowed = isHr || isAdmin;

  if (!allowed) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-16 sm:px-8">
        <div className="panel p-8">
          <EmptyState
            icon={ShieldAlert}
            title="HR Workspace is limited to the HR department"
            hint={`You are signed in as ${user.username} of the ${
              user.department || "General"
            } department. Ask an organization admin if you believe you need access.`}
            action={
              <Btn variant="secondary" onClick={() => router.push("/dashboard")}>
                Back to Dashboard
              </Btn>
            }
          />
        </div>
      </div>
    );
  }

  // Existing authorized documents restricted to HR-relevant scopes:
  // the HR department's documents plus organization-wide policies.
  const hrDocs = docs.filter(
    (d) => d.visibility === "organization" || d.department === "Human Resources",
  );
  const deptDocs = docs.filter((d) => d.department === "Human Resources");
  const hrRow = depts.find((d) => d.name === "Human Resources");

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-5 py-8 sm:px-8">
      <PageHeader
        icon={HeartPulse}
        title="HR Workspace"
        subtitle={`Policy library and questions for ${user.tenant_name} — ${
          isHr ? "you are in the Human Resources department" : "you have admin access"
        }`}
        actions={
          <>
            <Btn variant="secondary" onClick={() => router.push("/library")}>
              <FolderOpen size={15} /> Document Library
            </Btn>
            <Btn onClick={() => router.push("/ask")}>
              <MessageSquareText size={15} /> Ask about policy
            </Btn>
          </>
        }
      />

      <ErrorNote>{error}</ErrorNote>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard
          icon={FileText}
          label="HR documents you can access"
          value={loading ? "—" : deptDocs.length}
          hint="Your department"
          tone="indigo"
        />
        <StatCard
          icon={Building2}
          label="Company-wide documents"
          value={loading ? "—" : docs.filter((d) => d.visibility === "organization").length}
          hint="Visible to every employee"
          tone="violet"
        />
        <StatCard
          icon={Users}
          label="Members in HR"
          value={hrRow ? hrRow.members : "—"}
          hint="Human Resources"
          tone="emerald"
        />
        <StatCard
          icon={HeartPulse}
          label="Total documents you can access"
          value={loading ? "—" : docs.length}
          hint="Per your existing permissions"
          tone="amber"
        />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Panel
            icon={BookOpenCheck}
            title="Ask about HR policies"
            subtitle="Suggested questions — answers are grounded in documents you can access"
          >
            <div className="grid gap-2.5 sm:grid-cols-2">
              {HR_QUESTIONS.map((q) => (
                <button
                  key={q}
                  onClick={() => router.push(`/ask?q=${encodeURIComponent(q)}`)}
                  className="flex items-center gap-3 rounded-xl border border-line bg-white px-4 py-3 text-left text-sm text-slate-700 transition hover:border-brand-2 hover:bg-panel-2"
                >
                  <BookOpenCheck size={16} className="shrink-0 text-brand-2" />
                  <span className="min-w-0 truncate">{q}</span>
                </button>
              ))}
            </div>
          </Panel>

          <Panel
            icon={FileText}
            title="HR document library"
            subtitle="Your HR and company-wide documents, newest first"
            bodyClassName="p-0"
          >
            {loading ? (
              <div className="space-y-3 p-5">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="h-14 animate-pulse rounded-xl bg-panel-2" />
                ))}
              </div>
            ) : hrDocs.length === 0 ? (
              <EmptyState
                icon={FolderOpen}
                title="No HR documents yet"
                hint="HR policy documents appear here once they are uploaded with HR or company-wide visibility. Uploads are restricted to organization admins."
                action={
                  isAdmin ? (
                    <Btn onClick={() => router.push("/library")}>
                      <UploadCloud size={15} /> Upload document
                    </Btn>
                  ) : undefined
                }
              />
            ) : (
              <ul className="divide-y divide-line">
                {hrDocs.map((d) => (
                  <li key={d.id} className="flex items-center gap-3 px-5 py-3.5">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-indigo-50 text-indigo-600">
                      <FileText size={16} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p
                        className="truncate text-sm font-medium text-slate-800"
                        title={d.filename}
                      >
                        {d.filename}
                      </p>
                      <p className="truncate text-xs text-slate-500">
                        {d.department || "Organization-wide"} · {d.chunks} passages · by{" "}
                        {d.uploaded_by}
                      </p>
                    </div>
                    <Badge tone={d.visibility === "organization" ? "violet" : "indigo"}>
                      {d.visibility === "organization" ? "Company-wide" : "HR only"}
                    </Badge>
                    <span className="hidden shrink-0 text-xs text-slate-400 sm:block">
                      {formatDate(d.created)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>
        </div>

        <div className="space-y-6">
          <Panel icon={MessageSquareText} title="Quick actions">
            <div className="space-y-2.5">
              <QuickAction
                icon={MessageSquareText}
                label="Ask OmniRAG"
                hint="Grounded answers with citations"
                href="/ask"
                tone="violet"
              />
              <QuickAction
                icon={FolderOpen}
                label="Browse documents"
                hint={`${docs.length} accessible to you`}
                href="/library"
                tone="indigo"
              />
              <QuickAction
                icon={Building2}
                label="Departments"
                hint={`${depts.length} in your organization`}
                href="/departments"
                tone="emerald"
              />
            </div>
          </Panel>

          <Panel
            icon={isAdmin ? UploadCloud : Lock}
            title="Uploads & permissions"
            subtitle="Managed in the Document Library"
          >
            <p className="text-xs leading-relaxed text-slate-600">
              {isAdmin
                ? "As an organization admin you can upload HR policies and set their scope (company-wide, HR only, selected departments, or restricted) in the Document Library."
                : "Document uploads and permission changes are restricted to organization admins — your workspace only shows documents you are already authorized to read."}
            </p>
            <div className="mt-3">
              <Btn variant="secondary" onClick={() => router.push("/library")}>
                Open Document Library
              </Btn>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
