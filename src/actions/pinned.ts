/**
 * Pinned forges, as a forge admin reaches them (#8697): `deploy` puts one on
 * the owner's cloud, `update` is the only way its version or config change,
 * `rollback` is one action back to the previous version. All three are the
 * admin's, need the cloud account's writes switched on, and open the sealed
 * token for the one call that needs it (a `secret.read` event names it). Each
 * change is recorded with who and when before the cloud is touched; if the
 * cloud refuses, the record stays and the forge says `failed`, so nothing
 * moves without a line saying so.
 */

import type { App } from "../app.ts";
import { gatedFetch } from "../cloud/gate.ts";
import { provision, readDroplet, replace } from "../cloud/droplet.ts";
import type { Fetch } from "../cloud/providers.ts";
import { target as targetOf } from "../cloud/targets.ts";
import { getCloudAccount, secretNameOf } from "../core/cloud_account.ts";
import {
  APP, NAME, changesOf, checkConfig, getPinned, insertPinned, listPinned, previousOf,
  dropPinned, recordChange, setRemote, urlOf, validSource, validVersion, type Change, type Pinned,
} from "../core/pinned.ts";
import { resolveSecrets } from "../core/secret_store.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";

/** Swapped in tests; the real forge always uses `fetch`. */
export const net: { fetch: Fetch; probe: Fetch } = { fetch: (u, i) => fetch(u, i), probe: (u, i) => fetch(u, i) };

const admin = (a: User | undefined): Result<User, string> => (a?.isAdmin ? ok(a) : err("not_found"));

export interface PinnedView extends Pinned {
  /** Where it is served, once the droplet's address is read; empty before. */
  readonly url: string;
  readonly crew: false;
  readonly autoRelease: false;
  readonly changes: Change[];
}

const view = (app: App, p: Pinned): PinnedView => ({ ...p, url: urlOf(p), crew: false, autoRelease: false, changes: changesOf(app.db, p.id) });

export function pinnedForges(app: App, actor: User | undefined): Result<PinnedView[], string> {
  const who = admin(actor);
  return who.ok ? ok(listPinned(app.db).map((p) => view(app, p))) : who;
}

/** Open the account's token and run `go` with a gated fetch; the token never leaves this scope. */
async function withCloud<T>(app: App, who: User, p: Pinned, purpose: string, go: (f: Fetch, token: string) => Promise<T>, writes = true): Promise<Result<T, string>> {
  const account = getCloudAccount(app.db, p.target, p.account);
  if (!account) return err("No such cloud account.");
  if (writes && !account.writeAllowed) return err("That cloud account is read-only; allow writes on it first.");
  const secret = secretNameOf(account.provider, account.name);
  const token = resolveSecrets(app.db, app.config.dataDir, app.bus, [secret], { actor: who.id, run: `pinned:${purpose}` })[secret];
  if (token === undefined) return err("No such credential.");
  try {
    return ok(await go(gatedFetch(app.db, { provider: p.target, account: p.account }, `pinned:${purpose}`, net.fetch), token));
  } catch (e) {
    return err(`The cloud refused: ${e instanceof Error ? e.message.slice(0, 200) : "failed"}`);
  }
}

/** Read the droplet back and record its public IPv4 (empty while none is assigned). The cloud's refusal is returned, so "no address yet" and "the call was refused" differ. */
async function readAddress(app: App, who: User, name: string): Promise<Result<string, string>> {
  const p = getPinned(app.db, name);
  if (!p || p.remote === "") return ok("");
  const seen = await withCloud(app, who, p, "address", (f, token) => readDroplet(f, token, p.remote), false);
  if (!seen.ok) return seen;
  if (seen.value.address !== "") setRemote(app.db, name, { address: seen.value.address });
  return ok(seen.value.address);
}

export async function deployPinned(
  app: App,
  actor: User | undefined,
  input: { name: string; target: string; account: string; app: string; source: string; version: string; config?: unknown },
): Promise<Result<PinnedView, string>> {
  const who = admin(actor);
  if (!who.ok) return who;
  const t = targetOf(input.target);
  if (!t) return err("That is not a target the forge knows.");
  if (t.status === "refused") return err(t.refused);
  if (t.status !== "first") return err(`${t.label} is not written yet: ${t.refused}`);
  if (!NAME.test(input.name)) return err("A name is lowercase letters, digits and dashes, starting with a letter.");
  if (!APP.test(input.app)) return err("Name the app as owner/name.");
  if (!validSource(input.source)) return err("The source is an https git address.");
  if (!validVersion(input.version)) return err("A version is a full 40-character commit id or a tag like v1.2.3.");
  const config = checkConfig(input.config);
  if (!config.ok) return config;
  // A first deploy that failed before any droplet exists may be tried again: its row goes,
  // its volume (if one was made) is kept for the retry, and the new deploy is recorded afresh.
  const old = getPinned(app.db, input.name);
  if (old && !(old.state === "failed" && old.remote === "" && old.target === t.id)) return err("A pinned forge has that name already.");
  if (old) dropPinned(app.db, old.name);
  const p = insertPinned(app.db, { ...input, target: t.id, config: config.value }, who.value.id);
  app.bus.append({ kind: "pinned.deployed", actorId: who.value.id, payload: { name: p.name, target: p.target, version: p.version } });
  if (old?.volume) setRemote(app.db, p.name, { volume: old.volume });
  const made = await withCloud(app, who.value, p, "deploy", (f, token) =>
    provision(f, token, getPinned(app.db, p.name)!, {
      ...(old?.volume ? { have: old.volume } : {}),
      onVolume: (volume) => setRemote(app.db, p.name, { volume }),
    }),
  );
  if (!made.ok) {
    setRemote(app.db, p.name, { state: "failed" });
    return made;
  }
  setRemote(app.db, p.name, { ...made.value, state: "running" });
  return ok(view(app, getPinned(app.db, p.name)!));
}

async function change(
  app: App,
  actor: User | undefined,
  name: string,
  kind: "update" | "rollback",
  next: (p: Pinned) => Result<{ version: string; config: Record<string, string> }, string>,
): Promise<Result<PinnedView, string>> {
  const who = admin(actor);
  if (!who.ok) return who;
  const before = getPinned(app.db, name);
  if (!before) return err("No such pinned forge.");
  const to = next(before);
  if (!to.ok) return to;
  const same = to.value.version === before.version && JSON.stringify(to.value.config) === JSON.stringify(before.config);
  // A failed forge may be asked again for what it already says, to finish the replacement; nothing new to record.
  if (same && before.state !== "failed") return err("That is what it runs already.");
  if (!same) {
    const c = recordChange(app.db, before, kind, to.value, who.value.id);
    app.bus.append({ kind: kind === "update" ? "pinned.update" : "pinned.rollback", actorId: who.value.id, payload: { name, from: c.fromVersion, to: c.toVersion } });
  }
  const after = getPinned(app.db, name)!;
  const done = await withCloud(app, who.value, after, kind, (f, token) => replace(f, token, after, { onDeleted: () => setRemote(app.db, name, { remote: "", address: "" }) }));
  if (!done.ok) {
    setRemote(app.db, name, { state: "failed" });
    return done;
  }
  setRemote(app.db, name, { ...done.value, address: "", state: "running" });
  return ok(view(app, getPinned(app.db, name)!));
}

/** The only door to a new version or config. Either may be left as it is. */
export const updatePinned = (
  app: App,
  actor: User | undefined,
  name: string,
  input: { version?: string | undefined; config?: unknown },
): Promise<Result<PinnedView, string>> =>
  change(app, actor, name, "update", (p) => {
    const version = input.version ?? p.version;
    if (!validVersion(version)) return err("A version is a full 40-character commit id or a tag like v1.2.3.");
    const config = input.config === undefined ? ok(p.config) : checkConfig(input.config);
    return config.ok ? ok({ version, config: config.value }) : config;
  });

/** One action back to what the latest change replaced. */
export const rollbackPinned = (app: App, actor: User | undefined, name: string): Promise<Result<PinnedView, string>> =>
  change(app, actor, name, "rollback", (p) => {
    const prev = previousOf(app.db, p);
    return prev ? ok(prev) : err("There is no previous version: this forge has only ever run one.");
  });

/**
 * The health check: read the droplet's address back, ask the forge there for
 * its front page, and say what it answered. A forge that answers is `running`,
 * so one marked `failed` by a refused call recovers by itself once its droplet
 * is up; one that does not answer keeps its state, and `healthy` is false.
 */
export async function checkPinned(app: App, actor: User | undefined, name: string): Promise<Result<PinnedView & { healthy: boolean }, string>> {
  const who = admin(actor);
  if (!who.ok) return who;
  const p = getPinned(app.db, name);
  if (!p) return err("No such pinned forge.");
  if (p.remote === "") return err("This forge has no droplet yet; deploy or update it first.");
  const read = await readAddress(app, who.value, name);
  if (!read.ok) return read;
  const now = getPinned(app.db, name)!;
  let healthy = false;
  if (now.address !== "") {
    // The probe is audited like every other call made for this account; the address is a validated public IPv4 and the port is 1-65535.
    const probe = gatedFetch(app.db, { provider: now.target, account: now.account }, "pinned:probe", net.probe);
    try {
      const res = await probe(urlOf(now), { signal: AbortSignal.timeout(5_000), redirect: "manual" });
      healthy = res.status >= 200 && res.status < 400;
    } catch {
      healthy = false;
    }
  }
  if (healthy && now.state !== "running") setRemote(app.db, name, { state: "running" });
  const after = getPinned(app.db, name)!;
  app.bus.append({ kind: "pinned.check", actorId: who.value.id, payload: { name, address: after.address, state: after.state, healthy } });
  return ok({ ...view(app, after), healthy });
}
