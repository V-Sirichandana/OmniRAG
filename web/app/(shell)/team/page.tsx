"use client";

/**
 * Team Workspace — the Department Manager dashboard.
 *
 * Gated by the users.is_manager designation: the backend returns 403 for
 * non-managers, and only organization admins of the same tenant can grant it.
 * The payload (GET /api/team/overview) contains nothing beyond data the
 * caller can already read — the designation grants no extra privileges, so
 * there are deliberately no team-management controls here (the backend does
 * not support any).
 */
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Crown,
  FileText,
  FolderOpen,
  MessageSquareText,
  ShieldAlert,
  Users,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { TeamOverview } from "@/lib/types";
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

type State = "loading" | "denied" | "ready" | "error";

export default function TeamPage() {
  const { user } = useAuth();
  const router = useRouter();
  const [data, setData] = useState<TeamOverview | null>(null);
  const [state, setState] = useState<State>("loading");
  const [message, setMessage] = useState("");

  const load = useCallback(() => {
    if (!user) return;
    setState("loading");
    api
      .get<TeamOverview>("/api/team/overview")
      .then((d) => {
        setData(d);
        setState("ready");
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 403) {
          setState("denied");
        } else {
          setMessage(e instanceof ApiError ? e.message : "Failed to load");
          setState("error");
        }
      });
  }, [user]);

  useEffect(load, [load]);

  if (!user) return null;

  // Denied — designation missing (also what the backend returns).
  if (state === "denied" || (!user.is_manager && state !== "loading")) {
    return (
      <div className="mx-auto max-w-3xl px-5 py-16 sm:px-8">
        <div className="panel p-8">
          <EmptyState
            icon={ShieldAlert}
            title="The Team Workspace requires the manager designation"
            hint={`Only organization admins can designate a user as a manager (currently ${
              user.username
            } is not one). The designation only unlocks this workspace — it never grants extra document or user-management access.`}
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

  if (state === "error") {
    return (
      <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8">
        <PageHeader icon={Users} title="Team Workspace" />
        <ErrorNote>{message}</ErrorNote>
        <div className="mt-4">
          <Btn variant="secondary" onClick={load}>
            Retry
          </Btn>
        </div>
      </div>
    );
  }

  if (state === "loading" || !data) {
    return (
      <div className="mx-auto max-w-6xl space-y-6 px-5 py-8 sm:px-8">
        <div className="h-16 w-72 animate-pulse rounded-xl bg-panel-2" />
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl bg-panel-2" />
          ))}
        </div>
        <div className="h-72 animate-pulse rounded-2xl bg-panel-2" />
      </div>
    );
  }

  const passages = data.documents.reduce((n, d) => n + (d.chunks || 0), 0);

  return (
    <div className="mx-auto max-w-6xl space-y-6 px-5 py-8 sm:px-8">
      <PageHeader
        icon={Crown}
        title={`${data.department} — Team Workspace`}
        subtitle={`Designated manager view for ${user.username} · data is limited to your department's authorized documents`}
        actions={
          <>
            <Btn variant="secondary" onClick={() => router.push("/library")}>
              <FolderOpen size={15} /> Browse team documents
            </Btn>
            <Btn onClick={() => router.push("/ask")}>
              <MessageSquareText size={15} /> Ask OmniRAG
            </Btn>
          </>
        }
      />

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <StatCard icon={Users} label="Team members" value={data.member_count} hint={data.department} tone="indigo" />
        <StatCard icon={FileText} label="Team documents" value={data.document_count} hint="You are authorized to read" tone="violet" />
        <StatCard icon={FolderOpen} label="Indexed passages" value={passages} hint="Across team documents" tone="emerald" />
        <StatCard icon={Crown} label="Designation" value="Manager" hint="Granted by an organization admin" tone="amber" />
      </div>

      <div className="grid gap-6 lg:grid-cols-3">
        <div className="space-y-6 lg:col-span-2">
          <Panel
            icon={FileText}
            title="Team documents"
            subtitle="Department documents newest first — identical to your normal access"
            bodyClassName="p-0"
          >
            {data.documents.length === 0 ? (
              <EmptyState
                icon={FolderOpen}
                title="No documents in your department yet"
                hint="Documents shared with your department (or selected for it) appear here."
                action={
                  <Btn variant="secondary" onClick={() => router.push("/library")}>
                    Open Document Library
                  </Btn>
                }
              />
            ) : (
              <ul className="divide-y divide-line">
                {data.documents.map((d) => (
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
                        {d.chunks} passages · by {d.uploaded_by}
                      </p>
                    </div>
                    <Badge tone="slate">{d.visibility}</Badge>
                    <span className="hidden shrink-0 text-xs text-slate-400 sm:block">
                      {formatDate(d.created)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Panel>

          <Panel icon={ShieldAlert} title="What this workspace does" subtitle="Honest scope of the manager designation">
            <ul className="space-y-2 text-xs leading-relaxed text-slate-600">
              <li className="flex gap-2">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-emerald-500" />
                Shows your department's members and documents — exactly what you are already
                authorized to see; the backend re-checks every request.
              </li>
              <li className="flex gap-2">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
                Grants no access to other departments, other organizations, roles, invites, or
                the audit trail — those stay admin-only.
              </li>
              <li className="flex gap-2">
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" />
                Team-management actions (roles, permissions, uploads) are not shown because the
                backend does not grant them to managers — controls are never added just for
                appearance.
              </li>
            </ul>
          </Panel>
        </div>

        <div className="space-y-6">
          <Panel icon={MessageSquareText} title="Quick actions">
            <div className="space-y-2.5">
              <QuickAction
                icon={MessageSquareText}
                label="Ask OmniRAG"
                hint="Answers grounded in your documents"
                href="/ask"
                tone="violet"
              />
              <QuickAction
                icon={FolderOpen}
                label="Browse team documents"
                hint={`${data.document_count} in ${data.department}`}
                href="/library"
                tone="indigo"
              />
              <QuickAction
                icon={Users}
                label="Departments"
                hint="Organization structure"
                href="/departments"
                tone="emerald"
              />
            </div>
          </Panel>

          <Panel icon={Crown} title="Designation" subtitle="Set by organization admins">
            <p className="text-xs leading-relaxed text-slate-600">
              You are designated as a manager for <strong>{data.department}</strong>. This flag
              lives on your account server-side and can be revoked by an admin at any time from
              Administration → Employees.
            </p>
            <div className="mt-3">
              <Btn variant="secondary" onClick={() => router.push("/settings")}>
                View in Settings
              </Btn>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}
