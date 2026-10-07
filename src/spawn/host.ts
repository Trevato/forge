/**
 * Host dispatch for hosted children: a request whose Host is
 * `<name>--<parentHost>` is answered by that child's own App (data under
 * `children/<bodyId>`), not the parent's pages. The ledger is the source of
 * truth; BodyStore is only for placement capacity.
 */

import { childDirOf } from "../actions/spawn.ts";
import { createApp, type App } from "../app.ts";
import { childHost } from "./door.ts";
import { firstBoot } from "./first-boot.ts";
import { childPublicUrl, parseHostedChildName } from "./placement.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface ChildLedger {
  readonly name: string;
  readonly bodyId: string;
  readonly done: boolean;
}

function readLedgerSync(app: App, name: string): ChildLedger | undefined {
  try {
    const raw = readFileSync(join(app.config.dataDir, "spawn", `${name}.json`), "utf8");
    const parsed = JSON.parse(raw) as {
      name?: unknown;
      bodyId?: unknown;
      done?: unknown;
    };
    if (typeof parsed.name !== "string" || typeof parsed.bodyId !== "string") return undefined;
    return { name: parsed.name, bodyId: parsed.bodyId, done: parsed.done === true };
  } catch {
    return undefined;
  }
}

const caches = new WeakMap<App, Map<string, App>>();

function cacheOf(parent: App): Map<string, App> {
  let m = caches.get(parent);
  if (!m) {
    m = new Map();
    caches.set(parent, m);
  }
  return m;
}

/** Drop every hosted child App this parent has open (call when the parent stops). */
export function closeHostedChildren(parent: App): void {
  const m = caches.get(parent);
  if (!m) return;
  for (const child of m.values()) child.close();
  m.clear();
  caches.delete(parent);
}

async function openChild(parent: App, ledger: ChildLedger): Promise<App> {
  const url = childPublicUrl(ledger.name, childHost(parent));
  const child = createApp({
    dataDir: childDirOf(parent, ledger.bodyId),
    url,
    ...(parent.config.trustedProxies !== undefined
      ? { trustedProxies: parent.config.trustedProxies }
      : {}),
    ...(parent.config.clientIpHeader !== undefined
      ? { clientIpHeader: parent.config.clientIpHeader }
      : {}),
  });
  await firstBoot(child);
  return child;
}

/**
 * Resolve a request Host to a hosted child's App.
 * - `undefined` — not a child host (parent / app / other continues).
 * - `"unknown"` — shaped like a child host but no finished ledger.
 * - `App` — answer with this child's routes.
 */
export async function resolveHostedChild(
  parent: App,
  request: Request,
): Promise<App | "unknown" | undefined> {
  const host = request.headers.get("host");
  if (host === null) return undefined;
  const name = parseHostedChildName(host, childHost(parent));
  if (name === undefined) return undefined;
  const ledger = readLedgerSync(parent, name);
  if (ledger === undefined || !ledger.done) return "unknown";

  const cache = cacheOf(parent);
  const hit = cache.get(ledger.bodyId);
  if (hit) return hit;
  const opened = await openChild(parent, ledger);
  cache.set(ledger.bodyId, opened);
  return opened;
}
