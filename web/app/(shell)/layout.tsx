"use client";

/**
 * Authenticated app shell: navy sidebar + light workspace top bar.
 * The AuthProvider bounces unauthenticated visitors to /login; the backend
 * enforces the real security.
 */
import { Suspense, useState } from "react";
import { useAuth } from "@/lib/auth";
import { Sidebar } from "@/components/sidebar";
import { Topbar } from "@/components/topbar";

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
        <Suspense fallback={null}>
          <Topbar onMenu={() => setOpen(true)} />
        </Suspense>
        <main className="min-w-0 flex-1">{children}</main>
      </div>
    </div>
  );
}
