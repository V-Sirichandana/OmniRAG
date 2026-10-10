"""Agentic RAG as a LangGraph:  plan → retrieve → answer → verify ⟲ (one grounded retry) → done."""
import json, re
from typing import TypedDict
from langgraph.graph import StateGraph, END
from . import rag, llm
from .config import MIN_RERANK

NOT_FOUND = "I couldn't find this in the documents you have access to. Try rephrasing, or ask an administrator to upload the relevant document."
SYS = ("You are an enterprise knowledge assistant. Answer ONLY from the numbered context passages. "
       "Write the answer as plain markdown and do NOT include any citation markers, reference numbers, "
       "footnotes or page references (such as [1] or 【1†p.2】) anywhere in the answer — the numbered "
       "context is only for you to ground the answer. If the context does not contain the answer, say "
       "so plainly. Never invent facts.")

# citation/reference markers some models emit anyway (e.g. [1] or 【5†p.3】)
_CITE = re.compile(r"(?:\s*【\d+†[^】]*】)+|(?:\s*\[\d+\])+")


def clean_markers(text: str) -> str:
    """Strip any citation/reference markers from an answer before it is shown."""
    t = _CITE.sub("", text)
    t = re.sub(r"[ \t]{2,}", " ", t)
    t = re.sub(r" +([.,;:!?])", r"\1", t)
    return t.strip()

class S(TypedDict, total=False):
    question: str; history: list; tenant_id: str; doc_ids: list; provider: str
    queries: list; hits: list; answer: str; grounded: bool; score: int; unsupported: list
    retries: int; used: list; trace: list

def _log(s, msg): return s.get("trace", []) + [msg]
def _json(text):
    m = re.search(r"[\[{].*[\]}]", text, re.S)
    return json.loads(m.group(0)) if m else None

def plan(s: S):
    q, hist = s["question"], s.get("history", [])
    if len(q.split()) < 8 and not hist: return {"queries": [q], "trace": _log(s, "plan: single query")}
    try:
        ctx = "\n".join(f"{m['role']}: {m['content'][:200]}" for m in hist[-4:])
        t, p = llm.complete("Return ONLY a JSON array of up to 3 standalone search queries for the question. Resolve pronouns using the history.",
                            f"History:\n{ctx}\n\nQuestion: {q}", s.get("provider"))
        qs = [x for x in (_json(t) or []) if isinstance(x, str)][:3] or [q]
    except Exception: qs, p = [q], None
    return {"queries": list(dict.fromkeys([q] + qs)), "trace": _log(s, f"plan: {len(qs)} sub-queries")}

def retrieve(s: S):
    k = 8 if s.get("retries", 0) == 0 else 12
    pool = {}
    for q in s["queries"]:
        for h in rag.search(s["tenant_id"], s["doc_ids"], q, k): pool[h["id"]] = h
    hits = rag.rerank(s["question"], list(pool.values()), 6 if k == 8 else 8)
    hits = [h for h in hits if h["score"] is None or h["score"] >= MIN_RERANK]
    return {"hits": hits, "trace": _log(s, f"retrieve: {len(hits)} passages kept")}

def answer(s: S):
    if not s.get("hits"): return {"answer": NOT_FOUND, "grounded": True, "score": 100, "unsupported": [], "trace": _log(s, "answer: no evidence → not-found")}
    src = "\n\n".join(f"[{i+1}] ({h['meta']['filename']}, p.{h['meta']['page']})\n{h['text']}" for i, h in enumerate(s["hits"]))
    hist = "\n".join(f"{m['role']}: {m['content'][:300]}" for m in s.get("history", [])[-4:])
    extra = f"\nA previous draft contained unsupported claims: {s['unsupported']}. Remove them; use only what the sources state." if s.get("unsupported") else ""
    t, p = llm.complete(SYS + extra, f"Conversation so far:\n{hist}\n\nSources:\n{src}\n\nQuestion: {s['question']}", s.get("provider"), 0.1)
    return {"answer": t.strip(), "used": s.get("used", []) + [p], "trace": _log(s, f"answer: drafted via {p}")}

def verify(s: S):
    if not s.get("hits"): return {}
    src = "\n\n".join(f"[{i+1}] {h['text']}" for i, h in enumerate(s["hits"]))
    try:
        t, _ = llm.complete('You are a strict fact-checker. Return ONLY JSON: {"grounded": true|false, "score": 0-100, "unsupported": ["claim", ...]}. '
                            "A claim is unsupported if the sources do not state it.", f"Sources:\n{src}\n\nAnswer:\n{s['answer']}", s.get("provider"), 0)
        v = _json(t) or {}
        return {"grounded": bool(v.get("grounded", True)), "score": int(v.get("score", 70)), "unsupported": v.get("unsupported", [])[:5],
                "trace": _log(s, f"verify: score {v.get('score')}")}
    except Exception:
        return {"grounded": True, "score": -1, "unsupported": [], "trace": _log(s, "verify: judge unavailable")}

def bump(s: S): return {"retries": s.get("retries", 0) + 1, "trace": _log(s, "retry: regenerating with feedback")}
def after_verify(s: S): return "bump" if (not s.get("grounded", True) and s.get("retries", 0) < 1) else END

g = StateGraph(S)
for n, f in (("plan", plan), ("retrieve", retrieve), ("answer", answer), ("verify", verify), ("bump", bump)): g.add_node(n, f)
g.set_entry_point("plan"); g.add_edge("plan", "retrieve"); g.add_edge("retrieve", "answer"); g.add_edge("answer", "verify")
g.add_conditional_edges("verify", after_verify, {"bump": "bump", END: END}); g.add_edge("bump", "retrieve")
GRAPH = g.compile()

def run(question, tenant_id, doc_ids, history, provider=None) -> dict:
    out = GRAPH.invoke({"question": question, "tenant_id": tenant_id, "doc_ids": doc_ids, "history": history, "provider": provider, "retries": 0})
    # No sources, no model name in the result — retrieval details stay server-side.
    return {"answer": clean_markers(out["answer"]), "grounded": out.get("grounded", True),
            "confidence": out.get("score", 0), "trace": out.get("trace", [])}
