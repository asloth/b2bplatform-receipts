#!/usr/bin/env python3
"""
Check the processing status of an uploaded invoice.
Usage: python scripts/check_status.py <job_id>
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
        print(f"ERROR: {result.stderr.strip()}")
        sys.exit(1)
    return result.stdout.strip()


def main():
    if len(sys.argv) < 2:
        print("Usage: python scripts/check_status.py <job_id>")
        sys.exit(1)

    job_id = sys.argv[1]
    cluster_arn = terraform_output("db_cluster_arn")
    secret_arn = terraform_output("db_secret_arn")
    region = terraform_output("aws_region")

    rds = boto3.client("rds-data", region_name=region)

    # Invoice status
    result = rds.execute_statement(
        resourceArn=cluster_arn,
        secretArn=secret_arn,
        database="invoices",
        sql="SELECT id, status, s3_key, created_at, updated_at FROM invoices WHERE id = :id::uuid",
        parameters=[{"name": "id", "value": {"stringValue": job_id}}],
    )

    if not result["records"]:
        print(f"Invoice {job_id} not found.")
        sys.exit(1)

    row = result["records"][0]
    print(json.dumps({
        "job_id": row[0]["stringValue"],
        "status": row[1]["stringValue"],
        "s3_key": row[2]["stringValue"],
        "created_at": row[3]["stringValue"],
        "updated_at": row[4]["stringValue"],
    }, indent=2))

    if row[1]["stringValue"] == "EXTRACTED":
        fields_result = rds.execute_statement(
            resourceArn=cluster_arn,
            secretArn=secret_arn,
            database="invoices",
            sql="SELECT field_name, normalised_value, source FROM invoice_fields WHERE invoice_id = :id ORDER BY field_name",
            parameters=[{"name": "id", "value": {"stringValue": job_id}}],
        )
        fields = {
            r[0]["stringValue"]: r[1]["stringValue"]
            for r in fields_result["records"]
        }
        print("\nExtracted fields:")
        print(json.dumps(fields, indent=2))


if __name__ == "__main__":
    main()
