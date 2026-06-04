import base64
import json
import os
import re
import uuid

import boto3

s3 = boto3.client("s3")
sqs = boto3.client("sqs")
rds = boto3.client("rds-data")
PRESIGN_EXPIRY = 3600  # 1 hour

S3_BUCKET = os.environ["S3_BUCKET"]
SQS_QUEUE_URL = os.environ["SQS_QUEUE_URL"]
DB_CLUSTER_ARN = os.environ["DB_CLUSTER_ARN"]
DB_SECRET_ARN = os.environ["DB_SECRET_ARN"]
DB_NAME = os.environ["DB_NAME"]

MAX_PDF_BYTES = 50 * 1024 * 1024  # 50 MB


def handler(event, context):
    method = (event.get("requestContext") or {}).get("http", {}).get("method", "POST")
    path = event.get("rawPath", "")

    if method == "GET" and path.endswith("/preview"):
        invoice_id = (event.get("pathParameters") or {}).get("invoice_id")
        return _get_preview(invoice_id)

    if method == "GET":
        job_id = (event.get("pathParameters") or {}).get("job_id")
        return _get_status(job_id)

    try:
        pdf_bytes = _extract_pdf(event)
    except ValueError as e:
        return _error(400, str(e))

    invoice_id = str(uuid.uuid4())
    s3_key = f"{invoice_id}/raw.pdf"

    s3.put_object(
        Bucket=S3_BUCKET,
        Key=s3_key,
        Body=pdf_bytes,
        ContentType="application/pdf",
    )

    rds.execute_statement(
        resourceArn=DB_CLUSTER_ARN,
        secretArn=DB_SECRET_ARN,
        database=DB_NAME,
        sql="INSERT INTO invoices (id, status, s3_key) VALUES (:id::uuid, 'PROCESSING', :s3_key)",
        parameters=[
            {"name": "id", "value": {"stringValue": invoice_id}},
            {"name": "s3_key", "value": {"stringValue": s3_key}},
        ],
    )

    sqs.send_message(
        QueueUrl=SQS_QUEUE_URL,
        MessageBody=json.dumps({
            "invoice_id": invoice_id,
            "s3_key": s3_key,
            "s3_bucket": S3_BUCKET,
        }),
        MessageGroupId="invoice-processing",
        MessageDeduplicationId=invoice_id,
    )

    return {
        "statusCode": 202,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps({"job_id": invoice_id, "status": "PROCESSING"}),
    }


def _get_preview(invoice_id: str):
    if not invoice_id:
        return _error(400, "Missing invoice_id")
    result = rds.execute_statement(
        resourceArn=DB_CLUSTER_ARN,
        secretArn=DB_SECRET_ARN,
        database=DB_NAME,
        sql="SELECT s3_key FROM invoices WHERE id = :id::uuid",
        parameters=[{"name": "id", "value": {"stringValue": invoice_id}}],
    )
    if not result["records"]:
        return _error(404, "Invoice not found")
    s3_key = result["records"][0][0]["stringValue"]
    url = s3.generate_presigned_url(
        "get_object",
        Params={"Bucket": S3_BUCKET, "Key": s3_key},
        ExpiresIn=PRESIGN_EXPIRY,
    )
    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps({"url": url, "expires_in": PRESIGN_EXPIRY}),
    }


def _get_status(job_id: str):
    if not job_id:
        return _error(400, "Missing job_id")
    result = rds.execute_statement(
        resourceArn=DB_CLUSTER_ARN,
        secretArn=DB_SECRET_ARN,
        database=DB_NAME,
        sql="SELECT status, confidence_doc, is_invoice, created_at FROM invoices WHERE id = :id::uuid",
        parameters=[{"name": "id", "value": {"stringValue": job_id}}],
    )
    if not result["records"]:
        return _error(404, "Job not found")
    r = result["records"][0]
    return {
        "statusCode": 200,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps({
            "job_id": job_id,
            "status": r[0]["stringValue"],
            "confidence": r[1].get("doubleValue"),
            "is_invoice": r[2].get("booleanValue"),
            "created_at": r[3]["stringValue"],
        }),
    }


def _extract_pdf(event: dict) -> bytes:
    content_type = (event.get("headers") or {}).get("content-type", "")
    if "multipart/form-data" not in content_type:
        raise ValueError("Content-Type must be multipart/form-data")

    boundary_match = re.search(r"boundary=([^\s;]+)", content_type)
    if not boundary_match:
        raise ValueError("Missing multipart boundary")
    boundary = boundary_match.group(1).encode()

    body = event.get("body") or ""
    if event.get("isBase64Encoded"):
        raw = base64.b64decode(body)
    else:
        raw = body.encode("latin-1") if isinstance(body, str) else body

    pdf_bytes = _parse_multipart(raw, boundary)
    if pdf_bytes is None:
        raise ValueError("No file part found in request")
    if not pdf_bytes.startswith(b"%PDF"):
        raise ValueError("Uploaded file is not a valid PDF")
    if len(pdf_bytes) > MAX_PDF_BYTES:
        raise ValueError("PDF exceeds 50 MB limit")

    return pdf_bytes


def _parse_multipart(body: bytes, boundary: bytes) -> bytes | None:
    delimiter = b"--" + boundary
    for part in body.split(delimiter):
        if b"filename=" in part and b"\r\n\r\n" in part:
            _, content = part.split(b"\r\n\r\n", 1)
            return content.rstrip(b"\r\n--")
    return None


def _error(status: int, message: str) -> dict:
    return {
        "statusCode": status,
        "headers": {"Content-Type": "application/json"},
        "body": json.dumps({"error": message}),
    }
