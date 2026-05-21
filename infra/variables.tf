variable "aws_region" {
  description = "AWS region"
  type        = string
  default     = "us-east-2"
}

variable "domain_name" {
  description = "Full domain name e.g. app.yourdomain.com"
  type        = string
}

variable "hosted_zone_id" {
  description = "Route 53 hosted zone ID"
  type        = string
}

variable "ec2_instance_id" {
  description = "EC2 instance ID e.g. i-0abc123"
  type        = string
}

variable "vpc_id" {
  description = "VPC ID where EC2 is running"
  type        = string
}

variable "subnet_ids" {
  description = "List of public subnet IDs for ALB (min 2, different AZs)"
  type        = list(string)
}

variable "app_port" {
  description = "Port the app listens on inside EC2"
  type        = number
  default     = 3001
}

variable "ec2_iam_role_name" {
  description = "Name of the IAM role attached to the EC2 instance"
  type        = string
}

variable "app_name" {
  description = "App name used to namespace CloudWatch log group and IAM policy"
  type        = string
  default     = "p2p-trading"
}

variable "log_retention_days" {
  description = "Days to retain Docker logs in CloudWatch (0 = never expire)"
  type        = number
  default     = 30
}
