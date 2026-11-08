/**
 * Changing who is trusted (#8937): the owner's list, the kill switch and
 * the revert of one source's landings. Only a forge admin who is a person
 * may; each change is an event, so it is audited and the feed shows it.
 */
import type { App } from "../app.ts";
import { listEveryRepo } from "../core/repos.ts";
import {
  resumeFoldIn,
  stopFoldIn,
  trustSource,
  untrust,
  type TrustError,
  type TrustedSource,
} from "../core/trusted_sources.ts";
import type { User } from "../core/users.ts";
import { revertSource } from "../crew/fold_in.ts";
import { err, ok, type Result } from "../kernel/result.ts";

const mayChange = (actor: User | undefined): actor is User =>
  actor !== undefined && actor.isAdmin && actor.kind !== "agent";

export function addTrust(
  app: App,
  actor: User | undefined,
  input: { host: string; account: string; until: string },
): Result<TrustedSource, TrustError | "not_found"> {
  if (!mayChange(actor)) return err("not_found");
  const made = trustSource(app.db, { ...input, setBy: actor.username });
  if (typeof made === "string") return err(made);
  app.bus.append({
    kind: "trust.set",
    actorId: actor.id,
    payload: { account: made.account, host: made.host, until: made.until },
  });
  return ok(made);
}

export function removeTrust(app: App, actor: User | undefined, sourceId: string): Result<TrustedSource, "not_found"> {
  if (!mayChange(actor)) return err("not_found");
  const gone = untrust(app.db, sourceId);
  if (gone === undefined) return err("not_found");
  app.bus.append({ kind: "trust.removed", actorId: actor.id, payload: { account: gone.account, host: gone.host } });
  return ok(gone);
}

/** The kill switch: all folding in stops at once, and resumes on one action too. */
export function setFoldInStopped(app: App, actor: User | undefined, stopped: boolean): Result<boolean, "not_found"> {
  if (!mayChange(actor)) return err("not_found");
  if (stopped) stopFoldIn(app.db, actor.username);
  else resumeFoldIn(app.db);
  app.bus.append({ kind: stopped ? "foldin.stopped" : "foldin.resumed", actorId: actor.id, payload: {} });
  return ok(stopped);
}

/** Open a revert for everything one source landed, in every repository. */
export async function revertBySource(
  app: App,
  actor: User | undefined,
  host: string,
  account: string,
): Promise<Result<{ opened: number; refused: number }, "not_found">> {
  if (!mayChange(actor)) return err("not_found");
  let opened = 0;
  let refused = 0;
  for (const repo of listEveryRepo(app.db)) {
    const r = await revertSource(app, actor, repo, host, account);
    opened += r.opened.length;
    refused += r.refused.length;
  }
  app.bus.append({ kind: "trust.reverted", actorId: actor.id, payload: { account, host, opened, refused } });
  return ok({ opened, refused });
}
