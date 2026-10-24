"use client";

/**
 * Document Library — enterprise document management for the organization.
 *
 * Scopes: organization-wide (every employee), selected departments,
 * one department, or restricted (explicit allowlist). Downloading the
 * original file is a separate permission from viewing/querying; the
 * backend enforces every rule regardless of what this UI shows.
 */
import { Fragment, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Ban,
  Building2,
  Download,
  FileText,
  FolderOpen,
  Lock,
  Search,
  ShieldCheck,
  Trash2,
  UploadCloud,
  Users,
} from "lucide-react";
import { api, ApiError, API_BASE, getToken } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { AdminUser, Department, Doc, Visibility } from "@/lib/types";
import {
  Badge,
  Btn,
  EmptyState,
  ErrorNote,
  Field,
  PageHeader,
  Panel,
  formatDate,
  inputCls,
} from "@/components/ui";

const ACCEPT = ".pdf,.docx,.pptx,.txt,.md,.csv,.json";
const MAX_MB = 4; // Vercel request body limit is 4.5 MB

const VIS_META: Record<
  Visibility,
  { label: string; icon: typeof Building2; tone: "indigo" | "amber" | "emerald"; cls: string }
> = {
  organization: {
    label: "Organization",
    icon: Building2,
    tone: "emerald",
    cls: "bg-emerald-50 text-emerald-600 ring-emerald-100",
  },
  selected_departments: {
    label: "Departments",
    icon: Users,
    tone: "indigo",
    cls: "bg-indigo-50 text-indigo-600 ring-indigo-100",
  },
  department: {
    label: "Department",
    icon: FolderOpen,
    tone: "indigo",
    cls: "bg-indigo-50 text-indigo-600 ring-indigo-100",
  },
  // legacy alias written by older releases — same meaning as "department"
  org: {
    label: "Department",
    icon: FolderOpen,
    tone: "indigo",
    cls: "bg-indigo-50 text-indigo-600 ring-indigo-100",
  },
  restricted: {
    label: "Restricted",
    icon: Lock,
    tone: "amber",
    cls: "bg-amber-50 text-amber-600 ring-amber-100",
  },
};

const SCOPES = [
  { id: "organization", label: "All employees", icon: Building2 },
  { id: "selected_departments", label: "Departments", icon: Users },
  { id: "department", label: "One department", icon: FolderOpen },
  { id: "restricted", label: "Restricted", icon: Lock },
] as const;

type ScopeId = (typeof SCOPES)[number]["id"];

/** Human label for a document's audience. */
function scopeLabel(d: Doc): string {
  if (d.visibility === "organization") return "All departments";
  if (d.visibility === "selected_departments") {
    const names = (d.departments ?? []).map((t) => t.name);
    return names.length ? names.join(", ") : "Selected departments";
  }
  return d.department || "—";
}

function LibraryPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const search = useSearchParams();

  const [docs, setDocs] = useState<Doc[]>([]);
  const [depts, setDepts] = useState<Department[]>([]);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // upload form state
  const [file, setFile] = useState<File | null>(null);
  const [dept, setDept] = useState(search.get("dept") ?? "");
  const [vis, setVis] = useState<ScopeId>("department");
  const [selDepts, setSelDepts] = useState<string[]>([]);
  const [allowed, setAllowed] = useState<string[]>([]);
  const [allowDownload, setAllowDownload] = useState(true);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // per-document permissions editor (admins)
  const [edit, setEdit] = useState<Doc | null>(null);
  const [editVis, setEditVis] = useState<ScopeId>("department");
  const [editSelDepts, setEditSelDepts] = useState<string[]>([]);
  const [editAllowed, setEditAllowed] = useState<string[]>([]);
  const [editDownload, setEditDownload] = useState(true);
  const [permError, setPermError] = useState("");
  const [savingPerms, setSavingPerms] = useState(false);

  // client-side search + scope filter — operates ONLY on the authorized list
  // returned by /api/documents (never re-fetches, never bypasses the backend)
  const [q, setQ] = useState(search.get("q") ?? "");
  const [visFilter, setVisFilter] = useState<Visibility | "all">("all");

  const myDept = user?.department ?? "";
  const targetDept = dept || myDept; // where a new department-scoped upload would land

  const load = useCallback(() => {
    api
      .get<Doc[]>("/api/documents")
      .then((d) => {
        setDocs(d);
        setError(""); // a successful reload clears any earlier failure banner
      })
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    api.get<Department[]>("/api/departments").then(setDepts).catch(() => {});
    if (user?.role === "admin") {
      api.get<AdminUser[]>("/api/admin/users").then(setUsers).catch(() => {});
    }
  }, [load, user?.role]);

  // The topbar search pushes /library?q=…; the useState initializer for q only
  // runs on first mount, so re-sync whenever the URL query changes while this
  // page is already mounted (otherwise searching from /library does nothing).
  useEffect(() => {
    setQ(search.get("q") ?? "");
  }, [search]);

  function pickFile(f: File | null | undefined) {
    if (!f) return;
    if (f.size > MAX_MB * 1024 * 1024) {
      setUploadError(`File exceeds ${MAX_MB} MB.`);
      return;
    }
    setUploadError("");
    setFile(f);
  }

  function toggle(list: string[], id: string): string[] {
    return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
  }

  async function uploadFile(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setUploadError("Choose a file first.");
      return;
    }
    if (vis === "selected_departments" && selDepts.length === 0) {
      setUploadError("Pick at least one department.");
      return;
    }
    setUploading(true);
    setUploadError("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("visibility", vis);
      fd.append("department", vis === "department" || vis === "restricted" ? targetDept : "");
      fd.append("department_ids", selDepts.join(","));
      fd.append("allowed_user_ids", allowed.join(","));
      fd.append("download_allowed", String(allowDownload));
      await api.upload("/api/documents", fd);
      setFile(null);
      setAllowed([]);
      setSelDepts([]);
      setAllowDownload(true);
      if (inputRef.current) inputRef.current.value = "";
      load();
      window.dispatchEvent(new Event("omnirag:changed"));
    } catch (err) {
      setUploadError(err instanceof ApiError ? err.message : "Upload failed");
    } finally {
      setUploading(false);
    }
  }

  async function removeDoc(d: Doc) {
    if (!window.confirm(`Delete "${d.filename}" and all of its indexed chunks?`)) return;
    try {
      await api.del(`/api/documents/${d.id}`);
      load();
      window.dispatchEvent(new Event("omnirag:changed"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Delete failed");
    }
  }

  async function downloadDoc(d: Doc) {
    const token = getToken();
    if (!token) {
      setError("Session expired — please sign in again.");
      return;
    }
    try {
      const res = await fetch(`${API_BASE}/api/documents/${d.id}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = d.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError(`Download failed for "${d.filename}".`);
    }
  }

  function openEditor(d: Doc) {
    setEdit(d);
    setEditVis(d.visibility === "org" ? "department" : (d.visibility as ScopeId));
    setEditSelDepts((d.departments ?? []).map((t) => t.id));
    setEditAllowed(d.allowed_user_ids ?? []);
    setEditDownload(d.download_allowed !== false);
    setPermError("");
  }

  async function savePerms(d: Doc) {
    if (editVis === "selected_departments" && editSelDepts.length === 0) {
      setPermError("Pick at least one department.");
      return;
    }
    setSavingPerms(true);
    setPermError("");
    try {
      await api.patch(`/api/documents/${d.id}/access`, {
        visibility: editVis,
        allowed_user_ids: editAllowed,
        department_ids: editSelDepts,
        download_allowed: editDownload,
      });
      setEdit(null);
      load();
    } catch (err) {
      setPermError(err instanceof ApiError ? err.message : "Failed to save permissions");
    } finally {
      setSavingPerms(false);
    }
  }

  // org users are the possible recipients of restricted grants (same organization)
  const grantableUsers = users.filter((u) => u.id !== user?.id);

  // filter over the caller's own authorized document list
  const needle = q.trim().toLowerCase();
  const filtered = docs.filter((d) => {
    if (visFilter !== "all" && d.visibility !== visFilter) return false;
    if (!needle) return true;
    return (
      d.filename.toLowerCase().includes(needle) ||
      scopeLabel(d).toLowerCase().includes(needle) ||
      (d.department ?? "").toLowerCase().includes(needle)
    );
  });
  const filtering = needle.length > 0 || visFilter !== "all";

  return (
    <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8">
      <PageHeader
        icon={FileText}
        title="Document Library"
        subtitle={`${user?.tenant_name} · organization-wide, department, multi-department and restricted documents — enforced on the backend for every request`}
      />

      {/* scope row */}
      <div className="mb-5 flex flex-wrap items-center gap-3 text-xs">
        <Badge tone="indigo">
          <Building2 size={11} /> {isAdmin ? "Organization admin" : `Your department: ${myDept || "—"}`}
        </Badge>
        <span className="text-slate-500">
          {isAdmin
            ? `You manage every document of ${user?.tenant_name}, across all departments.`
            : "You see organization-wide files, your department's files, documents shared with your department, and restricted files granted to you."}
        </span>
      </div>

      <ErrorNote>{error}</ErrorNote>

      {/* upload panel (admins only) */}
      {isAdmin && (
        <Panel
          className="mb-6"
          icon={UploadCloud}
          title="Upload & Index New Document"
          subtitle="PDF · DOCX · PPTX · TXT · MD · CSV · JSON — choose who the file is for"
        >
          <form onSubmit={uploadFile} className="space-y-4">
            <div
              onClick={() => inputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                pickFile(e.dataTransfer.files?.[0]);
              }}
              className={`cursor-pointer rounded-xl border-2 border-dashed px-6 py-8 text-center transition ${
                dragging
                  ? "border-brand-2 bg-brand/10"
                  : "border-line bg-panel-2 hover:border-brand-2"
              }`}
            >
              <input
                ref={inputRef}
                type="file"
                accept={ACCEPT}
                className="hidden"
                onChange={(e) => pickFile(e.target.files?.[0])}
              />
              <UploadCloud size={26} className="mx-auto text-slate-400" />
              <p className="mt-2 text-sm text-slate-600">
                {file ? (
                  <span className="font-medium text-slate-900">{file.name}</span>
                ) : (
                  <>
                    <span className="font-medium text-brand-2">Choose a file</span> or drag it
                    here
                  </>
                )}
              </p>
              <p className="mt-1 text-[11px] text-slate-500">
                Max {MAX_MB} MB · extracted, chunked, embedded and indexed on upload
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Audience" hint="Company-wide content stays private to your organization.">
                <select
                  className={inputCls}
                  value={vis}
                  onChange={(e) => {
                    setVis(e.target.value as ScopeId);
                    setAllowed([]);
                  }}
                >
                  {SCOPES.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </Field>

              {(vis === "department" || vis === "restricted") && (
                <Field label="Department (required)">
                  <select
                    className={inputCls}
                    value={targetDept}
                    onChange={(e) => {
                      setDept(e.target.value);
                      setAllowed([]);
                    }}
                    required
                  >
                    <option value="" disabled>
                      Select department…
                    </option>
                    {depts.map((d) => (
                      <option key={d.id} value={d.name}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
            </div>

            {vis === "selected_departments" && (
              <Field
                label="Visible to departments"
                hint="Only members of the selected departments can view and query this document."
              >
                <div className="grid max-h-44 gap-1 overflow-y-auto rounded-lg border border-line bg-white p-2 sm:grid-cols-2">
                  {depts.map((d) => (
                    <label
                      key={d.id}
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-slate-700 hover:bg-panel-2"
                    >
                      <input
                        type="checkbox"
                        className="accent-indigo-500"
                        checked={selDepts.includes(d.id)}
                        onChange={() => setSelDepts((s) => toggle(s, d.id))}
                      />
                      {d.name}
                    </label>
                  ))}
                </div>
              </Field>
            )}

            {vis === "organization" && (
              <p className="flex items-start gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                <Building2 size={14} className="mt-0.5 shrink-0" />
                <span>
                  Every employee of <strong>{user?.tenant_name}</strong> will be able to view
                  and query this document. Other organizations never see it.
                </span>
              </p>
            )}

            {vis === "restricted" && (
              <Field
                label="Grant access to"
                hint="Only these members (any department of your organization) can retrieve this document."
              >
                <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-line bg-white p-2">
                  {grantableUsers.length === 0 ? (
                    <p className="px-2 py-1 text-xs text-slate-500">
                      No other members in your organization yet.
                    </p>
                  ) : (
                    grantableUsers.map((u) => (
                      <label
                        key={u.id}
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-slate-700 hover:bg-panel-2"
                      >
                        <input
                          type="checkbox"
                          className="accent-indigo-500"
                          checked={allowed.includes(u.id)}
                          onChange={() => setAllowed((a) => toggle(a, u.id))}
                        />
                        {u.username}
                        <span className="text-slate-500">· {u.department}</span>
                      </label>
                    ))
                  )}
                </div>
              </Field>
            )}

            <label className="flex cursor-pointer items-center gap-2 rounded-lg border border-line-2 bg-white px-3 py-2.5 text-xs text-slate-700">
              <input
                type="checkbox"
                className="accent-indigo-500"
                checked={allowDownload}
                onChange={(e) => setAllowDownload(e.target.checked)}
              />
              Allow members to download the original file (querying always stays available)
            </label>

            <ErrorNote>{uploadError}</ErrorNote>

            <div className="flex justify-end">
              <Btn type="submit" loading={uploading}>
                <UploadCloud size={15} /> Upload &amp; Index Document
              </Btn>
            </div>
          </form>
        </Panel>
      )}

      {/* indexed documents — scope resolved server-side per caller */}
      <Panel
        title={`Indexed Documents (${filtering ? `${filtered.length} of ${docs.length}` : docs.length})`}
        subtitle={
          filtering
            ? "Filtered on your device from your authorized list"
            : "Scoped to your role and permissions"
        }
        icon={FileText}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search
                size={14}
                className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400"
              />
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Filter by name or department…"
                aria-label="Filter documents"
                className="w-52 rounded-lg border border-line-2 bg-white py-1.5 pl-8 pr-2.5 text-xs text-slate-900 placeholder:text-slate-400 outline-none focus:border-brand-2 focus:ring-2 focus:ring-brand/15"
              />
            </div>
            <select
              value={visFilter}
              onChange={(e) => setVisFilter(e.target.value as Visibility | "all")}
              aria-label="Filter by audience"
              className="rounded-lg border border-line-2 bg-white px-2 py-1.5 text-xs text-slate-700 outline-none focus:border-brand-2"
            >
              <option value="all">All audiences</option>
              <option value="organization">Organization</option>
              <option value="department">Department</option>
              <option value="selected_departments">Selected departments</option>
              <option value="restricted">Restricted</option>
            </select>
          </div>
        }
        bodyClassName="p-0"
      >
        {loading ? (
          <div className="space-y-3 p-5">
            {[0, 1].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-xl bg-panel-2" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          filtering ? (
            <EmptyState
              icon={Search}
              title="No documents match your filters"
              hint="Adjust the search text or audience filter — the list only ever contains documents you are authorized to read."
              action={
                <Btn
                  variant="secondary"
                  onClick={() => {
                    setQ("");
                    setVisFilter("all");
                  }}
                >
                  Clear filters
                </Btn>
              }
            />
          ) : (
            <p className="px-5 py-10 text-center text-sm text-slate-500">
              {isAdmin
                ? "No documents yet — upload your first document above."
                : "No documents are visible to you yet."}
            </p>
          )
        ) : (
          <ul className="divide-y divide-line">
            {filtered.map((d) => {
              const meta = VIS_META[d.visibility] ?? VIS_META.department;
              const Icon = meta.icon;
              const canDownload = isAdmin || d.download_allowed !== false;
              return (
                <Fragment key={d.id}>
                  <li className="flex items-center gap-4 px-5 py-4 transition hover:bg-panel-2/60">
                    <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ring-1 ${meta.cls}`}>
                      <Icon size={18} />
                    </span>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="truncate text-sm font-medium text-slate-900" title={d.filename}>
                          {d.filename}
                        </p>
                        <Badge tone="indigo">{scopeLabel(d)}</Badge>
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                        {d.download_allowed === false && (
                          <Badge tone="slate">
                            <Ban size={10} /> No downloads
                          </Badge>
                        )}
                      </div>
                      <p className="mt-1 truncate text-xs text-slate-500">
                        {d.chunks} passage{d.chunks === 1 ? "" : "s"} · uploaded by{" "}
                        {d.uploaded_by} · {formatDate(d.created)}
                      </p>
                    </div>

                    <div className="flex shrink-0 items-center gap-1">
                      {canDownload && (
                        <button
                          onClick={() => void downloadDoc(d)}
                          title="Download original"
                          className="rounded-lg p-2 text-slate-500 transition hover:bg-panel-2 hover:text-brand-2"
                        >
                          <Download size={15} />
                        </button>
                      )}
                      {isAdmin && (
                        <>
                          <button
                            onClick={() => (edit?.id === d.id ? setEdit(null) : openEditor(d))}
                            title="Manage permissions"
                            className="rounded-lg p-2 text-slate-500 transition hover:bg-panel-2 hover:text-brand-2"
                          >
                            <ShieldCheck size={15} />
                          </button>
                          <button
                            onClick={() => void removeDoc(d)}
                            title="Delete document"
                            className="rounded-lg p-2 text-slate-500 transition hover:bg-red-50 hover:text-red-600"
                          >
                            <Trash2 size={15} />
                          </button>
                        </>
                      )}
                    </div>
                  </li>

                  {isAdmin && edit?.id === d.id && (
                    <li className="bg-panel-2/50 px-5 py-4">
                      <div className="grid gap-4 sm:grid-cols-2">
                        <Field label="Audience">
                          <select
                            className={inputCls}
                            value={editVis}
                            onChange={(e) => setEditVis(e.target.value as ScopeId)}
                          >
                            {SCOPES.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.label}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Field label="Download permission">
                          <label className="mt-1 flex cursor-pointer items-center gap-2 rounded-lg border border-line-2 bg-white px-3 py-2.5 text-xs text-slate-700">
                            <input
                              type="checkbox"
                              className="accent-indigo-500"
                              checked={editDownload}
                              onChange={(e) => setEditDownload(e.target.checked)}
                            />
                            Members with access may download the original
                          </label>
                        </Field>
                      </div>

                      {editVis === "selected_departments" && (
                        <div className="mt-3 grid max-h-44 gap-1 overflow-y-auto rounded-lg border border-line bg-white p-2 sm:grid-cols-2">
                          {depts.map((dp) => (
                            <label
                              key={dp.id}
                              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-slate-700 hover:bg-panel-2"
                            >
                              <input
                                type="checkbox"
                                className="accent-indigo-500"
                                checked={editSelDepts.includes(dp.id)}
                                onChange={() => setEditSelDepts((s) => toggle(s, dp.id))}
                              />
                              {dp.name}
                            </label>
                          ))}
                        </div>
                      )}

                      {editVis === "restricted" && (
                        <div className="mt-3 max-h-44 space-y-1 overflow-y-auto rounded-lg border border-line bg-white p-2">
                          {grantableUsers.map((u) => (
                            <label
                              key={u.id}
                              className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-slate-700 hover:bg-panel-2"
                            >
                              <input
                                type="checkbox"
                                className="accent-indigo-500"
                                checked={editAllowed.includes(u.id)}
                                onChange={() => setEditAllowed((a) => toggle(a, u.id))}
                              />
                              {u.username}
                              <span className="text-slate-500">· {u.department}</span>
                            </label>
                          ))}
                        </div>
                      )}

                      <div className="mt-3 flex items-center justify-end gap-2">
                        <ErrorNote>{permError}</ErrorNote>
                        <Btn variant="secondary" onClick={() => setEdit(null)}>
                          Cancel
                        </Btn>
                        <Btn loading={savingPerms} onClick={() => void savePerms(d)}>
                          Save permissions
                        </Btn>
                      </div>
                    </li>
                  )}
                </Fragment>
              );
            })}
          </ul>
        )}
      </Panel>
    </div>
  );
}

export default function LibraryRoute() {
  return (
    <Suspense fallback={null}>
      <LibraryPage />
    </Suspense>
  );
}
