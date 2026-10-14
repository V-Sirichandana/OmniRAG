"use client";

/**
 * Left navigation — dark navy rail: brand + organization, permission-aware
 * navigation (HR / Team workspaces appear only for the matching department or
 * manager designation; Administration only for admins), the user's chat
 * history, and the account card. Collapses into a drawer on small screens.
 *
 * Visibility here is UX only — every route and API is enforced server-side.
 */
import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Building2,
  Crown,
  FileText,
  LayoutDashboard,
  LogOut,
  HeartPulse,
  MessageSquareText,
  Plus,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Conversation, Department } from "@/lib/types";

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
  const isAdmin = user.role === "admin";
  const isHr = user.department === "Human Resources";
  const isManager = Boolean(user.is_manager);

  const groups: {
    label: string;
    items: { href: string; label: string; icon: typeof Users; count?: number | null }[];
  }[] = [
    {
      label: "Workspace",
      items: [
        { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
        { href: "/ask", label: "Ask OmniRAG", icon: MessageSquareText },
        { href: "/library", label: "Document Library", icon: FileText, count: null },
        { href: "/departments", label: "Departments", icon: Building2, count: deptCount },
      ],
    },
    ...(isHr || isManager
      ? [
          {
            label: "Team spaces",
            items: [
              ...(isHr ? [{ href: "/hr", label: "HR Workspace", icon: HeartPulse }] : []),
              ...(isManager
                ? [{ href: "/team", label: "Team Workspace", icon: Users }]
                : []),
            ],
          },
        ]
      : []),
    {
      label: "Administration",
      items: [
        ...(isAdmin ? [{ href: "/admin", label: "Administration", icon: ShieldCheck }] : []),
        { href: "/settings", label: "Settings", icon: SlidersHorizontal },
      ],
    },
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
          className="fixed inset-0 z-30 bg-slate-950/50 lg:hidden"
          onClick={onClose}
          aria-hidden
        />
      )}
      <aside
        className={`fixed inset-y-0 left-0 z-40 flex w-72 flex-col border-r border-navy-line bg-navy transition-transform duration-200 lg:static lg:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        {/* brand */}
        <div className="flex items-center justify-between gap-2 px-5 pt-5 pb-4">
          <button
            className="flex min-w-0 items-center gap-3 text-left"
            onClick={() => go("/dashboard")}
          >
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-brand to-accent shadow-[0_10px_30px_-14px_rgba(124,58,237,.9)]">
              <ShieldCheck size={20} className="text-white" />
            </span>
            <span className="min-w-0">
              <span className="block truncate text-[15px] font-bold text-white">OmniRAG</span>
              <span className="flex items-center gap-1 truncate text-xs text-slate-400">
                <Building2 size={11} className="shrink-0" />
                <span className="truncate">{user.tenant_name ?? "Workspace"}</span>
              </span>
            </span>
          </button>
          <button
            className="rounded-lg p-1.5 text-slate-400 hover:bg-navy-2 hover:text-white lg:hidden"
            onClick={onClose}
            aria-label="Close menu"
          >
            <X size={18} />
          </button>
        </div>

        {/* navigation */}
        <nav className="space-y-5 px-3">
          {groups.map((g) => (
            <div key={g.label}>
              <p className="mb-1.5 px-3 text-[10px] font-semibold tracking-[0.14em] text-slate-500">
                {g.label.toUpperCase()}
              </p>
              <div className="space-y-0.5">
                {g.items.map((item) => {
                  const on = pathname === item.href;
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.href}
                      onClick={() => go(item.href)}
                      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${
                        on
                          ? "bg-brand text-white shadow-[0_8px_24px_-14px_rgba(79,70,229,1)]"
                          : "text-slate-400 hover:bg-navy-2 hover:text-white"
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
              </div>
            </div>
          ))}
        </nav>

        {/* chat history */}
        <div className="mt-6 flex min-h-0 flex-1 flex-col px-3">
          <div className="mb-2 flex items-center justify-between px-1">
            <div>
              <p className="text-[10px] font-semibold tracking-[0.14em] text-slate-500">
                RECENT QUERIES
              </p>
              <p className="text-[10px] text-slate-600">Isolated to {user.username}</p>
            </div>
            <button
              onClick={() => go("/ask")}
              className="flex items-center gap-1 rounded-md border border-navy-line px-2 py-1 text-[11px] text-slate-400 transition hover:border-brand-2 hover:text-white"
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
                      on
                        ? "bg-navy-2 text-white"
                        : "text-slate-400 hover:bg-navy-2 hover:text-slate-200"
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
        <div className="border-t border-navy-line p-3">
          <div className="flex items-center gap-3 rounded-xl bg-navy-2 px-3 py-2.5">
            <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-gradient-to-br from-brand to-accent text-sm font-bold text-white">
              {user.username.slice(0, 1).toUpperCase()}
            </span>
            <div className="min-w-0 flex-1">
              <p className="flex items-center gap-1.5 truncate text-sm font-semibold text-white">
                <span className="truncate">{user.username}</span>
                {isAdmin && (
                  <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-amber-300">
                    ADMIN
                  </span>
                )}
                {!isAdmin && isManager && (
                  <span className="inline-flex items-center gap-0.5 rounded bg-indigo-500/20 px-1.5 py-0.5 text-[9px] font-bold tracking-wide text-indigo-300">
                    <Crown size={8} /> MANAGER
                  </span>
                )}
              </p>
              <p className="truncate text-[11px] text-slate-400">
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
