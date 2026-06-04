import json
import os
import re
import time
import uuid
from datetime import datetime

import boto3
import fitz  # PyMuPDF — provided via Lambda layer

s3 = boto3.client("s3")
textract = boto3.client("textract")
rds = boto3.client("rds-data")
cloudwatch = boto3.client("cloudwatch")

BEDROCK_REGION = os.environ.get("BEDROCK_REGION", "us-east-1")
bedrock = boto3.client("bedrock-runtime", region_name=BEDROCK_REGION)

DB_CLUSTER_ARN = os.environ["DB_CLUSTER_ARN"]
DB_SECRET_ARN = os.environ["DB_SECRET_ARN"]
DB_NAME = os.environ["DB_NAME"]
BEDROCK_MODEL_ID = os.environ.get("BEDROCK_MODEL_ID", "anthropic.claude-3-5-haiku-20241022-v1:0")
CW_NAMESPACE = os.environ.get("CW_NAMESPACE", "B2BPlatform/InvoiceProcessing")

# Confidence threshold: below this → human review queue
REVIEW_THRESHOLD = 0.85
# Classification threshold: below this → reject (not a real invoice)
CLASSIFY_THRESHOLD = 0.70

# Weighted importance of each field for the document-level confidence score
FIELD_WEIGHTS = {
    "total_amount":  0.25,
    "tax_amount":    0.20,
    "invoice_date":  0.15,
    "supplier_name": 0.15,
    "invoice_number": 0.10,
    "currency":      0.10,
    "subtotal":      0.05,
}

# Maps Textract AnalyzeExpense field types to our field names
TEXTRACT_FIELD_MAP = {
    "VENDOR":              "supplier_name",
    "VENDOR_NAME":         "supplier_name",
    "INVOICE_RECEIPT_ID":  "invoice_number",
    "INVOICE_DATE":        "invoice_date",
    "AMOUNT_DUE":          "total_amount",
    "TOTAL":               "total_amount",
    "TAX":                 "tax_amount",
    "SUBTOTAL":            "subtotal",
    "CURRENCY":            "currency",
}

_CLASSIFY_PROMPT = (
    "Look at this image. Is it a real business invoice or financial document "
    "(invoice, receipt, purchase order, credit note)?\n\n"
    'Return ONLY this JSON: {"is_invoice": true or false, "confidence": 0.0-1.0, "reason": "one sentence"}'
)

_EXTRACT_PROMPT = """You are an invoice data extraction assistant. Given raw OCR text from an invoice, return ONLY a JSON object:

{{
  "supplier_name": "string or null",
  "invoice_number": "string or null",
  "invoice_date": "YYYY-MM-DD or null",
  "total_amount": number or null,
  "tax_amount": number or null,
  "subtotal": number or null,
  "currency": "ISO 4217 code or null"
}}

Rules: normalize amounts to plain numbers, dates to YYYY-MM-DD, null if missing or ambiguous.
Return ONLY the JSON object, no explanation.

Invoice text:
{text}"""


# ── Entry point ────────────────────────────────────────────────────────────────

def handler(event, context):
    for record in event["Records"]:
        _process(json.loads(record["body"]))


def _process(body: dict):
    invoice_id = body["invoice_id"]
    s3_key = body["s3_key"]
    s3_bucket = body["s3_bucket"]
    t0 = time.time()

    _log(invoice_id, "start")

    # ── Step 1: Download PDF and classify the first page ──────────────────────
    pdf_bytes = s3.get_object(Bucket=s3_bucket, Key=s3_key)["Body"].read()
    image_bytes = _pdf_first_page_jpeg(pdf_bytes)
    classification = _classify_invoice(image_bytes, invoice_id)

    if not classification["is_invoice"] or classification["confidence"] < CLASSIFY_THRESHOLD:
        _log(invoice_id, "rejected", **classification)
        _update_status(invoice_id, "REJECTED", is_invoice=False)
        _delete_s3_object(s3_bucket, s3_key)
        _emit("InvoicesRejected", 1)
        return  # stop here — not a real invoice

    _log(invoice_id, "classified_as_invoice", confidence=classification["confidence"])

    # ── Step 2: OCR with Textract ─────────────────────────────────────────────
    textract_result = _textract_with_retry(s3_bucket, s3_key, invoice_id)
    if textract_result is None:
        _mark_failed(invoice_id, s3_bucket, s3_key, "textract_all_retries_failed")
        return

    textract_fields = _parse_textract(textract_result)
    raw_text = "\n".join(
        f"{k}: {v['text']}" for k, v in textract_fields.items() if v["text"]
    )
    _log(invoice_id, "textract_done", fields_found=list(textract_fields.keys()))

    # ── Step 3: Claude extraction ──────────────────────────────────────────────
    llm_fields = _invoke_claude(raw_text, invoice_id)
    if llm_fields is None:
        _mark_failed(invoice_id, s3_bucket, s3_key, "claude_extraction_failed")
        return

    _log(invoice_id, "claude_done", fields=list(llm_fields.keys()))

    # ── Step 4: Confidence scoring ────────────────────────────────────────────
    field_confidences = _score_fields(textract_fields, llm_fields)
    doc_confidence = _doc_confidence(field_confidences)
    _log(invoice_id, "confidence_scored", doc_confidence=doc_confidence)

    # ── Step 5: Persist fields ────────────────────────────────────────────────
    _save_fields(invoice_id, llm_fields, field_confidences)

    # ── Step 6: Route by confidence ───────────────────────────────────────────
    if doc_confidence >= REVIEW_THRESHOLD:
        _update_status(invoice_id, "EXTRACTED", confidence=doc_confidence, is_invoice=True)
        _emit("InvoicesExtracted", 1)
        _log(invoice_id, "complete", status="EXTRACTED", doc_confidence=doc_confidence)
    else:
        _update_status(invoice_id, "PENDING_REVIEW", confidence=doc_confidence, is_invoice=True)
        _create_review_task(invoice_id, doc_confidence, field_confidences, llm_fields)
        _emit("InvoicesPendingReview", 1)
        _log(invoice_id, "complete", status="PENDING_REVIEW", doc_confidence=doc_confidence)

    duration_ms = int((time.time() - t0) * 1000)
    _emit("ProcessingDurationMs", duration_ms, unit="Milliseconds")
    _emit("DocumentConfidence", round(doc_confidence * 100, 2))


# ── PDF → JPEG ─────────────────────────────────────────────────────────────────

def _pdf_first_page_jpeg(pdf_bytes: bytes) -> bytes:
    doc = fitz.open(stream=pdf_bytes, filetype="pdf")
    page = doc[0]
    mat = fitz.Matrix(2, 2)  # 2× zoom → cleaner image for Claude vision
    pix = page.get_pixmap(matrix=mat)
    return pix.tobytes("jpeg")


# ── Invoice classification (Claude Vision) ─────────────────────────────────────

def _classify_invoice(image_bytes: bytes, invoice_id: str) -> dict:
    try:
        response = bedrock.converse(
            modelId=BEDROCK_MODEL_ID,
            messages=[{
                "role": "user",
                "content": [
                    {"image": {"format": "jpeg", "source": {"bytes": image_bytes}}},
                    {"text": _CLASSIFY_PROMPT},
                ],
            }],
            inferenceConfig={"maxTokens": 128},
        )
        content = response["output"]["message"]["content"][0]["text"].strip()
        match = re.search(r"\{.*\}", content, re.DOTALL)
        if match:
            return json.loads(match.group())
    except Exception as exc:
        _log(invoice_id, "classify_error", error=str(exc))

    # On any failure: optimistically continue rather than drop the invoice
    return {"is_invoice": True, "confidence": 1.0, "reason": "classification_unavailable"}


# ── Textract ───────────────────────────────────────────────────────────────────

def _textract_with_retry(bucket: str, key: str, invoice_id: str) -> dict | None:
    for attempt, delay in enumerate([2, 4, 8], start=1):
        try:
            return textract.analyze_expense(
                Document={"S3Object": {"Bucket": bucket, "Name": key}}
            )
        except Exception as exc:
            _log(invoice_id, "textract_retry", attempt=attempt, error=str(exc))
            if attempt < 3:
                time.sleep(delay)
    return None


def _parse_textract(result: dict) -> dict:
    """Returns {field_name: {text: str, confidence: float 0-1}}"""
    fields: dict[str, dict] = {}
    for doc in result.get("ExpenseDocuments", []):
        for field in doc.get("SummaryFields", []):
            expense_type = field.get("Type", {}).get("Text", "")
            mapped = TEXTRACT_FIELD_MAP.get(expense_type)
            if not mapped:
                continue
            text = field.get("ValueDetection", {}).get("Text", "")
            conf = field.get("ValueDetection", {}).get("Confidence", 0) / 100
            if text and (mapped not in fields or conf > fields[mapped]["confidence"]):
                fields[mapped] = {"text": text, "confidence": conf}
    return fields


# ── Claude extraction ──────────────────────────────────────────────────────────

def _invoke_claude(text: str, invoice_id: str) -> dict | None:
    prompt = _EXTRACT_PROMPT.replace("{text}", text[:8000])
    try:
        response = bedrock.converse(
            modelId=BEDROCK_MODEL_ID,
            messages=[{
                "role": "user",
                "content": [{"text": prompt}],
            }],
            inferenceConfig={"maxTokens": 512},
        )
        content = response["output"]["message"]["content"][0]["text"].strip()
        match = re.search(r"\{.*\}", content, re.DOTALL)
        if not match:
            _log(invoice_id, "llm_parse_error", preview=content[:200])
            return None
        return json.loads(match.group())
    except Exception as exc:
        _log(invoice_id, "llm_error", error=str(exc))
        return None


# ── Confidence scoring ─────────────────────────────────────────────────────────

def _score_fields(textract_fields: dict, llm_fields: dict) -> dict:
    """Per-field confidence = 0.4 × textract_conf + 0.6 × llm_conf."""
    result = {}
    for field_name in FIELD_WEIGHTS:
        t_conf = textract_fields.get(field_name, {}).get("confidence", 0.0)
        llm_value = llm_fields.get(field_name)
        l_conf = _llm_field_confidence(field_name, llm_value)
        result[field_name] = round(0.4 * t_conf + 0.6 * l_conf, 4)
    return result


def _llm_field_confidence(field_name: str, value) -> float:
    if value is None:
        return 0.0
    base = 0.90
    try:
        if field_name == "invoice_date":
            datetime.strptime(str(value), "%Y-%m-%d")
        elif field_name in ("total_amount", "tax_amount", "subtotal"):
            float(value)
        elif field_name == "currency":
            if len(str(value)) != 3:
                return 0.40
    except (ValueError, TypeError):
        return 0.30
    return base


def _doc_confidence(field_confidences: dict) -> float:
    """Weighted average across all tracked fields."""
    score = sum(field_confidences.get(f, 0) * w for f, w in FIELD_WEIGHTS.items())
    return round(score, 4)


# ── DB helpers ─────────────────────────────────────────────────────────────────

def _update_status(invoice_id: str, status: str, *, confidence: float = None, is_invoice: bool = None):
    parts = ["status = :status", "updated_at = NOW()"]
    params = [
        {"name": "status", "value": {"stringValue": status}},
        {"name": "id",     "value": {"stringValue": invoice_id}},
    ]
    if confidence is not None:
        parts.append("confidence_doc = :conf")
        params.append({"name": "conf", "value": {"doubleValue": confidence}})
    if is_invoice is not None:
        parts.append("is_invoice = :is_invoice")
        params.append({"name": "is_invoice", "value": {"booleanValue": is_invoice}})

    rds.execute_statement(
        resourceArn=DB_CLUSTER_ARN,
        secretArn=DB_SECRET_ARN,
        database=DB_NAME,
        sql=f"UPDATE invoices SET {', '.join(parts)} WHERE id = :id::uuid",
        parameters=params,
    )


def _save_fields(invoice_id: str, llm_fields: dict, field_confidences: dict):
    for field_name, raw_value in llm_fields.items():
        if raw_value is None:
            continue
        rds.execute_statement(
            resourceArn=DB_CLUSTER_ARN,
            secretArn=DB_SECRET_ARN,
            database=DB_NAME,
            sql=(
                "INSERT INTO invoice_fields "
                "(id, invoice_id, field_name, raw_value, normalised_value, confidence, source) "
                "VALUES (:id::uuid, :invoice_id::uuid, :field_name, :raw_value, :norm, :conf, 'llm')"
            ),
            parameters=[
                {"name": "id",          "value": {"stringValue": str(uuid.uuid4())}},
                {"name": "invoice_id",  "value": {"stringValue": invoice_id}},
                {"name": "field_name",  "value": {"stringValue": field_name}},
                {"name": "raw_value",   "value": {"stringValue": str(raw_value)}},
                {"name": "norm",        "value": {"stringValue": str(raw_value)}},
                {"name": "conf",        "value": {"doubleValue": field_confidences.get(field_name, 0.0)}},
            ],
        )


def _create_review_task(invoice_id: str, doc_confidence: float, field_confidences: dict, llm_fields: dict):
    low_fields = {
        f: {"confidence": c, "value": llm_fields.get(f)}
        for f, c in field_confidences.items()
        if c < REVIEW_THRESHOLD
    }
    rds.execute_statement(
        resourceArn=DB_CLUSTER_ARN,
        secretArn=DB_SECRET_ARN,
        database=DB_NAME,
        sql=(
            "INSERT INTO human_review_tasks "
            "(id, invoice_id, doc_confidence, low_confidence_fields, status) "
            "VALUES (:id::uuid, :invoice_id::uuid, :conf, :fields::jsonb, 'OPEN')"
        ),
        parameters=[
            {"name": "id",         "value": {"stringValue": str(uuid.uuid4())}},
            {"name": "invoice_id", "value": {"stringValue": invoice_id}},
            {"name": "conf",       "value": {"doubleValue": doc_confidence}},
            {"name": "fields",     "value": {"stringValue": json.dumps(low_fields)}},
        ],
    )


def _mark_failed(invoice_id: str, bucket: str, key: str, reason: str):
    _log(invoice_id, "failed", reason=reason)
    try:
        s3.copy_object(
            Bucket=bucket,
            CopySource={"Bucket": bucket, "Key": key},
            Key=f"failed/{key}",
        )
    except Exception as exc:
        _log(invoice_id, "s3_copy_error", error=str(exc))
    _update_status(invoice_id, "FAILED")
    _emit("InvoicesFailed", 1)
    # Do NOT raise — SQS must not retry; we already exhausted our own retries


def _delete_s3_object(bucket: str, key: str):
    try:
        s3.delete_object(Bucket=bucket, Key=key)
    except Exception as exc:
        _log("s3", "delete_error", bucket=bucket, key=key, error=str(exc))


# ── CloudWatch metrics ─────────────────────────────────────────────────────────

def _emit(metric_name: str, value: float, unit: str = "Count"):
    try:
        cloudwatch.put_metric_data(
            Namespace=CW_NAMESPACE,
            MetricData=[{"MetricName": metric_name, "Value": value, "Unit": unit}],
        )
    except Exception as exc:
        _log("metrics", "emit_error", metric=metric_name, error=str(exc))


# ── Logging ────────────────────────────────────────────────────────────────────

def _log(invoice_id: str, step: str, **kwargs):
    print(json.dumps({"invoice_id": invoice_id, "step": step, **kwargs}))
