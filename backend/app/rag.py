"""Ingestion + hybrid retrieval. One Chroma collection per tenant; every query is
restricted to doc_ids the caller is allowed to see (per-document ACL)."""
import io, csv, re
from pathlib import Path
import chromadb
from chromadb.utils import embedding_functions
from rank_bm25 import BM25Okapi
from .config import CHROMA_DIR

_client = _ef = _ranker = None
_tok = lambda s: re.findall(r"\w+", s.lower())

def _coll(tid):
    global _client, _ef
    if _client is None:
        _client = chromadb.PersistentClient(path=CHROMA_DIR)
        _ef = embedding_functions.SentenceTransformerEmbeddingFunction(model_name="all-MiniLM-L6-v2")
    return _client.get_or_create_collection(f"t_{tid}", embedding_function=_ef, metadata={"hnsw:space": "cosine"})

def extract(filename: str, data: bytes) -> list[tuple[int, str]]:
    ext = Path(filename).suffix.lower()
    if ext == ".pdf":
        from pypdf import PdfReader
        return [(i + 1, p.extract_text() or "") for i, p in enumerate(PdfReader(io.BytesIO(data)).pages)]
    if ext == ".docx":
        import docx
        return [(1, "\n".join(p.text for p in docx.Document(io.BytesIO(data)).paragraphs))]
    if ext == ".pptx":
        from pptx import Presentation
        return [(i + 1, "\n".join(sh.text_frame.text for sh in s.shapes if sh.has_text_frame)) for i, s in enumerate(Presentation(io.BytesIO(data)).slides)]
    text = data.decode("utf-8", errors="ignore")
    if ext == ".csv":
        text = "\n".join(", ".join(r) for r in csv.reader(io.StringIO(text)))
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
    ids, docs, metas = [], [], []
    for page, text in extract(filename, data):
        for j, ch in enumerate(chunk(text)):
            ids.append(f"{doc_id}:{page}:{j}"); docs.append(ch)
            metas.append({"doc_id": doc_id, "filename": filename, "page": page})
    for i in range(0, len(ids), 100):
        _coll(tid).add(ids=ids[i:i+100], documents=docs[i:i+100], metadatas=metas[i:i+100])
    return len(ids)

def delete_doc(tid, doc_id): _coll(tid).delete(where={"doc_id": doc_id})
def drop_tenant(tid):
    _coll(tid); _client.delete_collection(f"t_{tid}")

def search(tid, doc_ids, query, k=8):
    """Hybrid: dense + BM25 fused with Reciprocal Rank Fusion, scoped to doc_ids."""
    if not doc_ids: return []
    c, where = _coll(tid), {"doc_id": {"$in": list(doc_ids)}}
    allc = c.get(where=where, include=["documents", "metadatas"])
    if not allc["ids"]: return []
    info = {i: (d, m) for i, d, m in zip(allc["ids"], allc["documents"], allc["metadatas"])}
    dense = c.query(query_texts=[query], n_results=min(k * 2, len(info)), where=where)["ids"][0]
    bm = BM25Okapi([_tok(info[i][0]) for i in allc["ids"]])
    sc = bm.get_scores(_tok(query))
    sparse = [allc["ids"][i] for i in sorted(range(len(sc)), key=lambda i: -sc[i])[:k * 2] if sc[i] > 0]
    rrf = {}
    for lst in (dense, sparse):
        for r, i in enumerate(lst): rrf[i] = rrf.get(i, 0) + 1 / (60 + r)
    top = sorted(rrf, key=rrf.get, reverse=True)[:k]
    return [{"id": i, "text": info[i][0], "meta": info[i][1], "score": None} for i in top]

def rerank(query, hits, top=6):
    """Cross-encoder rerank (FlashRank MiniLM). Falls back to fusion order if unavailable."""
    global _ranker
    if not hits: return []
    try:
        from flashrank import Ranker, RerankRequest
        _ranker = _ranker or Ranker(model_name="ms-marco-MiniLM-L-12-v2")
        res = _ranker.rerank(RerankRequest(query=query, passages=[{"id": h["id"], "text": h["text"]} for h in hits]))
        by = {h["id"]: h for h in hits}
        out = []
        for r in res[:top]:
            h = by[r["id"]]; h["score"] = float(r["score"]); out.append(h)
        return out
    except Exception as e:
        print("rerank unavailable:", e)
        return hits[:top]
