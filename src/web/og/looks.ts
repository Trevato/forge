/**
 * Which looks a card may carry. A card is public, so it carries only a
 * picture an anonymous reader could fetch from the look route: taken as
 * nobody (or a current thumb), of the home page, of a public app, and not
 * of a sealed pull's preview. Returns plain `CardImage`s naming files;
 * `embedShots` reads them once the card is known to be wanted.
 */

import { join } from "node:path";
import { previewEnv } from "../../apps/data.ts";
import type { AppRecord } from "../../core/apps.ts";
import { DEFAULT_PAGE, looksForEnv, lookVersion, type Look } from "../../core/looks.ts";
import { sealedPreview } from "../../core/sealed.ts";
import { keepLook } from "../../looks/service.ts";
import type { App } from "../../app.ts";
import type { CardImage, CardInput } from "./card.ts";
import { shotUri } from "./shot.ts";

/** The newest home-page picture of an environment an anonymous reader may see. */
function visibleLook(app: App, record: AppRecord, repoId: string, env: string): Look | undefined {
  if (record.access !== "public" || sealedPreview(app.db, repoId, env)) return undefined;
  const home = looksForEnv(app.db, record.id, env).filter(
    (l) => l.page === DEFAULT_PAGE && l.error === null && l.path !== "",
  );
  const thumb = home.find((l) => l.kind === "thumb" && keepLook(app.config.dataDir, l));
  const taken = (kind: Look["kind"]) => home.find((l) => l.kind === kind && l.takenAs === "nobody");
  return thumb ?? taken("desktop") ?? taken("phone");
}

const imageOf = (app: App, look: Look, label?: string): CardImage => ({
  id: `${look.id}.${lookVersion(look)}`,
  path: join(app.config.dataDir, look.path),
  ...(label ? { label } : {}),
});

/** The app's latest look, as a list of none or one. */
export function appImages(app: App, record: AppRecord, repoId: string): CardImage[] {
  const look = visibleLook(app, record, repoId, "production");
  return look ? [imageOf(app, look)] : [];
}

/** A pull's preview look, after what production looked like before it; none without the former. */
export function pullImages(app: App, record: AppRecord, repoId: string, number: number): CardImage[] {
  const after = visibleLook(app, record, repoId, previewEnv(number));
  if (!after) return [];
  const before = visibleLook(app, record, repoId, "production");
  return before
    ? [imageOf(app, before, "before"), imageOf(app, after, "after")]
    : [imageOf(app, after)];
}

/** The input with its pictures read and reduced; one that cannot be read is left out. */
export function embedShots(input: CardInput): CardInput {
  if (!input.images?.length) return input;
  const images: CardImage[] = [];
  for (const image of input.images) {
    const src = image.path === undefined ? undefined : shotUri(image.path);
    if (src) images.push({ ...image, src });
  }
  return { ...input, images };
}
