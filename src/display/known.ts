/**
 * What the forge last read of each repository's display (`display.json` on
 * its default branch) and showcase (how many of its pins are showcased),
 * kept in memory so a page that lists them — `/displays` and its New display
 * picker — reads git once per repository, not once per request.
 *
 * An entry is read again when its repository's default branch may have
 * moved: a `push`, a `pull.merged` or a `repo.*` event drops it. A
 * showcase count drops on those and on any `build.*` event (a pin, a demo,
 * the showcase switch). A ref that moves with no event (an origin's sync)
 * is caught by age: an entry older than `FRESH_MS` is answered as it stands
 * and read again in the background, the way the repository header's
 * Display link is (`hasDisplay`). Git stays the record: this is a cache,
 * empty on boot.
 */

import type { App } from "../app.ts";
import { listAdminOwnedRepos, listEveryRepo, readableRepoIds, repoDatesFor, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { listBuildPins } from "../git/builds.ts";
import { repoDir } from "../git/repos.ts";
import type { Result } from "../kernel/result.ts";
import { readDisplay, type DisplayConfig } from "./config.ts";
import { displayItems, sourceRepos } from "./items.ts";

/** How long an entry is answered without a background read. */
const FRESH_MS = 10 * 60_000;
/** How many repositories a cold listing reads from git at once. */
const READS_AT_ONCE = 8;

/** One kind of fact per repository id: kept, read once at a time, dropped on an event. */
class Kept<T> {
  private readonly kept = new Map<string, { value: T; at: number }>();
  private readonly reading = new Map<string, Promise<T>>();
  /** Bumped on every drop, so a read that started before it is not kept. */
  private readonly epoch = new Map<string, number>();

  drop(key: string): void {
    this.kept.delete(key);
    this.reading.delete(key);
    this.epoch.set(key, (this.epoch.get(key) ?? 0) + 1);
  }

  keys(): IterableIterator<string> {
    return this.kept.keys();
  }

  peek(key: string): T | undefined {
    return this.kept.get(key)?.value;
  }

  /** The kept value, or a read; a stale value is answered and read again behind it. */
  async get(key: string, read: () => Promise<T>): Promise<T> {
    const seen = this.kept.get(key);
    if (seen !== undefined) {
      if (Date.now() - seen.at > FRESH_MS) void this.load(key, read).catch(() => undefined);
      return seen.value;
    }
    return this.load(key, read);
  }

  private load(key: string, read: () => Promise<T>): Promise<T> {
    const going = this.reading.get(key);
    if (going !== undefined) return going;
    const started = this.epoch.get(key) ?? 0;
    const p = read()
      .then((value) => {
        if ((this.epoch.get(key) ?? 0) === started) this.kept.set(key, { value, at: Date.now() });
        return value;
      })
      .finally(() => {
        if (this.reading.get(key) === p) this.reading.delete(key);
      });
    this.reading.set(key, p);
    return p;
  }
}

/** The Arcade's pick as last read: kept until read again, so a sync reader always has an answer. */
interface ArcadePick {
  value: Repo | undefined;
  at: number;
  /** Bumped on every event that may change it; a pick read before the bump is stale. */
  epoch: number;
  readEpoch: number;
  reading: Promise<Repo | undefined> | undefined;
}

interface Known {
  readonly displays: Kept<Result<DisplayConfig, string> | undefined>;
  readonly arcade: ArcadePick;
  readonly showcased: Kept<number>;
  /** A display's demo count, with the source repositories it was counted over. */
  readonly counts: Kept<{ readonly n: number; readonly sources: readonly string[] }>;
}

const byApp = new WeakMap<App, Known>();

function knownFor(app: App): Known {
  let k = byApp.get(app);
  if (k !== undefined) return k;
  const made: Known = {
    displays: new Kept(),
    showcased: new Kept(),
    counts: new Kept(),
    arcade: { value: undefined, at: 0, epoch: 1, readEpoch: 0, reading: undefined },
  };
  app.bus.subscribe((event) => {
    const id = event.repoId;
    if (id === null) return;
    const moved = event.kind === "push" || event.kind === "pull.merged" || event.kind.startsWith("repo.");
    const pins = moved || event.kind.startsWith("build.");
    if (moved) {
      made.displays.drop(id);
      made.counts.drop(id);
      made.arcade.epoch++;
    }
    if (!pins) return;
    made.showcased.drop(id);
    // A count over this repository, or over an owner that may have gained or lost one.
    for (const key of [...made.counts.keys()]) {
      const c = made.counts.peek(key);
      if (c !== undefined && (event.kind.startsWith("repo.") || c.sources.includes(id))) made.counts.drop(key);
    }
  });
  byApp.set(app, made);
  k = made;
  return k;
}

/** `repo`'s display as last read: undefined when it has none, an error when its file is bad. */
export function displayOf(app: App, repo: Repo): Promise<Result<DisplayConfig, string> | undefined> {
  return knownFor(app).displays.get(repo.id, () => readDisplay(app, repo));
}

/** The title that makes a site admin's display the Arcade's. */
export const ARCADE_TITLE = "arcade-builds";

/**
 * The Arcade's display repository: of the repositories site admins own,
 * the one whose display is titled exactly `arcade-builds`; of several, the
 * most recently pushed to. Read again when an event may have moved it, or
 * when it is older than `FRESH_MS`.
 */
export function arcadeRepoOf(app: App): Promise<Repo | undefined> {
  const pick = knownFor(app).arcade;
  if (pick.readEpoch === pick.epoch && Date.now() - pick.at <= FRESH_MS) return Promise.resolve(pick.value);
  if (pick.reading !== undefined) return pick.reading;
  const started = pick.epoch;
  const p = findArcadeRepo(app)
    .then((value) => {
      pick.value = value;
      pick.at = Date.now();
      pick.readEpoch = started;
      return value;
    })
    .finally(() => {
      if (pick.reading === p) pick.reading = undefined;
    });
  pick.reading = p;
  return p;
}

/** The Arcade's display repository as last read, for a reader that cannot wait; a stale pick is read again behind it. */
export function arcadeRepoKnown(app: App): Repo | undefined {
  const pick = knownFor(app).arcade;
  if (pick.readEpoch !== pick.epoch || Date.now() - pick.at > FRESH_MS) void arcadeRepoOf(app).catch(() => undefined);
  return pick.value;
}

async function findArcadeRepo(app: App): Promise<Repo | undefined> {
  const repos = listAdminOwnedRepos(app.db);
  const read = await inTurn(repos, (repo) => displayOf(app, repo));
  const named = repos.filter((_, i) => {
    const config = read[i];
    return config?.ok === true && config.value.title === ARCADE_TITLE;
  });
  if (named.length <= 1) return named[0];
  const dates = repoDatesFor(app.db, named.map((r) => r.id));
  const when = (r: Repo): string => {
    const d = dates.get(r.id);
    return d?.pushedAt ?? d?.createdAt ?? "";
  };
  // Newest first; a tie goes to the later id (ids are monotonic).
  return [...named].sort((a, b) => when(b).localeCompare(when(a)) || b.id.localeCompare(a.id))[0];
}

/** How many of `repo`'s pins are in the showcase, as last read. */
export function showcasedIn(app: App, repo: Repo): Promise<number> {
  return knownFor(app).showcased.get(repo.id, async () => {
    const pins = await listBuildPins(repoDir(app.reposRoot, repo.ownerName, repo.name));
    return pins.filter((p) => p.demo?.showcase === true).length;
  });
}

/**
 * How many demos a display shows: every showcased pin of its sources.
 * Showcase publishes a demo (`items.ts`), so the count is the same for every
 * viewer who reads the display. A display that chooses its `builds` counts
 * what it shows a stranger: its showcased builds, and those in public
 * repositories.
 */
async function demoCount(app: App, display: Repo, config: DisplayConfig): Promise<number> {
  const counted = await knownFor(app).counts.get(display.id, async () => {
    if (config.builds !== undefined) {
      const items = await displayItems(app, display, config, undefined);
      return { n: items.length, sources: [...new Set(items.map((i) => i.repo.id))] };
    }
    const sources = sourceRepos(app, config);
    const each = await Promise.all(sources.map((r) => showcasedIn(app, r)));
    return { n: each.reduce((a, b) => a + b, 0), sources: sources.map((r) => r.id) };
  });
  return counted.n;
}

/** `fn` over `items`, `READS_AT_ONCE` at a time. */
async function inTurn<T, U>(items: readonly T[], fn: (item: T) => Promise<U>): Promise<U[]> {
  const out: U[] = new Array<U>(items.length);
  let next = 0;
  const worker = async () => {
    for (let i = next++; i < items.length; i = next++) out[i] = await fn(items[i]!);
  };
  await Promise.all(Array.from({ length: Math.min(READS_AT_ONCE, items.length) }, worker));
  return out;
}

export interface ListedDisplay {
  readonly repo: Repo;
  /** The display's file, read: an error when it does not parse. */
  readonly config: Result<DisplayConfig, string>;
  /** Showcased demos on it; undefined when its file is bad. */
  readonly demos: number | undefined;
}

/** Every repository with a display that `viewer` may read, by owner and name. */
export async function listedDisplays(app: App, viewer: User | undefined): Promise<ListedDisplay[]> {
  const all = listEveryRepo(app.db);
  const read = await inTurn(all, (repo) => displayOf(app, repo));
  const having = all.flatMap((repo, i) => {
    const config = read[i];
    return config === undefined ? [] : [{ repo, config }];
  });
  const readable = readableRepoIds(app.db, viewer, having.map((d) => d.repo.id));
  const shown = having.filter((d) => readable.has(d.repo.id));
  const counts = await inTurn(shown, (d) => (d.config.ok ? demoCount(app, d.repo, d.config.value) : Promise.resolve(undefined)));
  return shown.map((d, i) => ({ ...d, demos: counts[i] }));
}

/** Of `repos`, those with no `display.json` on their default branch. */
export async function withoutDisplay(app: App, repos: readonly Repo[]): Promise<Repo[]> {
  const read = await inTurn(repos, (repo) => displayOf(app, repo));
  return repos.filter((_, i) => read[i] === undefined);
}
