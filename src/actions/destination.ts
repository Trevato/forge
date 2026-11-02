/**
 * The snapshot destination, as an admin sets it. Every field is validated
 * here, then sealed as a forge-level secret; nothing is read back to a
 * person except which fields are set. A field left blank keeps what was
 * sealed, so the secret key is write-only and never re-shown.
 */

import type { App } from "../app.ts";
import { putSecret } from "./secrets.ts";
import {
  clearSealed,
  sealedSet,
  sealedTarget,
  SEALED,
  testTarget,
} from "../snapshot/destination.ts";
import { s3FromEnv, type S3Target } from "../snapshot/store.ts";
import { snapshotsOf } from "../snapshot/service.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { NOT_SEALED } from "../kernel/seal_words.ts";

export interface DestinationInput {
  readonly endpoint: string;
  readonly bucket: string;
  readonly region: string;
  readonly accessKey: string;
  readonly secretKey: string;
}

const KEY = /^[\x21-\x7e]{1,256}$/;

/** The reason a field is not acceptable, or undefined when it is (blank is fine). */
export function invalidField(i: DestinationInput): string | undefined {
  if (i.endpoint !== "") {
    let url: URL | undefined;
    try {
      url = new URL(i.endpoint);
    } catch {
      /* reported below */
    }
    if (
      !url ||
      !/^https?:$/.test(url.protocol) ||
      url.username !== "" ||
      url.password !== "" ||
      i.endpoint.length > 300
    )
      return "The endpoint must be an http(s) URL without credentials in it.";
  }
  if (i.bucket !== "" && !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(i.bucket))
    return "The bucket name is 3–63 lowercase letters, digits, dots or dashes.";
  if (i.region !== "" && !/^[a-z0-9-]{1,32}$/.test(i.region))
    return "The region is lowercase letters, digits and dashes.";
  if (i.accessKey !== "" && !KEY.test(i.accessKey))
    return "The access key must be printable characters without spaces.";
  if (i.secretKey !== "" && !KEY.test(i.secretKey))
    return "The secret key must be printable characters without spaces.";
  return undefined;
}

const isAdmin = (actor: User | undefined): boolean => actor?.isAdmin === true;

/** Who may set or forget where snapshots go, through every door — page, MCP, terminal: a site admin who is a person, never an agent. */
export const mayChangeDestination = (actor: Pick<User, "isAdmin" | "kind"> | null | undefined): boolean =>
  actor?.isAdmin === true && actor.kind !== "agent";

/** Seal what was given (an error is `not_found` or a sentence for the page); blank fields keep their sealed value. Says what is still missing. */
export function saveDestination(
  app: App,
  actor: User | undefined,
  input: DestinationInput,
): Result<string, string> {
  if (!mayChangeDestination(actor)) return err("not_found");
  const bad = invalidField(input);
  if (bad) return err(bad);
  const fields: [string, string][] = [
    [SEALED.endpoint, input.endpoint],
    [SEALED.bucket, input.bucket],
    [SEALED.region, input.region],
    [SEALED.accessKey, input.accessKey],
    [SEALED.secretKey, input.secretKey],
  ];
  for (const [name, value] of fields) {
    if (value === "") continue;
    const set = putSecret(app, actor, "forge", "", name, value);
    if (!set.ok) return err(NOT_SEALED);
  }
  snapshotsOf(app)?.forget();
  const have = sealedSet(app.db);
  const missing = [
    [SEALED.endpoint, "endpoint"],
    [SEALED.bucket, "bucket"],
    [SEALED.accessKey, "access key"],
    [SEALED.secretKey, "secret key"],
  ]
    .filter(([n]) => !have.includes(n!))
    .map(([, label]) => label);
  return ok(
    missing.length === 0
      ? "Destination sealed; the next snapshot goes there."
      : `Sealed, but not in effect until the ${missing.join(", ")} ${missing.length === 1 ? "is" : "are"} set.`,
  );
}

export function forgetDestination(
  app: App,
  actor: User | undefined,
): Result<void, "not_found"> {
  if (!mayChangeDestination(actor)) return err("not_found");
  clearSealed(app.db);
  app.bus.append({
    kind: "secret.deleted",
    actorId: actor!.id,
    payload: { name: "SNAPSHOT_S3_*", scope: "forge" },
  });
  snapshotsOf(app)?.forget();
  return ok();
}

/**
 * List the bucket and say what came of it, in one sentence. Fields given
 * are tried as typed (all four needed); with none given, the destination in
 * effect — sealed, else the environment's — is tried.
 */
export async function testDestination(
  app: App,
  actor: User | undefined,
  input: DestinationInput,
): Promise<Result<string, "not_found">> {
  if (!isAdmin(actor)) return err("not_found");
  const bad = invalidField(input);
  if (bad) return ok(bad);
  const typed =
    input.endpoint && input.bucket && input.accessKey && input.secretKey;
  let target: S3Target | undefined;
  if (typed)
    target = {
      endpoint: input.endpoint,
      bucket: input.bucket,
      accessKeyId: input.accessKey,
      secretAccessKey: input.secretKey,
      region: input.region || undefined,
    };
  else if (
    input.endpoint + input.bucket + input.accessKey + input.secretKey ===
    ""
  )
    target =
      sealedTarget({ db: app.db, dataDir: app.config.dataDir, bus: app.bus }) ??
      s3FromEnv();
  else
    return ok(
      "To test typed values give the endpoint, bucket, access key and secret key; or leave them all blank to test what is in effect.",
    );
  if (!target) return ok("There is no S3 destination to test; seal one first.");
  return ok(await testTarget(target));
}
