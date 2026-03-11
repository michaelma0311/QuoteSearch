import argparse
import json
import os
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from rapidfuzz import fuzz
from tqdm import tqdm

try:
    # Optional convenience: load env vars from a local .env if present.
    from dotenv import load_dotenv  # type: ignore

    load_dotenv()
except Exception:
    pass


PAGE_RE = re.compile(r"^===\s*Page\s+(\d+)\s*===$", re.IGNORECASE)
BOOK_RE = re.compile(r"^\s*Book\s+the\s+(First|Second|Third)\b", re.IGNORECASE)
CHAPTER_RE = re.compile(r"^\s*Chapter\s+(\d+)\b", re.IGNORECASE)


@dataclass(frozen=True)
class Page:
    pdf_page: int
    text: str


def _normalize_space(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip()


def load_pages(book_txt_path: str) -> List[Page]:
    with open(book_txt_path, "r", encoding="utf-8", errors="ignore") as f:
        lines = [line.rstrip("\n") for line in f]

    pages: List[Page] = []
    current_page_num: Optional[int] = None
    buf: List[str] = []

    def flush():
        nonlocal buf, current_page_num
        if current_page_num is None:
            return
        text = "\n".join(buf).strip()
        pages.append(Page(pdf_page=int(current_page_num), text=text))
        buf = []

    for line in lines:
        m = PAGE_RE.match(line.strip())
        if m:
            flush()
            current_page_num = int(m.group(1))
            continue
        if current_page_num is None:
            # ignore any preamble before first page marker
            continue
        buf.append(line)
    flush()
    return pages


def infer_book_and_chapter_by_page(pages: List[Page]) -> Dict[int, Dict[str, Any]]:
    """
    Best-effort page-level metadata:
    - carries forward last seen Book/Chapter markers
    """
    meta: Dict[int, Dict[str, Any]] = {}
    # Some PDF-to-text dumps omit explicit "Book the First/Second/Third" headings.
    # For Tale of Two Cities, chapter numbering resets to 1 at each new "Book".
    book_names = ["Book the First", "Book the Second", "Book the Third"]
    current_book: Optional[str] = None
    current_book_idx = 0
    current_chapter: Optional[int] = None
    last_chapter_seen: Optional[int] = None
    explicit_book_seen = False

    for p in pages:
        first_chapter_on_page: Optional[int] = None
        for line in p.text.splitlines():
            b = BOOK_RE.match(line)
            if b:
                current_book = f"Book the {b.group(1).title()}"
                if current_book in book_names:
                    current_book_idx = book_names.index(current_book)
                explicit_book_seen = True
            c = CHAPTER_RE.match(line)
            if c:
                ch = int(c.group(1))
                if first_chapter_on_page is None:
                    first_chapter_on_page = ch
                current_chapter = ch

        # If no explicit book heading exists anywhere, infer book boundaries by chapter reset to 1.
        if not explicit_book_seen:
            if (
                first_chapter_on_page == 1
                and last_chapter_seen is not None
                and last_chapter_seen != 1
                and current_book_idx < len(book_names) - 1
            ):
                current_book_idx += 1
            current_book = book_names[current_book_idx]
        else:
            # If explicit headings exist, keep carrying forward the last explicit/current book.
            if current_book is None:
                current_book = book_names[current_book_idx]

        if current_chapter is not None:
            last_chapter_seen = current_chapter
        meta[p.pdf_page] = {"book": current_book, "chapter": current_chapter}
    return meta


def chunk_text(text: str, chunk_chars: int = 1200, overlap_chars: int = 200) -> List[str]:
    text = _normalize_space(text)
    if not text:
        return []
    if chunk_chars <= 0:
        return [text]
    overlap_chars = max(0, min(overlap_chars, chunk_chars - 1))
    chunks: List[str] = []
    start = 0
    while start < len(text):
        end = min(len(text), start + chunk_chars)
        chunk = text[start:end].strip()
        if chunk:
            chunks.append(chunk)
        if end == len(text):
            break
        start = end - overlap_chars
    return chunks


def load_chapter_book_pages(path: Optional[str]) -> Dict[str, Dict[int, int]]:
    """
    JSON format:
    {
      "Book the First": { "1": 1, "2": 3 }
    }
    """
    if not path:
        return {}
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    out: Dict[str, Dict[int, int]] = {}
    for book, mapping in raw.items():
        out[str(book)] = {int(k): int(v) for k, v in mapping.items()}
    return out


def build_pdf_to_book_page_estimator(
    pages: List[Page],
    per_page_meta: Dict[int, Dict[str, Any]],
    chapter_book_pages: Dict[str, Dict[int, int]],
) -> Tuple[Dict[str, List[Tuple[int, int]]], "callable"]:
    """
    Returns:
    - anchors_by_book: {book: [(pdf_page_start_of_chapter, book_page_number), ...]}
    - estimate(book, pdf_page) -> Optional[int]
    """
    # find chapter starts in pdf pages for each book (best-effort)
    anchors_by_book: Dict[str, List[Tuple[int, int]]] = {}

    # Precompute first page where each (book, chapter) appears
    first_seen: Dict[Tuple[str, int], int] = {}
    for p in pages:
        b = per_page_meta.get(p.pdf_page, {}).get("book")
        if not b:
            continue
        # scan each page for chapter headings; multiple can exist, keep first occurrence overall
        for line in p.text.splitlines():
            m = CHAPTER_RE.match(line)
            if m:
                ch = int(m.group(1))
                key = (b, ch)
                first_seen.setdefault(key, p.pdf_page)

    for book, mapping in chapter_book_pages.items():
        anchors: List[Tuple[int, int]] = []
        for ch, book_page in mapping.items():
            pdf_page = first_seen.get((book, ch))
            if pdf_page is not None:
                anchors.append((int(pdf_page), int(book_page)))
        anchors.sort(key=lambda x: x[0])
        anchors_by_book[book] = anchors

    def estimate(book: Optional[str], pdf_page: int) -> Optional[int]:
        if not book:
            return None
        anchors = anchors_by_book.get(book) or []
        if len(anchors) < 2:
            return None
        xs = [a[0] for a in anchors]
        ys = [a[1] for a in anchors]

        # find segment for interpolation/extrapolation
        if pdf_page <= xs[0]:
            x0, y0 = xs[0], ys[0]
            x1, y1 = xs[1], ys[1]
        elif pdf_page >= xs[-1]:
            x0, y0 = xs[-2], ys[-2]
            x1, y1 = xs[-1], ys[-1]
        else:
            i = max(i for i, x in enumerate(xs) if x <= pdf_page)
            x0, y0 = xs[i], ys[i]
            x1, y1 = xs[i + 1], ys[i + 1]

        if x1 == x0:
            return int(round(y0))
        y = y0 + (pdf_page - x0) * (y1 - y0) / (x1 - x0)
        return int(round(y))

    return anchors_by_book, estimate


class Embedder:
    def __init__(self, provider: str, model: Optional[str] = None):
        self.provider = provider
        self.model = model
        self._client = None
        self._st = None

    def dimension(self) -> int:
        if self.provider == "local":
            # known default
            return 384
        # infer by embedding a short string (safe)
        vec = self.embed(["dimension probe"])[0]
        return len(vec)

    def embed(self, texts: List[str]) -> List[List[float]]:
        if self.provider == "openai":
            from openai import OpenAI

            if self._client is None:
                key = os.environ.get("OPENAI_API_KEY")
                if not key:
                    raise RuntimeError("OPENAI_API_KEY is not set")
                self._client = OpenAI(api_key=key)
            model = self.model or os.environ.get("OPENAI_EMBED_MODEL") or "text-embedding-3-small"
            resp = self._client.embeddings.create(model=model, input=texts)
            # keep order
            vectors = [d.embedding for d in resp.data]
            return vectors

        if self.provider == "local":
            from sentence_transformers import SentenceTransformer

            if self._st is None:
                model = self.model or "sentence-transformers/all-MiniLM-L6-v2"
                self._st = SentenceTransformer(model)
            vecs = self._st.encode(texts, normalize_embeddings=True)
            return vecs.tolist()

        raise ValueError(f"Unknown embedding provider: {self.provider}")


def ensure_pinecone_index(dimension: int, metric: str = "cosine"):
    from pinecone import Pinecone, ServerlessSpec

    api_key = os.environ.get("PINECONE_API_KEY")
    index_name = os.environ.get("PINECONE_INDEX")
    cloud = os.environ.get("PINECONE_CLOUD", "aws")
    region = os.environ.get("PINECONE_REGION", "us-east-1")

    if not api_key or not index_name:
        raise RuntimeError("PINECONE_API_KEY and PINECONE_INDEX must be set")

    pc = Pinecone(api_key=api_key)
    existing = {idx["name"] for idx in pc.list_indexes()}
    if index_name not in existing:
        pc.create_index(
            name=index_name,
            dimension=dimension,
            metric=metric,
            spec=ServerlessSpec(cloud=cloud, region=region),
        )
    return pc.Index(index_name)


def ingest(
    book_txt: str,
    chapter_book_pages_path: Optional[str],
    embedding_provider: str,
    embedding_model: Optional[str],
    namespace: Optional[str],
    chunk_chars: int,
    overlap_chars: int,
    batch_size: int,
):
    pages = load_pages(book_txt)
    if not pages:
        raise RuntimeError("No pages found. Expected markers like: === Page 4 ===")

    per_page_meta = infer_book_and_chapter_by_page(pages)
    chapter_book_pages = load_chapter_book_pages(chapter_book_pages_path)
    anchors_by_book, estimate_book_page = build_pdf_to_book_page_estimator(
        pages, per_page_meta, chapter_book_pages
    )

    embedder = Embedder(provider=embedding_provider, model=embedding_model)
    dim = embedder.dimension()
    index = ensure_pinecone_index(dim)
    namespace = namespace or os.environ.get("PINECONE_NAMESPACE") or "default"

    # Build chunks
    items: List[Tuple[str, str, Dict[str, Any]]] = []
    for p in pages:
        meta = per_page_meta.get(p.pdf_page, {})
        book = meta.get("book")
        chapter = meta.get("chapter")
        est_bp = estimate_book_page(book, p.pdf_page)
        chunks = chunk_text(p.text, chunk_chars=chunk_chars, overlap_chars=overlap_chars)
        for i, ch in enumerate(chunks):
            vec_id = f"pdf{p.pdf_page}_chunk{i}"
            md = {
                "pdf_page": p.pdf_page,
                "chunk": i,
                "book": book,
                "chapter": chapter,
                "est_book_page": est_bp,
                "preview": ch[:800],
            }
            items.append((vec_id, ch, md))

    # Upsert in batches
    for start in tqdm(range(0, len(items), batch_size), desc="Embedding+upserting"):
        batch = items[start : start + batch_size]
        texts = [b[1] for b in batch]
        vecs = embedder.embed(texts)
        vectors = []
        for (vec_id, _text, md), v in zip(batch, vecs):
            vectors.append({"id": vec_id, "values": v, "metadata": md})
        index.upsert(vectors=vectors, namespace=namespace)

    print(f"Done. Upserted {len(items)} vectors into index '{os.environ.get('PINECONE_INDEX')}' namespace '{namespace}'.")
    if chapter_book_pages:
        print("Anchor points found (pdf_page -> book_page):")
        for book, anchors in anchors_by_book.items():
            if anchors:
                print(f"  {book}: {anchors}")


def fuzzy_find_best_page(pages: List[Page], quote: str) -> Tuple[Optional[int], float, Optional[str]]:
    q_norm = _normalize_space(quote).lower()
    best_page = None
    best_score = -1.0
    best_preview = None

    for p in pages:
        txt = _normalize_space(p.text)
        txt_low = txt.lower()

        if q_norm and q_norm in txt_low:
            # perfect substring match
            return p.pdf_page, 100.0, txt[max(0, txt_low.find(q_norm) - 120) : txt_low.find(q_norm) + len(q_norm) + 120]

        # fuzzy partial ratio
        score = float(fuzz.partial_ratio(q_norm, txt_low))
        if score > best_score:
            best_score = score
            best_page = p.pdf_page
            best_preview = txt[:300]

    return best_page, best_score, best_preview


def semantic_query(
    quote: str,
    embedding_provider: str,
    embedding_model: Optional[str],
    namespace: Optional[str],
    top_k: int = 10,
) -> List[Dict[str, Any]]:
    embedder = Embedder(provider=embedding_provider, model=embedding_model)
    qvec = embedder.embed([quote])[0]

    index = ensure_pinecone_index(embedder.dimension())
    namespace = namespace or os.environ.get("PINECONE_NAMESPACE") or "default"

    res = index.query(vector=qvec, top_k=top_k, include_metadata=True, namespace=namespace)
    matches = []
    for m in getattr(res, "matches", []) or []:
        md = getattr(m, "metadata", None) or {}
        matches.append(
            {
                "score": float(getattr(m, "score", 0.0)),
                "id": getattr(m, "id", None),
                "pdf_page": md.get("pdf_page"),
                "est_book_page": md.get("est_book_page"),
                "book": md.get("book"),
                "chapter": md.get("chapter"),
                "preview": md.get("preview"),
            }
        )
    return matches


def query(
    book_txt: str,
    quote: str,
    chapter_book_pages_path: Optional[str],
    embedding_provider: str,
    embedding_model: Optional[str],
    namespace: Optional[str],
    fuzzy_threshold: float,
):
    pages = load_pages(book_txt)
    per_page_meta = infer_book_and_chapter_by_page(pages)
    chapter_book_pages = load_chapter_book_pages(chapter_book_pages_path)
    _anchors_by_book, estimate_book_page = build_pdf_to_book_page_estimator(
        pages, per_page_meta, chapter_book_pages
    )

    best_page, best_score, best_preview = fuzzy_find_best_page(pages, quote)
    if best_page is not None and best_score >= fuzzy_threshold:
        meta = per_page_meta.get(best_page, {})
        book = meta.get("book")
        est = estimate_book_page(book, best_page)
        print("Fuzzy match result:")
        print(f"  pdf_page: {best_page}")
        if est is not None:
            print(f"  estimated_book_page: {est}")
        if book:
            print(f"  book: {book}")
        if meta.get("chapter") is not None:
            print(f"  chapter: {meta.get('chapter')}")
        print(f"  score: {best_score:.1f}")
        if best_preview:
            print(f"  preview: {best_preview}")
        return

    print(f"Fuzzy score {best_score:.1f} below threshold {fuzzy_threshold:.1f}; trying semantic search (Pinecone)...")
    try:
        matches = semantic_query(
            quote=quote,
            embedding_provider=embedding_provider,
            embedding_model=embedding_model,
            namespace=namespace,
            top_k=10,
        )
    except Exception as e:
        print(f"Semantic search failed: {e}")
        print("Tip: set PINECONE_API_KEY + PINECONE_INDEX (and OPENAI_API_KEY if using --embedding-provider openai), then run: python to2csearch.py ingest ...")
        return
    if not matches:
        print("No Pinecone matches returned (is the index ingested + env vars set?).")
        return

    # Choose best page by highest score across chunks
    by_page: Dict[int, Dict[str, Any]] = {}
    for m in matches:
        p = m.get("pdf_page")
        if p is None:
            continue
        if p not in by_page or m["score"] > by_page[p]["score"]:
            by_page[p] = m
    best = max(by_page.values(), key=lambda x: x["score"])

    print("Semantic search result (best page by top chunk score):")
    print(f"  pdf_page: {best.get('pdf_page')}")
    if best.get("est_book_page") is not None:
        print(f"  estimated_book_page: {best.get('est_book_page')}")
    if best.get("book"):
        print(f"  book: {best.get('book')}")
    if best.get("chapter") is not None:
        print(f"  chapter: {best.get('chapter')}")
    print(f"  score: {best.get('score'):.4f}")
    if best.get("preview"):
        print(f"  preview: {best.get('preview')}")


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)

    ap_ing = sub.add_parser("ingest", help="Chunk pages, embed, and upsert into Pinecone")
    ap_ing.add_argument("--book-txt", required=True, help="Path to book.txt")
    ap_ing.add_argument("--chapter-book-pages", default=None, help="Path to JSON mapping like chapter_book_pages.example.json")
    ap_ing.add_argument("--embedding-provider", choices=["openai", "local"], default="openai")
    ap_ing.add_argument("--embedding-model", default=None)
    ap_ing.add_argument("--namespace", default=None)
    ap_ing.add_argument("--chunk-chars", type=int, default=1200)
    ap_ing.add_argument("--overlap-chars", type=int, default=200)
    ap_ing.add_argument("--batch-size", type=int, default=64)

    ap_q = sub.add_parser("query", help="Find best page for a user quote")
    ap_q.add_argument("--book-txt", required=True, help="Path to book.txt")
    ap_q.add_argument("--quote", required=True, help="User quote to locate")
    ap_q.add_argument("--chapter-book-pages", default=None, help="Path to JSON mapping like chapter_book_pages.example.json")
    ap_q.add_argument("--embedding-provider", choices=["openai", "local"], default="openai")
    ap_q.add_argument("--embedding-model", default=None)
    ap_q.add_argument("--namespace", default=None)
    ap_q.add_argument("--fuzzy-threshold", type=float, default=90.0)

    args = ap.parse_args()

    if args.cmd == "ingest":
        ingest(
            book_txt=args.book_txt,
            chapter_book_pages_path=args.chapter_book_pages,
            embedding_provider=args.embedding_provider,
            embedding_model=args.embedding_model,
            namespace=args.namespace,
            chunk_chars=args.chunk_chars,
            overlap_chars=args.overlap_chars,
            batch_size=args.batch_size,
        )
    elif args.cmd == "query":
        query(
            book_txt=args.book_txt,
            quote=args.quote,
            chapter_book_pages_path=args.chapter_book_pages,
            embedding_provider=args.embedding_provider,
            embedding_model=args.embedding_model,
            namespace=args.namespace,
            fuzzy_threshold=args.fuzzy_threshold,
        )


if __name__ == "__main__":
    main()

