"use client";

/**
 * Shared UI kit — design-system primitives used across every page.
 * Light-workspace styling (white panels, slate text, indigo accents) with a
 * few dashboard building blocks: StatCard, PageHeader, EmptyState,
 * QuickAction and a dependency-free horizontal bar chart.
 */
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Loader2, type LucideIcon } from "lucide-react";
import { useState, type ButtonHTMLAttributes, type ReactNode } from "react";

export function Panel({
  title,
  subtitle,
  icon: Icon,
  action,
  children,
  className = "",
  bodyClassName = "",
}: {
  title?: string;
  subtitle?: string;
  icon?: LucideIcon;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={`panel overflow-hidden shadow-[0_1px_2px_rgba(15,23,42,.04)] ${className}`}>
      {(title || action) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4">
          <div className="flex items-center gap-3">
            {Icon && (
              <span className="grid h-9 w-9 place-items-center rounded-xl bg-brand/10 text-brand-2">
                <Icon size={18} />
              </span>
            )}
            <div>
              <h2 className="text-[15px] font-semibold text-slate-900">{title}</h2>
              {subtitle && <p className="mt-0.5 text-xs text-muted">{subtitle}</p>}
            </div>
          </div>
          {action}
        </header>
      )}
      <div className={`p-5 ${bodyClassName}`}>{children}</div>
    </section>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "danger" | "ghost";
  loading?: boolean;
};

export function Btn({
  variant = "primary",
  loading = false,
  className = "",
  children,
  disabled,
  ...rest
}: BtnProps) {
  const styles: Record<string, string> = {
    primary:
      "bg-brand hover:bg-brand-2 text-white shadow-[0_8px_20px_-12px_rgba(79,70,229,.9)]",
    secondary: "bg-white hover:bg-panel-2 text-slate-700 border border-line-2",
    danger: "bg-red-50 hover:bg-red-100 text-red-600 border border-red-200",
    ghost: "bg-transparent hover:bg-panel-2 text-slate-600",
  };
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${styles[variant]} ${className}`}
    >
      {loading && <Loader2 size={15} className="animate-spin" />}
      {children}
    </button>
  );
}

const TONES: Record<string, string> = {
  indigo: "bg-indigo-50 text-indigo-700 border-indigo-200",
  amber: "bg-amber-50 text-amber-700 border-amber-200",
  emerald: "bg-emerald-50 text-emerald-700 border-emerald-200",
  red: "bg-red-50 text-red-600 border-red-200",
  slate: "bg-slate-100 text-slate-600 border-slate-200",
  violet: "bg-violet-50 text-violet-700 border-violet-200",
};

export function Badge({
  tone = "slate",
  children,
  className = "",
}: {
  tone?: keyof typeof TONES | string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${TONES[tone] ?? TONES.slate} ${className}`}
    >
      {children}
    </span>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1.5 block text-xs font-medium text-slate-600">{label}</span>
      {children}
      {hint && <span className="mt-1 block text-[11px] text-slate-500">{hint}</span>}
    </label>
  );
}

export const inputCls =
  "w-full rounded-lg border border-line-2 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 outline-none transition focus:border-brand-2 focus:ring-2 focus:ring-brand/20";

/** Teal focus treatment for the PUBLIC auth routes (/login, /signup, /join).
 *  Visual only — identical layout metrics to inputCls so auth and workspace
 *  forms stay pixel-consistent; the dashboard keeps inputCls untouched. */
export const authInputCls =
  "w-full rounded-lg border border-line-2 bg-white px-3.5 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 outline-none transition focus:border-teal-700 focus:ring-2 focus:ring-teal-700/20";

export function ErrorNote({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return (
    <p
      role="alert"
      className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600"
    >
      {children}
    </p>
  );
}

/** Password input with an accessible show/hide toggle (auth pages).
 *  The toggle is type="button" (never submits) and carries its own
 *  aria-label / aria-pressed state; the value stays controlled by the caller
 *  exactly like a plain input. */
export function PasswordField({
  label = "Password",
  hint,
  value,
  onChange,
  placeholder,
  autoComplete,
  required = true,
  minLength,
}: {
  label?: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
  required?: boolean;
  minLength?: number;
}) {
  const [show, setShow] = useState(false);
  return (
    <Field label={label} hint={hint}>
      <span className="relative block">
        <input
          type={show ? "text" : "password"}
          className={`${authInputCls} pr-11`}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          required={required}
          minLength={minLength}
          autoComplete={autoComplete}
        />
        <button
          type="button"
          onClick={() => setShow((s) => !s)}
          aria-label={show ? "Hide password" : "Show password"}
          aria-pressed={show}
          className="absolute inset-y-0 right-0 grid w-11 place-items-center rounded-r-lg text-slate-400 transition hover:text-slate-600 focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-teal-700"
        >
          {show ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </span>
    </Field>
  );
}

/** Page heading with optional actions — used on every workspace page. */
export function PageHeader({
  title,
  subtitle,
  icon: Icon,
  actions,
}: {
  title: string;
  subtitle?: string;
  icon?: LucideIcon;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="flex items-center gap-3">
        {Icon && (
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-brand to-accent text-white shadow-[0_10px_24px_-14px_rgba(79,70,229,.9)]">
            <Icon size={20} />
          </span>
        )}
        <div>
          <h1 className="text-xl font-bold tracking-tight text-slate-900">{title}</h1>
          {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
        </div>
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Headline statistic card (real backend values only — never placeholders). */
export function StatCard({
  icon: Icon,
  label,
  value,
  hint,
  tone = "indigo",
}: {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  hint?: string;
  tone?: "indigo" | "violet" | "emerald" | "amber" | "slate";
}) {
  const tones = {
    indigo: "bg-indigo-50 text-indigo-600",
    violet: "bg-violet-50 text-violet-600",
    emerald: "bg-emerald-50 text-emerald-600",
    amber: "bg-amber-50 text-amber-600",
    slate: "bg-slate-100 text-slate-600",
  } as const;
  return (
    <div className="panel flex items-center gap-4 p-4 shadow-[0_1px_2px_rgba(15,23,42,.04)]">
      <span className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl ${tones[tone]}`}>
        <Icon size={19} />
      </span>
      <div className="min-w-0">
        <p className="truncate text-xl font-bold tabular-nums text-slate-900">{value}</p>
        <p className="truncate text-[11px] font-medium text-muted">{label}</p>
        {hint && <p className="truncate text-[10px] text-slate-400">{hint}</p>}
      </div>
    </div>
  );
}

/** Consistent empty state for lists and dashboards. */
export function EmptyState({
  icon: Icon,
  title,
  hint,
  action,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center px-6 py-10 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-panel-2 text-slate-400 ring-1 ring-line">
        <Icon size={22} />
      </span>
      <p className="mt-3 text-sm font-semibold text-slate-700">{title}</p>
      {hint && <p className="mt-1 max-w-sm text-xs leading-relaxed text-slate-500">{hint}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

/** Large clickable shortcut used on the dashboards. */
export function QuickAction({
  icon: Icon,
  label,
  hint,
  href,
  onClick,
  tone = "indigo",
}: {
  icon: LucideIcon;
  label: string;
  hint?: string;
  href?: string;
  onClick?: () => void;
  tone?: "indigo" | "violet" | "emerald" | "amber";
}) {
  const router = useRouter();
  const tones = {
    indigo: "bg-indigo-50 text-indigo-600 group-hover:bg-indigo-100",
    violet: "bg-violet-50 text-violet-600 group-hover:bg-violet-100",
    emerald: "bg-emerald-50 text-emerald-600 group-hover:bg-emerald-100",
    amber: "bg-amber-50 text-amber-600 group-hover:bg-amber-100",
  } as const;
  const go = () => (href ? router.push(href) : onClick?.());
  return (
    <button
      type="button"
      onClick={go}
      className="group flex w-full items-center gap-3 rounded-xl border border-line bg-white p-4 text-left shadow-[0_1px_2px_rgba(15,23,42,.04)] transition hover:border-line-2 hover:shadow-[0_6px_18px_-10px_rgba(15,23,42,.25)]"
    >
      <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl transition ${tones[tone]}`}>
        <Icon size={18} />
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-slate-800">{label}</span>
        {hint && <span className="block truncate text-xs text-slate-500">{hint}</span>}
      </span>
    </button>
  );
}

/** Dependency-free horizontal bar chart fed with real backend numbers. */
export function Bars({ data }: { data: { label: string; value: number }[] }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <div className="space-y-3">
      {data.map((d) => (
        <div key={d.label} className="flex items-center gap-3">
          <span className="w-36 shrink-0 truncate text-xs text-slate-600" title={d.label}>
            {d.label}
          </span>
          <span className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-panel-2">
            <span
              className="block h-full rounded-full bg-gradient-to-r from-brand to-accent"
              style={{ width: `${Math.max(4, Math.round((d.value / max) * 100))}%` }}
            />
          </span>
          <span className="w-8 shrink-0 text-right text-xs font-semibold tabular-nums text-slate-700">
            {d.value}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Human-readable byte size for the storage stat. */
export function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const v = bytes / 1024 ** i;
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export function formatDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso.replace(" ", "T") + (iso.includes("Z") || iso.includes("+") ? "" : "Z"));
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
