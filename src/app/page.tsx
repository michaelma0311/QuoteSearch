/* eslint-disable @next/next/no-html-link-for-pages */
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
      debug?: Record<string, unknown>;
    }
  | { ok: false; error: string };

export default function HomePage() {
  const [quote, setQuote] = useState(
    "it was the best of times, it was the worst of times"
  );
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<QueryResponse | null>(null);

  const canSearch = useMemo(() => quote.trim().length > 0, [quote]);

  async function onSearch() {
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch("/api/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ quote, fuzzyThreshold: 70 })
      });
      const raw = await res.text();
      try {
        const json = JSON.parse(raw) as QueryResponse;
        setResult(json);
      } catch {
        setResult({
          ok: false,
          error: `API returned non-JSON (${res.status}). Body:\n${raw || "(empty)"}`
        });
      }
    } catch (e) {
      setResult({ ok: false, error: String(e) });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="container">
      <div className="header">
        <h1 className="title">BookRAG</h1>
        <p className="subtitle">
          Paste a quote from <span className="mono">A Tale of Two Cities</span>{" "}
          and get the best-matching <b>PDF page</b> (and an optional estimated{" "}
          <b>printed book page</b>).
        </p>
      </div>

      <div className="row">
        <div className="card">
          <div style={{ marginBottom: 10, color: "var(--muted)" }}>
            Quote / excerpt
          </div>
          <textarea
            className="textarea"
            value={quote}
            onChange={(e) => setQuote(e.target.value)}
            placeholder="Paste a quote..."
          />
          <div className="controls" style={{ marginTop: 12 }}>
            <button
              className="button"
              onClick={onSearch}
              disabled={!canSearch || loading}
            >
              {loading ? "Searching…" : "Find page"}
            </button>
          </div>
        </div>

        <div className="card">
          <div style={{ marginBottom: 10, color: "var(--muted)" }}>
            Result
          </div>

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
                  <div className="statLabel">Mode</div>
                  <div className="statValue">{result.mode}</div>
                </div>
                <div className="stat">
                  <div className="statLabel">PDF page</div>
                  <div className="statValue">{result.pdf_page}</div>
                </div>
                <div className="stat">
                  <div className="statLabel">Printed page (estimated)</div>
                  <div className="statValue">
                    {result.estimated_book_page ?? "—"}
                  </div>
                </div>
                <div className="stat">
                  <div className="statLabel">Score</div>
                  <div className="statValue">{result.score.toFixed(2)}</div>
                </div>
              </div>

              <div style={{ marginTop: 12, color: "var(--muted)" }}>
                {result.book ? (
                  <>
                    {result.book}
                    {typeof result.chapter === "number"
                      ? ` · Chapter ${result.chapter}${
                          result.chapter_title ? ` (${result.chapter_title})` : ""
                        }`
                      : ""}
                  </>
                ) : (
                  "—"
                )}
              </div>

              {result.context ? (
                <div className="pre" style={{ marginTop: 12 }}>
                  {result.context.before}
                  <span style={{ fontWeight: 800, color: "white" }}>
                    {result.context.match}
                  </span>
                  {result.context.after}
                </div>
              ) : null}
            </>
          )}

          <div style={{ marginTop: 12, color: "var(--muted)", fontSize: 13 }}>
          </div>
        </div>
      </div>
    </div>
  );
}

