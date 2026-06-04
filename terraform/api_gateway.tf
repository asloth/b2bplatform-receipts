resource "aws_apigatewayv2_api" "main" {
  name          = "${var.project_prefix}-api-${var.environment}"
  protocol_type = "HTTP"

  cors_configuration {
    allow_headers = ["content-type", "authorization"]
    allow_methods = ["GET", "POST", "PATCH", "OPTIONS"]
    allow_origins = ["*"]
    max_age       = 300
  }
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.main.id
  name        = "$default"
  auto_deploy = true
}

# ── Upload ────────────────────────────────────────────────────────────────────

resource "aws_apigatewayv2_integration" "upload" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.upload.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "upload" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "POST /invoices/upload"
  target    = "integrations/${aws_apigatewayv2_integration.upload.id}"
}

resource "aws_apigatewayv2_route" "invoice_status" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /invoices/{job_id}"
  target    = "integrations/${aws_apigatewayv2_integration.upload.id}"
}

resource "aws_lambda_permission" "api_gateway_upload" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.upload.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}

# ── Review (human-in-the-loop) ────────────────────────────────────────────────

resource "aws_apigatewayv2_integration" "review" {
  api_id                 = aws_apigatewayv2_api.main.id
  integration_type       = "AWS_PROXY"
  integration_uri        = aws_lambda_function.review.invoke_arn
  integration_method     = "POST"
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "review_list" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /review/tasks"
  target    = "integrations/${aws_apigatewayv2_integration.review.id}"
}

resource "aws_apigatewayv2_route" "review_get" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "GET /review/tasks/{task_id}"
  target    = "integrations/${aws_apigatewayv2_integration.review.id}"
}

resource "aws_apigatewayv2_route" "review_resolve" {
  api_id    = aws_apigatewayv2_api.main.id
  route_key = "PATCH /review/tasks/{task_id}"
  target    = "integrations/${aws_apigatewayv2_integration.review.id}"
}

resource "aws_lambda_permission" "api_gateway_review" {
  statement_id  = "AllowAPIGatewayInvokeReview"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.review.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.main.execution_arn}/*/*"
}
