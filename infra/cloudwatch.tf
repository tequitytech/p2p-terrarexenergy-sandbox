# ── CloudWatch Log Group ─────────────────────────────────────────────────────

resource "aws_cloudwatch_log_group" "docker" {
  name              = "/docker/${var.app_name}"
  retention_in_days = var.log_retention_days
}

# ── IAM Policy ───────────────────────────────────────────────────────────────

resource "aws_iam_policy" "docker_cloudwatch_logs" {
  name        = "${var.app_name}-docker-cloudwatch-logs"
  description = "Allows EC2 Docker awslogs driver to push to CloudWatch"

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect = "Allow"
        Action = [
          "logs:CreateLogGroup",
          "logs:CreateLogStream",
          "logs:PutLogEvents",
          "logs:DescribeLogGroups",
          "logs:DescribeLogStreams"
        ]
        Resource = "${aws_cloudwatch_log_group.docker.arn}:*"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "docker_logs" {
  role       = var.ec2_iam_role_name
  policy_arn = aws_iam_policy.docker_cloudwatch_logs.arn
}
