"use client";

/**
 * Document Library — upload & index with strict department isolation.
 *
 * Every document belongs to exactly one department and is visible ONLY to
 * that department (admins included). "Restricted" narrows access to an
 * explicit allowlist *within* the department.
 */
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Building2,
  Download,
  FileText,
  Lock,
  ShieldAlert,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { api, ApiError, getToken } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { AdminUser, Department, Doc, Visibility } from "@/lib/types";
import { Badge, Btn, ErrorNote, Field, Panel, formatDate, inputCls } from "@/components/ui";

const ACCEPT = ".pdf,.docx,.pptx,.txt,.md,.csv,.json";
const MAX_MB = 4; // Vercel request body limit is 4.5 MB

const VIS_META: Record<
  Visibility,
  { label: string; icon: typeof Building2; tone: "indigo" | "amber"; cls: string }
> = {
  // legacy alias: "org" behaves exactly like "department" (never crosses depts)
  org: {
    label: "Department",
    icon: Building2,
    tone: "indigo",
    cls: "bg-indigo-500/10 text-indigo-300 ring-indigo-500/30",
  },
  department: {
    label: "Department",
    icon: Building2,
    tone: "indigo",
    cls: "bg-indigo-500/10 text-indigo-300 ring-indigo-500/30",
  },
  restricted: {
    label: "Restricted",
    icon: Lock,
    tone: "amber",
    cls: "bg-amber-500/10 text-amber-300 ring-amber-500/30",
  },
};

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
  const [vis, setVis] = useState<Visibility>("department");
  const [allowed, setAllowed] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const myDept = user?.department ?? "";
  const targetDept = dept || myDept; // where a new upload would land

  const load = useCallback(() => {
    api
      .get<Doc[]>("/api/documents")
      .then(setDocs)
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

  function pickFile(f: File | null | undefined) {
    if (!f) return;
    if (f.size > MAX_MB * 1024 * 1024) {
      setUploadError(`File exceeds ${MAX_MB} MB.`);
      return;
    }
    setUploadError("");
    setFile(f);
  }

  async function uploadFile(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setUploadError("Choose a file first.");
      return;
    }
    setUploading(true);
    setUploadError("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("visibility", vis);
      fd.append("department", targetDept);
      fd.append("allowed_user_ids", allowed.join(","));
      await api.upload("/api/documents", fd);
      setFile(null);
      setAllowed([]);
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
    try {
      const res = await fetch(`/api/documents/${d.id}/download`, {
        headers: { Authorization: `Bearer ${getToken()}` },
      });
      if (!res.ok) throw new Error("download failed");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = d.filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setError("Download failed.");
    }
  }

  // same-department users are the only possible recipients of a grant
  const deptUsers = users.filter((u) => u.id !== user?.id && u.department === targetDept);
  const deptOptions = depts.some((d) => d.name === myDept) || !myDept
    ? depts
    : [...depts, { id: "__mine", name: myDept, code: "", created: "", documents: 0, members: 0 }];

  return (
    <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8">
      {/* header */}
      <div className="mb-6">
        <h1 className="text-xl font-bold text-white">Document Library</h1>
        <p className="mt-1 text-sm text-muted">
          {user?.tenant_name} · strict department isolation — every file, answer and
          citation stays inside its own department.
        </p>
      </div>

      {/* scope row: everyone sees exactly one department */}
      <div className="mb-5 flex flex-wrap items-center gap-3 text-xs">
        <Badge tone="indigo">
          <Building2 size={11} /> Your department: {myDept || "—"}
        </Badge>
        <span className="text-slate-500">
          {isAdmin
            ? "Even administrators only see files of their own department."
            : "Only your department's files are listed — nothing else is accessible."}
        </span>
      </div>

      <ErrorNote>{error}</ErrorNote>

      {/* upload panel (admins only) */}
      {isAdmin && (
        <Panel
          className="mb-6"
          icon={UploadCloud}
          title="Upload & Index New Document"
          subtitle="PDF · DOCX · PPTX · TXT · MD · CSV · JSON — always filed into one department"
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
                  : "border-line bg-ink-2/60 hover:border-line-2"
              }`}
            >
              <input
                ref={inputRef}
                type="file"
                accept={ACCEPT}
                className="hidden"
                onChange={(e) => pickFile(e.target.files?.[0])}
              />
              <UploadCloud size={26} className="mx-auto text-slate-500" />
              <p className="mt-2 text-sm text-slate-300">
                {file ? (
                  <span className="font-medium text-white">{file.name}</span>
                ) : (
                  <>
                    <span className="text-indigo-300">Choose a file</span> or drag it here
                  </>
                )}
              </p>
              <p className="mt-1 text-[11px] text-slate-500">
                Max {MAX_MB} MB · extracted, chunked, embedded and indexed on upload
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Department (required)" hint="Files are only ever visible inside this department.">
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
                  {deptOptions.map((d) => (
                    <option key={d.id} value={d.name}>
                      {d.name}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="Access Control">
                <div className="flex overflow-hidden rounded-lg border border-line">
                  {(
                    [
                      { id: "department", label: "Whole Department", icon: Building2 },
                      { id: "restricted", label: "Restricted", icon: Lock },
                    ] as const
                  ).map((v) => (
                    <button
                      key={v.id}
                      type="button"
                      onClick={() => setVis(v.id)}
                      className={`flex flex-1 items-center justify-center gap-1.5 px-2 py-2.5 text-xs font-medium transition ${
                        vis === v.id
                          ? "bg-brand text-white"
                          : "bg-ink-2 text-slate-400 hover:text-white"
                      }`}
                    >
                      <v.icon size={13} /> {v.label}
                    </button>
                  ))}
                </div>
              </Field>
            </div>

            {targetDept && targetDept !== myDept && (
              <p className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
                <ShieldAlert size={14} className="mt-0.5 shrink-0" />
                <span>
                  This file belongs to <strong>{targetDept}</strong>. Because isolation is
                  strict, <u>you won&apos;t see it yourself</u> — it is for that
                  department&apos;s members only.
                </span>
              </p>
            )}

            {vis === "restricted" && (
              <Field
                label="Grant access to"
                hint="Only these members (of the same department) can retrieve this document."
              >
                <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-line bg-ink-2 p-2">
                  {deptUsers.length === 0 ? (
                    <p className="px-2 py-1 text-xs text-slate-500">
                      No other members in {targetDept || "this department"} yet.
                    </p>
                  ) : (
                    deptUsers.map((u) => (
                      <label
                        key={u.id}
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-slate-300 hover:bg-panel-2"
                      >
                        <input
                          type="checkbox"
                          className="accent-indigo-500"
                          checked={allowed.includes(u.id)}
                          onChange={(e) =>
                            setAllowed((a) =>
                              e.target.checked ? [...a, u.id] : a.filter((x) => x !== u.id),
                            )
                          }
                        />
                        {u.username}
                        <span className="text-slate-500">· {u.department}</span>
                      </label>
                    ))
                  )}
                </div>
              </Field>
            )}

            <ErrorNote>{uploadError}</ErrorNote>

            <div className="flex justify-end">
              <Btn type="submit" loading={uploading}>
                <UploadCloud size={15} /> Upload &amp; Index Document
              </Btn>
            </div>
          </form>
        </Panel>
      )}

      {/* indexed documents — already scoped server-side to the caller's department */}
      <Panel
        title={`Indexed Documents (${docs.length})`}
        subtitle={`Scoped to ${myDept || "your department"}`}
        icon={FileText}
        bodyClassName="p-0"
      >
        {loading ? (
          <div className="space-y-3 p-5">
            {[0, 1].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-xl bg-panel-2/60" />
            ))}
          </div>
        ) : docs.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-slate-500">
            {isAdmin
              ? "No documents in your department yet — upload your first document above."
              : "No documents are visible to you yet."}
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {docs.map((d) => {
              const meta = VIS_META[d.visibility] ?? VIS_META.department;
              const Icon = meta.icon;
              return (
                <li
                  key={d.id}
                  className="flex items-center gap-4 px-5 py-4 transition hover:bg-panel-2/40"
                >
                  <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ring-1 ${meta.cls}`}>
                    <Icon size={18} />
                  </span>

                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium text-white" title={d.filename}>
                        {d.filename}
                      </p>
                      <Badge tone="indigo">{d.department || "—"}</Badge>
                      <Badge tone={meta.tone}>{meta.label}</Badge>
                    </div>
                    <p className="mt-1 truncate text-xs text-slate-500">
                      {d.chunks} passage{d.chunks === 1 ? "" : "s"} · uploaded by{" "}
                      {d.uploaded_by} · {formatDate(d.created)}
                    </p>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      onClick={() => void downloadDoc(d)}
                      title="Download original"
                      className="rounded-lg p-2 text-slate-500 transition hover:bg-panel-2 hover:text-white"
                    >
                      <Download size={15} />
                    </button>
                    {isAdmin && (
                      <button
                        onClick={() => void removeDoc(d)}
                        title="Delete document"
                        className="rounded-lg p-2 text-slate-500 transition hover:bg-red-500/10 hover:text-red-400"
                      >
                        <Trash2 size={15} />
                      </button>
                    )}
                  </div>
                </li>
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
