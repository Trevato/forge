/**
 * Cloud accounts as plain rows for the doors that are not the page (the
 * terminal, MCP): provider, name, what it is used for, when it was verified and
 * last used, and how many vendor calls it made today (UTC day). Never a token
 * value: nothing here opens the sealed secret. A forge admin's; anyone else is
 * told `not_found`.
 */

import type { App } from "../app.ts";
import { auditToday, type AuditRow } from "../core/cloud_audit.ts";
import { listCloudAccounts, recentCloudReads } from "../core/cloud_account.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { usedFor, type VendorUse } from "./declared.ts";
import { VENDOR_OF, type Provider } from "./providers.ts";

export interface AccountRow {
  readonly provider: Provider;
  readonly name: string;
  readonly summary: string;
  readonly usedFor: string;
  readonly verifiedAt: string | null;
  readonly lastUsedAt: string | null;
  readonly writeAllowed: boolean;
  readonly callsToday: number;
}

export interface CloudOverview {
  readonly accounts: AccountRow[];
  /** Today's vendor calls, newest first. */
  readonly today: AuditRow[];
}

export function cloudOverview(
  app: App,
  actor: User | undefined,
  uses: ReadonlyMap<string, readonly VendorUse[]> = new Map(),
): Result<CloudOverview, string> {
  if (actor?.isAdmin !== true) return err("not_found");
  const today = auditToday(app.db);
  const reads = recentCloudReads(app.db);
  const accounts = listCloudAccounts(app.db).map((a) => ({
    provider: a.provider,
    name: a.name,
    summary: a.summary,
    usedFor: usedFor(uses.get(VENDOR_OF[a.provider])),
    verifiedAt: a.verifiedAt,
    lastUsedAt: reads.find((r) => r.provider === a.provider && r.name === a.name)?.at ?? null,
    writeAllowed: a.writeAllowed,
    callsToday: today.filter((r) => r.provider === a.provider && r.account === a.name).length,
  }));
  return ok({ accounts, today });
}
