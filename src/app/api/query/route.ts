import { NextResponse } from "next/server";
import fs from "node:fs";
import path from "node:path";

import {
  buildPdfToBookPageEstimator,
  inferBookAndChapterByPage,
  inferPageChapterInfo,
  loadChapterBookPages,
  loadChapterTitles,
  loadPagesFromBookTxt,
  normalizeSpace,
} from "@/lib/book";

type Body = { quote?: string; fuzzyThreshold?: number; book?: string };

type BookCache = {
  pages: ReturnType<typeof loadPagesFromBookTxt>;
  perPageMeta: ReturnType<typeof inferBookAndChapterByPage>;
  pageInfo: ReturnType<typeof inferPageChapterInfo>;
  estimateBookPage: ReturnType<typeof buildPdfToBookPageEstimator>["estimate"];
  chapterTitles: ReturnType<typeof loadChapterTitles>;
};

const _caches = new Map<string, BookCache>();

const BOOK_FILES: Record<string, { txt: string; chapterPages: string; titles: string }> = {
  tale: {
    txt: "book.txt",
    chapterPages: "chapter_book_pages.tale.json",
    titles: "chapter_titles.tale.json",
  },
  butterflies: {
    txt: "butterfliesbook_pages.txt",
    chapterPages: "chapter_book_pages.butterflies.json",
    titles: "chapter_titles.butterflies.json",
  },
};

function resolveDataPath(rel: string) {
  const p1 = path.join(process.cwd(), "public", "data", rel);
  if (fs.existsSync(p1)) return p1;
  return path.join(process.cwd(), rel);
}

function getCache(bookKey: string): BookCache {
  const cached = _caches.get(bookKey);
  if (cached) return cached;

  const files = BOOK_FILES[bookKey];
  if (!files) throw new Error(`Unknown book: ${bookKey}`);

  const bookTxt = resolveDataPath(files.txt);
  const chapterJson = resolveDataPath(files.chapterPages);
  const titlesJson = resolveDataPath(files.titles);

  const pages = loadPagesFromBookTxt(bookTxt);
  const perPageMeta = inferBookAndChapterByPage(pages);
  const pageInfo = inferPageChapterInfo(pages);
  const chapterBookPages = loadChapterBookPages(chapterJson);
  const chapterTitles = loadChapterTitles(titlesJson);
  const { estimate } = buildPdfToBookPageEstimator({ pages, perPageMeta, chapterBookPages });

  const entry: BookCache = { pages, perPageMeta, pageInfo, estimateBookPage: estimate, chapterTitles };
  _caches.set(bookKey, entry);
  return entry;
}

function chapterForOffset(
  page: { chapterTop: number | null; chapterStarts: Array<{ chapter: number; offset: number }> },
  offset: number
) {
  let ch = page.chapterTop;
  for (const s of page.chapterStarts) {
    if (offset >= s.offset) ch = s.chapter;
    else break;
  }
  return ch;
}

function fuzzyBestPage(
  pages: { pdf_page: number; text: string }[],
  pageInfo: Record<number, { chapterTop: number | null; chapterStarts: Array<{ chapter: number; offset: number }>; normalized: string }>,
  quote: string
) {
  const q = normalizeSpace(quote).toLowerCase();
  let best = { pdf_page: pages[0]?.pdf_page ?? 0, score: -1, preview: "" };

  const qTokens = q.split(/[^a-z0-9']+/i).map((t) => t.trim()).filter(Boolean);
  const qTokenSet = new Set(qTokens);

  const bigrams = (s: string) => {
    const out = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    return out;
  };
  const qBigrams = bigrams(q);

  const tokenContainmentScore = (pageLow: string) => {
    if (qTokenSet.size === 0) return 0;
    let hit = 0;
    for (const t of qTokenSet) {
      if (t.length < 3) continue;
      if (pageLow.includes(t)) hit++;
    }
    const denom = Math.max(1, [...qTokenSet].filter((t) => t.length >= 3).length);
    return (hit / denom) * 100;
  };

  const bigramDiceScore = (pageLow: string) => {
    if (qBigrams.size === 0) return 0;
    const pBigrams = bigrams(pageLow);
    let inter = 0;
    for (const bg of qBigrams) if (pBigrams.has(bg)) inter++;
    return (200 * inter) / (qBigrams.size + pBigrams.size);
  };

  for (const p of pages) {
    const info = pageInfo[p.pdf_page];
    const txt = info?.normalized ?? normalizeSpace(p.text);
    const low = txt.toLowerCase();

    const idx = q.length ? low.indexOf(q) : -1;
    if (idx >= 0) {
      const preview = txt.slice(Math.max(0, idx - 140), idx + q.length + 140);
      return { pdf_page: p.pdf_page, score: 100, preview, matchOffset: idx };
    }

    const score = Math.max(tokenContainmentScore(low), bigramDiceScore(low));
    if (score > best.score) best = { pdf_page: p.pdf_page, score, preview: txt.slice(0, 320) };
  }

  return best;
}

function bestApproxSpan(hay: string, needle: string) {
  const h = hay.toLowerCase();
  const n = needle.toLowerCase();
  const exact = n.length ? h.indexOf(n) : -1;
  if (exact >= 0) return { start: exact, end: exact + n.length, mode: "exact" as const };

  const bigrams = (s: string) => {
    const out = new Set<string>();
    for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
    return out;
  };
  const dice = (a: Set<string>, b: Set<string>) => {
    if (!a.size || !b.size) return 0;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter++;
    return (200 * inter) / (a.size + b.size);
  };

  const nB = bigrams(n);
  const window = Math.max(60, Math.min(260, Math.round(n.length * 1.3)));
  const step = 18;
  let best = { start: 0, end: Math.min(h.length, window), score: -1 };
  for (let s = 0; s < h.length; s += step) {
    const e = Math.min(h.length, s + window);
    const w = h.slice(s, e);
    const score = dice(nB, bigrams(w));
    if (score > best.score) best = { start: s, end: e, score };
    if (e === h.length) break;
  }
  return { start: best.start, end: best.end, mode: "approx" as const };
}

function contextAroundSpan(text: string, span: { start: number; end: number }) {
  const t = normalizeSpace(text);
  const sentences = t.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (!sentences.length) return { before: "", match: t, after: "" };

  const starts: number[] = [];
  let pos = 0;
  for (const s of sentences) {
    starts.push(pos);
    pos += s.length + 1;
  }

  const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));
  let idx = 0;
  for (let i = 0; i < sentences.length; i++) {
    const st = starts[i]!;
    const en = st + sentences[i]!.length;
    if (span.start >= st && span.start <= en) { idx = i; break; }
    if (span.start > en) idx = i;
  }

  const from = clamp(idx - 3, 0, sentences.length - 1);
  const to = clamp(idx + 3, 0, sentences.length - 1);
  const selected = sentences.slice(from, to + 1);
  const selectedText = selected.join(" ");
  const selectedStart = starts[from] ?? 0;
  const relStart = clamp(span.start - selectedStart, 0, selectedText.length);
  const relEnd = clamp(span.end - selectedStart, relStart, selectedText.length);

  return {
    before: selectedText.slice(0, relStart),
    match: selectedText.slice(relStart, relEnd),
    after: selectedText.slice(relEnd),
  };
}

export async function POST(req: Request) {
  try {
    const body = (await req.json().catch(() => ({}))) as Body;
    const quote = (body.quote ?? "").trim();
    const fuzzyThreshold = typeof body.fuzzyThreshold === "number" ? body.fuzzyThreshold : 70;
    const bookKey = body.book === "butterflies" ? "butterflies" : "tale";

    if (!quote) {
      return NextResponse.json({ ok: false, error: "Missing quote" }, { status: 400 });
    }

    const { pages, perPageMeta, pageInfo, estimateBookPage, chapterTitles } = getCache(bookKey);

    const fuzzy = fuzzyBestPage(pages, pageInfo, quote);
    if (fuzzy.score >= fuzzyThreshold) {
      const meta = perPageMeta[fuzzy.pdf_page] ?? { book: null, chapter: null };
      const pinfo = pageInfo[fuzzy.pdf_page];
      const chapter =
        typeof (fuzzy as any).matchOffset === "number" && pinfo
          ? chapterForOffset(pinfo, (fuzzy as any).matchOffset)
          : meta.chapter;
      const chapterTitle = meta.book && chapter ? chapterTitles?.[meta.book]?.[chapter] : null;
      const pageText = pinfo?.normalized ?? pages.find((p) => p.pdf_page === fuzzy.pdf_page)?.text ?? "";
      const span = bestApproxSpan(pageText, quote);
      const context = contextAroundSpan(pageText, span);
      return NextResponse.json({
        ok: true,
        mode: "fuzzy",
        pdf_page: fuzzy.pdf_page,
        estimated_book_page: estimateBookPage(meta.book, fuzzy.pdf_page),
        book: meta.book,
        chapter,
        chapter_title: chapterTitle,
        score: fuzzy.score,
        context,
      });
    }

    return NextResponse.json({
      ok: false,
      error: `No strong match found (best score: ${fuzzy.score.toFixed(1)}). Try a longer or more exact quote.`,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: "API error: " + (e instanceof Error ? e.message : String(e)) },
      { status: 500 }
    );
  }
}
