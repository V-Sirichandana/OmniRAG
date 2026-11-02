"use client";

/**
 * Sign in to an existing organization — identifier + password, posted
 * unchanged to POST /api/auth/login as {username, password}: the backend
 * accepts the account's username OR its work email in that same field,
 * so existing accounts and clients keep working untouched. No password
 * reset exists in the backend, so there is intentionally NO
 * forgot-password link (guidance text instead).
 */
import { useState, type FormEvent, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { KeyRound, Loader2 } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Session } from "@/lib/types";
import { AuthShell } from "@/components/auth-shell";
import { ErrorNote, Field, PasswordField, authInputCls } from "@/components/ui";

const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);
  const [googleError, setGoogleError] = useState("");
  const googleBtnRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!GOOGLE_CLIENT_ID) return;
    const script = document.createElement("script");
    script.src = "https://accounts.google.com/gsi/client";
    script.async = true;
    script.defer = true;
    script.onload = () => {
      const g = (window as any).google;
      if (!g?.accounts?.id) return;
      g.accounts.id.initialize({
        client_id: GOOGLE_CLIENT_ID,
        callback: async (resp: { credential?: string }) => {
          if (!resp?.credential) {
            setGoogleError("Google sign-in did not return a credential.");
            return;
          }
          setGoogleBusy(true);
          setGoogleError("");
          try {
            const session = await api.post<Session>("/api/auth/google", {
              credential: resp.credential,
            }, { "X-Requested-With": "XMLHttpRequest" });
            login(session);
            router.replace("/dashboard");
          } catch (err) {
            setGoogleError(
              err instanceof ApiError
                ? err.message
                : "Google sign-in failed. Is the API running?",
            );
          } finally {
            setGoogleBusy(false);
          }
        },
      });
      if (googleBtnRef.current) {
        g.accounts.id.renderButton(googleBtnRef.current, {
          type: "standard",
          theme: "outline",
          size: "large",
          text: "continue_with",
          width: 320,
        });
      }
    };
    document.head.appendChild(script);
    return () => {
      try { document.head.removeChild(script); } catch {}
    };
  }, [login, router]);

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

        {GOOGLE_CLIENT_ID && (
          <div className="space-y-2">
            <div className="relative my-2">
              <div className="absolute inset-0 flex items-center">
                <span className="w-full border-t border-line" />
              </div>
              <div className="relative flex justify-center text-[11px] uppercase tracking-wide text-slate-400">
                <span className="bg-white px-2">or</span>
              </div>
            </div>
            <div ref={googleBtnRef} className="flex justify-center" />
            {googleBusy && (
              <p className="text-center text-xs text-slate-500">Signing in with Google…</p>
            )}
            <ErrorNote>{googleError}</ErrorNote>
          </div>
        )}
      </form>
    </AuthShell>
  );
}
