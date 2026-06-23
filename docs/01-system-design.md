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

    Person(clientUser, "Client / Tenant (external)", "EXTERNAL · client company — uploads invoice PDFs only (no search or chat access)")

    Enterprise_Boundary(b2bOrg, "B2B Platform Organisation (internal)") {
        Person(financeUser, "Internal Finance / AP User", "INTERNAL · uploads invoices, runs structured search, and asks the conversational assistant")
        Person(opsReviewer, "Internal Reviewer (Ops)", "INTERNAL · platform back-office — validates low-confidence extractions across tenants")
        System(platform, "Invoice Platform", "Ingests, extracts, validates, stores, and queries invoices")
    }

    System_Ext(erp, "ERP System (NetSuite / SAP)", "Source of truth for vendor masters, payment status, GL codes")
    System_Ext(bedrock, "AWS Bedrock (Claude)", "LLM inference for extraction and conversational Q&A")
    System_Ext(textract, "AWS Textract", "Managed OCR service")
    System_Ext(idp, "Identity Provider (Cognito)", "Tenant authentication and JWT issuance")

    Rel(clientUser, platform, "Uploads invoice PDFs", "HTTPS")
    Rel(financeUser, platform, "Uploads, searches, asks conversational questions", "HTTPS")
    Rel(opsReviewer, platform, "Reviews and approves flagged extractions", "HTTPS")
    Rel(platform, erp, "Reconciles invoices, retrieves payment status", "REST / SOAP / Webhooks")
    Rel(platform, bedrock, "Extraction prompts, conversational queries", "HTTPS")
    Rel(platform, textract, "PDF → raw text + layout", "HTTPS")
    Rel(clientUser, idp, "Authenticates", "OAuth 2.0 / OIDC")

    UpdateElementStyle(clientUser, $bgColor="#4f46e5", $fontColor="#ffffff", $borderColor="#3730a3")
    UpdateElementStyle(financeUser, $bgColor="#0891b2", $fontColor="#ffffff", $borderColor="#0e7490")
    UpdateElementStyle(opsReviewer, $bgColor="#0d9488", $fontColor="#ffffff", $borderColor="#0f766e")
    UpdateElementStyle(platform, $bgColor="#1168bd", $fontColor="#ffffff", $borderColor="#0b4884")
    UpdateElementStyle(erp, $bgColor="#6b7280", $fontColor="#ffffff", $borderColor="#4b5563")
    UpdateElementStyle(bedrock, $bgColor="#6b7280", $fontColor="#ffffff", $borderColor="#4b5563")
    UpdateElementStyle(textract, $bgColor="#6b7280", $fontColor="#ffffff", $borderColor="#4b5563")
    UpdateElementStyle(idp, $bgColor="#6b7280", $fontColor="#ffffff", $borderColor="#4b5563")
    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="1")
```

---

## 3. C4 Container Diagram

```mermaid
C4Container
    title Container Diagram — B2B Invoice Platform

    Person(extUser, "External Client", "Uploads invoice PDFs only")
    Person(intUser, "Internal User", "Finance (upload · search · chat) and Reviewer (validate flagged)")

    Boundary(api, "API Layer") {
        Container(apigw, "API Gateway", "AWS API Gateway", "Authenticates (JWT) and rate-limits per tenant")
    }

    Boundary(compute, "Compute Layer") {
        Container(uploadFn, "Upload Lambda", "Python", "Validates upload, stores PDF, enqueues job")
        Container(queryFn, "Query Lambda", "Python", "Structured search and conversational Q&A")
        Container(pipeline, "Processing Worker", "ECS Fargate", "Textract → Claude extraction → validation → persist")
        Container(erpWorker, "ERP Sync Worker", "Lambda", "Webhook sender and batch reconciliation")
    }

    Boundary(storage, "Data Layer") {
        ContainerDb(s3, "PDF Store", "S3", "Raw + redacted PDFs, per tenant")
        ContainerDb(aurora, "Operational DB", "Aurora PostgreSQL", "Invoice data, isolated per tenant")
        ContainerDb(opensearch, "Search Index", "OpenSearch", "Invoice embeddings for semantic search")
        ContainerDb(sqs, "Ingestion Queue", "SQS", "Async processing jobs")
        ContainerDb(reviewQueue, "Review Queue", "SQS", "Human-review tasks")
    }

    Boundary(integration, "Integration Layer") {
        Container(eventbridge, "Event Bus", "EventBridge", "Routes ERP events and scheduled jobs")
    }

    Rel(extUser, apigw, "Upload only", "HTTPS")
    Rel(intUser, apigw, "Upload, search, chat, review", "HTTPS")
    Rel(apigw, uploadFn, "POST /invoices/upload")
    Rel(apigw, queryFn, "search · /assist/query · review")
    Rel(uploadFn, s3, "Store PDF")
    Rel(uploadFn, sqs, "Enqueue job")
    Rel(sqs, pipeline, "Triggers processing")
    Rel(pipeline, aurora, "Write invoice fields")
    Rel(pipeline, opensearch, "Index embeddings")
    Rel(pipeline, reviewQueue, "Enqueue low-confidence tasks")
    Rel(queryFn, aurora, "Read (tenant-isolated)")
    Rel(queryFn, opensearch, "Semantic search")
    Rel(eventbridge, erpWorker, "ERP sync triggers")
    Rel(erpWorker, aurora, "Update sync status")

    UpdateElementStyle(extUser, $bgColor="#4f46e5", $fontColor="#ffffff", $borderColor="#3730a3")
    UpdateElementStyle(intUser, $bgColor="#0891b2", $fontColor="#ffffff", $borderColor="#0e7490")
    UpdateElementStyle(apigw, $bgColor="#b45309", $fontColor="#ffffff", $borderColor="#92400e")
    UpdateElementStyle(uploadFn, $bgColor="#1168bd", $fontColor="#ffffff", $borderColor="#0b4884")
    UpdateElementStyle(queryFn, $bgColor="#1168bd", $fontColor="#ffffff", $borderColor="#0b4884")
    UpdateElementStyle(pipeline, $bgColor="#1168bd", $fontColor="#ffffff", $borderColor="#0b4884")
    UpdateElementStyle(erpWorker, $bgColor="#1168bd", $fontColor="#ffffff", $borderColor="#0b4884")
    UpdateElementStyle(s3, $bgColor="#16a34a", $fontColor="#ffffff", $borderColor="#15803d")
    UpdateElementStyle(aurora, $bgColor="#16a34a", $fontColor="#ffffff", $borderColor="#15803d")
    UpdateElementStyle(opensearch, $bgColor="#16a34a", $fontColor="#ffffff", $borderColor="#15803d")
    UpdateElementStyle(sqs, $bgColor="#16a34a", $fontColor="#ffffff", $borderColor="#15803d")
    UpdateElementStyle(reviewQueue, $bgColor="#16a34a", $fontColor="#ffffff", $borderColor="#15803d")
    UpdateElementStyle(eventbridge, $bgColor="#0d9488", $fontColor="#ffffff", $borderColor="#0f766e")
    UpdateLayoutConfig($c4ShapeInRow="3", $c4BoundaryInRow="2")
```

> **Why stop at Container level (no C3/C4)?** The C4 *model* is applied to Container depth only. Each container is a single thin function, so a C3 (component) view would reveal nothing the §4 sequence flows don't already show, and C4 (code) is auto-generated rather than hand-maintained. The most likely future C3 candidate is the Processing Worker, if it grows into separate classifier / OCR / extractor / validator / scorer components.

---

## 4. Sequence Flows

### 4.1 Invoice Upload and Extraction

```mermaid
sequenceDiagram
    autonumber
    actor User
    box rgb(225,236,250) Edge & Compute
    participant APIGW as API Gateway
    participant UploadFn as Upload Lambda
    participant Worker as Processing Worker (ECS)
    end
    box rgb(238,238,238) AI Services
    participant Textract as AWS Textract
    participant Bedrock as Bedrock (Claude Haiku)
    end
    box rgb(223,246,231) Data Stores
    participant S3
    participant SQS as Ingestion Queue
    participant Aurora
    participant OpenSearch
    participant ReviewQueue as Review Queue
    end

    User->>APIGW: Upload invoice PDF + metadata
    APIGW->>UploadFn: Authenticated request (JWT)
    UploadFn->>S3: Store PDF (per-tenant path)
    UploadFn->>SQS: Enqueue job {invoice_id, tenant_id}
    UploadFn-->>User: 202 Accepted {job_id}

    SQS->>Worker: Pick up job
    Worker->>Bedrock: Classify rendered page — is this an invoice?
    Bedrock-->>Worker: {is_invoice, confidence}
    alt not an invoice (low classification confidence)
        Worker->>S3: Move PDF to quarantine/ (30-day lifecycle)
        Worker->>Aurora: status=REJECTED (rejection_reason=NOT_AN_INVOICE)
    else is an invoice
        Worker->>Textract: Extract text + tables from PDF
        Textract-->>Worker: Text + layout + tables
        Worker->>Bedrock: Extract fields from text
        Bedrock-->>Worker: Fields JSON {supplier, id, date, amounts, taxes, currency}
        Worker->>Worker: Validate fields + dedupe (natural key) + score confidence
        alt duplicate (natural-key match in tenant)
            Worker->>S3: Move PDF to quarantine/ (30-day lifecycle)
            Worker->>Aurora: status=REJECTED (rejection_reason=DUPLICATE)
        else confidence >= threshold
            Worker->>Aurora: Save invoice + fields (status=EXTRACTED)
            Worker->>Bedrock: Generate embeddings
            Worker->>OpenSearch: Add to search index
        else confidence < threshold
            Worker->>Aurora: Save invoice (status=PENDING_REVIEW)
            Worker->>ReviewQueue: Enqueue review task
        end
    end
```

### 4.2 Human Review Flow

```mermaid
sequenceDiagram
    autonumber
    actor Reviewer
    box rgb(225,236,250) Edge & Compute
    participant APIGW as API Gateway
    participant QueryFn as Query Lambda
    end
    box rgb(223,246,231) Data Stores
    participant Aurora
    participant OpenSearch
    participant SQS as Review Queue
    end

    SQS->>Reviewer: Notification (email / Slack)
    Reviewer->>APIGW: Open invoice for review (with raw fields)
    APIGW->>QueryFn: Authenticated request
    QueryFn->>Aurora: Read invoice + fields
    Aurora-->>QueryFn: Invoice with low-confidence fields highlighted
    QueryFn-->>Reviewer: Invoice detail with confidence scores

    Reviewer->>APIGW: Submit corrected values
    QueryFn->>Aurora: Save corrections, status=VALIDATED, write audit log
    QueryFn->>OpenSearch: Re-index corrected invoice
    QueryFn-->>Reviewer: 200 OK
```

### 4.3 Conversational Query

```mermaid
sequenceDiagram
    autonumber
    actor User as Internal Finance User
    box rgb(225,236,250) Edge & Compute
    participant APIGW as API Gateway
    participant QueryFn as Query Lambda
    end
    box rgb(238,238,238) AI Services
    participant Bedrock as Bedrock (Claude Sonnet)
    end
    box rgb(223,246,231) Data Stores
    participant OpenSearch
    participant Aurora
    end

    User->>APIGW: Ask question ("Total VAT paid to Supplier X in Q1?")
    APIGW->>QueryFn: Authenticated request
    QueryFn->>Bedrock: Classify intent (+ embed question)
    Bedrock-->>QueryFn: {intent, entities: supplier, period, field}
    alt structured / aggregation intent
        QueryFn->>Aurora: Sum tax for supplier + period (tenant-isolated)
        Aurora-->>QueryFn: Result
    else semantic / discrepancy intent
        QueryFn->>OpenSearch: Semantic search (tenant-filtered)
        OpenSearch-->>QueryFn: Best-matching invoices
        QueryFn->>Aurora: Fetch matched invoice fields (tenant-isolated)
        Aurora-->>QueryFn: Field details
    end
    QueryFn->>Bedrock: Compose answer from results
    Bedrock-->>QueryFn: "Supplier X was paid USD 42,380 in VAT during Q1 2026."
    QueryFn-->>User: {answer, sources}
```

### 4.4 ERP Reconciliation

```mermaid
sequenceDiagram
    autonumber
    box rgb(225,236,250) Platform
    participant EventBridge
    participant ERPWorker as ERP Sync Worker (Lambda)
    participant APIGW as API Gateway
    end
    box rgb(238,238,238) External ERP
    participant NetSuite as ERP (NetSuite / SAP)
    end
    box rgb(223,246,231) Data Stores
    participant Aurora
    end

    EventBridge->>ERPWorker: Scheduled trigger (every 15 min) OR invoice finalised
    ERPWorker->>Aurora: Find invoices needing sync
    ERPWorker->>NetSuite: Push invoice (REST API)
    NetSuite-->>ERPWorker: {erp_id, payment_status}
    ERPWorker->>Aurora: Save sync result (erp_id, payment_status)
    ERPWorker->>Aurora: Write audit log (ERP_SYNC)

    Note over NetSuite, ERPWorker: Inbound webhook: payment posted
    NetSuite->>APIGW: Payment posted webhook {erp_id, event}
    APIGW->>ERPWorker: Verify webhook signature
    ERPWorker->>Aurora: Save payment_status = PAID
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
    -- PROCESSING → {REJECTED (terminal) | EXTRACTED (auto) | PENDING_REVIEW → VALIDATED}; FAILED on pipeline error
    rejection_reason TEXT,               -- NOT_AN_INVOICE | DUPLICATE (set only when status=REJECTED)
    confidence_doc  NUMERIC(5,4),        -- overall document confidence score
    s3_key_raw      TEXT NOT NULL,
    s3_key_redacted TEXT,
    erp_sync_status TEXT DEFAULT 'PENDING',  -- PENDING → SYNCED → FAILED (current state; attempts logged in erp_sync_jobs)
    payment_status  TEXT,                    -- mirrored from ERP: UNPAID / PARTIAL / PAID
    erp_id          TEXT,                    -- external ERP record id once synced
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

Each decision below is tied to the specific requirement, SLO, budget line, or compliance rule that forced it — and names the alternative we rejected and why.

| Decision | Choice | Why (concrete driver) | Rejected alternative | Trade-off |
|----------|--------|-----------------------|----------------------|-----------|
| Ingestion pattern | Async (SQS + ECS) | Peak 20 PDF/s × ~4s extraction would hold sync HTTP connections and breach the P95 < 8s SLO under burst; a 202 + queue absorbs spikes and lets ECS scale on queue depth | Synchronous extraction in the request path — simpler, but cold starts + Textract latency miss the SLO at peak | Clients must poll or accept a webhook for final status |
| OCR engine | AWS Textract (AnalyzeExpense) | Invoice-tuned table/form extraction reaches the ≥ 98% totals / ≥ 96% tax accuracy targets out of the box; fully managed = no OCR infra to run | Tesseract / open-source OCR — cheaper per page but ~85% on tabular layouts; can't meet accuracy SLOs without heavy custom training | Higher per-page cost (~$0.015) and AWS lock-in |
| LLM routing | Claude Haiku (primary) → Sonnet (fallback/review) | 150k docs/mo under an $18k cap makes per-doc cost dominant; Haiku keeps extraction ~$0.001/doc and meets latency, with Sonnet reserved for the ~10% complex/flagged docs needing higher accuracy | Sonnet for every doc — meets accuracy but ~12× cost blows the budget; Haiku-only — cheap but misses the accuracy SLO on hard layouts | Two model versions + a confidence-routing threshold to maintain |
| Multi-tenant isolation | RLS + per-tenant S3 prefix | Compliance requires hard tenant isolation; DB-enforced Row-Level Security holds even if app code has a bug, without the cost of a schema/DB per tenant at this scale | Schema-per-tenant — stronger isolation but heavy migrations × N tenants; app-layer filtering only — one missing `WHERE` clause leaks data | RLS must be set (`SET LOCAL app.current_tenant`) in every DB session; more complex connection pooling |
| Vector store | OpenSearch Serverless | The RAG/semantic-query layer needs k-NN; Serverless is native AWS, IAM-integrated, and has no cluster to manage at 150k docs/mo | Pinecone/Weaviate — stronger hybrid search but adds a third-party vendor, separate auth, and a data-residency review; self-managed OpenSearch — node ops not justified at this scale | Minimum OCU billing applies even at low volume; less mature hybrid search than dedicated vendors |
| ERP integration | EventBridge + Lambda webhooks + batch fallback | ERPs are slow/unreliable; event-driven sync gives low latency while a scheduled batch reconciles anything missed, so a NetSuite/SAP outage never drops an invoice | Synchronous ERP call in the pipeline — couples the extraction SLO to ERP uptime; batch-only — simpler but stale on every invoice | Eventual consistency — invoice/ERP status can lag up to ~15 min |
| Data residency | Per-region stack + Route 53 latency routing | GDPR/regional residency requires EU data to stay in-region; per-region stacks keep storage + inference local and route users to their region with no code change | Single global region — simplest but violates EU residency; region-tagging in one shared DB — data still physically co-located, fails residency audits | More infra to operate per region; cross-region reporting needs deliberate aggregation |

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

- **Circuit breaker** (per tenant): trip after 3 consecutive Bedrock failures; route affected messages straight to the human review queue (no silent loss)
- **Retry with exponential backoff + jitter**: base 1s, max 3 retries (~6s window)
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

> **Headroom: 59% of the $18k budget** — overall AI volume can grow ~2.4× before the cap is reached.

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
