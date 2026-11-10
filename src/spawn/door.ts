/**
 * The spawn door: what `POST /api/v1/forges` and the MCP `spawn` tool share.
 * Plain input in, one status and one JSON body out. The owner's request is
 * turned into the plan's inputs here (the catalogue is only what they may
 * read, the briefs only the crew they named), and `dryRun` — true unless
 * the caller says `false` — returns the plan and changes nothing.
 */

import { startWatch, probeOf, type Probe } from "./live.ts";
import { firstProof, reachWords, settleChild } from "./reach.ts";
import { reissueClaim, spawnForge, type SpawnError } from "../actions/spawn.ts";
import type { App } from "../app.ts";
import { maxChildren } from "../core/capacity.ts";
import { getAgentByName } from "../core/agents.ts";
import { canRead, getRepo } from "../core/repos.ts";
import { kindOfToken, normalizeToken, parseApiBase } from "../core/subscriptions.ts";
import type { User } from "../core/users.ts";
import { repoDir } from "../git/repos.ts";
import { crossOrigin, type Ctx } from "../http/context.ts";
import { changeLink } from "./manage.ts";
import { takeDoor } from "../http/strangers.ts";
import {
  childPublicUrl,
  fallbackPlacement,
  hostedPlacement,
  memoryBodies,
  parentOrigin,
  type BodyStore,
  type Placement,
} from "./placement.ts";
import { dryRun, planSpawn, KEY_BUDGET_NOTE, MAX_APPS, type CatalogApp, type CrewBrief, type SpawnSource } from "./plan.ts";
import { bootHostedChild } from "./host.ts";
import { cellPlacement, ownsBody } from "./cell.ts";
import { cellsAvailable } from "../apps/contain.ts";
import { ANON_SPAWNS_PER_DAY, checkAnonSpawn, noteAnonSpawn } from "./rate.ts";
import { readdirSync, readFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export interface Door {
  readonly status: number;
  readonly body: Record<string, unknown>;
}

const MAX_CREW = 100;
const placements = new WeakMap<App, Placement>();
const probes = new WeakMap<App, (url: string) => Probe>();

/** Tests swap how a new child is asked whether it is live. */
export function useProbe(app: App, probe: (url: string) => Probe): void {
  probes.set(app, probe);
}

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
  childPublicUrl(name, parentOrigin(app.config));

/** Seed the in-memory body store from on-disk ledgers so room()/exists survive restart. */
function seedBodies(app: App, store: BodyStore): void {
  const dir = join(app.config.dataDir, "spawn");
  let files: string[] = [];
  try {
    files = readdirSync(dir);
  } catch {
    return;
  }
  const origin = parentOrigin(app.config);
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
        url: childPublicUrl(ledger.name, origin),
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
    const cap = () => maxChildren(app.db);
    // A cell where the host can hold one, the parent's own process where it cannot.
    p = fallbackPlacement(
      cellPlacement(app, store, cap),
      hostedPlacement({ host: parentOrigin(app.config), store, maxChildren: cap }),
      async () => (await cellsAvailable()).ok,
      ownsBody,
    );
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
      return say(403, "forbidden", "sign in as a person to spawn a forge; agents cannot");
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
export async function spawnDoor(
  ctx: Ctx,
  user: User | undefined,
  raw: Record<string, unknown>,
): Promise<Door> {
  const anon = user === undefined;
  if (!anon && user.kind !== "user") return spawnWords({ kind: "forbidden" });
  // A plan is free of children but not of work — it reads every catalog
  // app it names — so a stranger's are counted per address and per forge.
  if (anon) {
    const verdict = takeDoor(ctx.app, "plan", ctx.request);
    if (!verdict.allowed)
      return {
        status: 429,
        body: {
          error: "rate_limited",
          message: `too many plans without signing in: ${verdict.limit} a minute; try again in ${verdict.retryAfter}s`,
        },
      };
  }
  if (raw["dryRun"] !== undefined && typeof raw["dryRun"] !== "boolean")
    return invalid("dryRun", "must be true or false");
  const dry = raw["dryRun"] !== false;
  const apps = names(raw["apps"], "apps", MAX_APPS);
  if (!Array.isArray(apps)) return apps;
  const crew = names(raw["crew"], "crew", MAX_CREW);
  if (!Array.isArray(crew)) return crew;
  if (anon && crew.length > 0)
    return invalid("crew", "anonymous spawns carry no crew; claim the forge and invite one there");
  // A stranger has no key to seal and no account to keep: the key is
  // refused outright, the rest simply do not apply.
  if (anon && raw["modelKey"] !== undefined)
    return invalid(
      "modelKey",
      "anonymous spawns carry no model key; claim the forge and add one there",
    );
  // The child's model key: a key or subscription token with a whole-life budget, or none. A
  // subscription token is a person's own plan and never travels.
  const modelEndpointRaw = raw["modelEndpoint"];
  let modelEndpoint: string | undefined;
  if (modelEndpointRaw !== undefined) {
    if (typeof modelEndpointRaw !== "string")
      return invalid("modelEndpoint", "must be an https URL (e.g. https://openrouter.ai/api)");
    const parsed = parseApiBase(modelEndpointRaw);
    if (parsed === undefined)
      return invalid("modelEndpoint", "must be an https URL with no credentials, query, or hash (OpenRouter: https://openrouter.ai/api)");
    modelEndpoint = parsed;
  }
  const modelKey = raw["modelKey"];
  if (modelKey !== undefined) {
    const kind = typeof modelKey === "string" ? kindOfToken(normalizeToken(modelKey)) : undefined;
    if (kind === undefined)
      return invalid(
        "modelKey",
        "is empty or over 4096 characters once spaces, line breaks and a `Bearer ` prefix are dropped: paste an Anthropic key, a `claude setup-token` token, or your gateway's key (with its base URL)",
      );
    if (kind === "oauth" && modelEndpoint !== undefined)
      return invalid("modelEndpoint", "a subscription token (sk-ant-oat…) talks to Anthropic itself and takes no base URL");
    if (raw["budgetUsd"] === undefined) return invalid("budgetUsd", "a model key needs a budget in dollars, for its whole life");
  } else if (raw["budgetUsd"] !== undefined) {
    return invalid("budgetUsd", "a budget is for a model key; send modelKey with it");
  } else if (modelEndpoint !== undefined) {
    return invalid("modelEndpoint", "an API base URL is for a model key; send modelKey with it");
  }

  const db = ctx.app.db;
  // Only what the caller named and may read: an unreadable app is "not a known app".
  // A stranger reads only public repositories; their crew list is empty.
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
  if (!anon) {
    for (const name of new Set(crew)) {
      const agent = getAgentByName(db, name);
      if (!agent) return invalid("crew", `${name} is not on this forge's crew`);
      briefs.push({ agent: agent.user.username, text: agent.brief });
    }
  }
  const source: SpawnSource = { catalog, briefs, subscriptions: [] };
  const input = {
    name: raw["name"],
    org: raw["name"],
    apps,
    carryBriefs: briefs.length > 0,
    carrySubscriptions: false,
    direction: raw["direction"],
    // No account to keep, and no "for whom": a stranger's child is claimed
    // by whoever opens the link.
    keepAccess: anon ? false : raw["keepAccess"],
    budgetUsd: raw["budgetUsd"],
    fresh: raw["fresh"],
    followMode: raw["followMode"],
    size: raw["size"],
    template: raw["template"],
    ...(anon ? {} : { for: raw["for"] }),
  };

  if (dry) {
    const planned = planSpawn(input, source);
    if (!planned.ok) return spawnWords({ kind: "invalid", ...planned.error });
    return {
      status: 200,
      body: {
        dryRun: true,
        plan: planned.value,
        // Who the child's first admin will be: the caller, or whoever claims it.
        firstAdmin: user?.username ?? null,
        ...dryRun(planned.value, source),
        ...(planned.value.budgetUsd === null ? {} : { keyNote: KEY_BUDGET_NOTE }),
      },
    };
  }
  // A stranger may start only a few children a day; the plan above is free.
  if (anon) {
    const limit = checkAnonSpawn(ctx.app.db, ctx.request);
    if (!limit.allowed)
      return {
        status: 429,
        body: {
          error: "rate_limited",
          message: `anonymous spawns are limited to ${ANON_SPAWNS_PER_DAY} per day; try again after ${limit.resetsAt}`,
        },
      };
  }
  const startedAt = Date.now();
  const made = await spawnForge(ctx.app, user, input, source, {
    placement: placementFor(ctx.app),
    request: ctx.request,
    url: ctx.url,
    ...(typeof modelKey === "string" ? { modelKey } : {}),
    ...(modelEndpoint === undefined ? {} : { modelEndpoint }),
  });
  if (!made.ok) return spawnWords(made.error);
  if (anon && !made.value.existed) noteAnonSpawn(ctx.app.db, ctx.request);
  // Its apps come up now, so the first visit after a claim finds them awake.
  if (!made.value.existed) {
    void bootHostedChild(ctx.app, made.value.name);
    startWatch(ctx.app, { name: made.value.name, startedAt, probe: (probes.get(ctx.app) ?? probeOf)(made.value.url) });
  }
  // Proven from outside before it is called done: the child's home and each
  // app's public address, each with what came back. What does not answer yet
  // is kept proving behind this answer, and is an alarm if it never does.
  const proved = made.value.existed ? undefined : await firstProof(ctx.app, made.value.name);
  if (proved !== undefined) void settleChild(ctx.app, made.value.name);
  return {
    status: made.value.existed ? 200 : 201,
    body: {
      dryRun: false,
      ...made.value,
      ...(proved === undefined
        ? {}
        : {
            reach: {
              ok: proved.ok,
              says: proved.ok ? "Every public address answered." : `${reachWords(proved)}. Still checking; the owner is alarmed if it does not come up in 3 minutes.`,
              proofs: proved.proofs,
            },
          }),
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

/** Take a child's unclaimed link back, or undo that within the minute: an admin's, same-origin. */
export async function changeDoor(ctx: Ctx, user: User, name: string, act: "revoke" | "undo"): Promise<Door> {
  if (crossOrigin(ctx.request, ctx.url, ctx.app.log)) return spawnWords({ kind: "cross_origin" });
  if (!user.isAdmin) return { status: 403, body: { error: "forbidden", message: "only a site admin can end or bring back a claim link" } };
  const done = await changeLink(ctx.app, user.id, name, act);
  if (done.ok) return { status: 200, body: { name, says: done.says } };
  if (done.missing) return { status: 404, body: { error: "not_found", message: `no child forge named ${name}` } };
  return spawnWords({ kind: "refused", reason: "not_open", message: done.says });
}
