output "url" {
  value = "https://${local.host}"
}

output "tunnel_token_command" {
  description = "Run on the body when it has no public address."
  value       = local.use_tunel ? "cloudflared tunnel token ${cloudflare_zero_trust_tunnel_cloudflared.body[0].id}" : null
}
