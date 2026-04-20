"use client";

import { useMemo, useState } from "react";

type QueryResponse =
  | {
      ok: true;
      mode: "fuzzy" | "semantic";
      pdf_page: number;
      estimated_book_page?: number | null;
      book?: string | null;
      chapter?: number | null;
      chapter_title?: string | null;
      score: number;
      context?: { before: string; match: string; after: string } | null;
    }
  | { ok: false; error: string };

const BOOKS = {
  tale: {
    label: "A Tale of Two Cities",
    placeholder: "It was the best of times, it was the worst of times",
    subtitle: "Paste a quote to get its page in the Dover Edition.",
  },
  butterflies: {
    label: "In the Time of the Butterflies",
    placeholder: "She is plucking her bird of paradise of its dead branches",
    subtitle: "Paste a quote to get its page number.",
  },
} as const;

type BookKey = keyof typeof BOOKS;

export default function HomePage() {
  const [selectedBook, setSelectedBook] = useState<BookKey>("tale");
  const [quote, setQuote] = useState(BOOKS.tale.placeholder);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<QueryResponse | null>(null);

  const canSearch = useMemo(() => quote.trim().length > 0, [quote]);

  function selectBook(key: BookKey) {
    setSelectedBook(key);
    setQuote(BOOKS[key].placeholder);
    setResult(null);
  }

  async function onSearch() {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quote, fuzzyThreshold: 70, book: selectedBook }),
      });
      const raw = await res.text();
      try {
        setResult(JSON.parse(raw) as QueryResponse);
      } catch {
        setResult({ ok: false, error: `API returned non-JSON (${res.status}).\n${raw || "(empty)"}` });
      }
    } catch (e) {
      setResult({ ok: false, error: String(e) });
    } finally {
      setLoading(false);
    }
  }

  const book = BOOKS[selectedBook];

  return (
    <div className="container">
      <div className="header">
        <h1 className="title">BookSearch</h1>
        <p className="subtitle">{book.subtitle}</p>

        <div style={{ display: "flex", gap: 10, marginTop: 16, justifyContent: "center" }}>
          {(Object.keys(BOOKS) as BookKey[]).map((key) => (
            <button
              key={key}
              className="button"
              onClick={() => selectBook(key)}
              style={{
                opacity: selectedBook === key ? 1 : 0.45,
                fontWeight: selectedBook === key ? 700 : 400,
              }}
            >
              {BOOKS[key].label}
            </button>
          ))}
        </div>
      </div>

      <div className="row">
        <div className="card">
          <div style={{ marginBottom: 10, color: "var(--muted)" }}>
            Enter a quote to get page number, wording should be fairly exact. Margin of error is +/- 1 page.{selectedBook === "butterflies" ? " (Especially for butterflies cuz algo doesn't rly work that well on it)" : ""}
          </div>
          <textarea
            className="textarea"
            value={quote}
            onChange={(e) => setQuote(e.target.value)}
            placeholder="Paste a quote..."
          />
          <div className="controls" style={{ marginTop: 12 }}>
            <button className="button" onClick={onSearch} disabled={!canSearch || loading}>
              {loading ? "Searching…" : "Find page"}
            </button>
          </div>
        </div>

        <div className="card">
          <div style={{ marginBottom: 10, color: "var(--muted)" }}>Result</div>

          {!result ? (
            <div className="pre" style={{ minHeight: 160, color: "var(--muted)" }}>
              Run a search to see the best matching page.
            </div>
          ) : !result.ok ? (
            <div className="pre" style={{ borderColor: "rgba(255,80,80,0.35)" }}>
              {result.error}
            </div>
          ) : (
            <>
              <div className="grid">
                <div className="stat">
                  <div className="statLabel">Printed page (estimated)</div>
                  <div className="statValue">{result.estimated_book_page ?? "—"}</div>
                </div>
                <div className="stat">
                  <div className="statLabel">Accuracy Score</div>
                  <div className="statValue">{result.score.toFixed(2)}</div>
                </div>
              </div>

              <div style={{ marginTop: 12, color: "var(--muted)" }}>
                {result.book ? (
                  <>
                    {result.book}
                    {typeof result.chapter === "number"
                      ? ` · Chapter ${result.chapter}${result.chapter_title ? ` (${result.chapter_title})` : ""}`
                      : ""}
                  </>
                ) : "—"}
              </div>

              {result.context ? (
                <div className="pre" style={{ marginTop: 12 }}>
                  {result.context.before}
                  <span style={{ fontWeight: 800, color: "white" }}>{result.context.match}</span>
                  {result.context.after}
                </div>
              ) : null}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
