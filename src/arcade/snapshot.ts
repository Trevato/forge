/**
 * Export snapshot: a display's shelf in one offline HTML file, as
 * browser-arcade's `bun run bundle` made it — the shelf, every cart and
 * every cover inside the page, so it plays from disk with no server. Its
 * one top line says it is a dated copy that will never update.
 */

import type { App } from "../app.ts";
import type { DisplayConfig } from "../display/config.ts";
import { readCover } from "../git/builds.ts";
import { repoDir } from "../git/repos.ts";
import { readArt, readCapture } from "./carts.ts";
import { coverTemplateBytes, shelfPage } from "./host.ts";
import { slug, type Shelf } from "./shelf.ts";

/** `yyyymmdd` for a day. */
export const snapshotDate = (at: Date): string => at.toISOString().slice(0, 10).replaceAll("-", "");

/** The line across the top of a snapshot. */
export const snapshotLine = (date: string, producer: string | undefined): string =>
  `${producer === undefined ? "" : `${producer.toUpperCase()} • `}snapshot ${date} | This is an HTML file that doesn't receive updates`;

const dataUrl = (bytes: Uint8Array): string => {
  const type =
    bytes[0] === 0xff ? "image/jpeg" : bytes[0] === 0x52 ? "image/webp" : "image/png";
  return `data:${type};base64,${Buffer.from(bytes).toString("base64")}`;
};

/** The snapshot file for a display's shelf as it stands. */
export async function snapshotFile(
  app: App,
  config: Pick<DisplayConfig, "title" | "shelf">,
  shelf: Shelf,
  at: Date,
): Promise<{ name: string; html: string }> {
  const date = snapshotDate(at);
  const dataDir = app.config.dataDir;
  const carts: Record<string, string> = {};
  const labels: Record<string, string> = { "cover-template.png": dataUrl(coverTemplateBytes()) };
  for (const g of shelf.games)
    for (const b of g.builds) {
      const entry = shelf.entries.get(b.file);
      if (entry === undefined) continue;
      const { repo, pin, cart } = entry;
      const html = readCapture(dataDir, repo, pin.oid, cart.page);
      if (html !== undefined) carts[b.file] = new TextDecoder().decode(html);
      if (b.label !== undefined && cart.cover !== undefined) {
        const bytes = await readCover(repoDir(app.reposRoot, repo.ownerName, repo.name), cart.cover);
        if (bytes !== undefined) labels[b.label] = dataUrl(bytes);
      }
      if (b.art !== undefined) {
        const bytes = readArt(dataDir, repo, pin.oid, cart.page);
        if (bytes !== undefined) labels[b.art] = dataUrl(bytes);
      }
    }
  const html = shelfPage({
    title: config.title,
    tabTitle: `${config.title} · snapshot ${date}`,
    producer: config.shelf.producer,
    data: { snapshot: snapshotLine(date, config.shelf.producer), games: shelf.games, carts, labels },
  });
  return { name: `${slug(config.title)}-${date}.html`, html };
}
