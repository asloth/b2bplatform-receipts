#!/usr/bin/env bash
# Usage: bash scripts/test_upload.sh <path/to/invoice.pdf>
set -euo pipefail

PDF_FILE="${1:-}"
if [[ -z "$PDF_FILE" || ! -f "$PDF_FILE" ]]; then
    echo "Usage: bash scripts/test_upload.sh <path/to/invoice.pdf>"
    exit 1
fi

API_URL=$(terraform -chdir=terraform output -raw upload_url)
echo "Uploading $(basename "$PDF_FILE") to $API_URL ..."

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$API_URL" \
    -F "file=@${PDF_FILE};type=application/pdf")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -n -1)

echo "HTTP $HTTP_CODE"
echo "$BODY" | python3 -m json.tool

if [[ "$HTTP_CODE" == "202" ]]; then
    JOB_ID=$(echo "$BODY" | python3 -c "import sys,json; print(json.load(sys.stdin)['job_id'])")
    echo ""
    echo "Job queued. Check status in ~10s with:"
    echo "  python scripts/check_status.py $JOB_ID"
fi
