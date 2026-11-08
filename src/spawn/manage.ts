/**
 * The owner's two hands on a hosted forge: stop it (put it to sleep now; the
 * next request wakes it) and remove it (its ledger and its data, for good).
 * Both are the site admin's, and both write an event.
 */

import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { App } from "../app.ts";
import { childDirOf, listChildren } from "../actions/spawn.ts";
import { sleepChild } from "./host.ts";
import { CHILD_NAME } from "./placement.ts";

export type Managed = { readonly ok: true; readonly says: string } | { readonly ok: false; readonly says: string };

async function find(app: App, name: string) {
  if (!CHILD_NAME.test(name)) return undefined;
  return (await listChildren(app)).find((c) => c.name === name);
}

export async function stopForge(app: App, name: string): Promise<Managed> {
  const child = await find(app, name);
  if (child === undefined) return { ok: false, says: `no forge named ${name}` };
  const was = await sleepChild(app, name);
  if (was) app.bus.append({ kind: "forge.stopped", payload: { name } });
  return { ok: true, says: was ? `${name} is asleep; its next visitor wakes it` : `${name} was already asleep` };
}

export async function removeForge(app: App, name: string): Promise<Managed> {
  const child = await find(app, name);
  if (child === undefined) return { ok: false, says: `no forge named ${name}` };
  await sleepChild(app, name);
  await rm(join(app.config.dataDir, "spawn", `${name}.json`), { force: true });
  await rm(childDirOf(app, child.bodyId), { recursive: true, force: true });
  app.bus.append({ kind: "forge.removed", payload: { name } });
  return { ok: true, says: `${name} is removed, with its data` };
}
