# Invoice Processing Platform

**Turn PDF invoices into structured records, review uncertain fields, and ask questions about the results.**

An AWS invoice-processing prototype with a React dashboard and Python Lambda functions.
It combines Textract OCR with Bedrock extraction, routes low-confidence results to a human
review queue, and lets an assistant query the invoice database.

[Run the dashboard](#run-the-dashboard) · [Processing pipeline](#processing-pipeline) ·
[Architecture notes](docs/01-system-design.md) · [API design](docs/02-api-specs.md)

## What it does

- **Upload a PDF.** Store the document in S3 and enqueue an asynchronous processing job.
- **Extract invoice fields.** Classify the document, run OCR, and extract supplier, invoice
  number, date, subtotal, tax, total, and currency.
- **Review uncertain results.** Inspect the PDF alongside extracted fields, correct values,
  and resolve review tasks in the dashboard.
- **Ask about invoices.** A Bedrock assistant generates database queries and explains the
  results in the chat interface.
- **Observe processing.** Lambda logs and custom CloudWatch metrics expose processing steps
  and outcomes.

This repository contains both a working prototype implementation and a broader system design.
The design documents describe future capabilities too; their multi-tenant isolation, ERP
integrations, and accuracy/SLO targets are **design goals**, not measured or implemented guarantees
of this prototype.

## Processing pipeline

1. **Upload Lambda** writes the PDF to S3, creates an invoice record, and sends an SQS message.
2. **Worker Lambda** classifies the first page with Bedrock, runs Textract OCR, extracts fields
   with Bedrock, and stores the fields and confidence scores in Aurora PostgreSQL.
3. **Confidence routing** accepts a document at or above the current `0.85` threshold or creates
   a human review task below it. Classification has a separate rejection threshold.
4. **Review Lambda** lists tasks, retrieves fields, and saves corrections.
5. **Assistant Lambda** uses Bedrock's Converse API and a database-query tool to answer questions.

The confidence scores use heuristics in [`src/worker/handler.py`](src/worker/handler.py);
they are not a calibrated accuracy measurement.

## Stack

| Layer | Implementation |
| --- | --- |
| Dashboard | React 19, TypeScript, Vite 8, Tailwind CSS, shadcn/ui |
| API and processing | API Gateway HTTP API, Python 3.12 Lambda functions |
| AI | AWS Textract and Amazon Bedrock |
| Storage and queue | S3, Aurora PostgreSQL via RDS Data API, SQS |
| Infrastructure | Terraform, CloudWatch |

## Run the dashboard

Use **Node.js 20.19+ or 22.12+** and npm, matching the locked Vite engine requirement.

```bash
git clone https://github.com/asloth/b2bplatform-receipts.git
cd b2bplatform-receipts/frontend
npm ci
npm run dev
```

Open the local URL Vite prints, normally `http://localhost:5173`.

**Configure your API before using Upload, Review, or Chat.** The `BASE` constant in
[`frontend/src/api/client.ts`](frontend/src/api/client.ts) currently points to a specific AWS
deployment. It is not an environment-variable setting or a bundled local backend. Replace it
with the API Gateway base URL for your own deployment; omit the `/invoices/upload` suffix.
Starting Vite only starts the dashboard, not the AWS services.

Frontend checks, run from `frontend/`:

```bash
npm run lint
npm run build
```

## Backend and infrastructure

The backend is deployed with Terraform; there is no local API server or local cloud emulator
configured in the repository. Running the full flow needs an AWS account, permissions for the
services above, and access to the configured Bedrock models. Deployment and inference incur AWS
charges.

- Start with [`terraform/main.tf`](terraform/main.tf) and
  [`terraform/variables.tf`](terraform/variables.tf). Terraform **1.5+** is required, and the
  configuration currently uses a default VPC.
- Inspect the sample variables and choose your own values. Review the API access controls
  before deploying: the current API Gateway routes have no authorizer configured.
- The PyMuPDF Lambda layer is built through a local `pip` command in
  [`terraform/layers.tf`](terraform/layers.tf), targeting Python 3.12 Linux wheels.
- After deployment, [`scripts/init_db.py`](scripts/init_db.py) creates the database schema.
  It needs `boto3` and AWS credentials, and must be run from the repository root because it
  reads Terraform outputs from `terraform/`.
- [`terraform/outputs.tf`](terraform/outputs.tf) defines the upload URL, review URL, database
  identifiers, queue, and dashboard outputs. Use the API base URL to configure the frontend.

This is a development prototype, with no production authentication or tenant isolation wired
into these routes. Use a deployment you control with synthetic invoice data when evaluating it.
No live API endpoint is offered here as a public demo.

## Explore the code

| Path | Purpose |
| --- | --- |
| [`frontend/src/pages/`](frontend/src/pages/) | Upload, Review, and Chat screens |
| [`frontend/src/api/client.ts`](frontend/src/api/client.ts) | Dashboard API calls and base URL |
| [`src/upload/handler.py`](src/upload/handler.py) | Upload, status, and document preview |
| [`src/worker/handler.py`](src/worker/handler.py) | Classification, OCR, extraction, confidence, persistence |
| [`src/review/handler.py`](src/review/handler.py) | Human review queue and corrections |
| [`src/assistant/handler.py`](src/assistant/handler.py) | Conversational invoice queries |
| [`terraform/`](terraform/) | AWS infrastructure and Lambda packaging |
| [`scripts/`](scripts/) | Database initialization and status helpers |

## Design documents

- [System design](docs/01-system-design.md): proposed platform architecture and processing flows.
- [API specifications](docs/02-api-specs.md): target API contract; inspect the handlers and
  Terraform routes for the implemented subset.
- [AI evaluation](docs/03-ai-evaluation.md): evaluation methodology and target metrics.
- [MLOps operations](docs/04-mlops-operations.md): proposed operational approach.

The design documents are useful context, but claims about ERP synchronization, authenticated
multi-tenant access, or benchmark targets should be read as the broader design rather than the
current implementation.
