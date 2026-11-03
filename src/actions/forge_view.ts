/**
 * The forge as one read-only picture, for a reader that draws it (foundry,
 * a wall, a second monitor): the apps the caller may see, the crew's runs and
 * the station each is at, and the health numbers. It is composed of the
 * reads the board and home already use (`appsOf`, `crewNow`, `readHealth`), so
 * its numbers are theirs; it keeps no state of its own.
 *
 * An always-on view must not add load: the answer is built at most once per
 * `VIEW_TTL_MS` per reader, and a poll that holds its ETag costs a header.
 */
import type { App } from "../app.ts";
import type { User } from "../core/users.ts";
import type { Ctx } from "../http/context.ts";
import { appsOf } from "../web/studio/asks.ts";
import { crewNow } from "./crew_now.ts";
import { readHealth } from "./health.ts";

export const VIEW_TTL_MS = 2000;
/** Most apps listed; `counts.apps` stays the true number. */
export const VIEW_APPS = 200;

type Row = ReturnType<typeof crewNow>[number];

export interface ForgeView {
  readonly counts: { apps: number; running: number; queued: number; waiting: number };
  readonly apps: readonly { app: string; slug: string; access: string; running: number; queued: number }[];
  readonly runs: readonly Row[];
  readonly health: unknown;
}

interface Kept {
  at: number;
  text: string;
}

const kept = new WeakMap<App, Map<string, Kept>>();

export function forgeView(ctx: Pick<Ctx, "app">, user: User): ForgeView {
  const { repos, records } = appsOf(ctx, user);
  const runs = crewNow(ctx, user);
  const tally = new Map<string, { running: number; queued: number }>();
  for (const r of runs) {
    if (r.run === null) continue;
    const t = tally.get(r.app) ?? { running: 0, queued: 0 };
    if (r.state === "running") t.running++;
    else t.queued++;
    tally.set(r.app, t);
  }
  const apps = repos.slice(0, VIEW_APPS).map((repo) => {
    const name = `${repo.ownerName}/${repo.name}`;
    const record = records.get(repo.id)!;
    const t = tally.get(name) ?? { running: 0, queued: 0 };
    return { app: name, slug: record.slug, access: record.access, ...t };
  });
  return {
    counts: {
      apps: repos.length,
      running: runs.filter((r) => r.run !== null && r.state === "running").length,
      queued: runs.filter((r) => r.run !== null && r.state !== "running").length,
      waiting: runs.filter((r) => r.run === null).length,
    },
    apps,
    runs,
    health: readHealth(ctx.app, user),
  };
}

/** The view as JSON text for this reader, reused for `VIEW_TTL_MS`. */
export function forgeViewText(ctx: Pick<Ctx, "app">, user: User, now = Date.now()): string {
  let mine = kept.get(ctx.app);
  if (mine === undefined) kept.set(ctx.app, (mine = new Map()));
  const held = mine.get(user.id);
  if (held !== undefined && now - held.at < VIEW_TTL_MS) return held.text;
  const text = JSON.stringify({ ...forgeView(ctx, user), at: new Date(now).toISOString() });
  if (mine.size > 200) mine.clear();
  mine.set(user.id, { at: now, text });
  return text;
}
