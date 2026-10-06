/**
 * Forge-level secrets, as the forge's admins reach them. Writing and
 * removing are for a forge admin at every scope — these are the operator's
 * credentials, not an org's or a repo's to hold — and an everyone-else
 * caller is told `not_found`, never that the door exists. Reading is not
 * here at all: `resolveSecrets` (`core/secret_store.ts`) is the only path.
 * Events carry the name and the scope, never the value.
 */

import type { App } from "../app.ts";
import { getOrg } from "../core/orgs.ts";
import { getRepo } from "../core/repos.ts";
import {
  deleteSecret,
  isSecretScope,
  listSecretNames,
  setSecret,
  type SecretError,
  type SecretName,
  type SecretScope,
} from "../core/secret_store.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";

/** Where a secret lives: `forge` needs no ref, `org` an org name, `repo` `owner/name`. */
interface Target {
  readonly scope: SecretScope;
  readonly scopeId: string;
  readonly repoId?: string;
}

function resolveTarget(
  app: App,
  scope: string,
  ref: string,
): Result<Target, "invalid_scope" | "not_found"> {
  if (!isSecretScope(scope)) return err("invalid_scope");
  if (scope === "forge") return ok({ scope, scopeId: "" });
  if (scope === "org") {
    const org = getOrg(app.db, ref);
    return org ? ok({ scope, scopeId: org.id }) : err("not_found");
  }
  const [owner = "", name = "", ...rest] = ref.split("/");
  const repo = rest.length === 0 ? getRepo(app.db, owner, name) : undefined;
  return repo
    ? ok({ scope, scopeId: repo.id, repoId: repo.id })
    : err("not_found");
}

function admin(actor: User | undefined): Result<User, "not_found"> {
  return actor?.isAdmin ? ok(actor) : err("not_found");
}

export function listSecrets(
  app: App,
  actor: User | undefined,
  scope: string,
  ref = "",
): Result<SecretName[], "not_found" | "invalid_scope"> {
  const who = admin(actor);
  if (!who.ok) return who;
  const target = resolveTarget(app, scope, ref);
  if (!target.ok) return target;
  return ok(listSecretNames(app.db, target.value.scope, target.value.scopeId));
}

export function putSecret(
  app: App,
  actor: User | undefined,
  scope: string,
  ref: string,
  name: string,
  value: string,
): Result<SecretName, "not_found" | SecretError> {
  const who = admin(actor);
  if (!who.ok) return who;
  const target = resolveTarget(app, scope, ref);
  if (!target.ok) return target;
  const set = setSecret(
    app.db,
    app.config.dataDir,
    target.value.scope,
    target.value.scopeId,
    name,
    value,
  );
  if (!set.ok) return set;
  app.bus.append({
    kind: "secret.set",
    repoId: target.value.repoId,
    actorId: who.value.id,
    payload: { name, scope: target.value.scope },
  });
  return set;
}

export function removeSecret(
  app: App,
  actor: User | undefined,
  scope: string,
  ref: string,
  name: string,
): Result<void, "not_found" | "invalid_scope" | "no_such_secret"> {
  const who = admin(actor);
  if (!who.ok) return who;
  const target = resolveTarget(app, scope, ref);
  if (!target.ok) return target;
  if (!deleteSecret(app.db, target.value.scope, target.value.scopeId, name))
    return err("no_such_secret");
  app.bus.append({
    kind: "secret.deleted",
    repoId: target.value.repoId,
    actorId: who.value.id,
    payload: { name, scope: target.value.scope },
  });
  return ok();
}
