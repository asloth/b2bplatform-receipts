variable "aws_region" {
  description = "AWS region to deploy into"
  default     = "us-east-1"
}

variable "project_prefix" {
  description = "Short prefix for all resource names"
  default     = "b2bplatform"
}

variable "environment" {
  description = "Deployment environment (demo, staging, prod)"
  default     = "demo"
}

variable "bedrock_region" {
  description = "AWS region for Bedrock inference — must support Claude Haiku (us-east-1, us-west-2, eu-west-1)"
  default     = "us-east-1"
}

variable "review_api_key" {
  description = "Static key for the reviewer endpoint (X-Review-Key header). Change in production."
  default     = "demo-reviewer-key-change-in-prod"
  sensitive   = true
}
