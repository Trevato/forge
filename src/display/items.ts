/**
 * A display's items: the builds its `builds` names, else every pin in its
 * sources whose demo is in the showcase. Showcase publishes the demo: a writer turning it on publishes
 * that one demo — its captured page, screenshots, cover, name, version and
 * captions — to anyone who can see a display that includes it, whether or
 * not they can read the repository it lives in. The repository stays
 * private: to a viewer who cannot read it, an item is `open: false`, and
 * the display names it by its opaque `id` alone, never by `owner/name`,
 * and serves its assets only through the display's own routes
 * (`display/launch.ts`).
 *
 * Order: `builds`' order when it is given. Otherwise the keys `order`
 * names, in that order, then everything else, oldest pinned first, so a
 * new demo joins the end.
 */

import { createHmac } from "node:crypto";
import { statSync } from "node:fs";
import type { App } from "../app.ts";
import { demoDefaults, demoFactsAt } from "../actions/pin_demos.ts";
import { capturePath } from "../arcade/carts.ts";
import { canRead, getRepo, listAllReposByOwner, ownerInStanding, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { isCopiedPin, launchOf, listBuildPins, type BuildPin, type Demo, type Launch } from "../git/builds.ts";
import { repoDir } from "../git/repos.ts";
import { loadKey } from "../kernel/secret.ts";
import { demoKey, type DisplayConfig } from "./config.ts";

export interface DisplayItem {
  /** `owner/name:label`. Never shown to a viewer for whom the item is not `open`. */
  readonly key: string;
  /** The item's name on this display alone: opaque, keyed by the forge's secret (`demoId`). */
  readonly id: string;
  /** Whether the viewer reads the item's repository, and so may see which it is. */
  readonly open: boolean;
  /** The repository whose display this is. */
  readonly display: Repo;
  readonly repo: Repo;
  readonly pin: BuildPin;
  readonly demo: Demo;
  /** How it opens on this display: its override, else the pin's own. */
  readonly launch: Launch;
  /** The size of its captured page, when there is one. */
  readonly captured: number | undefined;
  /** Whether a picture of its captured page is kept. */
  readonly art: boolean;
}

const sizeOf = (path: string): number | undefined => {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
};

/**
 * A demo's id on one display: an HMAC of the display and the pin under the
 * forge's secret, so it names no repository, and an id from one display
 * resolves on no other.
 */
export function demoId(dataDir: string, display: Pick<Repo, "id">, repo: Pick<Repo, "id">, label: string): string {
  return createHmac("sha256", loadKey(dataDir)).update(`display-demo:${display.id}:${repo.id}:${label}`).digest("base64url").slice(0, 22);
}

/** Whether `s` has an id's shape. */
export const isDemoId = (s: string): boolean => /^[A-Za-z0-9_-]{22}$/.test(s);

/** The repositories a display's sources name, private ones too, each once. */
export function sourceRepos(app: App, config: DisplayConfig): Repo[] {
  const out = new Map<string, Repo>();
  for (const source of config.sources) {
    const repos =
      source.kind === "owner"
        ? listAllReposByOwner(app.db, source.owner, 100)
        : [getRepo(app.db, source.owner, source.name)].filter((r): r is Repo => r !== undefined);
    for (const repo of repos) if (!out.has(repo.id) && ownerInStanding(app.db, repo)) out.set(repo.id, repo);
  }
  return [...out.values()];
}

/**
 * The display's items, in display order, each marked `open` as `viewer`
 * reads its repository. The caller has already checked that `viewer` reads
 * the display itself.
 *
 * With `builds`, the items are those builds in that order, showcased or
 * not: a showcased one is published to every viewer, as below; one not
 * showcased is seen only by a viewer who reads its repository. Without
 * `builds`, every showcased pin in `sources`, in `order`.
 */
export async function displayItems(app: App, display: Repo, config: DisplayConfig, viewer: User | undefined): Promise<DisplayItem[]> {
  if (config.builds !== undefined) return chosenItems(app, display, config, config.builds, viewer);
  const found: DisplayItem[] = [];
  for (const { repo, pin } of await showcasedPins(app, config))
    found.push(await itemOf(app, display, config, repo, pin, pin.demo!, canRead(app.db, repo, viewer)));
  return orderItems(found, config.order);
}

/** Every showcased pin of the display's sources, each once: today's rule, before `builds`. */
async function showcasedPins(app: App, config: DisplayConfig): Promise<{ repo: Repo; pin: BuildPin }[]> {
  const out: { repo: Repo; pin: BuildPin }[] = [];
  const repos = sourceRepos(app, config);
  const pinsOf = new Map(
    await Promise.all(repos.map(async (r) => [r.id, await listBuildPins(repoDir(app.reposRoot, r.ownerName, r.name))] as const)),
  );
  for (const repo of repos) {
    // A fork carries its parent's pins: one both sources hold shows once, from the parent.
    const parentPins = repo.forkParentId === null ? undefined : pinsOf.get(repo.forkParentId);
    for (const pin of pinsOf.get(repo.id) ?? []) {
      if (pin.demo === undefined || !pin.demo.showcase) continue;
      if (parentPins !== undefined && isCopiedPin(pin, parentPins)) continue;
      out.push({ repo, pin });
    }
  }
  return out;
}

/**
 * The display's selection as keys, in order, as `viewer` may name them:
 * `builds` when the file gives it, else the showcased rule's keys of the
 * repositories `viewer` reads (all of them, for "everyone": the forge's own
 * view, never shown). Reads no launch facts, so a page that lists
 * many displays' selections stays cheap.
 */
export async function selectionKeys(app: App, config: DisplayConfig, viewer: User | undefined | "everyone"): Promise<string[]> {
  if (config.builds !== undefined) return [...config.builds];
  const found = (await showcasedPins(app, config))
    .filter(({ repo }) => viewer === "everyone" || canRead(app.db, repo, viewer))
    .map(({ repo, pin }) => ({ key: demoKey(repo.ownerName, repo.name, pin.label), pin }));
  return orderItems(found, config.order).map((i) => i.key);
}

/**
 * Items for the given keys, in that order, as `viewer` may see them: what a
 * display's page draws for builds that are not on it yet (its sidebar).
 */
export const itemsOfKeys = (app: App, display: Repo, config: DisplayConfig, keys: readonly string[], viewer: User | undefined): Promise<DisplayItem[]> =>
  chosenItems(app, display, config, keys, viewer);

/** The chosen builds a viewer may see on the display, in the chosen order. */
async function chosenItems(app: App, display: Repo, config: DisplayConfig, builds: readonly string[], viewer: User | undefined): Promise<DisplayItem[]> {
  const byRepo = new Map<string, { repo: Repo | undefined; pins: Map<string, BuildPin> }>();
  const out: DisplayItem[] = [];
  for (const key of builds) {
    const at = key.lastIndexOf(":");
    const [owner = "", name = ""] = key.slice(0, at).split("/");
    const label = key.slice(at + 1);
    const repoKey = `${owner}/${name}`;
    let held = byRepo.get(repoKey);
    if (held === undefined) {
      const found = getRepo(app.db, owner, name);
      const repo = found !== undefined && ownerInStanding(app.db, found) ? found : undefined;
      const pins = repo === undefined ? [] : await listBuildPins(repoDir(app.reposRoot, repo.ownerName, repo.name));
      held = { repo, pins: new Map(pins.map((p) => [p.label, p])) };
      byRepo.set(repoKey, held);
    }
    const pin = held.pins.get(label);
    if (held.repo === undefined || pin === undefined) continue;
    const open = canRead(app.db, held.repo, viewer);
    const showcased = pin.demo?.showcase === true;
    // Showcase publishes; anything else on a display is for its repository's readers alone.
    if (!showcased && !open) continue;
    out.push(await itemOf(app, display, config, held.repo, pin, pin.demo ?? (await plainDemo(app, held.repo, pin)), open));
  }
  return out;
}

/** What a display shows for a pin that names no demo: its repository and label, its default page, not showcased. */
async function plainDemo(app: App, repo: Repo, pin: BuildPin): Promise<Demo> {
  const facts = await demoFactsAt(app, repo, pin.oid);
  return { ...demoDefaults(repo, pin.label, facts.pages), version: pin.label, showcase: false };
}

async function itemOf(app: App, display: Repo, config: DisplayConfig, repo: Repo, pin: BuildPin, demo: Demo, open: boolean): Promise<DisplayItem> {
  const key = demoKey(repo.ownerName, repo.name, pin.label);
  const override = config.demos.get(key)?.launch;
  const launch =
    override ?? demo.launch ?? (await (async () => {
      const facts = await demoFactsAt(app, repo, pin.oid);
      return launchOf(demo, facts.launch, facts.pages);
    })());
  const base = capturePath(app.config.dataDir, repo, pin.oid, demo.page);
  return {
    key,
    id: demoId(app.config.dataDir, display, repo, pin.label),
    open,
    display,
    repo,
    pin,
    demo,
    launch,
    captured: sizeOf(`${base}.html`),
    art: sizeOf(`${base}.png`) !== undefined,
  };
}

/** The item `id` names on a display, or undefined: unshowcased, gone, or from another display. */
export async function displayItem(app: App, display: Repo, config: DisplayConfig, id: string): Promise<DisplayItem | undefined> {
  if (!isDemoId(id)) return undefined;
  return (await displayItems(app, display, config, undefined)).find((i) => i.id === id);
}

/** `order`'s keys first, in its order; the rest oldest pinned first. */
export function orderItems<T extends { readonly key: string; readonly pin: Pick<BuildPin, "pinnedAt"> }>(
  items: readonly T[],
  order: readonly string[],
): T[] {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const placed = order.map((k) => byKey.get(k)).filter((i): i is T => i !== undefined);
  const named = new Set(order);
  const rest = items
    .filter((i) => !named.has(i.key))
    .sort((a, b) => (a.pin.pinnedAt < b.pin.pinnedAt ? -1 : a.pin.pinnedAt > b.pin.pinnedAt ? 1 : a.key < b.key ? -1 : 1));
  return [...placed, ...rest];
}

/**
 * A person's new selection for a display, made whole: `named` is the list
 * they gave, in their order, of builds they may name; every build already on
 * the display from a repository they cannot read keeps its place, so a page
 * that never showed its key cannot drop it.
 */
export async function keepUnnamed(app: App, config: DisplayConfig, named: readonly string[], viewer: User | undefined): Promise<string[]> {
  const current = await selectionKeys(app, config, "everyone");
  const readable = (key: string): boolean => {
    const [owner = "", name = ""] = key.slice(0, key.lastIndexOf(":")).split("/");
    const repo = getRepo(app.db, owner, name);
    return repo !== undefined && canRead(app.db, repo, viewer);
  };
  const out = named.filter(readable);
  current.forEach((key, at) => {
    if (!readable(key) && !out.includes(key)) out.splice(Math.min(at, out.length), 0, key);
  });
  return out;
}
