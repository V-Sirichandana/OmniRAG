"use client";

/**
 * Departments — organization structure. Each department scopes document
 * visibility; admins can create and remove departments.
 */
import { useCallback, useEffect, useState } from "react";
import { Building2, FileText, Plus, Trash2, Users } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Department } from "@/lib/types";
import { Badge, Btn, ErrorNote, Field, Panel, inputCls } from "@/components/ui";

export default function DepartmentsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";
  const [depts, setDepts] = useState<Department[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .get<Department[]>("/api/departments")
      .then(setDepts)
      .catch((e) => setError(e instanceof ApiError ? e.message : "Failed to load"))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  async function createDept(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setFormError("");
    try {
      await api.post<Department>("/api/departments", {
        name: name.trim(),
        code: code.trim().toUpperCase(),
      });
      setName("");
      setCode("");
      setShowForm(false);
      load();
      window.dispatchEvent(new Event("omnirag:changed"));
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : "Failed to create");
    } finally {
      setBusy(false);
    }
  }

  async function removeDept(d: Department) {
    if (!window.confirm(`Delete department "${d.name}"? Documents must be moved first.`))
      return;
    try {
      await api.del(`/api/departments/${d.id}`);
      load();
      window.dispatchEvent(new Event("omnirag:changed"));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to delete");
    }
  }

  return (
    <div className="mx-auto max-w-6xl px-5 py-8 sm:px-8">
      <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-white">Departments</h1>
          <p className="mt-1 text-sm text-muted">
            Department membership controls which restricted documents a member can
            retrieve. Every check is enforced on the backend.
          </p>
        </div>
        {isAdmin && (
          <Btn onClick={() => setShowForm((s) => !s)} variant={showForm ? "secondary" : "primary"}>
            <Plus size={15} /> {showForm ? "Cancel" : "New Department"}
          </Btn>
        )}
      </div>

      {showForm && isAdmin && (
        <Panel className="mb-6" title="Create department" icon={Building2}>
          <form onSubmit={createDept} className="grid gap-4 sm:grid-cols-[1fr_140px_auto] sm:items-end">
            <Field label="Department name">
              <input
                className={inputCls}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Research Lab"
                required
                minLength={2}
                maxLength={60}
              />
            </Field>
            <Field label="Code">
              <input
                className={`${inputCls} uppercase`}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="RSH"
                maxLength={10}
              />
            </Field>
            <Btn type="submit" loading={busy}>
              Create
            </Btn>
            <div className="sm:col-span-3">
              <ErrorNote>{formError}</ErrorNote>
            </div>
          </form>
        </Panel>
      )}

      <ErrorNote>{error}</ErrorNote>

      {loading ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map((i) => (
            <div key={i} className="panel h-36 animate-pulse bg-panel/60" />
          ))}
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {depts.map((d) => (
            <div
              key={d.id}
              className="panel group flex flex-col p-5 transition hover:border-line-2"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-3">
                  <span className="grid h-11 w-11 place-items-center rounded-xl bg-gradient-to-br from-brand/25 to-accent/25 ring-1 ring-brand/30">
                    <Building2 size={20} className="text-indigo-300" />
                  </span>
                  <div>
                    <h3 className="font-semibold leading-tight text-white">{d.name}</h3>
                    <Badge tone="indigo" className="mt-1 font-mono">
                      {d.code}
                    </Badge>
                  </div>
                </div>
                {isAdmin && (
                  <button
                    onClick={() => void removeDept(d)}
                    title="Delete department"
                    className="rounded-lg p-2 text-slate-600 opacity-0 transition hover:bg-red-500/10 hover:text-red-400 group-hover:opacity-100"
                  >
                    <Trash2 size={15} />
                  </button>
                )}
              </div>

              <div className="mt-5 flex items-center gap-4 text-xs text-muted">
                <span className="flex items-center gap-1.5">
                  <FileText size={13} className="text-brand-2" />
                  {d.documents} document{d.documents === 1 ? "" : "s"}
                </span>
                <span className="flex items-center gap-1.5">
                  <Users size={13} className="text-accent" />
                  {d.members} member{d.members === 1 ? "" : "s"}
                </span>
              </div>

              <a
                href={`/library?dept=${encodeURIComponent(d.name)}`}
                className="mt-4 border-t border-line pt-3 text-xs font-medium text-indigo-400 transition hover:text-indigo-300"
              >
                View department documents →
              </a>
            </div>
          ))}
        </div>
      )}

      {!loading && depts.length === 0 && (
        <p className="mt-8 text-sm text-slate-500">No departments yet.</p>
      )}
    </div>
  );
}
