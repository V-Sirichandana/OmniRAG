/**
 * Minimal typed API client.
 *
 * - Same-origin: in development `next dev` proxies /api/* to FastAPI
 *   (127.0.0.1:8000); on Vercel vercel.json routes /api/* to the Python
 *   service. Override with NEXT_PUBLIC_API_BASE if you host the API apart.
 * - The JWT is stored in localStorage and sent as a Bearer header.
 *   No secrets (LLM keys, passwords) ever live in this bundle.
 */
import type { Session } from "./types";

const BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";
const TOKEN_KEY = "omnirag_token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (typeof window === "undefined") return;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

/** JSON.stringify that never yields "{}"/"[]" — and cannot emit "[object Object]". */
function readableJson(value: unknown): string | null {
  try {
    const json = JSON.stringify(value);
    return json && json !== "{}" && json !== "[]" ? json : null;
  } catch {
    return null;
  }
}

/**
 * Flatten an error payload into a short, safe string.
 *
 * FastAPI raises `detail` as a plain STRING for hand-rolled HTTPException but
 * as an ARRAY of Pydantic objects for 422 validation errors (e.g. a 1-character
 * question). `String(detail)` coerces that array to the literal "[object
 * Object]", so every shape is unwrapped explicitly and a raw JS object is never
 * rendered.
 */
function toDetailString(detail: unknown): string | null {
  if (typeof detail === "string") return detail.trim() || null;
  if (typeof detail === "number" || typeof detail === "boolean") return String(detail);
  if (Array.isArray(detail)) {
    const parts = detail.map(toDetailString).filter((s): s is string => !!s);
    return parts.length ? parts.join(" · ") : null;
  }
  if (detail && typeof detail === "object") {
    const obj = detail as Record<string, unknown>;
    for (const key of ["msg", "message", "detail", "error"]) {
      const value = obj[key];
      const text = typeof value === "string" ? value.trim() : toDetailString(value);
      if (text) return text;
    }
    return readableJson(detail);
  }
  return null;
}

/** Human-facing text for a non-2xx response body (falls back to a status line). */
function payloadMessage(data: unknown, status: number): string {
  if (typeof data === "string") {
    const text = data.trim();
    // Non-JSON bodies (proxies, HTML error pages) are not user-facing text.
    if (text && text.length <= 200 && !text.startsWith("<")) return text;
  } else if (data && typeof data === "object" && "detail" in data) {
    const detail = toDetailString((data as { detail: unknown }).detail);
    if (detail) return detail;
  }
  return `Request failed (${status})`;
}

const NETWORK_FAILURE =
  /^(failed to fetch|load failed|networkerror.*|network request failed|fetch failed)$/i;

/**
 * Normalize anything thrown while calling the API — API errors, network
 * failures, strings, object-shaped payloads or unknown values — into a safe,
 * readable string. Always returns a non-empty string, so it is always safe to
 * render and never produces "[object Object]".
 */
export function errorToMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message; // already normalized above
  if (e instanceof Error && NETWORK_FAILURE.test(e.message))
    return "Could not reach the server — check your connection and try again.";
  if (typeof e === "string" && e.trim()) return e.trim();
  if (e && typeof e === "object") {
    const obj = e as Record<string, unknown>;
    for (const key of ["message", "msg", "detail", "error"]) {
      const value = obj[key];
      const text = typeof value === "string" ? value.trim() : toDetailString(value);
      if (text) return text;
    }
    return readableJson(e) ?? "Request failed — please try again.";
  }
  return "Request failed — is the backend running?";
}

async function request<T>(
  path: string,
  opts: { method?: string; body?: unknown; formData?: FormData; auth?: boolean } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  const token = getToken();
  if (opts.auth !== false && token) headers.Authorization = `Bearer ${token}`;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(`${BASE}${path}`, {
    method: opts.method ?? (opts.body !== undefined || opts.formData ? "POST" : "GET"),
    headers,
    body: opts.formData ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined),
  });

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) throw new ApiError(payloadMessage(data, res.status), res.status);
  return data as T;
}

export const api = {
  get: <T,>(path: string) => request<T>(path),
  post: <T,>(path: string, body?: unknown) => request<T>(path, { method: "POST", body }),
  patch: <T,>(path: string, body: unknown) => request<T>(path, { method: "PATCH", body }),
  del: <T,>(path: string) => request<T>(path, { method: "DELETE" }),
  upload: <T,>(path: string, formData: FormData) =>
    request<T>(path, { method: "POST", formData }),
};

export type { Session };
