/**
 * What an origin's webhook delivery is signed with and sent to, shared by
 * the receiver (`hook.ts`) and the mirror's watcher (`mirror-pulls.ts`) so
 * neither imports the other. The secret is derived from the forge's key and
 * the repository, so nothing is stored.
 */

import { createHmac } from "node:crypto";
import type { App } from "../app.ts";
import type { Repo } from "../core/repos.ts";
import { loadKey } from "../kernel/secret.ts";

export const HOOK_SIGNATURE_HEADER = "x-forge-signature-256";

/** The secret the origin signs this mirror's deliveries with. */
export function hookSecret(app: App, repo: Repo): string {
  return createHmac("sha256", loadKey(app.config.dataDir))
    .update(`origin-hook:${repo.id}`)
    .digest("hex");
}

/** Where the origin delivers: https only, because the origin refuses the rest. */
export function hookUrl(app: App, repo: Repo): string | undefined {
  const base = app.config.url;
  if (base === undefined || !/^https:\/\//i.test(base)) return undefined;
  return `${base.replace(/\/+$/, "")}/api/v1/repos/${encodeURIComponent(repo.ownerName)}/${encodeURIComponent(repo.name)}/origin-hook`;
}

/**
 * The signature a delivery carries, as `sha256=<hex>`: ours, or the bare hex
 * Forgejo and Gitea send from a mirror's webhook.
 */
export function signatureOf(headers: Headers): string | null {
  const ours = headers.get(HOOK_SIGNATURE_HEADER);
  if (ours !== null) return ours;
  const hex = headers.get("x-forgejo-signature") ?? headers.get("x-gitea-signature");
  return hex !== null && /^[0-9a-f]{64}$/i.test(hex) ? `sha256=${hex.toLowerCase()}` : null;
}
