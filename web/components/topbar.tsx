"use client";

/**
 * Workspace top bar — company identity, global search (jumps to the
 * Document Library with the query) and the authenticated profile menu.
 * Admin actions live in the menu only when the backend actually allows them.
 */
import { useEffect, useRef, useState, type FormEvent } from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  Building2,
  LogOut,
  Menu,
  Search,
  Settings,
  ShieldCheck,
  UserRound,
} from "lucide-react";
import { useAuth } from "@/lib/auth";

/** First letters of the organization name — the "logo" when no image exists. */
function orgInitials(name?: string): string {
  const words = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "OR";
  return words.slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
}

export function Topbar({ onMenu }: { onMenu: () => void }) {
  const { user, logout } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  // close the profile menu on navigation or outside click
  useEffect(() => setMenu(false), [pathname]);
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [menu]);

  if (!user) return null;
  const isAdmin = user.role === "admin";

  function search(e: FormEvent) {
    e.preventDefault();
    const q = query.trim();
    router.push(q ? `/library?q=${encodeURIComponent(q)}` : "/library");
  }

  return (
    <header className="sticky top-0 z-20 flex items-center gap-3 border-b border-line bg-ink-2/90 px-4 py-3 backdrop-blur sm:px-6">
      <button
        onClick={onMenu}
        className="rounded-lg border border-line p-2 text-slate-600 transition hover:bg-panel-2 lg:hidden"
        aria-label="Open navigation"
      >
        <Menu size={18} />
      </button>

      {/* company identity */}
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-brand to-accent text-[11px] font-bold text-white">
          {orgInitials(user.tenant_name)}
        </span>
        <span className="hidden min-w-0 sm:block">
          <span className="block truncate text-sm font-semibold text-slate-900">
            {user.tenant_name ?? "Workspace"}
          </span>
          <span className="block truncate text-[10px] text-muted">Secure RAG workspace</span>
        </span>
      </div>

      {/* search */}
      <form onSubmit={search} className="ml-auto flex max-w-md flex-1 items-center sm:ml-6">
        <div className="relative w-full">
          <Search
            size={15}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search documents…"
            aria-label="Search documents"
            className="w-full rounded-lg border border-line bg-panel-2 py-2 pl-9 pr-3 text-sm text-slate-900 placeholder:text-slate-400 outline-none transition focus:border-brand-2 focus:bg-white focus:ring-2 focus:ring-brand/15"
          />
        </div>
      </form>

      {/* profile menu */}
      <div ref={menuRef} className="relative shrink-0">
        <button
          onClick={() => setMenu((m) => !m)}
          aria-expanded={menu}
          className="flex items-center gap-2 rounded-lg border border-line px-2 py-1.5 transition hover:bg-panel-2"
        >
          <span className="grid h-7 w-7 place-items-center rounded-full bg-gradient-to-br from-brand to-accent text-xs font-bold text-white">
            {user.username.slice(0, 1).toUpperCase()}
          </span>
          <span className="hidden text-left md:block">
            <span className="block max-w-[120px] truncate text-xs font-semibold text-slate-800">
              {user.username}
            </span>
            <span className="block text-[10px] text-muted">
              {isAdmin ? "Organization admin" : user.department || "General"}
            </span>
          </span>
        </button>

        {menu && (
          <div className="absolute right-0 top-full z-30 mt-2 w-60 overflow-hidden rounded-xl border border-line bg-white shadow-[0_16px_48px_-20px_rgba(15,23,42,.35)]">
            <div className="border-b border-line px-4 py-3">
              <p className="truncate text-sm font-semibold text-slate-900">{user.username}</p>
              <p className="truncate text-xs text-muted">{user.tenant_name}</p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                <span
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${
                    isAdmin
                      ? "border-amber-200 bg-amber-50 text-amber-700"
                      : "border-indigo-200 bg-indigo-50 text-indigo-700"
                  }`}
                >
                  {isAdmin ? <ShieldCheck size={10} /> : <UserRound size={10} />}
                  {isAdmin ? "Admin" : "Member"}
                </span>
                <span className="rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-600">
                  {user.department || "General"}
                </span>
              </div>
            </div>
            <button
              onClick={() => router.push("/settings")}
              className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-slate-700 transition hover:bg-panel-2"
            >
              <Settings size={15} className="text-slate-400" /> Settings
            </button>
            <button
              onClick={() => router.push("/departments")}
              className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-slate-700 transition hover:bg-panel-2"
            >
              <Building2 size={15} className="text-slate-400" /> Your department
            </button>
            <div className="border-t border-line">
              <button
                onClick={logout}
                className="flex w-full items-center gap-2.5 px-4 py-2.5 text-sm text-red-600 transition hover:bg-red-50"
              >
                <LogOut size={15} /> Sign out
              </button>
            </div>
          </div>
        )}
      </div>
    </header>
  );
}
