# MLOps & Operations Plan
# B2B Invoice Processing Platform

> Version 1.0 · June 2026

---

## 1. Model Versioning and Promotion

### 1.1 Bedrock Model Aliases

All model invocations use named aliases, not hard-coded model IDs:

| Alias | Current target | Role |
|-------|---------------|------|
| `invoice-extraction-primary` | `claude-haiku-4-5-20251001` | Extraction (fast, low cost) |
| `invoice-extraction-complex` | `claude-sonnet-4-6` | Low-confidence fallback |
| `invoice-query-conversational` | `claude-sonnet-4-6` | RAG synthesis + SQL generation |

When Anthropic releases a new model, promotion follows a canary process:
1. Create new alias version pointing to new model ID
2. Route 5% of extraction traffic to new alias via feature flag (SSM Parameter Store)
3. Compare accuracy metrics on canary traffic vs. golden set for 48h
4. Promote to 100% if accuracy meets targets and P95 latency is within SLO
5. Keep previous alias version live for 7 days as rollback target

**Rollback**: update SSM parameter — takes effect within 30 seconds (Lambda reads at cold start, ECS workers poll every 60s).

### 1.2 Prompt Versioning

Extraction and conversational prompts are stored in AWS Systems Manager Parameter Store under versioned paths:
```
/invoice-platform/{env}/prompts/extraction/v{N}
/invoice-platform/{env}/prompts/conversational/v{N}
```
- Immutable versions; new prompt = new `v{N+1}`
- Active version pointer stored at `…/prompts/extraction/active` (integer)
- CI pipeline runs regression suite on new version before changing `active` pointer

---

## 2. Drift Detection

### 2.1 Accuracy Drift

- **Weekly batch sampling**: 500 randomly selected invoices from the past 7 days (stratified by tenant and document type) are re-processed through the golden evaluation harness
- **Drift alert**: if any accuracy metric drops below target × 0.95 (e.g., `total_amount` accuracy < 93.1%), a P2 alert fires and the prompt/model team is paged
- **Trend tracking**: 12-week rolling accuracy chart in CloudWatch; anomaly detection model detects downward trends before threshold breach

### 2.2 Data Distribution Drift

- Input distribution metrics tracked per week: average OCR text length, proportion of scanned vs. native PDFs, language distribution, tax scheme distribution
- Significant shift (> 2σ from baseline) triggers a review of whether golden dataset needs expansion with new document types

### 2.3 ERP Reconciliation Discrepancy Rate

- Track `discrepancy_rate = invoices_with_ERP_mismatch / total_synced`
- A sustained discrepancy rate > 2% triggers a joint review with the ERP integration team

---

## 3. Backpressure Handling

### 3.1 SQS Queue Depth Management

| Queue depth (messages) | Action |
|-----------------------|--------|
| 0 – 500 | Normal: ECS workers at baseline (2 tasks) |
| 500 – 2,000 | Scale-out: ECS target tracking adds tasks up to 10 |
| 2,000 – 5,000 | Alert: CloudWatch alarm → PagerDuty P3 |
| > 5,000 | Throttle uploads at API Gateway (429) + P2 alert; ECS scales to max 20 tasks |
| DLQ > 50 | P2 alert; automatic DLQ replay attempted after on-call acknowledgement |

ECS auto-scaling metric:
```
TargetValue = 100  # messages per running task
ScaleOutCooldown = 60s
ScaleInCooldown = 300s
```

### 3.2 Bedrock Rate Limit Handling

- ECS workers implement exponential backoff with jitter: base 1s, max 16s, max 3 retries
- Per-tenant token budget enforced at the worker: if a tenant consumes > 20% of hourly Bedrock quota, their queue messages are delayed 30s via SQS visibility timeout extension
- Circuit breaker (per worker process): if 3 consecutive Bedrock calls fail, worker pauses extraction and routes messages directly to human review queue — **no silent data loss**

### 3.3 Database Connection Management

- PgBouncer (transaction pooling mode) sits between Lambdas/ECS workers and Aurora
- Max pool size: 100 connections to Aurora; PgBouncer handles thousands of application connections
- Aurora Serverless v2 scales ACUs (Aurora Capacity Units) from 0.5 to 64 automatically based on load

---

## 4. Cost Controls

### 4.1 Per-Tenant AI Spending Limits

Each tenant has a configurable monthly AI budget (stored in `tenants.config`). The cost-tracking Lambda:
- Runs every 15 minutes: reads CloudWatch Bedrock `InvokedModelId` + `InputTokenCount` / `OutputTokenCount` metrics
- Aggregates spend per tenant using model pricing constants
- If a tenant hits 80% of their budget: warning notification to tenant admin
- If a tenant hits 100%: extraction paused for that tenant, invoices queued; human review remains available

### 4.2 Model Routing Cost Optimisation

| Scenario | Model used | Est. cost/invoice |
|----------|-----------|------------------|
| Standard invoice, well-formatted PDF | Claude Haiku | $0.0009 |
| Low-confidence → Sonnet re-extraction | Claude Haiku + Sonnet | $0.0027 |
| Human-reviewed (no Sonnet) | Claude Haiku | $0.0009 |
| Conversational query (aggregation, SQL) | Claude Haiku | $0.0003 |
| Conversational query (open RAG synthesis) | Claude Sonnet | $0.0018 |

**Haiku-first policy**: Sonnet is only invoked when Haiku confidence < 0.85 or when the conversational query is classified as `open_question`. This keeps the blended average well below $0.002/invoice.

### 4.3 CloudWatch Billing Alarms

| Alarm | Threshold | Action |
|-------|-----------|--------|
| Daily AI spend | > $600 (~$18k/30) | Slack alert to platform engineering |
| Monthly AI spend | > $15,000 | PagerDuty P2; review of tenant usage |
| Monthly AI spend | > $17,500 | Auto-throttle Sonnet to Haiku globally; P1 alert |
| S3 storage growth | > 20% month-over-month | Lifecycle policy review |

---

## 5. Incident Runbooks

### 5.1 DLQ Spike

1. CloudWatch alarm → PagerDuty
2. On-call checks DLQ messages: `aws sqs receive-message --queue-url $DLQ_URL`
3. Identify error type: Bedrock timeout, Textract error, DB connection failure, or schema mismatch
4. Fix root cause (e.g., increase ECS memory if OOM, rotate Bedrock credentials if auth failure)
5. Replay DLQ: `aws sqs start-message-move-task --source-arn $DLQ_ARN --destination-arn $MAIN_QUEUE_ARN`
6. Monitor queue depth for 30 minutes; close incident when depth returns to baseline

### 5.2 Bedrock Sustained Timeout (> 10 min)

1. Circuit breakers will have already paused extraction workers
2. Confirm Bedrock health via AWS Status Page + CloudWatch `ThrottlingException` rate
3. If AWS-side issue: extraction queue accumulates (SQS retention = 4 days); human review SLA clock starts for high-priority invoices
4. Optionally activate OpenAI fallback (pre-configured LangChain adapter, disabled by default) via SSM flag
5. When Bedrock recovers: resume workers; replay backlog at controlled rate (100 messages/min)

### 5.3 Accuracy Drop Alert

1. Drift detection alarm fires with specific metric and delta
2. On-call reviews recent prompt or model alias changes (SSM Parameter Store history)
3. If change correlates: rollback to previous active prompt version or alias
4. If no recent change: expand golden dataset evaluation with recent failing documents
5. Schedule prompt engineering session within 48h

---

## 6. On-Call and SLA Targets

| Priority | Response time | Example triggers |
|----------|-------------|-----------------|
| P1 | 15 min | AI spend > $17.5k; DLQ > 500; API P95 > 2× SLO |
| P2 | 1 hour | DLQ > 50; accuracy drop > 3%; Bedrock error rate > 15% |
| P3 | 4 hours | Queue depth 2k–5k; single-tenant budget > 80% |

---

## 7. Pending SLO Risks — Changes Required Before Production Scale

The current demo deployment meets SLOs on warm paths but will violate them under
peak load (20 PDFs/s ingestion, 30 QPS queries). Two changes must be applied before
claiming compliance. They are documented here — not yet implemented — so they are
tracked, understood, and applied as a deliberate step when moving to production.

---

### Risk 1 — Textract Service Quota (Ingestion P95 < 8s at 20 PDFs/s)

**The problem**

AWS accounts start with a default quota of **1 TPS for `AnalyzeExpense`** (the Textract
call used for OCR in `src/worker/handler.py:_textract_with_retry`). At peak load of
20 PDFs/s, 19 of every 20 concurrent worker Lambdas will receive a
`ThrottlingException` and enter the retry loop:

```
attempt 1 → ThrottledException → wait 2s
attempt 2 → ThrottledException → wait 4s
attempt 3 → ThrottledException → wait 8s → FAILED
```

A single retry already consumes the entire 8s SLO budget. The invoice never reaches
extraction; it is marked FAILED.

**Why it is a quota and not a code fix**

Textract's `AnalyzeExpense` runs on shared AWS infrastructure. The 1 TPS default
protects other tenants on the same capacity pool. AWS provisions dedicated throughput
only after you formally request it — there is no code change that bypasses this.

**The fix — AWS Console action (takes 1–3 business days)**

```
AWS Console
  → Service Quotas
  → Amazon Textract
  → "AnalyzeDocument/AnalyzeExpense requests per second"
  → Request quota increase → target value: 25
  (25 = 20 peak + 25% safety margin)
```

**What changes in code after approval**

Nothing. The quota increase is account-level. Once approved, 20 concurrent Textract
calls will succeed on the first attempt, and the existing retry logic becomes a genuine
safety net for transient errors rather than a constant bottleneck.

**Verification**

After approval, run the load test in `scripts/load_test.py` at 20 users and confirm
`ProcessingDurationMs` P95 < 8000ms in the CloudWatch dashboard.

---

### Risk 2 — Lambda Cold Starts (Ingestion P95 < 8s + Query P95 < 400ms)

**The problem**

Lambda containers are created on demand when no warm container is available. For the
worker Lambda, a cold start adds **1.5–2.5s** due to Python runtime initialisation and
the import of heavy libraries (`boto3`, `fitz`/PyMuPDF). For the review Lambda it adds
**1–2s**.

At a burst of 20 simultaneous uploads, Lambda may spin up 15–20 new containers at
once. Each of those invoices loses 2s before doing any real work — pushing them over
the 8s ingestion SLO. For the review/query Lambda, a single cold start on an idle
period pushes a structured query over the 400ms SLO.

**Why it cannot be fixed in application code**

Cold start duration is determined by runtime initialisation time, not by what the
function does. The only way to eliminate cold starts is to keep containers pre-warmed.

**The fix — Provisioned Concurrency in `terraform/lambda.tf`**

Add the following to both Lambda resources:

```hcl
# Worker Lambda — keeps 20 warm containers ready for peak ingestion
resource "aws_lambda_provisioned_concurrency_config" "worker" {
  function_name                  = aws_lambda_function.worker.function_name
  qualifier                      = aws_lambda_function.worker.version
  provisioned_concurrent_executions = 20
}

# Review Lambda — keeps 5 warm containers ready for query SLO
resource "aws_lambda_provisioned_concurrency_config" "review" {
  function_name                  = aws_lambda_function.review.function_name
  qualifier                      = aws_lambda_function.review.version
  provisioned_concurrent_executions = 5
}
```

Note: provisioned concurrency requires a published Lambda version (not `$LATEST`).
The Lambda resources in `terraform/lambda.tf` need `publish = true` added before
applying this config.

**Cost impact**

| Resource | Provisioned | Monthly cost (approx.) |
|---|---|---|
| Worker Lambda (512 MB × 20) | 20 warm | ~$28/month |
| Review Lambda (256 MB × 5) | 5 warm | ~$4/month |
| **Total** | | **~$32/month** |

This is a fixed cost regardless of traffic, in exchange for eliminating latency spikes
at burst. It is well within the $18k/month AI budget constraint.

**Verification**

After `terraform apply`, invoke both Lambdas and confirm zero cold starts in
CloudWatch Logs Insights:

```sql
filter @message like /Init Duration/
| stats count() as cold_starts by bin(5m)
```

Zero results = all invocations are hitting warm containers.

PagerDuty escalation policy: primary on-call → secondary → engineering manager (if no ack within 2× response time).
