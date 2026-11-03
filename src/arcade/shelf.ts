/**
 * The shelf layout's data: a display's items that play as a file and have
 * their page captured, as cartridges. Items sharing a demo name are one
 * cartridge, and each is one of its builds, in display order, in the shape
 * browser-arcade's `games.json` has always had. A demo that opens as a
 * running preview or as screenshots has no file to play, so the shelf
 * leaves it out.
 *
 * Paths are relative to the display origin's root (`host.ts`); the forge's
 * own shelf page rewrites them to absolute addresses (`web/pages/display.ts`).
 * An item whose repository the shelf's viewer cannot read (`open: false`)
 * is named by its display and opaque id alone — `displays/<owner>/<display>/<id>…`
 * — and carries no repository, pin or commit.
 */

import type { Repo } from "../core/repos.ts";
import type { BuildPin, Demo } from "../git/builds.ts";
import type { DisplayItem } from "../display/items.ts";
import { pageFile } from "./carts.ts";

export interface ShelfBuild {
  readonly id: string;
  readonly name: string;
  /** The capture, relative to the Arcade's root. */
  readonly file: string;
  /** An uploaded cover, already titled. */
  readonly label?: string;
  /** The page's picture, for a cover drawn in the house style. */
  readonly art?: string;
  readonly titled?: boolean;
  readonly download: string;
  readonly date: string;
  readonly size: number;
  /** Where it came from: `owner/repo`, the pin and its commit; absent for an item not open to the viewer. */
  readonly repo?: string;
  readonly pin?: string;
  readonly oid?: string;
}

export interface ShelfGame {
  readonly id: string;
  readonly name: string;
  readonly producer: string;
  readonly builds: ShelfBuild[];
}

/** One item on the shelf, as the host serves its files. */
export interface ShelfEntry {
  readonly repo: Repo;
  readonly pin: BuildPin;
  readonly cart: Demo;
  readonly item: DisplayItem;
}

export interface Shelf {
  readonly games: ShelfGame[];
  /** Each relative path the shelf names, to the item it belongs to. */
  readonly entries: Map<string, ShelfEntry>;
}

export const slug = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "cart";

export const cartFile = (repo: Pick<Repo, "ownerName" | "name">, oid: string, page: string): string =>
  `carts/${repo.ownerName}/${repo.name}/${oid}/${pageFile(page)}.html`;
export const coverFile = (repo: Repo, label: string): string => `labels/${repo.ownerName}/${repo.name}/${label}.png`;
export const artFile = (repo: Repo, oid: string, page: string): string =>
  `art/${repo.ownerName}/${repo.name}/${oid}/${pageFile(page)}.png`;

type Shown = { readonly display: Pick<Repo, "ownerName" | "name">; readonly id: string };
const shownRoot = (item: Shown): string => `displays/${item.display.ownerName}/${item.display.name}/${item.id}`;
/** A published item's page on the display origin, by its display and id. */
export const shownFile = (item: Shown): string => `${shownRoot(item)}.html`;
/** A published item's cover, and its page's picture, on the display origin. */
export const shownCover = (item: Shown): string => `${shownRoot(item)}/cover.png`;
export const shownArt = (item: Shown): string => `${shownRoot(item)}/art.png`;

/** The shelf a display's items make; `producer` is the shelf layout's option. */
export function shelfOf(items: readonly DisplayItem[], producer: string | undefined): Shelf {
  const entries = new Map<string, ShelfEntry>();
  const byName = new Map<string, { name: string; builds: ShelfBuild[] }>();
  for (const item of items) {
    const { repo, pin, demo: cart } = item;
    if (item.launch !== "file" || item.captured === undefined) continue;
    const entry = { repo, pin, cart, item };
    const file = item.open ? cartFile(repo, pin.oid, cart.page) : shownFile(item);
    entries.set(file, entry);
    const cover = cart.cover === undefined ? undefined : item.open ? coverFile(repo, pin.label) : shownCover(item);
    if (cover !== undefined) entries.set(cover, entry);
    const art = cover === undefined && item.art ? (item.open ? artFile(repo, pin.oid, cart.page) : shownArt(item)) : undefined;
    if (art !== undefined) entries.set(art, entry);
    const game = byName.get(cart.name) ?? { name: cart.name, builds: [] };
    byName.set(cart.name, game);
    // A build's id is unique within its cart: a repeated version takes its pin's label.
    const taken = game.builds.some((b) => b.id === slug(cart.version));
    const id = !taken ? slug(cart.version) : item.open ? `${slug(cart.version)}-${slug(pin.label)}` : `${slug(cart.version)}-${item.id.slice(0, 6).toLowerCase()}`;
    game.builds.push({
      id,
      name: cart.version,
      file,
      ...(cover === undefined ? {} : { label: cover, titled: true }),
      ...(art === undefined ? {} : { art }),
      download: `${slug(cart.name)}-${slug(cart.version)}.html`,
      date: pin.pinnedAt.slice(0, 10),
      size: item.captured,
      ...(item.open ? { repo: `${repo.ownerName}/${repo.name}`, pin: pin.label, oid: pin.oid } : {}),
    });
  }
  // Cartridges in the order their first build stands in the display.
  const games = [...byName.values()].map((g) => ({ id: slug(g.name), name: g.name, producer: producer ?? "", builds: g.builds }));
  return { games, entries };
}
