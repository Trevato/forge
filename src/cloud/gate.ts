/**
 * The gate every vendor call goes through (docs/CLOUD.md). A call is either
 * an operator's (an admin verifying or auditing a token they attached) or a
 * hand-out to a run, which `cloud.json` must declare for the key's vendor.
 * Each writes one audit row; a refused hand-out never opens the key. A token is not an argument here, so it
 * cannot reach a row or a message.
 */

import type { Database } from "bun:sqlite";
import type { CloudDeclaration } from "../apps/manifest.ts";
import { accountOfSecret } from "../core/cloud_account.ts";
import { recordAudit } from "../core/cloud_audit.ts";
import { VENDOR_OF, isProvider, type Fetch } from "./providers.ts";

export interface Who {
  readonly provider: string;
  readonly account: string;
}

/** A `Fetch` for an admin's own verify or audit: one audit row per request. */
export function gatedFetch(
  db: Database,
  who: Who,
  purpose: string,
  f: Fetch,
): Fetch {
  return async (url, init) => {
    const u = new URL(url);
    recordAudit(db, {
      provider: who.provider,
      account: who.account,
      purpose,
      target: `${u.host}${u.pathname}`,
      bytesOut: bytesOf(init),
      allowed: true,
    });
    return f(url, init);
  };
}

/** Bytes a request body puts on the wire. */
function bytesOf(init: RequestInit | undefined): number {
  const b = init?.body;
  if (b === undefined || b === null) return 0;
  if (typeof b === "string") return Buffer.byteLength(b);
  if (b instanceof URLSearchParams) return Buffer.byteLength(b.toString());
  if (b instanceof ArrayBuffer || ArrayBuffer.isView(b)) return b.byteLength;
  return 0;
}

/**
 * A hand-out of a token to a run: allowed when `cloud.json` declares the
 * provider's vendor (`VENDOR_OF`) for any use, audited either way. Returns
 * whether to open the value.
 */
export function handOut(
  db: Database,
  who: Who,
  runId: string,
  declared: readonly CloudDeclaration[] | undefined,
): boolean {
  const vendor = isProvider(who.provider) ? VENDOR_OF[who.provider] : undefined;
  const use =
    vendor === undefined
      ? undefined
      : declared?.find((d) => d.vendor === vendor)?.use;
  const ok = use !== undefined;
  recordAudit(db, {
    provider: who.provider,
    account: who.account,
    purpose: `hand-out:${use ?? "undeclared"}`,
    target: `run ${runId}`,
    bytesOut: 0,
    allowed: ok,
  });
  return ok;
}

/**
 * What a run is asked to hold, minus every cloud key its repository does not
 * declare: those are named in `refused` and never reach `grantSecrets`, so
 * they are never opened. Each cloud name is audited.
 */
export function bar<T extends { names: readonly string[]; refused: readonly string[] }>(
  db: Database,
  asked: T,
  runId: string,
  declared: readonly CloudDeclaration[],
): T {
  const barred = asked.names.filter((n) => {
    const a = accountOfSecret(n);
    return a !== undefined && !handOut(db, { provider: a.provider, account: a.name }, runId, declared);
  });
  return {
    ...asked,
    names: asked.names.filter((n) => !barred.includes(n)),
    refused: [...asked.refused, ...barred.map((n) => `${n}: its vendor is not declared in cloud.json`)],
  };
}
