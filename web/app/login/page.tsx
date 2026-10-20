"use client";

/**
 * Sign in to an existing organization — identifier + password, posted
 * unchanged to POST /api/auth/login as {username, password}: the backend
 * accepts the account's username OR its work email in that same field,
 * so existing accounts and clients keep working untouched. No password
 * reset exists in the backend, so there is intentionally NO
 * forgot-password link (guidance text instead).
 */
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { KeyRound, Loader2 } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Session } from "@/lib/types";
import { AuthShell } from "@/components/auth-shell";
import { ErrorNote, Field, PasswordField, authInputCls } from "@/components/ui";

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const session = await api.post<Session>("/api/auth/login", {
        username,
        password,
      });
      login(session);
      router.replace("/dashboard");
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Something went wrong. Is the API running?",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell
      title="Sign in"
      subtitle="Use your work email or organization username to continue to your workspace."
      footer={
        <>
          New to OmniRAG?{" "}
          <Link
            href="/signup"
            className="font-semibold text-teal-700 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
          >
            Create an organization
          </Link>{" "}
          or{" "}
          <Link
            href="/join"
            className="font-semibold text-teal-700 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
          >
            join with an invitation
          </Link>
          .
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <Field label="Work email or username">
          <input
            className={authInputCls}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="you@company.com"
            required
            minLength={3}
            maxLength={254}
            autoComplete="username"
          />
        </Field>

        <PasswordField
          value={password}
          onChange={setPassword}
          placeholder="Your password"
          autoComplete="current-password"
        />

        <p className="text-[11px] leading-relaxed text-slate-500">
          Password trouble? Contact your organization administrator.
        </p>

        <ErrorNote>{error}</ErrorNote>

        <button
          type="submit"
          disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-teal-700 px-4 py-3 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
        >
          {busy ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <KeyRound size={16} />
          )}
          {busy ? "Signing in…" : "Sign In"}
        </button>
      </form>
    </AuthShell>
  );
}
