"""Ingestion + hybrid retrieval (same interface as the original Chroma version).

Chunks and their embedding vectors live in the platform database (SQLite
locally, PostgreSQL in production) so documents and vectors survive restarts,
redeploys and logins. Retrieval keeps the original pipeline:

    dense (vector cosine) + sparse (BM25)  →  Reciprocal Rank Fusion  →  rerank

Every query is restricted to the doc_ids the caller is allowed to see
(per-document / per-department ACL enforced upstream in main.py).
"""
import io, csv, json, math, re
from pathlib import Path
from . import db as D, embeddings as E
from .config import MIN_RERANK  # noqa: F401  (kept for parity with the original module)

_tok = lambda s: re.findall(r"\w+", s.lower())


def extract(filename: str, data: bytes) -> list[tuple[int, str]]:
    """Return [(page_number, text)] for the uploaded file."""
    ext = Path(filename).suffix.lower()
    if ext == ".pdf":
        from pypdf import PdfReader
        return [(i + 1, p.extract_text() or "") for i, p in enumerate(PdfReader(io.BytesIO(data)).pages)]
    if ext == ".docx":
        import docx
        return [(1, "\n".join(p.text for p in docx.Document(io.BytesIO(data)).paragraphs))]
    if ext == ".pptx":
        from pptx import Presentation
        return [(i + 1, "\n".join(sh.text_frame.text for sh in s.shapes if sh.has_text_frame))
                for i, s in enumerate(Presentation(io.BytesIO(data)).slides)]
    text = data.decode("utf-8", errors="ignore")
    if ext == ".csv":
        text = "\n".join(", ".join(r) for r in csv.reader(io.StringIO(text)))
    if ext == ".json":
        try:
            text = json.dumps(json.loads(text), indent=2, ensure_ascii=False)
        except Exception:
            pass
    return [(1, text)]


def chunk(text, size=900, overlap=150):
    paras, out, cur = [p.strip() for p in re.split(r"\n\s*\n|\n", text) if p.strip()], [], ""
    for p in paras:
        while len(p) > size:  # hard-split very long paragraphs
            out.append((cur + " " + p[:size]).strip()); cur = ""; p = p[size - overlap:]
        if len(cur) + len(p) > size and cur:
            out.append(cur.strip()); cur = cur[-overlap:]
        cur += " " + p
    if cur.strip(): out.append(cur.strip())
    return out


def ingest(tid, doc_id, filename, data) -> int:
    """Extract → chunk → embed → store. Returns the number of chunks."""
    rows = []
    for page, text in extract(filename, data):
        for j, ch in enumerate(chunk(text)):
            rows.append((f"{doc_id}:{page}:{j}", tid, doc_id, page, ch))
    if not rows:
        return 0
    vectors = E.embed([r[4] for r in rows])          # None → BM25-only mode
    with D.db() as c:
        c.executemany(
            "INSERT INTO chunks(id,tenant_id,doc_id,page,text,embedding) VALUES(?,?,?,?,?,?)",
            [r + (json.dumps(v) if vectors is not None else None,) for r in rows],
        )
    return len(rows)


def delete_doc(tid, doc_id):
    with D.db() as c:
        c.execute("DELETE FROM chunks WHERE tenant_id=? AND doc_id=?", (tid, doc_id))


def drop_tenant(tid):
    with D.db() as c:
        c.execute("DELETE FROM chunks WHERE tenant_id=?", (tid,))


def _cosine(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a)); nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb) if na and nb else 0.0


def search(tid, doc_ids, query, k=8):
    """Hybrid: dense + BM25 fused with Reciprocal Rank Fusion, scoped to doc_ids."""
    if not doc_ids:
        return []
    # Chunk the IN (...) list to stay well under statement limits.
    allowed = []
    for i in range(0, len(doc_ids), 400):
        part = doc_ids[i:i + 400]
        with D.db() as c:
            allowed += c.execute(
                f"SELECT ch.id, ch.text, ch.page, ch.embedding, d.filename FROM chunks ch "
                f"JOIN documents d ON d.id=ch.doc_id "
                f"WHERE ch.tenant_id=? AND ch.doc_id IN ({','.join('?' * len(part))})",
                (tid, *part),
            ).fetchall()
    if not allowed:
        return []

    info = {r["id"]: (r["text"], {"doc_id": r["filename"], "filename": r["filename"], "page": r["page"],
                                  "_doc_id": None}) for r in allowed}
    # keep the real doc_id in meta (used for debugging / future ACL joins)
    doc_ids_by_chunk = {}
    for i in range(0, len(doc_ids), 400):
        part = doc_ids[i:i + 400]
        with D.db() as c:
            for r in c.execute(
                f"SELECT id, doc_id FROM chunks WHERE tenant_id=? AND doc_id IN ({','.join('?' * len(part))})",
                (tid, *part),
            ).fetchall():
                doc_ids_by_chunk[r["id"]] = r["doc_id"]
    for cid, meta in info.items():
        meta["meta_doc_id"] = doc_ids_by_chunk.get(cid)
        meta["doc_id"] = doc_ids_by_chunk.get(cid)

    order = [r["id"] for r in allowed]
    texts = [info[i][0] for i in order]

    # --- dense leg (None when no embedding provider is configured) ----------
    dense: list[str] = []
    qv = E.embed([query])
    if qv:
        vecs = []
        for r in allowed:
            try:
                vecs.append(json.loads(r["embedding"]) if r["embedding"] else None)
            except Exception:
                vecs.append(None)
        scored = [(i, _cosine(qv[0], v)) for i, v in zip(order, vecs) if v]
        scored.sort(key=lambda t: -t[1])
        dense = [i for i, s in scored[: k * 2] if s > 0]

    # --- sparse leg (always available) --------------------------------------
    from rank_bm25 import BM25Okapi
    bm = BM25Okapi([_tok(t) for t in texts])
    sc = bm.get_scores(_tok(query))
    sparse = [order[i] for i in sorted(range(len(sc)), key=lambda i: -sc[i])[: k * 2] if sc[i] > 0]

    # --- Reciprocal Rank Fusion --------------------------------------------
    rrf: dict[str, float] = {}
    for lst in (dense, sparse):
        for r, i in enumerate(lst):
            rrf[i] = rrf.get(i, 0) + 1 / (60 + r)
    if not rrf and not dense:
        # No lexical overlap at all: fall back to the dense order so a configured
        # embedding model can still surface related passages.
        rrf = {i: 1.0 for i in dense}
    top = sorted(rrf, key=rrf.get, reverse=True)[:k]
    return [{"id": i, "text": info[i][0], "meta": {k: v for k, v in info[i][1].items() if k != "_doc_id"},
             "score": None} for i in top]


def rerank(query, hits, top=6):
    """Cross-encoder rerank (FlashRank). Falls back to fusion order if unavailable."""
    if not hits:
        return []
    try:
        from flashrank import Ranker, RerankRequest
        ranker = Ranker(model_name="ms-marco-MiniLM-L-12-v2")
        res = ranker.rerank(RerankRequest(query=query, passages=[{"id": h["id"], "text": h["text"]} for h in hits]))
        by = {h["id"]: h for h in hits}
        out = []
        for r in res[:top]:
            h = by[r["id"]]; h["score"] = float(r["score"]); out.append(h)
        return out
    except Exception as e:
        print("rerank unavailable:", e)
        return hits[:top]
