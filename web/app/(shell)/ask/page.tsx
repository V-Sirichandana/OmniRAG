"use client";

/**
 * Ask OmniRAG — chat over the documents you are authorized to access.
 *
 * Streams nothing (single request); answers are plain text and the UI states
 * plainly when nothing was found — an abstention is always shown, never
 * hidden, but only as a short user-friendly notice (the pipeline's internal
 * wording stays server-side). Obvious casual messages ("hi", "thanks") get a
 * fixed reply from the backend without retrieval. Supports deep-links:
 * /ask?c=<id> loads a conversation, /ask?q=<text> pre-fills and sends a question.
 */
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  BookOpenCheck,
  CornerDownLeft,
  Loader2,
  Sparkles,
} from "lucide-react";
import { api, ApiError, errorToMessage } from "@/lib/api";
import { presentAssistantText } from "@/lib/answer-text";
import { useAuth } from "@/lib/auth";
import type { ChatResponse, Message, Providers } from "@/lib/types";
import { ErrorNote } from "@/components/ui";

const LANGUAGES = ["English", "Español", "Français", "हिन्दी"];

/** Composer grows up to this height (matches `max-h-40`) before scrolling. */
const COMPOSER_MAX_PX = 160;

/** API contract for one chat question (mirrors the backend's validation). */
const MIN_Q = 2;
const MAX_Q = 2000;
const TOO_SHORT_MSG = "Please type at least 2 characters.";
const TOO_LONG_MSG = `That message is too long — please keep it under ${MAX_Q} characters.`;

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
  const qParam = search.get("q");

  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [language, setLanguage] = useState("English");
  const [providers, setProviders] = useState<Providers | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  // conversation id created by the current session's first send — its local
  // transcript is authoritative and must not be clobbered by a refetch race
  const createdRef = useRef<string | null>(null);
  // mirrors `busy` for use in non-render callbacks (the conversation loader)
  const busyRef = useRef(false);
  const submittingRef = useRef(false); // synchronous in-flight guard against double-submit
  const autoSentRef = useRef(false); // send ?q= exactly once (even under StrictMode)

  // provider status banner (LLM key presence)
  useEffect(() => {
    api.get<Providers>("/api/providers").then(setProviders).catch(() => {});
  }, []);

  // load an existing conversation
  useEffect(() => {
    let alive = true;
    setError(""); // a previous failure must not linger on a healthy (re)load
    if (!convId) {
      setMessages([]);
      return;
    }
    if (convId === createdRef.current) return; // just created locally — skip refetch
    api
      .get<Message[]>(`/api/conversations/${convId}`)
      // a send already in flight owns the transcript — don't wipe it
      .then((m) => alive && !busyRef.current && setMessages(m))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 404) router.replace("/ask");
        else if (alive) setError("Could not load this conversation.");
      });
    return () => {
      alive = false;
    };
  }, [convId, router]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);

  // Composer stays one compact line and grows with the message up to
  // COMPOSER_MAX_PX, then scrolls internally. Runs on every input change —
  // typing and the programmatic clear after a successful send.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    const border =
      parseFloat(getComputedStyle(el).borderTopWidth) +
      parseFloat(getComputedStyle(el).borderBottomWidth);
    el.style.height = "auto"; // collapse to content, then measure
    el.style.height = `${Math.min(el.scrollHeight + border, COMPOSER_MAX_PX)}px`;
  }, [input]);

  const send = useCallback(
    async (text?: string) => {
      // Synchronous in-flight guard: prevents duplicate submissions from
      // rapid double-clicks/Enter presses before React re-renders `busy`.
      if (submittingRef.current) return;
      const q = (text ?? input).trim();
      if (!q || busy) return;
      // Enforce the API contract (question: 2..2000 chars) BEFORE any state is
      // touched, so an over/under-length message never erases the composer.
      if (q.length < MIN_Q || q.length > MAX_Q) {
        setError(q.length < MIN_Q ? TOO_SHORT_MSG : TOO_LONG_MSG);
        return;
      }
      submittingRef.current = true;
      setError("");
      setInput("");
      setMessages((m) => [...m, { role: "user", content: q }]);
      setBusy(true);
      busyRef.current = true;
      try {
        const res = await api.post<ChatResponse>("/api/chat", {
          question: q,
          conversation_id: convId,
          language,
        });
        setMessages((m) => [...m, { role: "assistant", content: res.answer }]);
        if (!convId && res.conversation_id) {
          createdRef.current = res.conversation_id;
          router.replace(`/ask?c=${res.conversation_id}`); // also strips ?q=
        }
        window.dispatchEvent(new Event("omnirag:changed")); // refresh sidebar list
      } catch (e) {
        setError(errorToMessage(e)); // normalized string — never "[object Object]"
        setMessages((m) => m.slice(0, -1)); // roll back the optimistic user bubble
        // A failed send must not destroy the question: give it back if the
        // composer is still empty (never clobber text typed meanwhile).
        setInput((cur) => (cur.trim() ? cur : q));
      } finally {
        setBusy(false);
        busyRef.current = false;
        submittingRef.current = false;
      }
    },
    [busy, convId, input, language, router],
  );

  // deep-link: /ask?q=… pre-fills the composer and sends once
  useEffect(() => {
    if (!qParam || convId || autoSentRef.current) return;
    autoSentRef.current = true;
    setInput(qParam);
    void send(qParam);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qParam, convId]);

  const noLlm = providers !== null && providers.llm.length === 0;

  return (
    // `h-full` fills the shell's <main> exactly. Hardcoded viewport math
    // mis-measures the topbar, overflows <main> and yields blank space plus
    // whole-page scroll. Here only the message list scrolls; the composer
    // stays pinned to the bottom.
    <div className="flex h-full flex-col overflow-hidden">
      {/* header */}
      <div className="border-b border-line bg-white px-5 py-4 sm:px-8">
        <div className="mx-auto flex max-w-4xl flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-slate-900">Ask OmniRAG</h1>
            <p className="mt-0.5 text-sm text-muted">
              Plain answers drawn only from the documents you can access.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="rounded-lg border border-line-2 bg-white px-2.5 py-1.5 text-xs text-slate-700 outline-none focus:border-brand-2"
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
            <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-700">
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
              <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-brand/15 to-accent/15 ring-1 ring-brand/25">
                <Sparkles size={26} className="text-brand-2" />
              </div>
              <h2 className="mt-4 text-lg font-semibold text-slate-900">
                Knowledge ready, {user?.username}
              </h2>
              <p className="mt-1 text-sm text-muted">
                Ask a question about the documents you are authorized to read. You get a
                plain answer — and a clear note when the information is not there.
              </p>
              <div className="mt-6 space-y-2.5 text-left">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => void send(s)}
                    className="flex w-full items-center gap-3 rounded-xl border border-line bg-white px-4 py-3 text-sm text-slate-700 transition hover:border-brand-2 hover:bg-panel-2"
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
                <div className="max-w-[85%] rounded-2xl rounded-br-md bg-brand px-4 py-3 text-sm leading-relaxed text-white shadow-[0_8px_20px_-14px_rgba(79,70,229,.9)]">
                  {m.content}
                </div>
              </div>
            ) : (
              <div key={i} className="flex justify-start">
                <div className="max-w-[92%]">
                  <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-muted">
                    <span className="grid h-5 w-5 place-items-center rounded-md bg-gradient-to-br from-brand to-accent">
                      <Sparkles size={11} className="text-white" />
                    </span>
                    OmniRAG
                  </div>
                  <div className="rounded-2xl rounded-bl-md border border-line bg-white px-4 py-3.5 shadow-[0_1px_2px_rgba(15,23,42,.05)]">
                    <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-800">
                      {presentAssistantText(m.content)}
                    </p>
                  </div>
                </div>
              </div>
            ),
          )}

          {busy && (
            <div className="flex items-center gap-2 text-xs text-slate-500">
              <span className="h-2 w-2 animate-ping rounded-full bg-brand-2" />
              Thinking…
            </div>
          )}

          <ErrorNote>{error}</ErrorNote>
          <div ref={bottomRef} />
        </div>
      </div>

      {/* composer */}
      <div className="border-t border-line bg-white px-4 py-4 sm:px-8">
        <form
          className="mx-auto flex max-w-4xl items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            ref={composerRef}
            rows={1}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              // a length warning clears as soon as the user types again —
              // real request errors (from send/loads) stay until a retry
              if (error === TOO_SHORT_MSG || error === TOO_LONG_MSG) setError("");
            }}
            onKeyDown={(e) => {
              // !isComposing: IME users commit a composition with Enter
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Ask anything about your organization's documents…"
            className="max-h-40 min-h-[46px] flex-1 resize-none rounded-xl border border-line-2 bg-white px-4 py-3 text-sm text-slate-900 placeholder:text-slate-400 outline-none focus:border-brand-2 focus:ring-2 focus:ring-brand/20"
          />
          <button
            type="submit"
            disabled={busy || !input.trim()}
            className="flex h-[46px] items-center gap-2 rounded-xl bg-brand px-5 text-sm font-semibold text-white transition hover:bg-brand-2 disabled:opacity-40"
          >
            {busy ? (
              <>
                Sending
                <Loader2 size={14} className="animate-spin" />
              </>
            ) : (
              <>
                Send <CornerDownLeft size={14} />
              </>
            )}
          </button>
        </form>
        <p className="mx-auto mt-2 max-w-4xl text-[10px] text-slate-500">
          Answers are generated only from documents you are authorized to read. Enter to
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
