resource "aws_s3_bucket" "pdfs" {
  bucket        = "${var.project_prefix}-pdfs-${var.environment}-${data.aws_caller_identity.current.account_id}"
  force_destroy = true # lets terraform destroy work even when bucket has objects
}

resource "aws_s3_bucket_versioning" "pdfs" {
  bucket = aws_s3_bucket.pdfs.id
  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "pdfs" {
  bucket = aws_s3_bucket.pdfs.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "pdfs" {
  bucket = aws_s3_bucket.pdfs.id

  rule {
    id     = "expire-failed-pdfs"
    status = "Enabled"
    filter {
      prefix = "failed/"
    }
    expiration {
      days = 30
    }
  }
}

resource "aws_s3_bucket_public_access_block" "pdfs" {
  bucket                  = aws_s3_bucket.pdfs.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
