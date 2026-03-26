# Knowledge Ingestion

Feed documents to Chvor and it extracts facts into its memory system. Upload PDFs, Word docs, images, text files, or paste a URL. The AI can then recall this information during conversations.

---

## Quick Start

Ask the AI:

> "Ingest this URL: https://docs.example.com/api-reference"

Or use the Knowledge panel in the sidebar to upload files.

---

## Supported Formats

| Format | Extensions | Notes |
|--------|-----------|-------|
| PDF | .pdf | Text extraction (not scanned images) |
| Word | .docx | Full text + formatting |
| Text | .txt | Plain text |
| Markdown | .md | Parsed as-is |
| Images | .png, .jpeg, .webp | Analyzed via vision LLM |
| URLs | — | Page content scraped and ingested |

---

## How It Works

```
Upload file or URL
       |
  Validate (magic bytes, size, format)
       |
  Extract text (PDF parser, DOCX parser, vision LLM for images)
       |
  Chunk (3000 chars with 500-char overlap)
       |
  LLM fact extraction (per chunk)
       |
  Deduplicate against existing memories
       |
  Store as memory nodes (linked to source resource)
       |
  Filter sensitive data (API keys, passwords, tokens)
```

### Extraction Details

- **Chunk size**: 3000 characters with 500-character overlap
- **Max chunks**: 50 per resource
- **Concurrent extractions**: Max 3 simultaneous LLM calls
- **Sensitivity filter**: Automatically redacts API keys, tokens, passwords, and PII

### Fact Categories

Extracted facts are classified into:

| Category | Example |
|----------|---------|
| `profile` | "The API requires OAuth 2.0 authentication" |
| `preference` | "The style guide prefers camelCase" |
| `entity` | "The project uses PostgreSQL 15 on AWS RDS" |
| `event` | "v2.0 was released on March 15, 2026" |
| `pattern` | "All endpoints return JSON with a data wrapper" |
| `case` | "Rate limiting returns 429 with a Retry-After header" |

---

## Using the Knowledge Panel

1. Click **Knowledge** in the sidebar
2. Click **Upload** to add a file, or **Add URL** to ingest a webpage
3. Watch the status: pending -> processing -> complete
4. Click a resource to see extracted memories
5. Click **Reprocess** to re-extract after changes

---

## AI Tools

| Tool | Description |
|------|-------------|
| `native__ingest_url` | Ingest a web page by URL |
| `native__ingest_document` | Upload a file for ingestion |

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/knowledge` | List all resources with status |
| `POST` | `/api/knowledge/upload` | Upload file (multipart/form-data) |
| `POST` | `/api/knowledge/url` | Ingest URL `{url, title?}` |
| `GET` | `/api/knowledge/:id` | Resource metadata |
| `GET` | `/api/knowledge/:id/memories` | Extracted memories for resource |
| `DELETE` | `/api/knowledge/:id` | Remove resource and unlink memories |
| `POST` | `/api/knowledge/:id/reprocess` | Re-extract facts |

---

## Security

- Magic byte validation prevents disguised file uploads
- SSRF protection blocks URLs pointing to private/internal networks
- Sensitive data (API keys, tokens, passwords) is filtered before storage
- File size limits enforced at upload
