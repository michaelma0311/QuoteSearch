import fs from "node:fs";
import { OpenAI } from "openai";
import { Pinecone } from "@pinecone-database/pinecone";

import {
  buildPdfToBookPageEstimator,
  inferBookAndChapterByPage,
  inferPageChapterInfo,
  loadChapterBookPages,
  loadPagesFromBookTxt,
  normalizeSpace,
  repoPath
} from "../src/lib/book";

type Options = {
  namespace: string;
  chunkChars: number;
  overlapChars: number;
  batchSize: number;
  maxPages?: number;
};

function chunkText(text: string, chunkChars: number, overlapChars: number) {
  const t = normalizeSpace(text);
  if (!t) return [] as Array<{ text: string; start: number }>;
  if (chunkChars <= 0) return [{ text: t, start: 0 }];
  const overlap = Math.max(0, Math.min(overlapChars, chunkChars - 1));

  const chunks: Array<{ text: string; start: number }> = [];
  let start = 0;
  while (start < t.length) {
    const end = Math.min(t.length, start + chunkChars);
    const raw = t.slice(start, end);
    const trimmed = raw.trim();
    if (trimmed) {
      // Adjust start offset to account for left-trim (so offsets align with normalized text indices).
      const leftTrim = raw.length - raw.trimStart().length;
      chunks.push({ text: trimmed, start: start + leftTrim });
    }
    if (end === t.length) break;
    start = end - overlap;
  }
  return chunks;
}

function getEnv(name: string, optional = false) {
  const v = process.env[name];
  if (!v && !optional) throw new Error(`Missing env var: ${name}`);
  return v ?? "";
}

function parseArgs(): Options {
  const args = process.argv.slice(2);
  const get = (k: string) => {
    const idx = args.indexOf(k);
    return idx >= 0 ? args[idx + 1] : undefined;
  };
  return {
    namespace: get("--namespace") ?? (process.env.PINECONE_NAMESPACE ?? "default"),
    chunkChars: Number(get("--chunk-chars") ?? "1200"),
    overlapChars: Number(get("--overlap-chars") ?? "200"),
    batchSize: Number(get("--batch-size") ?? "64"),
    maxPages: get("--max-pages") ? Number(get("--max-pages")) : undefined
  };
}

async function main() {
  const opts = parseArgs();

  const bookTxt = repoPath("book.txt");
  const chapterJson = repoPath("chapter_book_pages.tale.json");
  if (!fs.existsSync(bookTxt)) throw new Error(`Missing file: ${bookTxt}`);
  if (!fs.existsSync(chapterJson)) throw new Error(`Missing file: ${chapterJson}`);

  const pages = loadPagesFromBookTxt(bookTxt);
  if (pages.length === 0) throw new Error("No pages found (expected === Page N === markers).");

  const perPageMeta = inferBookAndChapterByPage(pages);
  const pageInfo = inferPageChapterInfo(pages);
  const chapterBookPages = loadChapterBookPages(chapterJson);
  const { estimate } = buildPdfToBookPageEstimator({ pages, perPageMeta, chapterBookPages });

  const openai = new OpenAI({ apiKey: getEnv("OPENAI_API_KEY") });
  const embedModel = process.env.OPENAI_EMBED_MODEL ?? "text-embedding-3-small";

  // Determine embedding dimension (one cheap call).
  const probe = await openai.embeddings.create({ model: embedModel, input: "dimension probe" });
  const dim = probe.data[0]?.embedding?.length;
  if (!dim) throw new Error("Could not infer embedding dimension from OpenAI response.");

  const pinecone = new Pinecone({ apiKey: getEnv("PINECONE_API_KEY") });
  const indexName = getEnv("PINECONE_INDEX");

  // Best-effort create index if missing.
  try {
    const existing = await pinecone.listIndexes();
    const names = new Set((existing.indexes ?? []).map((i: any) => i.name));
    if (!names.has(indexName)) {
      const cloud = process.env.PINECONE_CLOUD ?? "aws";
      const region = process.env.PINECONE_REGION ?? "us-east-1";
      await pinecone.createIndex({
        name: indexName,
        dimension: dim,
        metric: "cosine",
        spec: { serverless: { cloud, region } } as any
      });
      console.log(`Created Pinecone index '${indexName}' (${dim}d cosine, ${cloud}/${region}).`);
    }
  } catch (e) {
    // If create/list fails due to permissions, user can create index in console.
    console.log(
      `Index check/create skipped or failed (this is ok if your index already exists): ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }

  const index = pinecone.index(indexName).namespace(opts.namespace);

  const work = (opts.maxPages ? pages.slice(0, opts.maxPages) : pages).filter((p) => p.text.trim().length > 0);
  console.log(`Preparing chunks from ${work.length} pages…`);

  const vectors: Array<{ id: string; text: string; metadata: any }> = [];
  for (const p of work) {
    const meta = perPageMeta[p.pdf_page] ?? { book: null, chapter: null };
    const info = pageInfo[p.pdf_page];
    const estBookPage = estimate(meta.book, p.pdf_page);
    const chunks = chunkText(p.text, opts.chunkChars, opts.overlapChars);
    for (let i = 0; i < chunks.length; i++) {
      const { text, start } = chunks[i]!;
      // Determine chapter for this chunk by comparing its start offset to chapter starts.
      let chunkChapter: number | null = info?.chapterTop ?? meta.chapter ?? null;
      if (info?.chapterStarts?.length) {
        for (const s of info.chapterStarts) {
          if (start >= s.offset) chunkChapter = s.chapter;
          else break;
        }
      }
      vectors.push({
        id: `pdf${p.pdf_page}_chunk${i}`,
        text,
        metadata: {
          pdf_page: p.pdf_page,
          chunk: i,
          book: meta.book,
          chapter: chunkChapter,
          chunk_start: start,
          est_book_page: estBookPage,
          preview: text.slice(0, 800)
        }
      });
    }
  }
  console.log(`Total chunks: ${vectors.length}`);

  const batchSize = Math.max(1, opts.batchSize);
  for (let start = 0; start < vectors.length; start += batchSize) {
    const batch = vectors.slice(start, start + batchSize);
    const inputs = batch.map((b) => b.text);
    const emb = await openai.embeddings.create({ model: embedModel, input: inputs });
    const values = emb.data.map((d) => d.embedding);

    const up = batch.map((b, i) => ({
      id: b.id,
      values: values[i]!,
      metadata: b.metadata
    }));

    await index.upsert(up as any);
    const end = Math.min(vectors.length, start + batchSize);
    process.stdout.write(`Upserted ${end}/${vectors.length}\r`);
  }
  process.stdout.write("\n");
  console.log(`Done. Upserted ${vectors.length} vectors to '${indexName}' namespace '${opts.namespace}'.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

