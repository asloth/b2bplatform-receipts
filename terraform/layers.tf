# Build PyMuPDF Lambda layer locally, then upload.
# Only re-runs if the version pin changes.
resource "null_resource" "pymupdf_build" {
  triggers = {
    pymupdf_version = "1.24.0"
    python_version  = "3.12"
  }

  provisioner "local-exec" {
    command = <<-EOT
      pip install "pymupdf==1.24.0" \
        -t "/tmp/${var.project_prefix}-pymupdf-layer/python" \
        --platform manylinux2014_x86_64 \
        --only-binary=:all: \
        --python-version 3.12 \
        --quiet
    EOT
  }
}

data "archive_file" "pymupdf_layer" {
  depends_on  = [null_resource.pymupdf_build]
  type        = "zip"
  source_dir  = "/tmp/${var.project_prefix}-pymupdf-layer"
  output_path = "/tmp/${var.project_prefix}-pymupdf-layer.zip"
}

resource "aws_lambda_layer_version" "pymupdf" {
  filename            = data.archive_file.pymupdf_layer.output_path
  layer_name          = "${var.project_prefix}-pymupdf"
  compatible_runtimes = ["python3.12"]
  source_code_hash    = data.archive_file.pymupdf_layer.output_base64sha256
}
