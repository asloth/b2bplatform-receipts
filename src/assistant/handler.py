import json
import os
import re

import boto3

rds = boto3.client("rds-data")

BEDROCK_REGION = os.environ.get("BEDROCK_REGION", "us-east-1")
bedrock = boto3.client("bedrock-runtime", region_name=BEDROCK_REGION)

DB_CLUSTER_ARN = os.environ["DB_CLUSTER_ARN"]
DB_SECRET_ARN = os.environ["DB_SECRET_ARN"]
DB_NAME = os.environ["DB_NAME"]
MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "us.anthropic.claude-sonnet-4-6")

MAX_ROWS = 100  # hard cap on query results returned to Claude

_SCHEMA = """
You have access to a PostgreSQL invoice database with these tables:

invoices
  id          UUID  (primary key)
  status      TEXT  — PROCESSING | REJECTED | EXTRACTED | PENDING_REVIEW | VALIDATED | FAILED
  confidence_doc  FLOAT  — document-level confidence 0–1
  is_invoice  BOOLEAN
  s3_key      TEXT
  created_at  TIMESTAMP
  updated_at  TIMESTAMP

invoice_fields  (one row per extracted field per invoice)
  id              UUID
  invoice_id      UUID  → invoices.id
  field_name      TEXT  — supplier_name | invoice_number | invoice_date |
                          total_amount | tax_amount | subtotal | currency
  raw_value       TEXT
  normalised_value TEXT
  confidence      FLOAT  — field-level confidence 0–1
  source          TEXT  — llm | human | textract

human_review_tasks
  id               UUID
  invoice_id       UUID  → invoices.id
  doc_confidence   FLOAT
  status           TEXT  — OPEN | RESOLVED
  resolution_notes TEXT
  resolved_at      TIMESTAMP
  created_at       TIMESTAMP

Useful patterns:
  — To get a field value for an invoice: JOIN invoice_fields f ON f.invoice_id = i.id AND f.field_name = 'total_amount'
  — All amounts are stored as TEXT in normalised_value; cast with ::numeric for math
  — Dates are stored as TEXT in YYYY-MM-DD format
  — 'created_at' on invoices is when the PDF was uploaded
"""

_SYSTEM = f"""You are an invoice assistant for a B2B platform. You help users understand \
and query their invoice data by generating SQL queries and explaining the results clearly.

{_SCHEMA}

Rules:
- Only use SELECT statements — never INSERT, UPDATE, DELETE, DROP, etc.
- Limit results to {MAX_ROWS} rows maximum.
- Be concise. Give direct answers, not long explanations.
- If the user asks something unrelated to invoices, politely redirect them.
- When showing numbers that are amounts, include the currency if available.
- If a query returns no results, say so clearly and suggest why."""

_TOOL = {
    "name": "query_invoices",
    "description": "Execute a read-only SQL SELECT query against the invoice database and return the results.",
    "inputSchema": {
        "json": {
            "type": "object",
            "properties": {
                "sql": {
                    "type": "string",
                    "description": "A valid PostgreSQL SELECT statement.",
                }
            },
            "required": ["sql"],
        }
    },
}


def handler(event, context):
    body = json.loads(event.get("body") or "{}")
    question = (body.get("question") or "").strip()
    history = body.get("history") or []  # [{role, content}] from the frontend

    if not question:
        return _resp(400, {"error": "question is required"})

    # Keep last 6 messages (3 turns) for context without bloating the prompt
    trimmed_history = [
        {
            "role": m["role"],
            "content": m["content"] if isinstance(m["content"], list) else [{"text": m["content"]}],
        }
        for m in history[-6:]
    ]
    messages = trimmed_history + [{"role": "user", "content": [{"text": question}]}]

    try:
        answer, sql_used, rows = _run_agent(messages)
        return _resp(200, {"answer": answer, "sql": sql_used, "rows": rows})
    except Exception as exc:
        return _resp(500, {"error": str(exc)})


# ── Agentic loop ───────────────────────────────────────────────────────────────

def _run_agent(messages: list) -> tuple[str, str | None, list | None]:
    sql_used = None
    rows = None

    for _ in range(3):  # max 3 tool-call rounds
        response = bedrock.converse(
            modelId=MODEL_ID,
            system=[{"text": _SYSTEM}],
            messages=messages,
            toolConfig={"tools": [{"toolSpec": _TOOL}]},
            inferenceConfig={"maxTokens": 1024, "temperature": 0},
        )

        msg = response["output"]["message"]
        stop_reason = response["stopReason"]

        if stop_reason == "tool_use":
            # Claude wants to run a query
            tool_call = next(b["toolUse"] for b in msg["content"] if "toolUse" in b)
            sql = tool_call["input"]["sql"]
            tool_use_id = tool_call["toolUseId"]

            result, error = _execute_sql(sql)
            sql_used = sql
            rows = result

            # Append Claude's tool call + our result to the conversation
            messages = messages + [
                {"role": "assistant", "content": msg["content"]},
                {
                    "role": "user",
                    "content": [
                        {
                            "toolResult": {
                                "toolUseId": tool_use_id,
                                "content": [
                                    {
                                        "text": json.dumps(result) if not error
                                        else f"Error: {error}",
                                    }
                                ],
                            }
                        }
                    ],
                },
            ]
            continue

        # stop_reason == "end_turn" — Claude has a final answer
        text = next(
            (b["text"] for b in msg["content"] if "text" in b), ""
        )
        return text, sql_used, rows

    return "I wasn't able to fully answer that. Please try rephrasing.", sql_used, rows


# ── SQL execution ──────────────────────────────────────────────────────────────

def _execute_sql(sql: str) -> tuple[list, str | None]:
    # Safety: only allow SELECT statements
    clean = sql.strip().lstrip("(")
    if not re.match(r"^\s*SELECT\b", clean, re.IGNORECASE):
        return [], "Only SELECT queries are allowed."

    try:
        result = rds.execute_statement(
            resourceArn=DB_CLUSTER_ARN,
            secretArn=DB_SECRET_ARN,
            database=DB_NAME,
            sql=sql,
            includeResultMetadata=True,
        )
    except Exception as exc:
        return [], str(exc)

    columns = [c["label"] for c in result.get("columnMetadata", [])]
    rows = []
    for record in result.get("records", [])[:MAX_ROWS]:
        row = {}
        for col, cell in zip(columns, record):
            val = next(iter(cell.values()), None)
            row[col] = val
        rows.append(row)

    return rows, None


# ── Response ───────────────────────────────────────────────────────────────────

def _resp(status: int, body: dict) -> dict:
    return {
        "statusCode": status,
        "headers": {
            "Content-Type": "application/json",
        },
        "body": json.dumps(body),
    }
