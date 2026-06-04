locals {
  cw_namespace = "B2BPlatform/InvoiceProcessing"
}

resource "aws_cloudwatch_dashboard" "main" {
  dashboard_name = "${var.project_prefix}-${var.environment}"

  dashboard_body = jsonencode({
    widgets = [
      {
        type   = "metric"
        x      = 0
        y      = 0
        width  = 12
        height = 6
        properties = {
          region = var.aws_region
          title  = "Invoice Processing Volume"
          view   = "timeSeries"
          period = 3600
          stat   = "Sum"
          metrics = [
            [local.cw_namespace, "InvoicesExtracted"],
            [local.cw_namespace, "InvoicesPendingReview"],
            [local.cw_namespace, "InvoicesRejected"],
            [local.cw_namespace, "InvoicesFailed"],
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 0
        width  = 12
        height = 6
        properties = {
          region = var.aws_region
          title  = "Avg Document Confidence (0-100)"
          view   = "timeSeries"
          period = 3600
          stat   = "Average"
          metrics = [
            [local.cw_namespace, "DocumentConfidence"]
          ]
          yAxis = { left = { min = 0, max = 100 } }
        }
      },
      {
        type   = "metric"
        x      = 0
        y      = 6
        width  = 12
        height = 6
        properties = {
          region = var.aws_region
          title  = "Processing Duration P95 (ms)"
          view   = "timeSeries"
          period = 3600
          stat   = "p95"
          metrics = [
            [local.cw_namespace, "ProcessingDurationMs"]
          ]
        }
      },
      {
        type   = "metric"
        x      = 12
        y      = 6
        width  = 12
        height = 6
        properties = {
          region = var.aws_region
          title  = "Open Human Review Tasks"
          view   = "singleValue"
          period = 300
          stat   = "Sum"
          metrics = [
            [local.cw_namespace, "InvoicesPendingReview"]
          ]
        }
      },
    ]
  })
}

resource "aws_cloudwatch_metric_alarm" "low_confidence" {
  alarm_name          = "${var.project_prefix}-low-avg-confidence"
  comparison_operator = "LessThanThreshold"
  evaluation_periods  = 3
  metric_name         = "DocumentConfidence"
  namespace           = local.cw_namespace
  period              = 3600
  statistic           = "Average"
  threshold           = 85
  alarm_description   = "Average extraction confidence dropped below 85 for 3 consecutive hours"
  treat_missing_data  = "notBreaching"
}
