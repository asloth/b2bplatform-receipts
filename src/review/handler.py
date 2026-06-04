"""
Human-in-the-loop review API.

Routes:
  GET  /review/tasks           → list all OPEN tasks
  GET  /review/tasks/{task_id} → task detail + invoice fields
  PATCH /review/tasks/{task_id} → resolve: submit corrections, mark RESOLVED
"""
import json
import os
import uuid

import boto3

rds = boto3.client("rds-data")

DB_CLUSTER_ARN = os.environ["DB_CLUSTER_ARN"]
DB_SECRET_ARN = os.environ["DB_SECRET_ARN"]
DB_NAME = os.environ["DB_NAME"]


def handler(event, context):
    method = event.get("requestContext", {}).get("http", {}).get("method", "")
    path = event.get("rawPath", "")
    path_params = event.get("pathParameters") or {}
    task_id = path_params.get("task_id")

    if method == "GET" and path == "/review/tasks":
        return _list_tasks()

    if method == "GET" and task_id:
        return _get_task(task_id)

    if method == "PATCH" and task_id:
        body = json.loads(event.get("body") or "{}")
        return _resolve_task(task_id, body)

    return _resp(404, {"error": "Not found"})


# ── Handlers ───────────────────────────────────────────────────────────────────

def _list_tasks():
    result = _sql(
        """
        SELECT
            t.id,
            t.invoice_id,
            t.doc_confidence,
            t.low_confidence_fields,
            t.status,
            t.created_at,
            i.s3_key
        FROM human_review_tasks t
        JOIN invoices i ON i.id = t.invoice_id
        WHERE t.status = 'OPEN'
        ORDER BY t.created_at ASC
        """
    )
    tasks = [
        {
            "task_id":               r[0]["stringValue"],
            "invoice_id":            r[1]["stringValue"],
            "doc_confidence":        r[2].get("doubleValue", 0),
            "low_confidence_fields": json.loads(r[3]["stringValue"]) if r[3].get("stringValue") else {},
            "status":                r[4]["stringValue"],
            "created_at":            r[5]["stringValue"],
            "s3_key":                r[6]["stringValue"],
        }
        for r in result["records"]
    ]
    return _resp(200, {"tasks": tasks, "count": len(tasks)})


def _get_task(task_id: str):
    result = _sql(
        """
        SELECT
            t.id,
            t.invoice_id,
            t.doc_confidence,
            t.low_confidence_fields,
            t.status,
            t.created_at,
            i.s3_key,
            i.status AS invoice_status
        FROM human_review_tasks t
        JOIN invoices i ON i.id = t.invoice_id
        WHERE t.id = :task_id::uuid
        """,
        [{"name": "task_id", "value": {"stringValue": task_id}}],
    )
    if not result["records"]:
        return _resp(404, {"error": "Task not found"})

    r = result["records"][0]
    invoice_id = r[1]["stringValue"]

    fields_result = _sql(
        "SELECT field_name, raw_value, normalised_value, confidence, source "
        "FROM invoice_fields WHERE invoice_id = :id::uuid ORDER BY field_name",
        [{"name": "id", "value": {"stringValue": invoice_id}}],
    )
    fields = [
        {
            "field_name":       f[0]["stringValue"],
            "raw_value":        f[1].get("stringValue"),
            "normalised_value": f[2].get("stringValue"),
            "confidence":       f[3].get("doubleValue", 0),
            "source":           f[4].get("stringValue"),
        }
        for f in fields_result["records"]
    ]

    return _resp(200, {
        "task_id":               r[0]["stringValue"],
        "invoice_id":            invoice_id,
        "doc_confidence":        r[2].get("doubleValue", 0),
        "low_confidence_fields": json.loads(r[3]["stringValue"]) if r[3].get("stringValue") else {},
        "status":                r[4]["stringValue"],
        "created_at":            r[5]["stringValue"],
        "s3_key":                r[6]["stringValue"],
        "invoice_status":        r[7]["stringValue"],
        "fields":                fields,
    })


def _resolve_task(task_id: str, body: dict):
    """
    Body:
      {
        "resolution_notes": "optional text",
        "corrected_fields": {"total_amount": "1200.00", "currency": "EUR"}  // optional
      }
    """
    notes = body.get("resolution_notes", "")
    corrected = body.get("corrected_fields", {})

    # Fetch invoice_id for this task
    result = _sql(
        "SELECT invoice_id FROM human_review_tasks WHERE id = :task_id::uuid AND status = 'OPEN'",
        [{"name": "task_id", "value": {"stringValue": task_id}}],
    )
    if not result["records"]:
        return _resp(404, {"error": "Task not found or already resolved"})

    invoice_id = result["records"][0][0]["stringValue"]

    # Apply corrections: update normalised_value + source for each corrected field
    for field_name, new_value in corrected.items():
        existing = _sql(
            "SELECT id FROM invoice_fields WHERE invoice_id = :iid::uuid AND field_name = :fn",
            [
                {"name": "iid", "value": {"stringValue": invoice_id}},
                {"name": "fn",  "value": {"stringValue": field_name}},
            ],
        )
        if existing["records"]:
            _sql(
                "UPDATE invoice_fields SET normalised_value = :val, source = 'human', confidence = 1.0 "
                "WHERE invoice_id = :iid::uuid AND field_name = :fn",
                [
                    {"name": "val", "value": {"stringValue": str(new_value)}},
                    {"name": "iid", "value": {"stringValue": invoice_id}},
                    {"name": "fn",  "value": {"stringValue": field_name}},
                ],
            )
        else:
            # Field was missing — insert it
            _sql(
                "INSERT INTO invoice_fields (id, invoice_id, field_name, raw_value, normalised_value, confidence, source) "
                "VALUES (:id::uuid, :iid::uuid, :fn, :val, :val, 1.0, 'human')",
                [
                    {"name": "id",  "value": {"stringValue": str(uuid.uuid4())}},
                    {"name": "iid", "value": {"stringValue": invoice_id}},
                    {"name": "fn",  "value": {"stringValue": field_name}},
                    {"name": "val", "value": {"stringValue": str(new_value)}},
                ],
            )

    # Mark task resolved
    _sql(
        "UPDATE human_review_tasks SET status = 'RESOLVED', resolution_notes = :notes, resolved_at = NOW() WHERE id = :id::uuid",
        [
            {"name": "notes", "value": {"stringValue": notes}},
            {"name": "id",    "value": {"stringValue": task_id}},
        ],
    )

    # Mark invoice as VALIDATED
    _sql(
        "UPDATE invoices SET status = 'VALIDATED', updated_at = NOW() WHERE id = :id::uuid",
        [{"name": "id", "value": {"stringValue": invoice_id}}],
    )

    return _resp(200, {"task_id": task_id, "status": "RESOLVED", "invoice_status": "VALIDATED"})


# ── Helpers ────────────────────────────────────────────────────────────────────

def _sql(sql: str, parameters: list = None):
    kwargs = dict(
        resourceArn=DB_CLUSTER_ARN,
        secretArn=DB_SECRET_ARN,
        database=DB_NAME,
        sql=sql,
    )
    if parameters:
        kwargs["parameters"] = parameters
    return rds.execute_statement(**kwargs)


def _resp(status: int, body: dict) -> dict:
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps(body),
    }
