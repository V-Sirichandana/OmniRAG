"use client";

/**
 * Login / Join with Employee ID / Create Organization.
 * Dark centered card with purple shield brand — mirrors the reference design.
 */
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Building2, KeyRound, Loader2, ShieldCheck, UserPlus } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Session } from "@/lib/types";
import { ErrorNote, Field, inputCls } from "@/components/ui";

type Tab = "signin" | "join" | "org";

const TABS: { id: Tab; label: string }[] = [
  { id: "signin", label: "Sign in" },
  { id: "join", label: "Join with Employee ID" },
  { id: "org", label: "Create Organization" },
];

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [tab, setTab] = useState<Tab>("signin");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [orgName, setOrgName] = useState("");
  const [invite, setInvite] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      let session: Session;
      if (tab === "signin") {
        session = await api.post<Session>("/api/auth/login", { username, password });
      } else if (tab === "join") {
        session = await api.post<Session>("/api/auth/register", {
          username,
          password,
          invite_code: invite.trim(),
        });
      } else {
        session = await api.post<Session>("/api/auth/signup-org", {
          org_name: orgName.trim(),
          username,
          password,
        });
      }
      login(session);
      router.replace("/ask");
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Something went wrong. Is the API running?");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="glow-bg flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        {/* brand */}
        <div className="mb-7 flex flex-col items-center text-center">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-brand to-accent shadow-[0_16px_40px_-16px_rgba(124,58,237,.9)]">
            <ShieldCheck className="text-white" size={28} strokeWidth={2.2} />
          </div>
          <h1 className="mt-4 text-3xl font-bold tracking-tight text-white">OmniRAG</h1>
          <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted">
            Enterprise Knowledge Base with Cross-Department Retrieval &amp; Strict Citations
          </p>
        </div>

        <div className="panel p-6 shadow-[0_24px_80px_-40px_rgba(79,70,229,.55)]">
          {/* tabs */}
          <div className="mb-5 flex border-b border-line" role="tablist">
            {TABS.map((t) => (
              <button
                key={t.id}
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => {
                  setTab(t.id);
                  setError("");
                }}
                className={`-mb-px flex-1 border-b-2 px-2 py-2.5 text-[13px] font-medium transition ${
                  tab === t.id
                    ? "border-brand-2 text-white"
                    : "border-transparent text-slate-500 hover:text-slate-300"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <form onSubmit={submit} className="space-y-4">
            {tab === "org" && (
              <Field label="Organization name">
                <input
                  className={inputCls}
                  value={orgName}
                  onChange={(e) => setOrgName(e.target.value)}
                  placeholder="e.g. Acme Corporation"
                  required
                  minLength={2}
                  maxLength={80}
                />
              </Field>
            )}

            {tab === "join" && (
              <Field label="Company Employee ID" hint="Ask your administrator to issue one from Administration.">
                <input
                  className={`${inputCls} font-mono uppercase tracking-wider`}
                  value={invite}
                  onChange={(e) => setInvite(e.target.value)}
                  placeholder="ENG-482910"
                  required
                />
              </Field>
            )}

            <Field label="Username">
              <input
                className={inputCls}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder={tab === "org" ? "Choose an admin username" : "your.username"}
                required
                minLength={3}
                maxLength={40}
                autoComplete="username"
              />
            </Field>

            <Field label="Password">
              <input
                type="password"
                className={inputCls}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
                required
                minLength={8}
                autoComplete={
                  tab === "signin" ? "current-password" : "new-password"
                }
              />
            </Field>

            <ErrorNote>{error}</ErrorNote>

            <button
              type="submit"
              disabled={busy}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 py-3 text-sm font-semibold text-white transition hover:bg-brand-2 disabled:opacity-60"
            >
              {busy ? (
                <Loader2 size={16} className="animate-spin" />
              ) : tab === "signin" ? (
                <KeyRound size={16} />
              ) : tab === "join" ? (
                <UserPlus size={16} />
              ) : (
                <Building2 size={16} />
              )}
              {tab === "signin"
                ? "Sign in to Workspace"
                : tab === "join"
                  ? "Join Workspace"
                  : "Create Organization"}
            </button>
          </form>

          <p className="mt-4 text-center text-[11px] leading-relaxed text-slate-500">
            Multi-tenant by design — every organization&apos;s documents, chats and
            retrieval results are isolated on the backend.
          </p>
        </div>
      </div>
    </main>
  );
}
