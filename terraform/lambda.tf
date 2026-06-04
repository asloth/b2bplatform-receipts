data "archive_file" "upload" {
  type        = "zip"
  source_dir  = "${path.module}/../src/upload"
  output_path = "/tmp/${var.project_prefix}-upload.zip"
}

data "archive_file" "worker" {
  type        = "zip"
  source_dir  = "${path.module}/../src/worker"
  output_path = "/tmp/${var.project_prefix}-worker.zip"
}

data "archive_file" "review" {
  type        = "zip"
  source_dir  = "${path.module}/../src/review"
  output_path = "/tmp/${var.project_prefix}-review.zip"
}

resource "aws_lambda_function" "upload" {
  function_name    = "${var.project_prefix}-upload-${var.environment}"
  role             = aws_iam_role.lambda.arn
  handler          = "handler.handler"
  runtime          = "python3.12"
  filename         = data.archive_file.upload.output_path
  source_code_hash = data.archive_file.upload.output_base64sha256
  memory_size      = 256
  timeout          = 30

  environment {
    variables = {
      S3_BUCKET      = aws_s3_bucket.pdfs.bucket
      SQS_QUEUE_URL  = aws_sqs_queue.ingestion.url
      DB_CLUSTER_ARN = aws_rds_cluster.aurora.arn
      DB_SECRET_ARN  = aws_rds_cluster.aurora.master_user_secret[0].secret_arn
      DB_NAME        = "invoices"
    }
  }
}

resource "aws_lambda_function" "worker" {
  function_name    = "${var.project_prefix}-worker-${var.environment}"
  role             = aws_iam_role.lambda.arn
  handler          = "handler.handler"
  runtime          = "python3.12"
  filename         = data.archive_file.worker.output_path
  source_code_hash = data.archive_file.worker.output_base64sha256
  memory_size      = 512
  timeout          = 300
  layers           = [aws_lambda_layer_version.pymupdf.arn]

  environment {
    variables = {
      S3_BUCKET        = aws_s3_bucket.pdfs.bucket
      SQS_QUEUE_URL    = aws_sqs_queue.ingestion.url
      DB_CLUSTER_ARN   = aws_rds_cluster.aurora.arn
      DB_SECRET_ARN    = aws_rds_cluster.aurora.master_user_secret[0].secret_arn
      DB_NAME          = "invoices"
      BEDROCK_MODEL_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0"
      BEDROCK_REGION   = var.bedrock_region
      CW_NAMESPACE     = "B2BPlatform/InvoiceProcessing"
    }
  }
}

resource "aws_lambda_function" "review" {
  function_name    = "${var.project_prefix}-review-${var.environment}"
  role             = aws_iam_role.lambda.arn
  handler          = "handler.handler"
  runtime          = "python3.12"
  filename         = data.archive_file.review.output_path
  source_code_hash = data.archive_file.review.output_base64sha256
  memory_size      = 256
  timeout          = 30

  environment {
    variables = {
      DB_CLUSTER_ARN = aws_rds_cluster.aurora.arn
      DB_SECRET_ARN  = aws_rds_cluster.aurora.master_user_secret[0].secret_arn
      DB_NAME        = "invoices"
    }
  }
}

resource "aws_lambda_event_source_mapping" "worker_sqs" {
  event_source_arn = aws_sqs_queue.ingestion.arn
  function_name    = aws_lambda_function.worker.arn
  batch_size       = 1
  enabled          = true
}
