"use client";

/**
 * Authenticated app shell: sidebar + top bar (mobile). The AuthProvider
 * bounces unauthenticated visitors to /login; the backend enforces the
 * real security.
 */
import { Suspense, useState } from "react";
import { Menu, ShieldCheck } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { Sidebar } from "@/components/sidebar";

export default function ShellLayout({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const [open, setOpen] = useState(false);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-line-2 border-t-brand-2" />
      </div>
    );
  }
  if (!user) return null; // AuthProvider redirects to /login

  return (
    <div className="flex min-h-screen">
      <Suspense fallback={null}>
        <Sidebar open={open} onClose={() => setOpen(false)} />
      </Suspense>
      <div className="flex min-w-0 flex-1 flex-col">
        {/* mobile top bar */}
        <header className="flex items-center gap-3 border-b border-line bg-ink-2 px-4 py-3 lg:hidden">
          <button
            onClick={() => setOpen(true)}
            className="rounded-lg border border-line p-2 text-slate-300"
            aria-label="Open menu"
          >
            <Menu size={18} />
          </button>
          <span className="flex items-center gap-2 font-semibold text-white">
            <span className="grid h-7 w-7 place-items-center rounded-lg bg-gradient-to-br from-brand to-accent">
              <ShieldCheck size={15} className="text-white" />
            </span>
            OmniRAG
          </span>
        </header>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
