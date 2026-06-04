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

PagerDuty escalation policy: primary on-call → secondary → engineering manager (if no ack within 2× response time).
