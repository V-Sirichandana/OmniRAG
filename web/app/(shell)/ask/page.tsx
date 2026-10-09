"use client";

/**
 * Ask Documents — chat over the organization's indexed documents.
 * Streams nothing (single request), shows answers with numbered source
 * citations, and states plainly when the answer was not found.
 */
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  BookOpenCheck,
  CornerDownLeft,
  FileText,
  Sparkles,
} from "lucide-react";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import type { ChatResponse, Message, Providers } from "@/lib/types";
import { Badge, ErrorNote } from "@/components/ui";

const LANGUAGES = ["English", "Español", "Français", "हिन्दी"];

const SUGGESTIONS = [
  "What is the parental leave policy?",
  "Summarize the deployment security standard.",
  "How many casual leave days do employees get?",
];

function AskPage() {
  const { user } = useAuth();
  const router = useRouter();
  const search = useSearchParams();
  const convId = search.get("c");

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [language, setLanguage] = useState("English");
  const [providers, setProviders] = useState<Providers | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // provider status banner (LLM key presence)
  useEffect(() => {
    api.get<Providers>("/api/providers").then(setProviders).catch(() => {});
  }, []);

  // load an existing conversation
  useEffect(() => {
    let alive = true;
    if (!convId) {
      setMessages([]);
      return;
    }
    api
      .get<Message[]>(`/api/conversations/${convId}`)
      .then((m) => alive && setMessages(m))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 404) router.replace("/ask");
      });
    return () => {
      alive = false;
    };
  }, [convId, router]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);

  const send = useCallback(
    async (text?: string) => {
      const q = (text ?? input).trim();
      if (!q || busy) return;
      setError("");
      setInput("");
      setMessages((m) => [...m, { role: "user", content: q }]);
      setBusy(true);
      try {
        const res = await api.post<ChatResponse>("/api/chat", {
          question: q,
          conversation_id: convId,
          language,
        });
        setMessages((m) => [
          ...m,
          {
            role: "assistant",
            content: res.answer,
            citations: res.citations,
            grounded: res.grounded,
            confidence: res.confidence,
            provider: res.provider,
            latency_ms: res.latency_ms,
          },
        ]);
        if (!convId && res.conversation_id) {
          router.replace(`/ask?c=${res.conversation_id}`);
        }
        window.dispatchEvent(new Event("omnirag:changed")); // refresh sidebar list
      } catch (e) {
        setError(e instanceof ApiError ? e.message : "Request failed — is the backend running?");
      } finally {
        setBusy(false);
      }
    },
    [busy, convId, input, language, router],
  );

  const noLlm = providers !== null && providers.llm.length === 0;

  return (
    <div className="flex h-[calc(100vh-3.25rem)] flex-col lg:h-screen">
      {/* header */}
      <div className="border-b border-line bg-ink-2/60 px-5 py-4 backdrop-blur sm:px-8">
        <div className="mx-auto flex max-w-4xl flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-white">Ask Documents</h1>
            <p className="mt-0.5 text-sm text-muted">
              Strictly from your organization&apos;s indexed documents — every answer cites
              its sources.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {providers && (
              <Badge tone={noLlm ? "amber" : "emerald"}>
                {noLlm ? "LLM key missing" : `LLM: ${providers.llm[0]}`}
              </Badge>
            )}
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="rounded-lg border border-line bg-ink-2 px-2.5 py-1.5 text-xs text-slate-300 outline-none focus:border-brand-2"
              title="Answer language"
            >
              {LANGUAGES.map((l) => (
                <option key={l} value={l}>
                  {l}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* messages */}
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-8">
        <div className="mx-auto max-w-4xl space-y-5">
          {noLlm && (
            <div className="flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs text-amber-200">
              <AlertTriangle size={15} className="mt-0.5 shrink-0" />
              <span>
                No LLM API key is configured on the server, so answers are disabled.
                Set <code className="font-mono">GROQ_API_KEY</code> (or another provider
                key) in the backend environment — see README.
              </span>
            </div>
          )}

          {messages.length === 0 && !busy && (
            <div className="mx-auto max-w-2xl pt-8 text-center">
              <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-brand/25 to-accent/25 ring-1 ring-brand/40">
                <Sparkles size={26} className="text-indigo-300" />
              </div>
              <h2 className="mt-4 text-lg font-semibold text-white">
                Knowledge ready, {user?.username}
              </h2>
              <p className="mt-1 text-sm text-muted">
                Ask a question about your indexed documents. Answers include strict,
                numbered citations — and say so plainly when the information is not
                there.
              </p>
              <div className="mt-6 space-y-2.5 text-left">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => void send(s)}
                    className="flex w-full items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3 text-sm text-slate-300 transition hover:border-brand-2 hover:text-white"
                  >
                    <BookOpenCheck size={16} className="shrink-0 text-brand-2" />
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) =>
            m.role === "user" ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] rounded-2xl rounded-br-md border border-brand/40 bg-brand/15 px-4 py-3 text-sm leading-relaxed text-indigo-100">
                  {m.content}
                </div>
              </div>
            ) : (
              <div key={i} className="flex justify-start">
                <div className="max-w-[92%] rounded-2xl rounded-bl-md border border-line bg-panel px-4 py-3.5">
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-slate-200">
                    {m.content}
                  </p>

                  {/* citations */}
                  {m.citations && m.citations.length > 0 && (
                    <div className="mt-3 border-t border-line pt-3">
                      <p className="mb-2 text-[10px] font-semibold tracking-[0.14em] text-slate-500">
                        SOURCES
                      </p>
                      <div className="space-y-2">
                        {m.citations.map((c, ci) => (
                          <details key={ci} className="group rounded-lg border border-line bg-ink-2/70 px-3 py-2">
                            <summary className="flex cursor-pointer list-none items-center gap-2 text-xs text-slate-300">
                              <span className="grid h-5 w-5 shrink-0 place-items-center rounded bg-brand/25 font-mono text-[10px] font-bold text-indigo-300">
                                {ci + 1}
                              </span>
                              <FileText size={12} className="shrink-0 text-slate-500" />
                              <span className="truncate font-medium">{c.filename}</span>
                              <span className="shrink-0 text-slate-500">p.{c.page}</span>
                            </summary>
                            {c.snippet && (
                              <p className="mt-2 border-l-2 border-brand/50 pl-3 text-xs leading-relaxed text-slate-400">
                                {c.snippet}
                              </p>
                            )}
                          </details>
                        ))}
                      </div>
                    </div>
                  )}

                  {(m.citations?.length ?? 0) === 0 && (
                    <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-1.5 text-[11px] text-amber-200">
                      No supporting sources found in your accessible documents.
                    </p>
                  )}

                  {/* meta */}
                  <div className="mt-3 flex flex-wrap items-center gap-2 text-[10px] text-slate-500">
                    {typeof m.confidence === "number" && (
                      <Badge tone={m.confidence >= 0.7 ? "emerald" : m.confidence >= 0.4 ? "amber" : "red"}>
                        {Math.round(m.confidence * 100)}% confidence
                      </Badge>
                    )}
                    {m.grounded === false && <Badge tone="amber">partially grounded</Badge>}
                    {m.provider && <span>via {m.provider}</span>}
                    {typeof m.latency_ms === "number" && <span>{(m.latency_ms / 1000).toFixed(1)}s</span>}
                  </div>
                </div>
              </div>
            ),
          )}

          {busy && (
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span className="h-2 w-2 animate-ping rounded-full bg-brand-2" />
              Retrieving, reranking and verifying…
            </div>
          )}

          <ErrorNote>{error}</ErrorNote>
          <div ref={bottomRef} />
        </div>
      </div>

      {/* composer */}
      <div className="border-t border-line bg-ink-2/60 px-4 py-4 backdrop-blur sm:px-8">
        <form
          className="mx-auto flex max-w-4xl items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Ask anything about your organization's documents…"
            className="max-h-40 min-h-[52px] flex-1 resize-none rounded-xl border border-line bg-ink px-4 py-3 text-sm text-white placeholder:text-slate-500 outline-none focus:border-brand-2 focus:ring-2 focus:ring-brand/25"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="flex h-[52px] items-center gap-2 rounded-xl bg-brand px-5 text-sm font-semibold text-white transition hover:bg-brand-2 disabled:opacity-40"
          >
            Send <CornerDownLeft size={14} />
          </button>
        </form>
        <p className="mx-auto mt-2 max-w-4xl text-[10px] text-slate-600">
          Answers are generated only from documents your account can access. Enter to
          send · Shift+Enter for a new line.
        </p>
      </div>
    </div>
  );
}

export default function AskRoute() {
  return (
    <Suspense fallback={null}>
      <AskPage />
    </Suspense>
  );
}
