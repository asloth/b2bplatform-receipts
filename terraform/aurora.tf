resource "aws_security_group" "aurora" {
  name   = "${var.project_prefix}-aurora-${var.environment}"
  vpc_id = data.aws_vpc.default.id

  ingress {
    description = "PostgreSQL within VPC"
    from_port   = 5432
    to_port     = 5432
    protocol    = "tcp"
    cidr_blocks = [data.aws_vpc.default.cidr_block]
  }

  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_db_subnet_group" "aurora" {
  name       = "${var.project_prefix}-${var.environment}"
  subnet_ids = data.aws_subnets.default.ids
}

data "aws_rds_engine_version" "postgresql" {
  engine       = "aurora-postgresql"
  default_only = true
}

resource "aws_rds_cluster" "aurora" {
  cluster_identifier          = "${var.project_prefix}-${var.environment}"
  engine                      = "aurora-postgresql"
  engine_mode                 = "provisioned"
  engine_version              = data.aws_rds_engine_version.postgresql.version
  database_name               = "invoices"
  master_username             = "dbadmin"
  manage_master_user_password = true # Secrets Manager handles the password

  serverlessv2_scaling_configuration {
    min_capacity = 0.5
    max_capacity = 2
  }

  enable_http_endpoint   = true # Data API — Lambda connects without being in the VPC
  db_subnet_group_name   = aws_db_subnet_group.aurora.name
  vpc_security_group_ids = [aws_security_group.aurora.id]
  skip_final_snapshot    = true
  deletion_protection    = false
}

resource "aws_rds_cluster_instance" "aurora" {
  identifier         = "${var.project_prefix}-${var.environment}-1"
  cluster_identifier = aws_rds_cluster.aurora.id
  instance_class     = "db.serverless"
  engine             = aws_rds_cluster.aurora.engine
  engine_version     = aws_rds_cluster.aurora.engine_version
}
