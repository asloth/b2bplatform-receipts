output "upload_url" {
  description = "POST here to upload a PDF invoice"
  value       = "${aws_apigatewayv2_api.main.api_endpoint}/invoices/upload"
}

output "review_tasks_url" {
  description = "GET here to list invoices pending human review"
  value       = "${aws_apigatewayv2_api.main.api_endpoint}/review/tasks"
}

output "dashboard_url" {
  description = "CloudWatch dashboard URL"
  value       = "https://${var.aws_region}.console.aws.amazon.com/cloudwatch/home?region=${var.aws_region}#dashboards:name=${aws_cloudwatch_dashboard.main.dashboard_name}"
}

output "s3_bucket_name" {
  value = aws_s3_bucket.pdfs.bucket
}

output "queue_url" {
  value = aws_sqs_queue.ingestion.url
}

output "db_cluster_arn" {
  value = aws_rds_cluster.aurora.arn
}

output "db_secret_arn" {
  value = aws_rds_cluster.aurora.master_user_secret[0].secret_arn
}

output "aws_region" {
  value = var.aws_region
}
