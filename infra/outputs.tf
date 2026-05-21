output "alb_dns_name" {
  description = "ALB DNS name"
  value       = aws_lb.app.dns_name
}

output "certificate_arn" {
  description = "ACM certificate ARN"
  value       = aws_acm_certificate.cert.arn
}

output "app_url" {
  description = "App HTTPS URL"
  value       = "https://${var.domain_name}"
}
