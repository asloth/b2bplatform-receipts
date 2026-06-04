# System Design Document — B2B Invoice Processing Platform

> Version 1.0 · June 2026

---

## 1. Executive Summary

This document describes the architecture for a multi-tenant B2B invoice processing platform. The system ingests PDF invoices (supplier and customer), extracts and validates key fields using OCR and LLM-based information extraction, persists data in a relational store, exposes structured and conversational query APIs, and synchronises with external ERP systems (NetSuite / SAP).

**Design goals in priority order:**
1. Accuracy — ≥ 98% on totals/dates; ≥ 96% on taxes/currency; ≥ 95% on supplier ID
2. Reliability — SLOs met under peak load and 20% AI provider instability
3. Security — strict multi-tenant isolation, encryption, PII redaction, GDPR-compliant data residency
4. Cost efficiency — AI spend ≤ USD 18k/month at full scale

---

## 2. C4 Context Diagram

```mermaid
C4Context
    title System Context — B2B Invoice Platform

    Person(financeUser, "Finance / AP User", "Uploads invoices and queries data via Web or API")
    Person(reviewer, "Human Reviewer", "Validates low-confidence extractions")
    System(platform, "Invoice Platform", "Ingests, extracts, validates, stores, and queries invoices")
    System_Ext(erp, "ERP System (NetSuite / SAP)", "Source of truth for vendor masters, payment status, GL codes")
    System_Ext(bedrock, "AWS Bedrock (Claude)", "LLM inference for extraction and conversational Q&A")
    System_Ext(textract, "AWS Textract", "Managed OCR service")
    System_Ext(idp, "Identity Provider (Cognito)", "Tenant authentication and JWT issuance")

    Rel(financeUser, platform, "Uploads PDFs, searches invoices, asks questions", "HTTPS")
    Rel(reviewer, platform, "Reviews and approves flagged extractions", "HTTPS")
    Rel(platform, erp, "Reconciles invoices, retrieves payment status", "REST / SOAP / Webhooks")
    Rel(platform, bedrock, "Extraction prompts, conversational queries", "HTTPS")
    Rel(platform, textract, "PDF → raw text + layout", "HTTPS")
    Rel(financeUser, idp, "Authenticates", "OAuth 2.0 / OIDC")
```

---

## 3. C4 Container Diagram

```mermaid
C4Container
    title Container Diagram — B2B Invoice Platform

    Person(user, "Finance User / Reviewer")

    Boundary(edge, "Edge Layer") {
        Container(waf, "WAF + Shield", "AWS WAF", "Rate limiting, DDoS protection, geo-blocking")
        Container(apigw, "API Gateway", "AWS API Gateway", "REST API · JWT auth · throttling per tenant")
    }

    Boundary(compute, "Compute Layer") {
        Container(uploadFn, "Upload Lambda", "Python 3.12", "Validates upload, stores PDF to S3, enqueues job")
        Container(queryFn, "Query Lambda", "Python 3.12", "Structured search and conversational Q&A")
        Container(pipeline, "Processing Worker", "ECS Fargate", "Textract → Claude extraction → validation → persist")
        Container(erpWorker, "ERP Sync Worker", "Lambda", "Webhook sender and batch reconciliation")
    }

    Boundary(storage, "Data Layer") {
        ContainerDb(s3, "PDF Store", "S3", "Raw PDFs (per-tenant prefix) + redacted copies")
        ContainerDb(aurora, "Operational DB", "Aurora PostgreSQL Serverless v2", "Multi-tenant data · Row-Level Security")
        ContainerDb(opensearch, "Vector Store", "OpenSearch Serverless", "Invoice embeddings for RAG")
        ContainerDb(sqs, "Ingestion Queue", "SQS FIFO + DLQ", "Async processing jobs")
        ContainerDb(reviewQueue, "Review Queue", "SQS", "Human-in-the-loop tasks")
    }

    Boundary(integration, "Integration Layer") {
        Container(eventbridge, "Event Bus", "EventBridge", "Routes ERP events and scheduled batch jobs")
    }

    Rel(user, waf, "HTTPS")
    Rel(waf, apigw, "Filtered traffic")
    Rel(apigw, uploadFn, "POST /invoices/upload")
    Rel(apigw, queryFn, "GET /invoices/* · POST /assist/query")
    Rel(uploadFn, s3, "PutObject")
    Rel(uploadFn, sqs, "SendMessage")
    Rel(sqs, pipeline, "Triggers processing")
    Rel(pipeline, aurora, "INSERT invoice fields")
    Rel(pipeline, opensearch, "Index embeddings")
    Rel(pipeline, reviewQueue, "Enqueue low-confidence tasks")
    Rel(queryFn, aurora, "SELECT (RLS enforced)")
    Rel(queryFn, opensearch, "k-NN vector search")
    Rel(eventbridge, erpWorker, "ERP sync triggers")
    Rel(erpWorker, aurora, "Update sync status")
```

---

## 4. Sequence Flows

### 4.1 Invoice Upload and Extraction

```mermaid
sequenceDiagram
    actor User
    participant APIGW as API Gateway
    participant UploadFn as Upload Lambda
    participant S3
    participant SQS as Ingestion Queue
    participant Worker as Processing Worker (ECS)
    participant Textract as AWS Textract
    participant Bedrock as Bedrock (Claude Haiku)
    participant Aurora

    User->>APIGW: POST /invoices/upload (multipart PDF + metadata)
    APIGW->>UploadFn: Authenticated request (JWT)
    UploadFn->>S3: PutObject (tenant_id/raw/{invoice_id}.pdf)
    UploadFn->>SQS: SendMessage {invoice_id, tenant_id, s3_key}
    UploadFn-->>User: 202 Accepted {job_id}

    SQS->>Worker: ReceiveMessage
    Worker->>Textract: AnalyzeDocument (S3 URI)
    Textract-->>Worker: Blocks (text + layout + tables)
    Worker->>Bedrock: Extraction prompt + raw text
    Bedrock-->>Worker: Structured JSON {supplier, id, date, amounts, taxes, currency}
    Worker->>Worker: Validate fields (business rules + confidence scoring)
    alt confidence >= threshold
        Worker->>Aurora: INSERT invoice + fields (status=EXTRACTED)
        Worker->>Bedrock: Generate embeddings (Titan)
        Worker->>OpenSearch: Index invoice embedding
    else confidence < threshold
        Worker->>Aurora: INSERT invoice (status=PENDING_REVIEW)
        Worker->>ReviewQueue: Enqueue review task
    end
```

### 4.2 Human Review Flow

```mermaid
sequenceDiagram
    actor Reviewer
    participant APIGW as API Gateway
    participant QueryFn as Query Lambda
    participant Aurora
    participant SQS as Review Queue

    SQS->>Reviewer: Notification (email / Slack webhook)
    Reviewer->>APIGW: GET /invoices/{id}?include=raw_fields
    APIGW->>QueryFn: Authenticated request
    QueryFn->>Aurora: SELECT invoice + fields WHERE id = ?
    Aurora-->>QueryFn: Invoice record with low-confidence fields highlighted
    QueryFn-->>Reviewer: Invoice detail with confidence scores

    Reviewer->>APIGW: PATCH /invoices/{id}/fields (corrected values)
    QueryFn->>Aurora: UPDATE fields + status=VALIDATED + audit_log entry
    QueryFn->>OpenSearch: Re-index corrected embedding
    QueryFn-->>Reviewer: 200 OK
```

### 4.3 Conversational Query

```mermaid
sequenceDiagram
    actor User
    participant APIGW as API Gateway
    participant QueryFn as Query Lambda
    participant OpenSearch
    participant Aurora
    participant Bedrock as Bedrock (Claude Sonnet)

    User->>APIGW: POST /assist/query {"q": "Total VAT paid to Supplier X in Q1?"}
    APIGW->>QueryFn: Authenticated request
    QueryFn->>Bedrock: Intent classification + embedding of query
    Bedrock-->>QueryFn: {intent: structured_query, entities: {supplier, period, field: tax}}
    QueryFn->>Aurora: SELECT SUM(tax_amount) WHERE supplier_id = ? AND date BETWEEN ?
    Aurora-->>QueryFn: Result set
    QueryFn->>Bedrock: Compose natural language answer from SQL result
    Bedrock-->>QueryFn: "Supplier X was paid USD 42,380 in VAT during Q1 2026."
    QueryFn-->>User: {"answer": "...", "sources": [{invoice_id, amount}]}
```

### 4.4 ERP Reconciliation

```mermaid
sequenceDiagram
    participant EventBridge
    participant ERPWorker as ERP Sync Worker (Lambda)
    participant NetSuite as ERP (NetSuite / SAP)
    participant Aurora

    EventBridge->>ERPWorker: Scheduled trigger (every 15 min) OR invoice.validated event
    ERPWorker->>Aurora: SELECT invoices WHERE erp_sync_status = PENDING
    ERPWorker->>NetSuite: POST /invoices (REST / SuiteScript)
    NetSuite-->>ERPWorker: {erp_id, payment_status}
    ERPWorker->>Aurora: UPDATE erp_sync_status = SYNCED, erp_id, payment_status
    ERPWorker->>Aurora: INSERT audit_log {action: ERP_SYNC, result}

    Note over NetSuite, ERPWorker: Inbound webhook: payment posted
    NetSuite->>APIGW: POST /erp/webhook {erp_id, event: PAYMENT_POSTED}
    APIGW->>ERPWorker: Verify HMAC signature
    ERPWorker->>Aurora: UPDATE invoice payment_status = PAID
```

---

## 5. Data Model

### Core Tables (Aurora PostgreSQL)

```sql
-- Tenant registry
CREATE TABLE tenants (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        TEXT NOT NULL,
    region      TEXT NOT NULL,           -- e.g. 'eu-west-1' for data residency
    config      JSONB,                   -- tax schemes, currency defaults
    created_at  TIMESTAMPTZ DEFAULT NOW()
);

-- Invoice header
CREATE TABLE invoices (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    invoice_type    TEXT NOT NULL CHECK (invoice_type IN ('SUPPLIER', 'CUSTOMER')),
    status          TEXT NOT NULL DEFAULT 'PROCESSING',
    -- PROCESSING → PENDING_REVIEW → VALIDATED → ERP_SYNCED
    confidence_doc  NUMERIC(5,4),        -- overall document confidence score
    s3_key_raw      TEXT NOT NULL,
    s3_key_redacted TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Extracted fields (one row per field per invoice)
CREATE TABLE invoice_fields (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    invoice_id      UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    tenant_id       UUID NOT NULL,
    field_name      TEXT NOT NULL,       -- supplier_name, invoice_id, date, total_amount, tax_amount ...
    raw_value       TEXT,               -- as extracted (before normalisation)
    normalised_value TEXT,              -- after currency/date normalisation
    confidence      NUMERIC(5,4),
    source          TEXT,               -- 'textract', 'llm', 'human'
    reviewed_by     UUID,               -- user who corrected this field
    reviewed_at     TIMESTAMPTZ
);

-- Immutable audit trail
CREATE TABLE audit_logs (
    id          BIGSERIAL PRIMARY KEY,
    tenant_id   UUID NOT NULL,
    invoice_id  UUID,
    actor_id    UUID,
    action      TEXT NOT NULL,          -- UPLOAD, EXTRACT, REVIEW, ERP_SYNC, EXPORT ...
    before_state JSONB,
    after_state  JSONB,
    created_at  TIMESTAMPTZ DEFAULT NOW()
) PARTITION BY RANGE (created_at);     -- monthly partitions

-- ERP sync tracking
CREATE TABLE erp_sync_jobs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL,
    invoice_id      UUID NOT NULL REFERENCES invoices(id),
    erp_type        TEXT NOT NULL CHECK (erp_type IN ('NETSUITE', 'SAP')),
    status          TEXT NOT NULL DEFAULT 'PENDING',
    erp_id          TEXT,
    payment_status  TEXT,
    attempts        INT DEFAULT 0,
    last_attempt_at TIMESTAMPTZ,
    payload         JSONB
);

-- Human review task queue (persisted, not just SQS)
CREATE TABLE human_review_tasks (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   UUID NOT NULL,
    invoice_id  UUID NOT NULL REFERENCES invoices(id),
    assigned_to UUID,
    reason      TEXT,                   -- which fields triggered review
    sla_due_at  TIMESTAMPTZ,
    resolved_at TIMESTAMPTZ,
    status      TEXT DEFAULT 'OPEN'
);
```

**Row-Level Security (RLS):**
```sql
ALTER TABLE invoices ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoices
    USING (tenant_id = current_setting('app.current_tenant')::UUID);
-- Same policy applied to invoice_fields, audit_logs, erp_sync_jobs, human_review_tasks
```

**Indexes (critical for SLO compliance):**
```sql
CREATE INDEX idx_invoices_tenant_status   ON invoices(tenant_id, status);
CREATE INDEX idx_invoices_tenant_created  ON invoices(tenant_id, created_at DESC);
CREATE INDEX idx_fields_invoice           ON invoice_fields(invoice_id);
CREATE INDEX idx_audit_tenant_invoice     ON audit_logs(tenant_id, invoice_id, created_at DESC);
```

---

## 6. Key Decisions and Trade-offs

| Decision | Choice | Rationale | Trade-off |
|----------|--------|-----------|-----------|
| Ingestion pattern | Async (SQS + ECS) | Decouples upload from processing; absorbs 20 PDF/s bursts; 202 response keeps P95 < 8s | Status polling / webhook adds client complexity |
| OCR engine | AWS Textract | Managed, handles tables/forms natively; AnalyzeExpense purpose-built for invoices | Higher per-page cost than open-source (Tesseract); vendor lock-in |
| LLM routing | Claude Haiku (primary) → Sonnet (fallback/review) | Haiku: low latency + cost for extraction; Sonnet: accuracy on complex/flagged docs | Two model versions to maintain |
| Multi-tenant isolation | RLS + per-tenant S3 prefix | Row-Level Security at DB layer is the strongest isolation without schema-per-tenant cost | RLS must be set in every DB session; more complex connection pool setup |
| Vector store | OpenSearch Serverless | Native AWS, no cluster management, integrates with IAM; sufficient for 150k/month | Less mature than Pinecone/Weaviate for hybrid search; no serverless cold-start issue at this scale |
| ERP integration | EventBridge + Lambda webhooks + batch fallback | Resilient: if ERP is unavailable, batch job catches up; EventBridge decouples routing | Eventual consistency — invoice status may lag ERP by up to 15 min |
| Data residency | Per-region CDK stack + Route 53 latency routing | Supports EU, US, APAC without code changes | More operational overhead; cross-region reporting requires careful design |

---

## 7. Reliability and SLO Compliance

### SLO Summary

| SLO | Target | Mechanism |
|-----|--------|-----------|
| Ingestion (upload → queued) | P95 < 1s | Synchronous only up to S3 PUT + SQS send |
| Extraction pipeline | P95 < 8s total | ECS worker processes median doc in ~4s; 8s budget allows Textract (~1.5s) + Haiku (~1s) + DB write (~0.5s) + buffer |
| Structured query | P95 < 400ms | Aurora read replica + PgBouncer + composite indexes + ElastiCache (hot tenant caches) |
| Conversational query | P95 < 2.5s | Haiku streaming + pre-computed embeddings; Sonnet only on explicit complex queries |

### Bedrock Instability (20% rate limit/timeout budget)

- **Circuit breaker** (per tenant): trip after 3 consecutive Bedrock failures; fall back to cached extraction template + human review queue
- **Retry with exponential backoff + jitter**: max 3 retries within 6s window
- **Model fallback chain**: Claude Haiku → Claude Sonnet → flag for human review (no silent failures)
- **SQS message visibility timeout**: 30s; failed messages return to queue automatically → DLQ after 3 attempts
- **DLQ alarm**: CloudWatch alarm fires if DLQ depth > 50 messages → PagerDuty

### Backpressure

- SQS FIFO queue with `maxReceiveCount = 3` before DLQ
- ECS Fargate auto-scales on `ApproximateNumberOfMessagesVisible` metric (target: 100 messages/worker)
- API Gateway per-tenant throttle: 50 RPS upload, 200 RPS query — prevents single tenant starving others

---

## 8. Cost Estimates

### AI / Inference (primary budget concern)

| Component | Volume | Unit price | Monthly cost |
|-----------|--------|-----------|-------------|
| AWS Textract (AnalyzeExpense) | 150k PDFs × 3 pages avg | $0.015/page | $6,750 |
| Textract (tables/forms) | Same as above | Already included | — |
| Bedrock Claude Haiku (extraction) | 150k docs × 1.5k input tokens | $0.25/1M input tokens | $56 |
| Bedrock Claude Haiku (output) | 150k × 300 output tokens | $1.25/1M output tokens | $56 |
| Bedrock Claude Sonnet (complex, 10%) | 15k docs × 3k tokens | $3.00/1M input | $135 |
| Amazon Titan Embeddings | 150k docs × 500 tokens | $0.0001/1k tokens | $8 |
| Conversational queries (est. 200k/month) | 200k × 2k input + 500 output | Mixed Haiku/Sonnet | $350 |
| **Total AI spend** | | | **~$7,355/month** |

> **Headroom: 59% of $18k budget** — leaves room for query volume growth 2.4× before budget is hit.

### Infrastructure (representative AWS costs)

| Component | Estimated monthly |
|-----------|-----------------|
| ECS Fargate (processing workers, avg 4 tasks) | $350 |
| Aurora PostgreSQL Serverless v2 | $400 |
| S3 (150k PDFs × avg 500KB + lifecycle) | $180 |
| OpenSearch Serverless (1 OCU min) | $175 |
| API Gateway + Lambda | $120 |
| SQS, EventBridge, CloudWatch | $80 |
| **Infrastructure subtotal** | **~$1,305/month** |

**Total platform cost: ~$8,660/month** at full design-load scale.

---

## 9. Security and Compliance

### Encryption
- **At rest**: S3 SSE-KMS (per-tenant KMS key); Aurora storage encryption with AWS-managed CMK; OpenSearch encrypted at rest
- **In transit**: TLS 1.3 enforced on all endpoints; VPC-internal traffic via PrivateLink to Textract and Bedrock
- **Application-level**: Sensitive fields (bank account numbers, PII) encrypted with `pgcrypto` in Aurora before insert

### PII Redaction
- After Textract extraction, a pre-persist step identifies PII categories (names, account numbers, VAT IDs) using Amazon Comprehend
- Redacted PDF stored in `s3://.../redacted/{invoice_id}.pdf`; original retained in `s3://.../raw/...` with S3 Object Lock for compliance period
- Redaction metadata logged in `invoice_fields` with `field_name = 'pii_redacted'`

### Multi-tenant Isolation
- RLS on all Aurora tables (set via `SET LOCAL app.current_tenant = '{tenant_id}'` in every DB session)
- S3 bucket policy + IAM conditions enforce `s3:prefix` per tenant
- Cognito user pools per tenant; JWT `custom:tenant_id` claim verified at API Gateway authoriser
- No cross-tenant queries possible at the application layer; DB-level RLS as hard backstop

### Data Residency
- CDK stack parameterised by region (`EU_WEST_1`, `US_EAST_1`, `AP_SOUTHEAST_1`)
- Tenant onboarding sets `region` in `tenants` table; Route 53 latency-based routing directs traffic to the correct regional stack
- Aurora Global Database with write forwarding disabled in secondary regions (read-only replica for DR, no cross-region write)
- Bedrock model invocations stay within the tenant's region; no cross-region inference

### Compliance Controls
- S3 Object Lock (compliance mode, 7-year retention) for original PDFs
- `audit_logs` table is immutable (append-only; no DELETE/UPDATE policy via DB role)
- GDPR right-to-erasure: personal data fields encrypted with per-user key; erasure = key deletion
- SOC 2 / ISO 27001 alignment through AWS Config rules + Security Hub standards

---

## 10. Observability Strategy

### Metrics (CloudWatch)
| Metric | Source | Alert threshold |
|--------|--------|----------------|
| `IngestP95Latency` | Custom metric from ECS worker | > 7s |
| `ExtractionConfidenceAvg` | Custom metric | < 0.90 for any tenant |
| `SQSDepth` | SQS ApproximateNumberOfMessages | > 5,000 |
| `DLQDepth` | SQS DLQ | > 50 |
| `BedrockErrorRate` | Custom metric | > 15% over 5 min |
| `QueryP95Latency` | API Gateway / X-Ray | > 350ms |
| `HumanReviewSLABreach` | Custom metric | Any task overdue > SLA |
| `MonthlyAICost` | Cost Explorer API | > $15,000 |

### Tracing
- AWS X-Ray end-to-end traces from API Gateway through Lambda → ECS → Textract → Bedrock → Aurora
- Custom trace segments for extraction pipeline steps (OCR, LLM call, validation, persist)
- OpenTelemetry SDK in ECS workers exports spans to X-Ray via ADOT collector

### Logging
- Structured JSON logs (correlation_id, tenant_id, invoice_id, step, duration_ms) → CloudWatch Logs
- Log groups per service with 90-day retention; archive to S3 Glacier after 90 days
- CloudWatch Logs Insights queries for per-tenant accuracy reports and error analysis

### Dashboards
- **Operational**: queue depth, worker throughput, error rates, P95 latencies
- **Accuracy**: rolling 24h extraction accuracy per field type per tenant
- **Cost**: daily AI spend vs monthly budget burn rate
- **ERP**: sync lag, webhook delivery rate, payment status reconciliation backlog
