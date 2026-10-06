variable "name" {
  description = "The forge's name. Must start with spike- while this is a spike; every resource carries it."
  type        = string
  validation {
    condition     = can(regex("^spike-[a-z0-9-]{1,40}$", var.name))
    error_message = "name must match ^spike-[a-z0-9-]{1,40}$ — the spike never touches names outside that prefix."
  }
}

variable "account_id" {
  type = string
}

variable "zone_id" {
  type = string
}

variable "zone_name" {
  description = "The zone's domain, e.g. example.com; the forge answers at <name>.<zone_name>."
  type        = string
}

variable "body_url" {
  description = "Where the forge's body answers over HTTPS (a Fly app, a Container's URL, a box behind a tunnel). Empty: the module makes a tunnel and you point cloudflared at it."
  type        = string
  default     = ""
}
