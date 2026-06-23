# AI / Information Extraction & Evaluation Plan
# B2B Invoice Processing Platform

> Version 1.0 · June 2026

---

## 1. Extraction Pipeline

### 1.1 Document Classification — pre-OCR gate

Before any OCR spend, the rendered first page is classified by a vision model (Claude Haiku) to confirm the document is actually an invoice. This is a deliberately cheap filter placed *ahead* of the expensive Textract call.

- `is_invoice` confidence ≥ 0.70 → continue to OCR (§1.2)
- `is_invoice` confidence < 0.70 → **REJECTED** (`rejection_reason = NOT_AN_INVOICE`); the PDF is moved to a `quarantine/` S3 prefix with a 30-day lifecycle — recoverable if the classifier was wrong, then auto-expired — and is never OCR'd or persisted as an invoice

**Rationale:** Textract costs ~$0.015/page, so non-invoices (scans of unrelated documents, blank or corrupt pages, accidental or abusive uploads) are filtered before incurring OCR or extraction cost — cheapest filter first. A soft-delete to quarantine (rather than a hard delete) keeps a misclassified real invoice recoverable while still satisfying data-minimisation.

### 1.2 OCR Stage — AWS Textract

Textract `AnalyzeExpense` is the primary OCR entry point. It is purpose-built for financial documents and returns both line-item tables and summary fields with bounding-box coordinates.

```
S3 PDF → Textract.AnalyzeExpense()
       → ExpenseSummaryFields  (VENDOR, INVOICE_DATE, TOTAL, TAX ...)
       → LineItemGroups        (per-line items with amounts, descriptions)
       → Blocks                (raw text blocks with coordinates for LLM context)
```

**Post-OCR normalisation:** Textract output is lightly cleaned (remove headers/footers, page numbers, watermarks) before being passed to the LLM. Tables are serialised as Markdown for prompt readability.

### 1.3 LLM Extraction Stage — Claude Haiku (primary)

A structured extraction prompt instructs Claude Haiku to produce a validated JSON object. The prompt uses:
- **System message**: role assignment + output JSON schema definition + tax-scheme reference table (multi-country VAT, GST, IVA, etc.)
- **User message**: Textract raw output (text + serialised tables, ~1,200 tokens average)
- **JSON mode / tool use**: Bedrock tool-use call with strict schema forces structured output, eliminating free-text hallucination

**Target extraction schema:**
```json
{
  "supplier_name":    "string",
  "supplier_id":      "string (VAT/NIF/EIN format-validated)",
  "invoice_number":   "string",
  "invoice_date":     "YYYY-MM-DD",
  "due_date":         "YYYY-MM-DD | null",
  "currency":         "ISO 4217 code",
  "subtotal":         "decimal string",
  "tax_rate":         "decimal (0-1) | null",
  "tax_amount":       "decimal string",
  "total_amount":     "decimal string",
  "payment_terms":    "string | null",
  "line_items": [
    { "description": "string", "quantity": "decimal", "unit_price": "decimal", "amount": "decimal" }
  ],
  "per_field_confidence": { "field_name": 0.00 }
}
```

**Math invariant check (hard rule):** `subtotal + tax_amount = total_amount` (tolerance ±0.02 for rounding). Mismatches immediately reduce document confidence and flag for review.

**Claude Sonnet fallback:** Triggered when Haiku confidence < 0.85 for any critical field (totals, dates, supplier_id). Sonnet receives the same prompt plus the Haiku output annotated with low-confidence markers; it returns a corrected extraction. Estimated 10% of documents use Sonnet.

---

## 2. Confidence Scoring

### 2.1 Per-Field Confidence

Each field receives a confidence score `[0, 1]` from two sources averaged with weights:
- **Textract native confidence** (0.4 weight) — bounding box OCR certainty
- **LLM self-assessed confidence** (0.6 weight) — elicited via the extraction prompt asking the model to score each field

### 2.2 Document-Level Confidence

```
doc_confidence = weighted_avg(field_confidences, weights)
```

Field weights by business criticality:

| Field | Weight |
|-------|--------|
| `total_amount` | 0.25 |
| `invoice_date` | 0.15 |
| `tax_amount` | 0.20 |
| `supplier_id` | 0.15 |
| `invoice_number` | 0.10 |
| `currency` | 0.10 |
| `subtotal` | 0.05 |

### 2.3 Confidence Thresholds and Routing

| Document confidence | Action |
|--------------------|--------|
| ≥ 0.95 | Auto-accept → persist → ERP sync |
| 0.85 – 0.94 | Accept with warning flag; reviewer notified asynchronously (SLA: 24h) |
| < 0.85 | Block → PENDING_REVIEW; Sonnet re-extraction attempted first |
| < 0.85 after Sonnet | Hard human review required; SLA: 4h for critical invoices |

> Two terminal `REJECTED` outcomes sit **outside** this confidence ladder: `NOT_AN_INVOICE` (pre-OCR classification, §1.1) and `DUPLICATE` (natural-key match, §3). Both move the PDF to quarantine rather than persisting an invoice, so they never reach this routing table.

---

## 3. Validation Rules (Hard Business Rules)

Beyond confidence, the following deterministic rules are applied regardless of LLM output:

| Rule | Check | Action on failure |
|------|-------|-----------------|
| Math balance | `subtotal + tax ≈ total` (±0.02) | Flag discrepancy, human review |
| Invoice date range | `invoice_date` not in future; not more than 2 years ago | Flag + alert |
| Currency vs. tax scheme | `tax_rate` must be valid for the invoice's country — e.g. ES {0.21, 0.10, 0.04}, FR {0.20, 0.10, 0.055, 0.021}, DE {0.19, 0.07} | Flag for country-specific review |
| Supplier ID format | Validated against regex per country (NIF, EIN, ABN, GSTIN…) | Low confidence penalty |
| Duplicate detection | Natural key `Hash(supplier_id + invoice_number + total_amount)` checked against tenant's existing invoices | `REJECTED` (`rejection_reason = DUPLICATE`); PDF moved to quarantine |
| Required fields | `supplier_name`, `invoice_number`, `invoice_date`, `total_amount` must be non-null | PENDING_REVIEW |

---

## 4. Conversational Layer (RAG + SQL Generation)

### 4.1 Architecture

```
User query
  → Intent classification (Claude Haiku, ~300ms)
       ├─ aggregation → SQL generation → Aurora
       ├─ lookup      → Aurora SELECT + return fields
       └─ semantic    → RAG (OpenSearch k-NN + metadata filter) → Claude Sonnet synthesis
```

> These three intents are returned to the client as the `query_type` field in `/assist/query` (API Spec §5).

### 4.2 RAG Index

- **Embedding model**: Amazon Titan Text Embeddings V2 (1,024 dimensions)
- **Indexed content**: concatenated extracted fields + summary sentence per invoice
- **Metadata filters**: `tenant_id`, `invoice_type`, `currency`, `date_range`, `supplier_id` — applied pre-k-NN to avoid cross-tenant leakage
- **Retrieval**: top-5 invoices by cosine similarity; results reranked by date relevance

### 4.3 SQL Generation Guardrails

- Claude generates parameterised SQL (`$1`, `$2` placeholders) — never string-interpolated
- Allowed tables whitelist: `invoices`, `invoice_fields` only
- `EXPLAIN` cost check: queries estimated > 10,000 rows require explicit `LIMIT`
- DML blocked: only `SELECT` permitted at the query-layer DB role

---

## 5. Quality Metrics and Evaluation Harness

### 5.1 Accuracy Targets vs. Measurement Method

| Field | Target | Metric | Measurement |
|-------|--------|--------|-------------|
| `total_amount` | ≥ 98% | Exact match (±0.01) | Weekly sample of 500 validated invoices vs. human gold |
| `invoice_date` | ≥ 98% | Exact match | Same sample |
| `tax_amount` | ≥ 96% | Exact match (±0.01) | Same sample |
| `currency` | ≥ 96% | Exact match | Same sample |
| `supplier_id` | ≥ 95% | Exact match | Same sample |
| Duplicate recall | ≥ 99.5% | Recall on seeded duplicates | Monthly injection test |
| Math invariant pass rate | ≥ 99.8% | Rule check | Every invoice |

### 5.2 Golden Dataset

- 2,000 manually annotated invoices covering: 12 countries, 8 languages, 4 tax schemes, scanned vs. native PDF, low/high complexity
- 200 adversarial samples: stamps over fields, rotated pages, multi-invoice PDFs, handwritten amendments
- Golden set refreshed quarterly with new real-world samples (anonymised with tenant consent)

### 5.3 Regression Test Suite

Run on every model update or prompt change in CI:
1. **Field accuracy** — batch extraction on golden set → compare vs. ground truth → fail if any target missed
2. **Math invariant** — assert 100% pass on golden set
3. **Latency** — P95 extraction < 6s on 100-document batch
4. **Hallucination probe** — 20 adversarial prompts designed to elicit made-up values; fail if any non-null response on intentionally blank fields
5. **Cross-tenant isolation** — verify RAG k-NN with different `tenant_id` metadata filter returns no overlap

### 5.4 Human-in-the-Loop Feedback Loop

Reviewer corrections are captured as ground-truth labels. Monthly:
1. Aggregate corrected fields by type and frequency
2. Identify systematic error patterns (e.g., Haiku consistently misreads a specific tax format)
3. Update extraction prompt or add few-shot examples
4. Run regression suite before promoting updated prompt to production
5. Track correction rate over time as proxy for model drift
