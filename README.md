## To2cSearch (page-aware quote → page number)

This turns your `book.txt` (with `=== Page N ===` markers) into a lookup tool:

- **First**: exact / fuzzy quote match against the local pages
- **Fallback**: semantic search via embeddings in **Pinecone**
- **Output**: best matching **PDF page number**, plus an optional estimated **book page** using chapter anchors

### Setup

- **Install**

```bash
python -m pip install -r requirements.txt
```

- **Configure env**
  - Copy `env.example` values into your environment (PowerShell example):

```powershell
setx PINECONE_API_KEY "..."
setx PINECONE_INDEX "to2csearch-tale"
setx PINECONE_CLOUD "aws"
setx PINECONE_REGION "us-east-1"
setx PINECONE_NAMESPACE "tale-of-two-cities"
setx OPENAI_API_KEY "..."   # only if using --embedding-provider openai
setx OPENAI_EMBED_MODEL "text-embedding-3-small"
```

### Chapter → book page mapping (optional)

If you want to estimate “real book pages” from PDF pages, create a JSON file like `chapter_book_pages.example.json`:

- Keys are the **book header** as it appears in text (`Book the First`, `Book the Second`, ...)
- Values map **chapter number → book page number**

The tool will:
- detect where those chapters start in the PDF pages
- build anchor points
- do **piecewise linear interpolation** to estimate book pages for any result

### Ingest into Pinecone (semantic search)

```bash
python to2csearch.py ingest --book-txt book.txt --chapter-book-pages chapter_book_pages.example.json
```

### Query a quote

```bash
python to2csearch.py query --book-txt book.txt --quote "it was the best of times, it was the worst of times"
```

If fuzzy match is weak, it automatically falls back to Pinecone semantic search (if configured).

## Vercel Web App (Next.js + TypeScript)

This repo also contains a deployable web UI + API:

- **UI**: `src/app/page.tsx`
- **API**: `src/app/api/query/route.ts`

### Run locally

```bash
npm install
npm run dev
```

Then open the printed URL (usually `http://localhost:3000`).

### Ingest embeddings into Pinecone (Node)

This step is required for semantic search fallback. (Fuzzy-only still works without Pinecone.)

```bash
npm run ingest
```

Optional flags:

```bash
npm run ingest -- --namespace "tale-of-two-cities" --chunk-chars 1200 --overlap-chars 200 --batch-size 64
```

### Deploy to Vercel

- Push this repo to GitHub
- Create a new Vercel project from the repo
- Add these **Environment Variables** in Vercel:
  - `OPENAI_API_KEY`
  - `OPENAI_EMBED_MODEL` (recommended: `text-embedding-3-small`)
  - `PINECONE_API_KEY`
  - `PINECONE_INDEX`
  - `PINECONE_NAMESPACE` (optional; default `default`)
  - `PINECONE_CLOUD` and `PINECONE_REGION` (only needed if you want the ingest script to auto-create the index)
- Deploy

