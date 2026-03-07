import fs from "node:fs";
import path from "node:path";

export type Page = { pdf_page: number; text: string };
export type PerPageMeta = Record<
  number,
  { book: string | null; chapter: number | null }
>;

const PAGE_RE = /^===\s*Page\s+(\d+)\s*===$/i;
const CHAPTER_RE = /^\s*Chapter\s+(\d+)\b/i;

function normalizeSpace(s: string) {
  return s.replace(/\s+/g, " ").trim();
}

export type PageChapterInfo = {
  pdf_page: number;
  book: string | null;
  /** Chapter in effect at the very top of the page (before any new chapter heading on the same page). */
  chapterTop: number | null;
  /** Where chapters start *within* the normalized page text (offset into normalizeSpace(page.text)). */
  chapterStarts: Array<{ chapter: number; offset: number }>;
  /** Normalized page text used for offset math. */
  normalized: string;
};

export function loadPagesFromBookTxt(bookTxtPath: string): Page[] {
  const raw = fs.readFileSync(bookTxtPath, "utf-8");
  const lines = raw.split(/\r?\n/);

  const pages: Page[] = [];
  let currentPage: number | null = null;
  let buf: string[] = [];

  const flush = () => {
    if (currentPage == null) return;
    pages.push({ pdf_page: currentPage, text: buf.join("\n").trim() });
    buf = [];
  };

  for (const line of lines) {
    const m = PAGE_RE.exec(line.trim());
    if (m) {
      flush();
      currentPage = Number(m[1]);
      continue;
    }
    if (currentPage == null) continue;
    buf.push(line);
  }
  flush();
  return pages;
}

function buildNormalizedAndChapterOffsets(pageText: string) {
  let normalized = "";
  const chapterStarts: Array<{ chapter: number; offset: number }> = [];

  const lines = pageText.split(/\r?\n/);
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const ch = CHAPTER_RE.exec(line);

    const lineNorm = normalizeSpace(line);
    if (!lineNorm) continue;

    const offsetBefore = normalized.length ? normalized.length + 1 : 0; // +1 for join space
    if (normalized.length) normalized += " ";
    normalized += lineNorm;

    if (ch) {
      chapterStarts.push({ chapter: Number(ch[1]), offset: offsetBefore });
    }
  }

  return { normalized, chapterStarts };
}

export function inferPageChapterInfo(pages: Page[]): Record<number, PageChapterInfo> {
  // Your book.txt has chapter numbering reset for each "Book", but doesn't contain
  // explicit "Book the First/Second/Third" headings — so infer by Chapter 1 boundaries.
  const bookNames = ["Book the First", "Book the Second", "Book the Third"] as const;
  let bookIdx = 0;
  let lastChapterSeen: number | null = null;
  let currentChapter: number | null = null;

  const info: Record<number, PageChapterInfo> = {};

  for (const p of pages) {
    // chapter at the very top of the page is whatever was current before processing headings on this page
    const chapterTop = currentChapter;

    const { normalized, chapterStarts } = buildNormalizedAndChapterOffsets(p.text);
    const firstChapterOnPage = chapterStarts.length ? chapterStarts[0]!.chapter : null;

    if (
      firstChapterOnPage === 1 &&
      lastChapterSeen != null &&
      lastChapterSeen !== 1 &&
      bookIdx < bookNames.length - 1
    ) {
      bookIdx += 1;
    }

    if (chapterStarts.length) {
      currentChapter = chapterStarts[chapterStarts.length - 1]!.chapter;
      lastChapterSeen = currentChapter;
    }

    info[p.pdf_page] = {
      pdf_page: p.pdf_page,
      book: bookNames[bookIdx] ?? null,
      chapterTop,
      chapterStarts,
      normalized
    };
  }

  return info;
}

export function inferBookAndChapterByPage(pages: Page[]): PerPageMeta {
  // Backwards-compatible: chapter is the chapter *at the top of the page* (fixes "chapter starts mid-page" mislabeling).
  const info = inferPageChapterInfo(pages);
  const meta: PerPageMeta = {};
  for (const [k, v] of Object.entries(info)) {
    meta[Number(k)] = { book: v.book, chapter: v.chapterTop };
  }
  return meta;
}

export type ChapterBookPages = Record<string, Record<number, number>>;
export type ChapterTitles = Record<string, Record<number, string>>;

export function loadChapterBookPages(jsonPath: string): ChapterBookPages {
  const raw = fs.readFileSync(jsonPath, "utf-8");
  const data = JSON.parse(raw) as Record<string, Record<string, number>>;
  const out: ChapterBookPages = {};
  for (const [book, mapping] of Object.entries(data)) {
    out[book] = {};
    for (const [k, v] of Object.entries(mapping)) out[book]![Number(k)] = Number(v);
  }
  return out;
}

export function loadChapterTitles(jsonPath: string): ChapterTitles {
  const raw = fs.readFileSync(jsonPath, "utf-8");
  const data = JSON.parse(raw) as Record<string, Record<string, string>>;
  const out: ChapterTitles = {};
  for (const [book, mapping] of Object.entries(data)) {
    out[book] = {};
    for (const [k, v] of Object.entries(mapping)) out[book]![Number(k)] = String(v);
  }
  return out;
}

export function buildPdfToBookPageEstimator(opts: {
  pages: Page[];
  perPageMeta: PerPageMeta;
  chapterBookPages: ChapterBookPages;
}) {
  const { pages, perPageMeta, chapterBookPages } = opts;

  // firstSeen[(book, chapter)] = pdf_page
  const firstSeen = new Map<string, number>();
  for (const p of pages) {
    const m = perPageMeta[p.pdf_page];
    const book = m?.book;
    if (!book) continue;
    for (const line of p.text.split(/\r?\n/)) {
      const c = CHAPTER_RE.exec(line);
      if (!c) continue;
      const ch = Number(c[1]);
      const key = `${book}::${ch}`;
      if (!firstSeen.has(key)) firstSeen.set(key, p.pdf_page);
    }
  }

  const anchorsByBook: Record<string, Array<[number, number]>> = {};
  for (const [book, mapping] of Object.entries(chapterBookPages)) {
    const anchors: Array<[number, number]> = [];
    for (const [chStr, bookPage] of Object.entries(mapping)) {
      const ch = Number(chStr);
      const pdfPage = firstSeen.get(`${book}::${ch}`);
      if (pdfPage != null) anchors.push([pdfPage, bookPage]);
    }
    anchors.sort((a, b) => a[0] - b[0]);
    anchorsByBook[book] = anchors;
  }

  const estimate = (book: string | null | undefined, pdfPage: number) => {
    if (!book) return null;
    const anchors = anchorsByBook[book] ?? [];
    if (anchors.length < 2) return null;

    const xs = anchors.map((a) => a[0]);
    const ys = anchors.map((a) => a[1]);

    let x0: number, y0: number, x1: number, y1: number;
    if (pdfPage <= xs[0]!) {
      [x0, y0] = anchors[0]!;
      [x1, y1] = anchors[1]!;
    } else if (pdfPage >= xs[xs.length - 1]!) {
      [x0, y0] = anchors[anchors.length - 2]!;
      [x1, y1] = anchors[anchors.length - 1]!;
    } else {
      let i = 0;
      for (let j = 0; j < xs.length; j++) if (xs[j]! <= pdfPage) i = j;
      [x0, y0] = anchors[i]!;
      [x1, y1] = anchors[i + 1]!;
    }

    if (x1 === x0) return Math.round(y0);
    const y = y0 + ((pdfPage - x0) * (y1 - y0)) / (x1 - x0);
    return Math.round(y);
  };

  return { anchorsByBook, estimate, normalizeSpace };
}

export function repoPath(...segments: string[]) {
  return path.join(process.cwd(), ...segments);
}

export { normalizeSpace };

