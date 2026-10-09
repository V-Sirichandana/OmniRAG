"use client";

/**
 * Left sidebar: brand + org, primary navigation, per-user chat history and
 * the account card. Collapses into an overlay drawer on small screens.
 */
import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Building2,
  FileText,
  LogOut,
  MessageSquareText,
  Plus,
  Settings,
  ShieldCheck,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Conversation, Department } from "@/lib/types";

const NAV = [
  { href: "/ask", label: "Ask Documents", icon: MessageSquareText },
  { href: "/departments", label: "Departments", icon: Building2 },
  { href: "/library", label: "Document Library", icon: FileText },
] as const;

export function Sidebar({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [convs, setConvs] = useState<Conversation[]>([]);
  const [deptCount, setDeptCount] = useState<number | null>(null);

  // load conversation list + department count, refresh on demand
  useEffect(() => {
    if (!user) return;
    const load = () => {
      api.get<Conversation[]>("/api/conversations").then(setConvs).catch(() => {});
      api
        .get<Department[]>("/api/departments")
        .then((d) => setDeptCount(d.length))
        .catch(() => {});
    };
    load();
    window.addEventListener("omnirag:changed", load);
    return () => window.removeEventListener("omnirag:changed", load);
  }, [user]);

  if (!user) return null;
  const active = pathname;
  const isAdmin = user.role === "admin";

  const items = [
    ...NAV.map((n) => ({ ...n, count: n.href === "/departments" ? deptCount : undefined })),
    ...(isAdmin
      ? [{ href: "/admin", label: "Administration", icon: Settings, count: undefined }]
      : []),
  ];

  const go = (href: string) => {
    router.push(href);
    onClose();
  };

  return (
    <>
      {/* backdrop on mobile */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/60 lg:hidden"
          onClick={onClose}
          aria-hidden
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-line bg-ink-2 transition-transform duration-200 lg:static lg:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* brand */}
        <div className="flex items-center justify-between gap-2 px-5 pt-5 pb-4">
          <button className="flex min-w-0 items-center gap-3 text-left" onClick={() => go("/ask")}>
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-brand to-accent shadow-[0_10px_30px_-14px_rgba(124,58,237,.9)]">
              <ShieldCheck size={20} className="text-white" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-bold text-white">OmniRAG</span>
              <span className="flex items-center gap-1 truncate text-xs text-muted">
                <Building2 size={11} className="shrink-0" />
                <span className="truncate">{user.tenant_name ?? "Workspace"}</span>
              </span>
            </span>
          </button>
          <button className="rounded-lg p-1.5 text-slate-400 hover:bg-panel-2 lg:hidden" onClick={onClose} aria-label="Close menu">
            <X size={18} />
          </button>
        </div>

        {/* navigation */}
        <nav className="space-y-1 px-3">
          {items.map((item) => {
            const on = active === item.href;
            const Icon = item.icon;
            return (
              <button
                key={item.href}
                onClick={() => go(item.href)}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${
                  on
                    ? "bg-brand text-white shadow-[0_8px_24px_-14px_rgba(79,70,229,1)]"
                    : "text-slate-400 hover:bg-panel-2 hover:text-white"
                }`}
              >
                <Icon size={17} className="shrink-0" />
                <span className="flex-1 text-left">
                  {item.label}
                  {typeof item.count === "number" && item.count > 0 && (
                    <span className="ml-1 text-xs opacity-70">({item.count})</span>
                  )}
                </span>
              </button>
            );
          })}
        </nav>

        {/* chat history */}
        <div className="mt-6 flex min-h-0 flex-1 flex-col px-3">
          <div className="mb-2 flex items-center justify-between px-1">
            <div>
              <p className="text-[10px] font-semibold tracking-[0.14em] text-slate-500">
                YOUR QUERIES
              </p>
              <p className="text-[10px] text-slate-600">Isolated to {user.username}</p>
            </div>
            <button
              onClick={() => go("/ask")}
              className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-[11px] text-slate-400 transition hover:border-brand-2 hover:text-white"
            >
              <Plus size={12} /> New
            </button>
          </div>
          <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pb-3">
            {convs.length === 0 ? (
              <p className="px-1 py-3 text-xs text-slate-600">No conversations yet</p>
            ) : (
              convs.map((c) => {
                const on = pathname === "/ask" && search.get("c") === c.id;
                return (
                  <button
                    key={c.id}
                    onClick={() => go(`/ask?c=${c.id}`)}
                    className={`block w-full truncate rounded-md px-2.5 py-2 text-left text-xs transition ${
                      on ? "bg-panel-2 text-white" : "text-slate-400 hover:bg-panel-2 hover:text-slate-200"
                    }`}
                    title={c.title}
                  >
                    {c.title || "Untitled query"}
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* account card */}
        <div className="border-t border-line p-3">
          <div className="flex items-center gap-3 rounded-xl bg-panel px-3 py-2.5">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand to-accent text-sm font-bold text-white">
              {user.username.slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 truncate text-sm font-semibold text-white">
                {user.username}
                {isAdmin && (
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-amber-300">
                    ADMIN
                  </span>
                )}
              </p>
              <p className="truncate text-[11px] text-muted">
                {user.department || "General"}
              </p>
            </div>
            <button
              onClick={logout}
              title="Sign out"
              className="rounded-lg p-2 text-red-400/80 transition hover:bg-red-500/10 hover:text-red-400"
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}
