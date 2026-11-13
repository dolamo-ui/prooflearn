"""RAG = 'retrieve, then answer'. Cut a document into passages, rank them against the question (BM25, the same idea
search engines use) and give the AI only the best few. Every passage keeps a number, so an answer can say which one it used."""
import math
import re

STOP_WORDS = set("""about after again also and are because been before being but can could did does for from have into
its more most not our please should than that the their them then there these this those through under use was were what
when where which who will with would your""".split())


def chunk_text(source: str, target: int = 900) -> list[dict]:
    """Passages of about 400-900 characters, never in the middle of a sentence if avoidable."""
    paragraphs = [p.strip() for p in re.split(r"\r?\n\s*\r?\n", source) if p.strip()]
    pieces: list[str] = []
    for p in paragraphs:
        if len(p) <= target:
            pieces.append(p)
            continue
        cur = ""
        for sentence in re.split(r"(?<=[.!?])\s+", p):
            if len(sentence) > target:  # one huge "sentence": cut by length
                if cur:
                    pieces.append(cur)
                    cur = ""
                pieces.extend(sentence[i:i + target] for i in range(0, len(sentence), target))
            elif len(cur + " " + sentence) > target:
                if cur:
                    pieces.append(cur)
                cur = sentence
            else:
                cur = f"{cur} {sentence}" if cur else sentence
        if cur:
            pieces.append(cur)
    merged: list[str] = []  # join very short neighbours (headings, list items) so passages carry meaning
    for piece in pieces:
        if merged and len(merged[-1]) < 400 and len(merged[-1] + "\n\n" + piece) <= target:
            merged[-1] = f"{merged[-1]}\n\n{piece}"
        else:
            merged.append(piece)
    return [{"id": i + 1, "text": t} for i, t in enumerate(merged)]


def _stem(w: str) -> str:
    return w[:-1] if len(w) > 4 and w.endswith("s") and not w.endswith("ss") else w


def _tokens(text: str) -> list[str]:
    return [_stem(w) for w in re.findall(r"[^\W_]{3,}", text.lower()) if w not in STOP_WORDS]


def retrieve(source: str, query: str, k: int = 6) -> list[dict]:
    """The k passages that best match the query, in reading order."""
    chunks = chunk_text(source.strip())
    if not chunks:
        return []
    q = list(dict.fromkeys(_tokens(query)))
    docs = [_tokens(c["text"]) for c in chunks]
    avg = (sum(len(d) for d in docs) / len(docs)) or 1
    df: dict[str, int] = {}
    for d in docs:
        for t in set(d):
            df[t] = df.get(t, 0) + 1
    k1, b = 1.2, 0.75
    scored = []
    for c, d in zip(chunks, docs):
        tf: dict[str, int] = {}
        for t in d:
            tf[t] = tf.get(t, 0) + 1
        score = 0.0
        for t in q:
            f = tf.get(t, 0)
            if not f:
                continue
            n = df.get(t, 0)
            idf = math.log(1 + (len(chunks) - n + 0.5) / (n + 0.5))
            score += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * len(d)) / avg)))
        scored.append((c, score))
    hits = [s for s in scored if s[1] > 0]
    chosen = (sorted(hits, key=lambda s: -s[1]) if hits else scored)[:k]
    return sorted((s[0] for s in chosen), key=lambda c: c["id"])


def as_passages(chunks: list[dict]) -> str:
    return "\n\n".join(f"[{c['id']}] {c['text']}" for c in chunks)


def retrieve_source_text(source: str, query: str, max_chunks: int = 5, max_chars: int = 4000) -> str:
    return "\n\n".join(c["text"] for c in retrieve(source, query, max_chunks))[:max_chars]


def pick_passages(source: str, focus: str, part: int = 0, parts: int = 1, k: int = 6) -> list[dict]:
    """Passages for ONE batch of a big test. The note (or the best matches for a focus) is cut into `parts`
    consecutive slices, and batch number `part` uses its own slice, so a long test covers the whole note."""
    all_ = retrieve(source, focus, k * parts) if focus else chunk_text(source.strip())
    if not all_:
        return []
    a = (part * len(all_)) // parts
    b = max(a + 1, ((part + 1) * len(all_)) // parts)
    piece = all_[a:b]
    if len(piece) <= k:
        return piece
    step = len(piece) / k
    return [piece[int(i * step)] for i in range(k)]
