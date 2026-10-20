"use client";

/**
 * Shared frame for the public auth routes (/login, /signup, /join):
 * a navy + teal brand panel beside a white form surface, stacked on
 * mobile. The form always renders (identical server HTML, hydration and
 * first paint); an already-authenticated visitor is redirected to
 * /dashboard by an effect once the session bootstrap completes.
 *
 * Visual only — no fetching, no token handling (lib/auth.tsx owns that),
 * and no organization selector of any kind: onboarding joins are strictly
 * invitation-driven by the backend.
 */
import { useEffect, type ReactNode } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { useAuth } from "@/lib/auth";

export function AuthShell({
  title,
  subtitle,
  footer,
  children,
}: {
  title: string;
  subtitle: string;
  footer?: ReactNode;
  children: ReactNode;
}) {
  const { user, loading } = useAuth();
  const router = useRouter();

  // Already signed in → straight to the workspace (pure effect: the form
  // still renders during the brief session bootstrap, so server HTML,
  // hydration and first paint are identical — no gated/spinner flash).
  useEffect(() => {
    if (!loading && user) router.replace("/dashboard");
  }, [loading, user, router]);

  return (
    <main className="flex min-h-screen flex-col lg:flex-row">
      {/* brand panel — navy with teal glow (auth routes only) */}
      <aside className="auth-glow relative flex flex-col justify-between gap-8 px-6 py-8 text-white lg:w-[44%] lg:min-w-[380px] lg:max-w-[560px] lg:px-12 lg:py-12">
        <Link href="/" className="inline-flex items-center gap-3 self-start rounded-lg">
          <span className="grid h-10 w-10 place-items-center rounded-xl bg-teal-400/15 ring-1 ring-teal-400/40">
            <ShieldCheck size={20} className="text-teal-300" strokeWidth={2.2} />
          </span>
          <span className="text-lg font-semibold tracking-tight">OmniRAG</span>
        </Link>

        {/* AI retrieval illustration: document cards → retrieval/network
            core → cited answer. Hand-authored inline SVG (no external
            assets, no packages), navy + teal to match .auth-glow. */}
        <div className="hidden lg:block">
          <svg
            viewBox="0 0 480 340"
            role="img"
            aria-label="AI knowledge retrieval: enterprise documents flow into a retrieval network that returns an answer with citations"
            className="w-full max-w-[430px] select-none"
            fill="none"
          >
            <defs>
              <radialGradient id="authCoreGlow" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stopColor="#2dd4bf" stopOpacity="0.55" />
                <stop offset="60%" stopColor="#14b8a6" stopOpacity="0.22" />
                <stop offset="100%" stopColor="#14b8a6" stopOpacity="0" />
              </radialGradient>
              <linearGradient id="authFlow" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#2dd4bf" stopOpacity="0.15" />
                <stop offset="100%" stopColor="#2dd4bf" stopOpacity="0.85" />
              </linearGradient>
              <pattern id="authDots" width="18" height="18" patternUnits="userSpaceOnUse">
                <circle cx="1.5" cy="1.5" r="1.5" fill="#ffffff" fillOpacity="0.07" />
              </pattern>
            </defs>

            {/* dot-grid backdrop */}
            <rect x="0" y="0" width="480" height="340" rx="18" fill="url(#authDots)" />

            {/* document cards (staggered) */}
            <g>
              <rect x="76" y="150" width="100" height="128" rx="10" fill="#ffffff" fillOpacity="0.06" stroke="#ffffff" strokeOpacity="0.28" />
              <rect x="90" y="166" width="40" height="6" rx="3" fill="#5eead4" fillOpacity="0.75" />
              <rect x="90" y="186" width="66" height="5" rx="2.5" fill="#cbd5e1" fillOpacity="0.5" />
              <rect x="90" y="200" width="54" height="5" rx="2.5" fill="#cbd5e1" fillOpacity="0.45" />
              <rect x="90" y="214" width="66" height="5" rx="2.5" fill="#cbd5e1" fillOpacity="0.5" />
              <rect x="90" y="228" width="42" height="5" rx="2.5" fill="#cbd5e1" fillOpacity="0.4" />
            </g>
            <g>
              <rect x="28" y="40" width="100" height="132" rx="10" fill="#0f1c33" stroke="#ffffff" strokeOpacity="0.32" />
              <rect x="42" y="56" width="44" height="6" rx="3" fill="#5eead4" fillOpacity="0.85" />
              <rect x="42" y="76" width="70" height="5" rx="2.5" fill="#cbd5e1" fillOpacity="0.55" />
              <rect x="42" y="90" width="58" height="5" rx="2.5" fill="#cbd5e1" fillOpacity="0.5" />
              <rect x="42" y="104" width="70" height="5" rx="2.5" fill="#5eead4" fillOpacity="0.7" />
              <rect x="42" y="118" width="46" height="5" rx="2.5" fill="#cbd5e1" fillOpacity="0.45" />
            </g>

            {/* connectors: documents → core */}
            <path d="M 130 104 C 165 108, 178 122, 196 138" stroke="url(#authFlow)" strokeWidth="1.8" strokeLinecap="round" />
            <circle cx="130" cy="104" r="3" fill="#5eead4" />
            <path d="M 178 210 C 198 206, 202 194, 206 180" stroke="url(#authFlow)" strokeWidth="1.8" strokeLinecap="round" />
            <circle cx="178" cy="210" r="3" fill="#5eead4" />
            <rect x="157" y="113" width="7" height="7" rx="1.5" transform="rotate(45 160.5 116.5)" fill="#5eead4" fillOpacity="0.75" />

            {/* retrieval / network core */}
            <g>
              <circle cx="248" cy="150" r="76" fill="url(#authCoreGlow)" />
              <circle cx="248" cy="150" r="58" stroke="#5eead4" strokeOpacity="0.35" strokeWidth="1.2" strokeDasharray="3 8" />
              <circle cx="248" cy="150" r="40" stroke="#2dd4bf" strokeOpacity="0.55" strokeWidth="1.5" />
              <g stroke="#99f6e4" strokeOpacity="0.5" strokeWidth="1">
                <line x1="248" y1="150" x2="248" y2="122" />
                <line x1="248" y1="150" x2="224" y2="140" />
                <line x1="248" y1="150" x2="272" y2="142" />
                <line x1="248" y1="150" x2="234" y2="170" />
                <line x1="248" y1="150" x2="264" y2="166" />
                <line x1="224" y1="140" x2="248" y2="122" />
                <line x1="272" y1="142" x2="264" y2="166" />
              </g>
              <circle cx="248" cy="150" r="13" fill="#2dd4bf" fillOpacity="0.25" />
              <circle cx="248" cy="150" r="8" fill="#14b8a6" stroke="#5eead4" strokeWidth="1.5" />
              <circle cx="248" cy="122" r="4.5" fill="#5eead4" />
              <circle cx="224" cy="140" r="4.5" fill="#e2e8f0" fillOpacity="0.85" />
              <circle cx="272" cy="142" r="4.5" fill="#e2e8f0" fillOpacity="0.85" />
              <circle cx="234" cy="170" r="4.5" fill="#e2e8f0" fillOpacity="0.85" />
              <circle cx="264" cy="166" r="4.5" fill="#5eead4" />
            </g>
            {/* AI sparkle */}
            <path d="M306 89 l2.6 6.4 6.4 2.6 -6.4 2.6 -2.6 6.4 -2.6 -6.4 -6.4 -2.6 6.4 -2.6 z" fill="#5eead4" fillOpacity="0.85" />

            {/* core → answer */}
            <path d="M 310 150 L 338 150" stroke="#2dd4bf" strokeOpacity="0.75" strokeWidth="1.8" strokeLinecap="round" />
            <path d="M 333 144.5 l 6 5.5 -6 5.5" stroke="#5eead4" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" fill="none" />

            {/* cited answer card */}
            <g>
              <rect x="346" y="64" width="110" height="176" rx="12" fill="#ffffff" fillOpacity="0.08" stroke="#ffffff" strokeOpacity="0.3" />
              <circle cx="369" cy="84" r="9" fill="#14b8a6" fillOpacity="0.9" />
              <circle cx="369" cy="84" r="3.2" fill="#ffffff" fillOpacity="0.9" />
              <rect x="384" y="79" width="54" height="6" rx="3" fill="#ffffff" fillOpacity="0.45" />
              <rect x="360" y="106" width="82" height="5" rx="2.5" fill="#cbd5e1" fillOpacity="0.5" />
              <rect x="360" y="118" width="70" height="5" rx="2.5" fill="#cbd5e1" fillOpacity="0.5" />
              <rect x="360" y="130" width="82" height="5" rx="2.5" fill="#cbd5e1" fillOpacity="0.45" />
              <rect x="360" y="142" width="50" height="5" rx="2.5" fill="#5eead4" fillOpacity="0.8" />
              <rect x="414" y="142" width="28" height="5" rx="2.5" fill="#cbd5e1" fillOpacity="0.45" />
              <rect x="360" y="164" width="40" height="18" rx="9" fill="#14b8a6" fillOpacity="0.18" stroke="#2dd4bf" strokeOpacity="0.6" />
              <text x="380" y="176.5" textAnchor="middle" fontSize="10" fill="#99f6e4">[1]</text>
              <rect x="406" y="164" width="40" height="18" rx="9" fill="#14b8a6" fillOpacity="0.18" stroke="#2dd4bf" strokeOpacity="0.6" />
              <text x="426" y="176.5" textAnchor="middle" fontSize="10" fill="#99f6e4">[2]</text>
              <rect x="360" y="200" width="64" height="5" rx="2.5" fill="#cbd5e1" fillOpacity="0.35" />
            </g>
          </svg>
        </div>

        <p className="text-xs leading-relaxed text-slate-400">
          Multi-tenant by design — every organization&apos;s documents, chats and
          retrieval results are isolated on the backend.
        </p>
      </aside>

      {/* form surface — white, centered, responsive */}
      <section className="flex flex-1 items-center justify-center bg-white px-4 py-10 sm:px-8">
        <div className="w-full max-w-md rounded-2xl border border-line bg-white p-6 shadow-[0_20px_60px_-40px_rgba(15,23,42,.5)] sm:p-8">
          <div className="mb-6 flex items-center gap-2.5 lg:hidden">
            <span className="grid h-9 w-9 place-items-center rounded-lg bg-navy text-teal-300">
              <ShieldCheck size={18} strokeWidth={2.2} />
            </span>
            <span className="text-base font-semibold tracking-tight text-slate-900">
              OmniRAG
            </span>
          </div>

          <h1 className="text-xl font-bold tracking-tight text-slate-900">{title}</h1>
          <p className="mt-1.5 text-sm leading-relaxed text-muted">{subtitle}</p>

          <div className="mt-6">{children}</div>

          {footer && (
            <div className="mt-6 border-t border-line pt-4 text-center text-[13px] leading-relaxed text-slate-500">
              {footer}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
