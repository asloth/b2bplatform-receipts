# API Specifications — B2B Invoice Processing Platform

> Version 1.0 · June 2026 · Base URL: `https://api.invoices.{tenant}.example.com/v1`

**Conventions**
- All endpoints require `Authorization: Bearer {JWT}` (Cognito-issued, tenant-scoped) — **except** the inbound ERP webhook (§6a), which is authenticated by HMAC signature, not JWT.
- All responses include `X-Request-Id` and `X-Tenant-Id` headers.
- `POST /invoices/upload` accepts an optional `Idempotency-Key` header; replaying the same key returns the original `job_id` instead of creating a duplicate (safe client retries under provider instability).
- Monetary values are always strings (e.g. `"12705.00"`) to avoid floating-point drift. Identifiers are prefixed ULIDs (`inv_`, `job_`, `ten_`, `usr_`, `esj_`).
- `429` responses include a `Retry-After` header (seconds).

---

## 1. POST /invoices/upload

Upload a PDF invoice for async processing.

**Request** — `multipart/form-data`

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file` | file (PDF) | Yes | Invoice PDF, max 25MB |
| `invoice_type` | string | Yes | `SUPPLIER` or `CUSTOMER` |
| `project_code` | string | No | Client project reference |
| `tags` | string | No | Comma-separated labels |

```http
POST /v1/invoices/upload
Content-Type: multipart/form-data; boundary=----boundary
Authorization: Bearer eyJhbGciOiJSUzI1NiJ9...

------boundary
Content-Disposition: form-data; name="file"; filename="invoice-001.pdf"
Content-Type: application/pdf

<binary PDF data>
------boundary
Content-Disposition: form-data; name="invoice_type"

SUPPLIER
------boundary
Content-Disposition: form-data; name="project_code"

PRJ-2026-042
------boundary--
```

**Response — 202 Accepted**
```json
{
  "job_id": "job_01HXYZ3K8MPQRS789ABCDEF",
  "invoice_id": "inv_01HXYZ3K8MPQRS789ABCDEF",
  "status": "PROCESSING",
  "estimated_completion_seconds": 6,
  "status_url": "/v1/invoices/inv_01HXYZ3K8MPQRS789ABCDEF"
}
```

> Poll `status_url` (P95 ~6s to a terminal state) or register a webhook at `/v1/webhooks` to receive `INVOICE_READY` / `INVOICE_NEEDS_REVIEW` / `INVOICE_REJECTED` events.

**Error responses**

| Status | Code | Condition |
|--------|------|-----------|
| 400 | `INVALID_FILE_TYPE` | Non-PDF uploaded |
| 400 | `FILE_TOO_LARGE` | > 25MB |
| 400 | `MISSING_INVOICE_TYPE` | `invoice_type` absent |
| 429 | `RATE_LIMIT_EXCEEDED` | Tenant upload throttle hit |
| 413 | `PAYLOAD_TOO_LARGE` | Multipart body > 30MB |

---

## 2. GET /invoices/{id}

Retrieve a fully-extracted invoice with per-field confidence scores.

```http
GET /v1/invoices/inv_01HXYZ3K8MPQRS789ABCDEF
Authorization: Bearer eyJhbGciOiJSUzI1NiJ9...
```

> Add `?include=raw_fields` to also return each field's raw (pre-normalisation) value and Textract bounding box — used by the reviewer UI.

**Response — 200 OK**
```json
{
  "id": "inv_01HXYZ3K8MPQRS789ABCDEF",
  "tenant_id": "ten_01HABC",
  "invoice_type": "SUPPLIER",
  "status": "VALIDATED",
  "confidence_doc": 0.974,
  "project_code": "PRJ-2026-042",
  "created_at": "2026-06-03T09:15:00Z",
  "updated_at": "2026-06-03T09:15:07Z",
  "fields": {
    "supplier_name":   { "value": "Acme Supplies S.A.",   "confidence": 0.991, "source": "llm" },
    "supplier_id":     { "value": "ES-B12345678",          "confidence": 0.963, "source": "llm" },
    "invoice_number":  { "value": "ACM-2026-00441",        "confidence": 0.997, "source": "textract" },
    "invoice_date":    { "value": "2026-05-28",            "confidence": 0.998, "source": "textract" },
    "due_date":        { "value": "2026-06-27",            "confidence": 0.995, "source": "llm" },
    "currency":        { "value": "EUR",                   "confidence": 0.999, "source": "llm" },
    "subtotal":        { "value": "10500.00",              "confidence": 0.998, "source": "textract" },
    "tax_rate":        { "value": "0.21",                  "confidence": 0.987, "source": "llm" },
    "tax_amount":      { "value": "2205.00",               "confidence": 0.985, "source": "llm" },
    "total_amount":    { "value": "12705.00",              "confidence": 0.998, "source": "textract" },
    "payment_terms":   { "value": "NET30",                 "confidence": 0.944, "source": "llm" },
    "bank_iban":       { "value": "[REDACTED]",            "confidence": null,  "source": "pii_redacted" }
  },
  "documents": {
    "original_url":  "/v1/invoices/inv_01HXYZ3K8MPQRS789ABCDEF/download?type=raw",
    "redacted_url":  "/v1/invoices/inv_01HXYZ3K8MPQRS789ABCDEF/download?type=redacted"
  },
  "erp_sync": {
    "status": "SYNCED",
    "erp_id": "NS-VB-20260603-441",
    "payment_status": "UNPAID",
    "synced_at": "2026-06-03T09:20:00Z"
  }
}
```

**`status` enum (extraction lifecycle):** `PROCESSING` → then `REJECTED` (terminal — not an invoice or duplicate), `EXTRACTED` (auto, high confidence), or `PENDING_REVIEW` → `VALIDATED` (after human review); `FAILED` on pipeline error. When `status` is `REJECTED`, a `rejection_reason` ∈ `{NOT_AN_INVOICE, DUPLICATE}` is included and the source PDF is moved to a quarantine prefix (30-day lifecycle) rather than persisted as an invoice.

ERP synchronisation is a **separate dimension**, reported in the `erp_sync` object — `status` ∈ `{PENDING, SYNCED, FAILED}`, `payment_status` ∈ `{UNPAID, PARTIAL, PAID}` — never folded into the top-level `status`.

---

## 3. PATCH /invoices/{id}/fields

Submit human-review corrections for a `PENDING_REVIEW` invoice. Called by the internal reviewer UI; every correction is audit-logged and the invoice is re-indexed for RAG.

```http
PATCH /v1/invoices/inv_01HXYZ3K8MPQRS789ABCDEF/fields
Content-Type: application/json
Authorization: Bearer eyJhbGciOiJSUzI1NiJ9...

{
  "fields": {
    "supplier_id": { "value": "ES-B12345678" },
    "tax_amount":  { "value": "2205.00" }
  },
  "resolution": "APPROVED"
}
```

**Response — 200 OK**
```json
{
  "id": "inv_01HXYZ3K8MPQRS789ABCDEF",
  "status": "VALIDATED",
  "corrected_fields": ["supplier_id", "tax_amount"],
  "reviewed_by": "usr_01HOPS",
  "reviewed_at": "2026-06-03T10:02:00Z"
}
```

Corrected fields are persisted with `source: "human"` and `confidence: 1.0`; the invoice transitions `PENDING_REVIEW → VALIDATED` and an `invoice.validated` event is emitted to EventBridge to trigger ERP sync.

| Status | Code | Condition |
|--------|------|-----------|
| 404 | `INVOICE_NOT_FOUND` | Unknown id for this tenant |
| 409 | `NOT_IN_REVIEW` | Invoice is not in `PENDING_REVIEW` |
| 422 | `VALIDATION_FAILED` | Corrected values fail business rules (e.g. `subtotal + tax_amount ≠ total_amount`) |

---

## 4. GET /invoices/search

Structured search with filtering, sorting, and pagination.

```http
GET /v1/invoices/search
  ?supplier_id=ES-B12345678
  &date_from=2026-01-01
  &date_to=2026-06-03
  &status=VALIDATED
  &invoice_type=SUPPLIER
  &currency=EUR
  &project_code=PRJ-2026-042
  &sort=invoice_date:desc
  &page=1
  &limit=25
Authorization: Bearer eyJhbGciOiJSUzI1NiJ9...
```

**Query parameters**

| Parameter | Type | Description |
|-----------|------|-------------|
| `supplier_id` | string | Exact match on extracted supplier VAT/ID |
| `supplier_name` | string | Full-text search (pg_trgm) |
| `date_from` / `date_to` | date | Invoice date range |
| `status` | string | Filter by processing status |
| `invoice_type` | string | `SUPPLIER` or `CUSTOMER` |
| `currency` | string | ISO 4217 code |
| `project_code` | string | Exact match |
| `amount_min` / `amount_max` | decimal | Filter by total_amount |
| `has_discrepancy` | boolean | Invoices flagged for ERP mismatch |
| `sort` | string | `field:asc|desc`. Allowed: `invoice_date`, `total_amount`, `created_at` |
| `page` / `limit` | int | Pagination; max limit = 100 |

**Response — 200 OK**
```json
{
  "total": 142,
  "pages": 6,
  "page": 1,
  "limit": 25,
  "items": [
    {
      "id": "inv_01HXYZ3K8MPQRS789ABCDEF",
      "invoice_number": "ACM-2026-00441",
      "invoice_date": "2026-05-28",
      "supplier_name": "Acme Supplies S.A.",
      "total_amount": "12705.00",
      "currency": "EUR",
      "status": "VALIDATED",
      "confidence_doc": 0.974
    }
  ]
}
```

---

## 5. POST /assist/query

Natural language conversational interface for invoice data.

```http
POST /v1/assist/query
Content-Type: application/json
Authorization: Bearer eyJhbGciOiJSUzI1NiJ9...

{
  "q": "What is the total VAT paid to Acme Supplies in Q1 2026?",
  "context": {
    "project_code": "PRJ-2026-042",
    "currency": "EUR"
  },
  "stream": false
}
```

**Request fields**

| Field | Type | Description |
|-------|------|-------------|
| `q` | string | Natural language question |
| `context` | object | Optional filters to scope the query |
| `stream` | boolean | If true, Server-Sent Events stream (default: false) |

**Response — 200 OK**
```json
{
  "request_id": "req_01HABC",
  "answer": "You paid a total of EUR 6,615.00 in VAT to Acme Supplies during Q1 2026, across 3 invoices.",
  "confidence": 0.97,
  "query_type": "aggregation",
  "sources": [
    { "invoice_id": "inv_01H...", "invoice_number": "ACM-2026-00111", "tax_amount": "2205.00", "date": "2026-01-15" },
    { "invoice_id": "inv_01H...", "invoice_number": "ACM-2026-00220", "tax_amount": "2205.00", "date": "2026-02-12" },
    { "invoice_id": "inv_01H...", "invoice_number": "ACM-2026-00330", "tax_amount": "2205.00", "date": "2026-03-20" }
  ],
  "sql_used": "SELECT SUM(f.normalised_value::numeric) FROM invoice_fields f JOIN invoices i ON f.invoice_id = i.id WHERE i.tenant_id = $1 AND f.field_name = 'tax_amount' AND i.invoice_date BETWEEN '2026-01-01' AND '2026-03-31' AND i.supplier_name ILIKE '%Acme Supplies%'"
}
```

> **`query_type`** is one of `aggregation` (SQL over Aurora), `semantic` (k-NN over OpenSearch), or `lookup` (single record). `sql_used` is returned for `aggregation`; `rag_chunks_used` (the matched invoice snippets) is returned for `semantic`. This mirrors the routing branch in System Design §4.3.

**Streaming response** (SSE when `stream: true`):
```
data: {"delta": "You paid a total"}
data: {"delta": " of EUR 6,615.00"}
data: {"delta": " in VAT..."}
data: {"done": true, "sources": [...]}
```

---

## 6. ERP Webhooks

### 6a. Inbound — ERP posts to platform

```http
POST /v1/erp/webhook
Content-Type: application/json
X-ERP-Signature: sha256=abc123...   (HMAC-SHA256 of body with shared secret)

{
  "erp_type": "NETSUITE",
  "event": "PAYMENT_POSTED",
  "erp_id": "NS-VB-20260603-441",
  "payment_date": "2026-06-03",
  "payment_amount": "12705.00",
  "currency": "EUR",
  "reference": "PAY-NS-8841"
}
```

**Response — 200 OK**
```json
{ "received": true, "invoice_id": "inv_01HXYZ3K8MPQRS789ABCDEF" }
```

**Signature verification failure → 401 Unauthorized**

### 6b. GET /erp/sync/{id} — sync job status

```http
GET /v1/erp/sync/esj_01HABC
Authorization: Bearer eyJhbGciOiJSUzI1NiJ9...
```

```json
{
  "id": "esj_01HABC",
  "invoice_id": "inv_01HXYZ3K8MPQRS789ABCDEF",
  "erp_type": "NETSUITE",
  "status": "SYNCED",
  "erp_id": "NS-VB-20260603-441",
  "payment_status": "PAID",
  "attempts": 1,
  "last_attempt_at": "2026-06-03T09:20:00Z"
}
```

---

## Common Error Envelope

All errors follow this structure:
```json
{
  "error": {
    "code": "INVOICE_NOT_FOUND",
    "message": "Invoice inv_01HXYZ not found for this tenant.",
    "request_id": "req_01HABC"
  }
}
```
