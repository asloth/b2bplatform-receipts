resource "aws_sqs_queue" "ingestion_dlq" {
  name                        = "${var.project_prefix}-ingestion-dlq.fifo"
  fifo_queue                  = true
  content_based_deduplication = true
}

resource "aws_sqs_queue" "ingestion" {
  name                        = "${var.project_prefix}-ingestion.fifo"
  fifo_queue                  = true
  content_based_deduplication = true
  # visibility timeout must be longer than worker Lambda timeout (300s)
  visibility_timeout_seconds = 360

  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.ingestion_dlq.arn
    maxReceiveCount     = 3
  })
}

resource "aws_cloudwatch_metric_alarm" "dlq_depth" {
  alarm_name          = "${var.project_prefix}-dlq-has-messages"
  comparison_operator = "GreaterThanThreshold"
  evaluation_periods  = 1
  metric_name         = "ApproximateNumberOfMessagesVisible"
  namespace           = "AWS/SQS"
  period              = 60
  statistic           = "Sum"
  threshold           = 0
  alarm_description   = "DLQ has messages — invoice processing failures need investigation"

  dimensions = {
    QueueName = aws_sqs_queue.ingestion_dlq.name
  }
}
