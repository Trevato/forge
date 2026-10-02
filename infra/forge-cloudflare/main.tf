locals {
  host      = "${var.name}.${var.zone_name}"
  use_tunnel = var.body_url == ""
  body_url  = local.use_tunnel ? "https://${var.name}-body.${var.zone_name}" : var.body_url
}

# --- the front door: one Worker, one Durable Object -------------------------

resource "cloudflare_workers_script" "front" {
  account_id  = var.account_id
  script_name = var.name
  content     = file("${path.module}/worker.js")
  main_module = "worker.js"

  bindings = [
    { name = "FORGE", type = "durable_object_namespace", class_name = "Forge" },
    { name = "BODY_URL", type = "plain_text", text = local.body_url },
  ]

  migrations = {
    new_tag            = "v1"
    new_sqlite_classes = ["Forge"]
  }
}

resource "cloudflare_workers_route" "front" {
  zone_id = var.zone_id
  pattern = "${local.host}/*"
  script  = cloudflare_workers_script.front.script_name
}

# The route needs a proxied record to attach to; 192.0.2.1 is the documentation
# address, never reached because the Worker answers first.
resource "cloudflare_dns_record" "front" {
  zone_id = var.zone_id
  name    = var.name
  type    = "A"
  content = "192.0.2.1"
  proxied = true
  ttl     = 1
  comment = "forge spike ${var.name}: tofu destroy removes this"
}

# --- the tunnel, only when the body is a box that has no public address -----

resource "cloudflare_zero_trust_tunnel_cloudflared" "body" {
  count      = local.use_tunnel ? 1 : 0
  account_id = var.account_id
  name       = var.name
  config_src = "cloudflare"
}

resource "cloudflare_zero_trust_tunnel_cloudflared_config" "body" {
  count      = local.use_tunnel ? 1 : 0
  account_id = var.account_id
  tunnel_id  = cloudflare_zero_trust_tunnel_cloudflared.body[0].id
  config = {
    ingress = [
      { hostname = "${var.name}-body.${var.zone_name}", service = "http://127.0.0.1:3000" },
      { service = "http_status:404" },
    ]
  }
}

resource "cloudflare_dns_record" "body" {
  count   = local.use_tunnel ? 1 : 0
  zone_id = var.zone_id
  name    = "${var.name}-body"
  type    = "CNAME"
  content = "${cloudflare_zero_trust_tunnel_cloudflared.body[0].id}.cfargotunnel.com"
  proxied = true
  ttl     = 1
  comment = "forge spike ${var.name}: tunnel to the body"
}
