/**
 * Where a display item opens. A `file` demo plays on the display origin,
 * `arcade.<app domain>`, never on the forge's: a captured page is a
 * stranger's code. A page in a repository anyone may read plays at its
 * plain address; one in a repository only the viewer may read carries a
 * short grant the forge signed for that page alone (`signCart`).
 *
 * An item the viewer cannot read the repository of (`open: false`) is
 * reached only through its display, by its opaque id: on the forge under
 * `/<owner>/<display>/display/demo/<id>/…`, and on the display origin at
 * `displays/<owner>/<display>/<id>.html`. Showcase published it, so it
 * plays without a grant when the display is public; a private display's
 * page carries a grant for that path.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import type { App } from "../app.ts";
import { appsRuntime } from "../apps/runtime.ts";
import { arcadeUrl } from "../arcade/host.ts";
import { cartFile, shownFile } from "../arcade/shelf.ts";
import { canRead, type Repo } from "../core/repos.ts";
import type { BuildPin } from "../git/builds.ts";
import { loadKey } from "../kernel/secret.ts";
import type { DisplayItem } from "./items.ts";

/** How long a grant to play a private page lasts. */
export const CART_GRANT_MS = 60 * 60 * 1000;

const mac = (dataDir: string, payload: string): string =>
  createHmac("sha256", loadKey(dataDir)).update(`cart:${payload}`).digest("base64url");

/** A grant to play the capture at `path` (`carts/<owner>/<repo>/<sha>/<page>.html`) until it expires. */
export function signCart(dataDir: string, path: string, now = Date.now()): string {
  const expires = now + CART_GRANT_MS;
  return `${expires}.${mac(dataDir, `${path}:${expires}`)}`;
}

/** Whether `grant` vouches for `path` now. */
export function verifyCart(dataDir: string, path: string, grant: string, now = Date.now()): boolean {
  const dot = grant.indexOf(".");
  const expires = grant.slice(0, dot);
  if (dot === -1 || !/^\d{1,15}$/.test(expires) || Number(expires) <= now) return false;
  const a = Buffer.from(grant.slice(dot + 1));
  const b = Buffer.from(mac(dataDir, `${path}:${expires}`));
  return a.length === b.length && timingSafeEqual(a, b);
}

/** The display origin, or undefined where no apps run. */
export function displayOrigin(app: App): string | undefined {
  const runtime = appsRuntime(app);
  return runtime === undefined ? undefined : arcadeUrl(runtime);
}

type Hidden = Pick<DisplayItem, "display" | "id">;

/** An item's own routes on the forge, under its display. */
export const shownBase = (item: Hidden): string => `/${item.display.ownerName}/${item.display.name}/display/demo/${item.id}`;

/** Where a captured demo plays, or undefined where no apps run or nothing is captured. */
export function playUrl(app: App, item: DisplayItem): string | undefined {
  if (item.captured === undefined) return undefined;
  if (item.open) return pinPlayUrl(app, item.repo, item.pin.oid, item.demo.page);
  const origin = displayOrigin(app);
  if (origin === undefined) return undefined;
  const path = shownFile(item);
  const plain = canRead(app.db, item.display, undefined);
  return `${origin}/${path}${plain ? "" : `?g=${signCart(app.config.dataDir, path)}`}`;
}

/**
 * Where a commit's captured page plays on the display origin, read through
 * its own repository: plain when anyone may read it, else with a grant.
 * The caller says it is captured (`captureState`).
 */
export function pinPlayUrl(app: App, repo: Repo, oid: string, page: string): string | undefined {
  const origin = displayOrigin(app);
  if (origin === undefined) return undefined;
  const path = cartFile(repo, oid, page);
  return `${origin}/${path}${canRead(app.db, repo, undefined) ? "" : `?g=${signCart(app.config.dataDir, path)}`}`;
}

/** Where a captured demo downloads, on the forge. */
export const downloadUrl = (item: DisplayItem): string =>
  item.open
    ? `/${item.repo.ownerName}/${item.repo.name}/builds/${item.pin.oid}/download?page=${encodeURIComponent(item.demo.page)}`
    : `${shownBase(item)}/download`;

/** A pin's screenshots, on its repository. */
export const repoShotsUrl = (repo: Pick<Repo, "ownerName" | "name">, pin: Pick<BuildPin, "label">): string =>
  `/${repo.ownerName}/${repo.name}/builds/${encodeURIComponent(pin.label)}/shots`;

/** A demo's screenshots, on the forge. */
export const shotsUrl = (item: DisplayItem): string => (item.open ? repoShotsUrl(item.repo, item.pin) : `${shownBase(item)}/shots`);

/** A demo's cover, or the picture of its captured page, on the forge. */
export const coverUrl = (item: DisplayItem): string =>
  item.open ? `/${item.repo.ownerName}/${item.repo.name}/builds/${encodeURIComponent(item.pin.label)}/cover` : `${shownBase(item)}/cover`;
