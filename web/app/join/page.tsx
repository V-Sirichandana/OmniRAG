"use client";

/**
 * Accept an organization invitation — invitation code + new account,
 * posted unchanged to POST /api/auth/register (payload identical to the
 * previous implementation: {username, password, invite_code}).
 *
 * There is deliberately NO organization picker: the backend derives the
 * organization, role and department from the invitation itself, so a user
 * can never choose or impersonate a different organization here. The code
 * is single-use with an expiry, both enforced server-side.
 */
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Loader2, UserPlus } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Session } from "@/lib/types";
import { AuthShell } from "@/components/auth-shell";
import { ErrorNote, Field, PasswordField, authInputCls } from "@/components/ui";

export default function JoinPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [invite, setInvite] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setBusy(true);
    try {
      const session = await api.post<Session>("/api/auth/register", {
        username,
        password,
        invite_code: invite.trim(),
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
      title="Join your organization"
      subtitle="Your invitation determines which organization you join, and the role and department you receive — you cannot pick or switch organizations here."
      footer={
        <>
          Already have an account?{" "}
          <Link
            href="/login"
            className="font-semibold text-teal-700 underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
          >
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} className="space-y-4">
        <Field
          label="Invitation code"
          hint="Ask your administrator to issue one from Administration."
        >
          <input
            className={`${authInputCls} font-mono uppercase tracking-wider`}
            value={invite}
            onChange={(e) => setInvite(e.target.value)}
            placeholder="ENG-482910"
            required
            autoComplete="off"
          />
        </Field>

        <Field label="Username">
          <input
            className={authInputCls}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="your.username"
            required
            minLength={3}
            maxLength={40}
            autoComplete="username"
          />
        </Field>

        <PasswordField
          value={password}
          onChange={setPassword}
          placeholder="At least 8 characters"
          autoComplete="new-password"
          minLength={8}
        />

        <PasswordField
          label="Confirm password"
          hint="Checked in your browser before submitting."
          value={confirm}
          onChange={setConfirm}
          placeholder="Repeat the password"
          autoComplete="new-password"
          minLength={8}
        />

        <ErrorNote>{error}</ErrorNote>

        <button
          type="submit"
          disabled={busy}
          className="flex w-full items-center justify-center gap-2 rounded-lg bg-teal-700 px-4 py-3 text-sm font-semibold text-white transition hover:bg-teal-800 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-700"
        >
          {busy ? (
            <Loader2 size={16} className="animate-spin" />
          ) : (
            <UserPlus size={16} />
          )}
          {busy ? "Joining…" : "Join Organization"}
        </button>
      </form>
    </AuthShell>
  );
}
