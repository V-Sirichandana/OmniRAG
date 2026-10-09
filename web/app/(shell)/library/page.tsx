"use client";

/**
 * Document Library — upload & index, department filters, access control and
 * the indexed document list (with download/delete for admins).
 */
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import {
  Building2,
  Download,
  FileText,
  Globe2,
  Lock,
  Trash2,
  UploadCloud,
} from "lucide-react";
import { api, ApiError, getToken } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { AdminUser, Department, Doc, Visibility } from "@/lib/types";
import { Badge, Btn, ErrorNote, Field, Panel, formatDate, inputCls } from "@/components/ui";

const ACCEPT = ".pdf,.docx,.pptx,.txt,.md,.csv,.json";
const MAX_MB = 4; // Vercel request body limit is 4.5 MB

const VIS_META: Record<Visibility, { label: string; icon: typeof Globe2; tone: "emerald" | "indigo" | "amber"; cls: string }> = {
  org: { label: "Org-wide", icon: Globe2, tone: "emerald", cls: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/30" },
  department: { label: "Department", icon: Building2, tone: "indigo", cls: "bg-indigo-500/10 text-indigo-300 ring-indigo-500/30" },
  restricted: { label: "Restricted", icon: Lock, tone: "amber", cls: "bg-amber-500/10 text-amber-300 ring-amber-500/30" },
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
  const [filter, setFilter] = useState<string>(search.get("dept") ?? "All");

  // upload form state
  const [file, setFile] = useState<File | null>(null);
  const [dept, setDept] = useState(search.get("dept") && search.get("dept") !== "All" ? search.get("dept")! : "");
  const [vis, setVis] = useState<Visibility>("org");
  const [allowed, setAllowed] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

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
      fd.append("department", dept);
      fd.append("allowed_user_ids", allowed.join(","));
      await api.upload("/api/documents", fd);
      setFile(null);
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

  const filtered = docs.filter((d) => filter === "All" || d.department === filter);
  const filterOptions = ["All", ...depts.map((d) => d.name)];

  return (
    <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8">
      {/* header */}
      <div className="mb-6">
        <h1 className="text-xl font-bold text-white">Document Library</h1>
        <p className="mt-1 text-sm text-muted">
          {user?.tenant_name} ({isAdmin ? "Administrator" : "Member"} oversight) · indexed
          knowledge with per-document access control
        </p>
      </div>

      {/* department filter */}
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs font-medium text-slate-500">
          {isAdmin ? "Administrator" : ""} Department Filter:
        </span>
        {filterOptions.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded-full border px-3 py-1.5 text-xs font-medium transition ${
              filter === f
                ? "border-brand bg-brand text-white"
                : "border-line bg-panel text-slate-400 hover:border-line-2 hover:text-white"
            }`}
          >
            {f}
          </button>
        ))}
        <span className="ml-auto text-xs text-slate-500">Viewing: {filter}</span>
      </div>

      <ErrorNote>{error}</ErrorNote>

      {/* upload panel (admins only) */}
      {isAdmin && (
        <Panel
          className="mb-6"
          icon={UploadCloud}
          title="Upload & Index New Document"
          subtitle="PDF · DOCX · PPTX · TXT · MD · CSV · JSON"
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
              <Field label="Department">
                <select
                  className={inputCls}
                  value={dept}
                  onChange={(e) => setDept(e.target.value)}
                  required={vis === "department"}
                >
                  <option value="">Select department…</option>
                  {depts.map((d) => (
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
                      { id: "org", label: "Whole Org", icon: Globe2 },
                      { id: "department", label: "Department", icon: Building2 },
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

            {vis === "restricted" && (
              <Field label="Grant access to" hint="Only these users will be able to retrieve this document.">
                <div className="max-h-40 space-y-1 overflow-y-auto rounded-lg border border-line bg-ink-2 p-2">
                  {users
                    .filter((u) => u.id !== user?.id)
                    .map((u) => (
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
                    ))}
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

      {/* indexed documents */}
      <Panel
        title={`Indexed Documents (${filtered.length})`}
        subtitle={
          filter === "All"
            ? "All documents you are authorized to see"
            : `Filtered to ${filter}`
        }
        icon={FileText}
        bodyClassName="p-0"
      >
        {loading ? (
          <div className="space-y-3 p-5">
            {[0, 1].map((i) => (
              <div key={i} className="h-16 animate-pulse rounded-xl bg-panel-2/60" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-slate-500">
            {isAdmin
              ? "No documents indexed yet — upload your first document above."
              : "No documents are visible to you yet."}
          </p>
        ) : (
          <ul className="divide-y divide-line">
            {filtered.map((d) => {
              const meta = VIS_META[d.visibility] ?? VIS_META.org;
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
