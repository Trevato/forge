/**
 * The origin's webhook, in both directions.
 *
 * Out: after a pull is proposed there, a forge origin is asked once to send
 * this mirror's door its events (`watchPulls`). In: the delivery is believed
 * for nothing but "look again" — it is signed with a secret only this forge
 * and the origin hold, and it only names an issue or a pull, which is then
 * read from the origin as the sync worker would (`item-check.ts`,
 * `pull-check.ts`). The secret is derived from the forge's key and the
 * repository, so nothing is stored.
 */

import type { App } from "../app.ts";
import { verifySignature } from "../core/webhooks.ts";
import { originForRepo } from "../core/origins.ts";
import type { Repo } from "../core/repos.ts";
import { bustOrigin } from "../view/cache.ts";
import { providerForOrigin } from "./credential.ts";
import { HOOK_SIGNATURE_HEADER, hookSecret, hookUrl, signatureOf } from "./hook-secret.ts";
import { refreshOriginItem } from "./item-check.ts";
import { refreshOriginPull } from "./pull-check.ts";

export { HOOK_SIGNATURE_HEADER, hookSecret, hookUrl, signatureOf };

/** The most a delivery may say; it names a pull and little else. */
export const HOOK_BODY_MAX = 256 * 1024;

/** The pull number a delivery names: ours, Gitea's or GitHub's shape. */
export function numberIn(body: unknown): number | undefined {
  const at = (v: unknown, key: string): unknown =>
    typeof v === "object" && v !== null ? (v as Record<string, unknown>)[key] : undefined;
  for (const n of [
    at(at(body, "payload"), "number"),
    at(body, "number"),
    at(at(body, "pull_request"), "number"),
  ])
    if (typeof n === "number" && Number.isSafeInteger(n) && n > 0) return n;
  return undefined;
}

/**
 * A delivery for a mirror: answers whether it was accepted. Every refusal is
 * the same answer, so nothing says which mirrors have an origin.
 */
export async function receiveOriginHook(
  app: App,
  repo: Repo,
  raw: string,
  signature: string | null,
): Promise<boolean> {
  const link = originForRepo(app.db, repo.id);
  if (!link || signature === null) return false;
  if (!(await verifySignature(hookSecret(app, repo), raw, signature))) return false;
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return false;
  }
  const provider = providerForOrigin(app, link.origin);
  if (!provider.ok) return false;
  const ctx = { db: app.db, repoId: repo.id, actorId: link.origin.userId };
  const number = numberIn(body);
  // A delivery naming no pull costs nothing; the sync sweep catches up.
  if (number === undefined) return true;
  // The item and its thread first (issue or pull), then a pull's check.
  const item = await refreshOriginItem(ctx, provider.value, link.fullName, number);
  // An origin that cannot be read is a refusal, so it sends the event again.
  if (item === false) return false;
  if (item === "pull") await refreshOriginPull(ctx, provider.value, link.fullName, number);
  bustOrigin(link.origin.id, link.fullName);
  return true;
}

/**
 * Ask the origin to deliver this mirror's events here, once. Best effort: an
 * origin that cannot be asked is still polled, so the pull is never lost.
 */
export async function watchPulls(app: App, repo: Repo): Promise<void> {
  const link = originForRepo(app.db, repo.id);
  const url = hookUrl(app, repo);
  if (!link || url === undefined || link.origin.software !== "forge") return;
  const provider = providerForOrigin(app, link.origin);
  if (!provider.ok || provider.value.watch === undefined) return;
  await provider.value.watch(link.fullName, { url, secret: hookSecret(app, repo) });
}

/** The longest the origin is given to accept the hook. */
export const WATCH_TIMEOUT_MS = 10_000;

/**
 * `watchPulls`, for the request path: the caller does not wait for it, and it
 * gives up after `WATCH_TIMEOUT_MS`. It never rejects.
 */
export function watchPullsSoon(app: App, repo: Repo, timeoutMs = WATCH_TIMEOUT_MS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const giveUp = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  return Promise.race([watchPulls(app, repo).catch(() => undefined), giveUp]).finally(() =>
    clearTimeout(timer),
  );
}
