terraform {
  required_version = ">= 1.8"
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }

  # State lives in the forge's own S3-compatible bucket, under this forge's
  # prefix and credential. Everything else comes at init time:
  #   tofu init -backend-config=backend.hcl
  # where backend.hcl holds bucket, key = "spike-<name>/tofu.tfstate",
  # endpoints = { s3 = "https://…" }, region, and the skip_* flags below.
  # Credentials come from AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, which
  # the run's declared secrets put in the environment (never a file).
  backend "s3" {
    use_lockfile                = true # S3 conditional writes: a lock object beside the state
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    use_path_style              = true
  }
}

provider "cloudflare" {} # CLOUDFLARE_API_TOKEN from the environment
