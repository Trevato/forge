/**
 * Cloud accounts, as a forge admin reaches them. A credential is checked
 * with the provider's read-only calls (`cloud/providers.ts`) BEFORE it is
 * sealed, so a bad paste is never stored; sealing goes through `putSecret`.
 * Every later open of the value — a re-verify, an audit — goes through
 * `resolveSecrets`, so it shows up as a `secret.read` event naming its run.
 * Anyone who is not a forge admin is told `not_found`.
 */

import type { App } from "../app.ts";
import { audit, isProvider, verify, type Fetch, type Provider } from "../cloud/providers.ts";
import {
  CLOUD_NAME,
  forgetCloudAccount,
  recordVerified,
  secretNameOf,
  setWriteAllowed,
} from "../core/cloud_account.ts";
import { createIssue } from "../core/issues.ts";
import { getRepo } from "../core/repos.ts";
import { resolveSecrets } from "../core/secret_store.ts";
import type { User } from "../core/users.ts";
import { id } from "../kernel/id.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { putSecret, removeSecret } from "./secrets.ts";

/** Swapped in tests; the real forge always uses `fetch`. */
export const net: { fetch: Fetch } = { fetch: (u, i) => fetch(u, i) };

const admin = (a: User | undefined): Result<User, string> =>
  a?.isAdmin ? ok(a) : err("not_found");

function target(
  provider: string,
  name: string,
): Result<{ provider: Provider; name: string; secret: string }, string> {
  if (!isProvider(provider)) return err("That is not a provider the forge knows.");
  if (!CLOUD_NAME.test(name))
    return err("A name is lowercase letters, digits and underscores, starting with a letter.");
  return ok({ provider, name, secret: secretNameOf(provider, name) });
}

/** Verify, then seal. Returns the one-sentence summary. */
export async function addAccount(
  app: App,
  actor: User | undefined,
  provider: string,
  name: string,
  value: string,
): Promise<Result<string, string>> {
  const who = admin(actor);
  if (!who.ok) return who;
  const t = target(provider, name);
  if (!t.ok) return t;
  const v = await verify(t.value.provider, value, net.fetch);
  if (!v.ok) return v;
  const set = putSecret(app, who.value, "forge", "", t.value.secret, value);
  if (!set.ok) return err("That credential cannot be stored.");
  recordVerified(app.db, t.value.provider, t.value.name, v.value.summary);
  return ok(v.value.summary);
}

/** Open the sealed value for one named purpose, which the read event records. */
function open(app: App, actor: User, secret: string, run: string): string | undefined {
  return resolveSecrets(app.db, app.config.dataDir, app.bus, [secret], {
    actor: actor.id,
    run,
  })[secret];
}

export async function reverify(
  app: App,
  actor: User | undefined,
  provider: string,
  name: string,
): Promise<Result<string, string>> {
  const who = admin(actor);
  if (!who.ok) return who;
  const t = target(provider, name);
  if (!t.ok) return t;
  const value = open(app, who.value, t.value.secret, `verify:${t.value.provider}`);
  if (value === undefined) return err("No such credential.");
  const v = await verify(t.value.provider, value, net.fetch);
  if (!v.ok) return v;
  recordVerified(app.db, t.value.provider, t.value.name, v.value.summary);
  return ok(v.value.summary);
}

export function allowWrite(
  app: App,
  actor: User | undefined,
  provider: string,
  name: string,
  allowed: boolean,
): Result<void, string> {
  const who = admin(actor);
  if (!who.ok) return who;
  if (!setWriteAllowed(app.db, provider, name, allowed)) return err("No such credential.");
  app.bus.append({
    kind: "cloud.write_allowed",
    actorId: who.value.id,
    payload: { provider, name, allowed },
  });
  return ok();
}

export function removeAccount(
  app: App,
  actor: User | undefined,
  provider: string,
  name: string,
): Result<void, string> {
  const who = admin(actor);
  if (!who.ok) return who;
  const t = target(provider, name);
  if (!t.ok) return t;
  const gone = removeSecret(app, who.value, "forge", "", t.value.secret);
  if (!gone.ok) return err("No such credential.");
  forgetCloudAccount(app.db, t.value.provider, t.value.name);
  return ok();
}

/**
 * A read-only audit of one credential: one issue per finding in the repo
 * named `owner/name`, skipping a finding whose issue is already open.
 * Returns how many issues it opened and how many findings it saw.
 */
export async function auditAccount(
  app: App,
  actor: User | undefined,
  provider: string,
  name: string,
  repoRef: string,
): Promise<Result<{ opened: number; found: number }, string>> {
  const who = admin(actor);
  if (!who.ok) return who;
  const t = target(provider, name);
  if (!t.ok) return t;
  const [owner = "", rname = "", ...rest] = repoRef.trim().split("/");
  const repo = rest.length === 0 ? getRepo(app.db, owner, rname) : undefined;
  if (!repo) return err("Name a repository as owner/name to file the findings in.");
  const value = open(app, who.value, t.value.secret, `audit:${t.value.provider}:${id()}`);
  if (value === undefined) return err("No such credential.");
  const found = await audit(t.value.provider, value, net.fetch);
  if (!found.ok) return found;
  let opened = 0;
  for (const f of found.value) {
    const title = `[audit] ${f.title}`;
    const dup = app.db
      .query("SELECT 1 FROM issue WHERE repo_id = ?1 AND title = ?2 AND state = 'open'")
      .get(repo.id, title);
    if (dup) continue;
    const made = createIssue(app.db, {
      repoId: repo.id,
      authorId: who.value.id,
      title: title.slice(0, 200),
      body: f.body,
    });
    if (!made.ok) continue;
    app.bus.append({
      kind: "issue.opened",
      repoId: repo.id,
      actorId: who.value.id,
      payload: { number: made.value.number },
    });
    opened++;
  }
  return ok({ opened, found: found.value.length });
}
