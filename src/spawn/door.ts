/**
 * The spawn door: what `POST /api/v1/forges` and the MCP `spawn` tool share.
 * Plain input in, one status and one JSON body out. The owner's request is
 * turned into the plan's inputs here (the catalogue is only what they may
 * read, the briefs only the crew they named), and `dryRun` — true unless
 * the caller says `false` — returns the plan and changes nothing.
 */

import { listChildren, reissueClaim, spawnForge, type SpawnError } from "../actions/spawn.ts";
import type { App } from "../app.ts";
import { getAgentByName } from "../core/agents.ts";
import { canRead, getRepo } from "../core/repos.ts";
import { kindOfToken } from "../core/subscriptions.ts";
import type { User } from "../core/users.ts";
import { repoDir } from "../git/repos.ts";
import type { Ctx } from "../http/context.ts";
import {
  childPublicUrl,
  hostedPlacement,
  memoryBodies,
  type BodyStore,
  type Placement,
} from "./placement.ts";
import { dryRun, planSpawn, KEY_BUDGET_NOTE, MAX_APPS, type CatalogApp, type CrewBrief, type SpawnSource } from "./plan.ts";
import { readdirSync, readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface Door {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const MAX_CREW = 100;
const placements = new WeakMap<App, Placement>();

/** Tests (and an external placement, one day) swap where children live. */
export function usePlacement(app: App, placement: Placement): void {
  placements.set(app, placement);
}

/**
 * The parent forge's public host. A hosted child's address is
 * `<name>--<this>` (see `childPublicUrl`), one label under the platform apex.
 */
export const childHost = (app: App): string =>
  app.config.url ? new URL(app.config.url).host : (app.config.host ?? "localhost");

/** Public URL of a hosted child — derived from name + parent host so old ledgers stay reachable. */
export const childUrlOf = (app: App, name: string): string =>
  childPublicUrl(name, childHost(app));

/** Seed the in-memory body store from on-disk ledgers so room()/exists survive restart. */
function seedBodies(app: App, store: BodyStore): void {
  const dir = join(app.config.dataDir, "spawn");
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    return;
  }
  const host = childHost(app);
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const ledger = JSON.parse(readFileSync(join(dir, f), "utf8")) as {
        name?: unknown;
        bodyId?: unknown;
        url?: unknown;
      };
      if (typeof ledger.name !== "string" || typeof ledger.bodyId !== "string") continue;
      if (store.list().some((b) => b.bodyId === ledger.bodyId || b.name === ledger.name)) continue;
      store.add({
        bodyId: ledger.bodyId,
        name: ledger.name,
        url: childPublicUrl(ledger.name, host),
        depth: 1,
        agents: 1,
        ssh: false,
      });
    } catch {
      // A corrupt ledger line is ignored for capacity; spawn reads it carefully.
    }
  }
}

function placementFor(app: App): Placement {
  let p = placements.get(app);
  if (!p) {
    const store = memoryBodies();
    seedBodies(app, store);
    p = hostedPlacement({ host: childHost(app), store });
    placements.set(app, p);
  }
  return p;
}

/** Why this forge can hold no child right now, or undefined when it can. */
export function noRoom(app: App): string | undefined {
  return placementFor(app).room?.()?.message;
}

/** One status and one sentence per kind of failure. */
export function spawnWords(e: SpawnError): Door {
  const say = (status: number, error: string, message: string): Door => ({
    status,
    body: { error, message },
  });
  switch (e.kind) {
    case "unauthorized":
      return say(401, "unauthorized", "sign in with a token to spawn a forge");
    case "forbidden":
      return say(403, "forbidden", "only an admin of this forge may spawn a child");
    case "cross_origin":
      return say(403, "cross_origin", "this request came from another origin");
    case "invalid":
      return say(422, "invalid", `${e.field}: ${e.reason}`);
    case "refused":
      return say(409, "refused", e.message);
    case "exists":
      return say(409, "exists", e.message);
    case "failed":
      return say(500, "failed", `the child could not be made: ${e.message}`);
  }
}

const invalid = (field: string, reason: string): Door =>
  spawnWords({ kind: "invalid", field, reason });

const names = (v: unknown, field: string, max: number): string[] | Door => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== "string"))
    return invalid(field, `must be a list of at most ${max} names`);
  return v as string[];
};

async function bytesOf(dir: string): Promise<number> {
  let n = 0;
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])) {
    if (e.isFile()) n += (await stat(join(e.parentPath, e.name)).catch(() => undefined))?.size ?? 0;
  }
  return n;
}

/** Plan a child (and make it unless `dryRun` is true, the default). */
export async function spawnDoor(ctx: Ctx, user: User, raw: Record<string, unknown>): Promise<Door> {
  if (!user.isAdmin) return spawnWords({ kind: "forbidden" });
  if (raw["dryRun"] !== undefined && typeof raw["dryRun"] !== "boolean")
    return invalid("dryRun", "must be true or false");
  const dry = raw["dryRun"] !== false;
  const apps = names(raw["apps"], "apps", MAX_APPS);
  if (!Array.isArray(apps)) return apps;
  const crew = names(raw["crew"], "crew", MAX_CREW);
  if (!Array.isArray(crew)) return crew;
  // The child's model key: an API-billed key with a whole-life budget, or none. A
  // subscription token is a person's own plan and never travels.
  const modelKey = raw["modelKey"];
  if (modelKey !== undefined) {
    if (typeof modelKey !== "string" || kindOfToken(modelKey) !== "api_key")
      return invalid("modelKey", "must be an API key (sk-ant-api…); a subscription token is a person's own plan and never goes to a child");
    if (raw["budgetUsd"] === undefined) return invalid("budgetUsd", "a model key needs a budget in dollars, for its whole life");
  } else if (raw["budgetUsd"] !== undefined) {
    return invalid("budgetUsd", "a budget is for a model key; send modelKey with it");
  }

  const db = ctx.app.db;
  // Only what the caller named and may read: an unreadable app is "not a known app".
  const catalog: CatalogApp[] = [];
  for (const ref of new Set(apps)) {
    const [o, n, ...rest] = ref.split("/");
    const repo = o && n && rest.length === 0 ? getRepo(db, o, n) : undefined;
    if (!repo || !canRead(db, repo, user)) continue;
    catalog.push({
      ref,
      readable: true,
      bytes: await bytesOf(repoDir(ctx.app.reposRoot, o!, n!)),
      forgeJsonBytes: 0,
    });
  }
  const briefs: CrewBrief[] = [];
  for (const name of new Set(crew)) {
    const agent = getAgentByName(db, name);
    if (!agent) return invalid("crew", `${name} is not on this forge's crew`);
    briefs.push({ agent: agent.user.username, text: agent.brief });
  }
  const source: SpawnSource = { catalog, briefs, subscriptions: [] };
  const input = {
    name: raw["name"],
    org: raw["name"],
    apps,
    carryBriefs: briefs.length > 0,
    carrySubscriptions: false,
    direction: raw["direction"],
    keepAccess: raw["keepAccess"],
    budgetUsd: raw["budgetUsd"],
    for: raw["for"],
  };

  if (dry) {
    const planned = planSpawn(input, source);
    if (!planned.ok) return spawnWords({ kind: "invalid", ...planned.error });
    return {
      status: 200,
      body: {
        dryRun: true,
        plan: planned.value,
        ...dryRun(planned.value, source),
        ...(planned.value.budgetUsd === null ? {} : { keyNote: KEY_BUDGET_NOTE }),
      },
    };
  }
  const made = await spawnForge(ctx.app, user, input, source, {
    placement: placementFor(ctx.app),
    request: ctx.request,
    url: ctx.url,
    ...(typeof modelKey === "string" ? { modelKey } : {}),
  });
  if (!made.ok) return spawnWords(made.error);
  return {
    status: made.value.existed ? 200 : 201,
    body: {
      dryRun: false,
      ...made.value,
      ...(typeof modelKey === "string" ? { keyNote: KEY_BUDGET_NOTE } : {}),
    },
  };
}

/** A new claim link for an unclaimed child (#729): the old one dies. */
export async function reissueDoor(ctx: Ctx, user: User, name: string): Promise<Door> {
  const made = await reissueClaim(ctx.app, user, name, { request: ctx.request, url: ctx.url });
  if (made.ok) return { status: 201, body: { ...made.value } };
  if (made.error.kind === "not_found")
    return { status: 404, body: { error: "not_found", message: `no child forge named ${name}` } };
  return spawnWords(made.error);
}
