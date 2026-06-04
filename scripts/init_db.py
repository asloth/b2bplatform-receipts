#!/usr/bin/env python3
"""
Run once after terraform apply to create (or migrate) the DB schema.
Usage: python scripts/init_db.py
"""
import json
import subprocess
import sys

import boto3


def terraform_output(key: str) -> str:
    result = subprocess.run(
        ["terraform", "output", "-raw", key],
        capture_output=True,
        text=True,
        cwd="terraform",
    )
    if result.returncode != 0:
        print(f"ERROR: could not get terraform output '{key}': {result.stderr.strip()}")
        sys.exit(1)
    return result.stdout.strip()


SCHEMA = [
    # Extensions
    'CREATE EXTENSION IF NOT EXISTS "pgcrypto"',

    # Core invoices table
    """CREATE TABLE IF NOT EXISTS invoices (
        id             UUID PRIMARY KEY,
        status         TEXT NOT NULL DEFAULT 'PROCESSING',
        s3_key         TEXT NOT NULL,
        confidence_doc NUMERIC(5,4),
        is_invoice     BOOLEAN DEFAULT TRUE,
        created_at     TIMESTAMPTZ DEFAULT NOW(),
        updated_at     TIMESTAMPTZ DEFAULT NOW()
    )""",

    # Extracted fields (one row per field per invoice)
    """CREATE TABLE IF NOT EXISTS invoice_fields (
        id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        invoice_id       UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
        field_name       TEXT NOT NULL,
        raw_value        TEXT,
        normalised_value TEXT,
        confidence       NUMERIC(5,4),
        source           TEXT
    )""",

    # Human review tasks (created when doc_confidence < 0.85)
    """CREATE TABLE IF NOT EXISTS human_review_tasks (
        id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        invoice_id            UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
        doc_confidence        NUMERIC(5,4),
        low_confidence_fields JSONB,
        status                TEXT NOT NULL DEFAULT 'OPEN',
        resolution_notes      TEXT,
        resolved_at           TIMESTAMPTZ,
        created_at            TIMESTAMPTZ DEFAULT NOW()
    )""",

    # Indexes
    "CREATE INDEX IF NOT EXISTS idx_fields_invoice    ON invoice_fields(invoice_id)",
    "CREATE INDEX IF NOT EXISTS idx_review_open       ON human_review_tasks(status) WHERE status = 'OPEN'",
    "CREATE INDEX IF NOT EXISTS idx_invoices_status   ON invoices(status)",
]

# Safe migrations: add columns to invoices if upgrading from a previous schema
MIGRATIONS = [
    "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS confidence_doc NUMERIC(5,4)",
    "ALTER TABLE invoices ADD COLUMN IF NOT EXISTS is_invoice BOOLEAN DEFAULT TRUE",
]


def main():
    cluster_arn = terraform_output("db_cluster_arn")
    secret_arn = terraform_output("db_secret_arn")
    region = terraform_output("aws_region")

    rds = boto3.client("rds-data", region_name=region)

    def run(sql: str):
        rds.execute_statement(
            resourceArn=cluster_arn,
            secretArn=secret_arn,
            database="invoices",
            sql=sql.strip(),
        )

    print(f"Connecting to cluster: {cluster_arn}")

    print("\nCreating schema...")
    for stmt in SCHEMA:
        preview = stmt.strip().replace("\n", " ")[:70]
        print(f"  {preview}...")
        run(stmt)

    print("\nApplying migrations...")
    for stmt in MIGRATIONS:
        print(f"  {stmt[:70]}...")
        run(stmt)

    print("\nDone. Schema is ready.")


if __name__ == "__main__":
    main()
