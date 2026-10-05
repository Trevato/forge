/**
 * The spawn door: what `POST /api/v1/forges` and the MCP `spawn` tool share.
 * Plain input in, one status and one JSON body out. The owner's request is
 * turned into the plan's inputs here (the catalogue is only what they may
 * read, the briefs only the crew they named), and `dryRun` — true unless
 * the caller says `false` — returns the plan and changes nothing.
 */

import { listChildren, spawnForge, type SpawnError } from "../actions/spawn.ts";
import type { App } from "../app.ts";
import { getAgentByName } from "../core/agents.ts";
import { canRead, getRepo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { repoDir } from "../git/repos.ts";
import type { Ctx } from "../http/context.ts";
import { hostedPlacement, type Placement } from "./placement.ts";
import { dryRun, planSpawn, MAX_APPS, type CatalogApp, type CrewBrief, type SpawnSource } from "./plan.ts";
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

function placementFor(app: App): Placement {
  let p = placements.get(app);
  if (!p) {
    const host = app.config.url ? new URL(app.config.url).host : (app.config.host ?? "localhost");
    p = hostedPlacement({ host });
    placements.set(app, p);
  }
  return p;
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
  };

  if (dry) {
    const planned = planSpawn(input, source);
    if (!planned.ok) return spawnWords({ kind: "invalid", ...planned.error });
    return { status: 200, body: { dryRun: true, plan: planned.value, ...dryRun(planned.value, source) } };
  }
  const made = await spawnForge(ctx.app, user, input, source, {
    placement: placementFor(ctx.app),
    request: ctx.request,
    url: ctx.url,
  });
  return made.ok ? { status: made.value.existed ? 200 : 201, body: { dryRun: false, ...made.value } } : spawnWords(made.error);
}

