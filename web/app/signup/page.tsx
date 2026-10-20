"use client";

/**
 * Create a new organization — company name + first administrator account,
 * posted unchanged to POST /api/auth/signup-org (payload identical to the
 * previous implementation: {org_name, username, password}). The endpoint
 * creates the tenant, its first admin and the standard departments, then
 * returns a session. Confirmation is client-side only and never sent.
 */
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Building2, Loader2 } from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { Session } from "@/lib/types";
import { AuthShell } from "@/components/auth-shell";
import { ErrorNote, Field, PasswordField, authInputCls } from "@/components/ui";

export default function SignupPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [orgName, setOrgName] = useState("");
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
      const session = await api.post<Session>("/api/auth/signup-org", {
        org_name: orgName.trim(),
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
      title="Create organization"
      subtitle="Set up a new OmniRAG workspace and its first administrator account."
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
        <Field label="Company name">
          <input
            className={authInputCls}
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            placeholder="e.g. Acme Corporation"
            required
            minLength={2}
            maxLength={80}
            autoComplete="organization"
          />
        </Field>

        <Field label="Admin username" hint="This account will administer the new organization.">
          <input
            className={authInputCls}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Choose an admin username"
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
            <Building2 size={16} />
          )}
          {busy ? "Creating organization…" : "Create Organization"}
        </button>
      </form>
    </AuthShell>
  );
}
