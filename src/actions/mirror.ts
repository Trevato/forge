/**
 * The off-box mirror, as an admin sets it. The same fields as the
 * destination (`actions/destination.ts`), validated the same way and sealed
 * as forge-level secrets under their own names; nothing is read back to a
 * person except which are set. A blank field keeps what was sealed.
 */

import type { App } from "../app.ts";
import { putSecret } from "./secrets.ts";
import { invalidField, type DestinationInput } from "./destination.ts";
import {
  clearMirrorSealed,
  mirrorSealedSet,
  MIRROR_SEALED,
  recordMirror,
} from "../snapshot/mirror.ts";
import { snapshotsOf } from "../snapshot/service.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { NOT_SEALED } from "../kernel/seal_words.ts";

const isAdmin = (actor: User | undefined): boolean => actor?.isAdmin === true;

function forgetState(app: App): void {
  try {
    recordMirror(app.config.dataDir, undefined);
  } catch {
    // The next pass overwrites it.
  }
}

/** Seal what was given (an error is `not_found` or a sentence for the page); says what is still missing. */
export function saveMirror(
  app: App,
  actor: User | undefined,
  input: DestinationInput,
): Result<string, string> {
  if (!isAdmin(actor)) return err("not_found");
  const bad = invalidField(input);
  if (bad) return err(bad);
  const fields: [string, string][] = [
    [MIRROR_SEALED.endpoint, input.endpoint],
    [MIRROR_SEALED.bucket, input.bucket],
    [MIRROR_SEALED.region, input.region],
    [MIRROR_SEALED.accessKey, input.accessKey],
    [MIRROR_SEALED.secretKey, input.secretKey],
  ];
  for (const [name, value] of fields) {
    if (value === "") continue;
    if (!putSecret(app, actor, "forge", "", name, value).ok)
      return err(NOT_SEALED);
  }
  // A new target is not judged by the old one's last pass.
  const svc = snapshotsOf(app);
  svc?.forget();
  if (fields.some(([, v]) => v !== "")) {
    forgetState(app);
    void svc?.mirrorFresh().catch(() => {});
  }
  const have = mirrorSealedSet(app.db);
  const missing = [
    [MIRROR_SEALED.endpoint, "endpoint"],
    [MIRROR_SEALED.bucket, "bucket"],
    [MIRROR_SEALED.accessKey, "access key"],
    [MIRROR_SEALED.secretKey, "secret key"],
  ]
    .filter(([n]) => !have.includes(n!))
    .map(([, label]) => label);
  return ok(
    missing.length === 0
      ? "Mirror sealed; it is brought level within the hour."
      : `Sealed, but not in effect until the ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} set.`,
  );
}

export function forgetMirror(
  app: App,
  actor: User | undefined,
): Result<void, "not_found"> {
  if (!isAdmin(actor)) return err("not_found");
  clearMirrorSealed(app.db);
  app.bus.append({
    kind: "secret.deleted",
    actorId: actor!.id,
    payload: { name: "SNAPSHOT_MIRROR_S3_*", scope: "forge" },
  });
  const svc = snapshotsOf(app);
  svc?.forget();
  forgetState(app);
  // A pass against the old mirror may still be running and would write its
  // failure after this: a fresh pass starts when it ends, and with no mirror
  // clears the state the board reads — no mirror, no line.
  void svc?.mirrorFresh().catch(() => {});
  return ok();
}
