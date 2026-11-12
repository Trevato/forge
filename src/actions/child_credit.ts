/**
 * An admin sets the dollars a child may spend on this forge's model
 * credential (#10484). The first time mints the child's bearer and hands it
 * to the child's `parent.json` and only then saves it (a failed hand-off
 * leaves nothing, so a retry mints again); later ones only move the cap. An
 * event on the outbox, so the audit has it.
 */

import type { App } from "../app.ts";
import { childDirOf, listChildren } from "./spawn.ts";
import { setCap, type Credit } from "../spawn/credit.ts";
import { fundingOf, keepFunding } from "../spawn/funding.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireUser } from "./access.ts";

export type CreditError = "unauthorized" | "forbidden" | "not_found" | "invalid_amount" | "unreachable";

export async function lendCredit(
  app: App,
  actor: User | undefined,
  name: string,
  usd: unknown,
): Promise<Result<Credit, CreditError>> {
  const user = requireUser(actor);
  if (!user.ok) return err("unauthorized");
  if (!user.value.isAdmin) return err("forbidden");
  const child = (await listChildren(app)).find((c) => c.name === name && c.done);
  if (child === undefined) return err("not_found");
  if (typeof usd !== "number") return err("invalid_amount");
  const dir = childDirOf(app, child.bodyId);
  const set = setCap(app, name, usd, fundingOf(dir) !== undefined, (token, credit) =>
    keepFunding(dir, { token, capUsd: credit.capUsd, spentUsd: credit.spentUsd }),
  );
  if (set === undefined) return err("invalid_amount");
  if (set === "unreachable") return err("unreachable");
  app.bus.append({ kind: "forge.credit_set", actorId: user.value.id, payload: { name, usd: set.capUsd } });
  return ok(set);
}
