/**
 * The looks every preview of the forge takes as its owner (#8974): home
 * with its pins, /flow, the seeded repository's head and its pull's page,
 * each at desk and phone width. The looks service adds them to whatever
 * forge.json lists for a preview of the forge's own repository
 * (`FORGE_REPO`), so no edit of forge.json can drop one.
 *
 * Plain data and no imports beyond a type: the seed (`preview-seed.ts`)
 * makes what these pages show, and the looks service reads the list.
 */

import type { LookKind } from "../core/looks.ts";

/** The preview-only site admin's name. */
export const PREVIEW_ADMIN = "preview-admin";
/** The repository the admin's pages are about. */
export const PREVIEW_REPO = "sample";
/**
 * The seeded pull's number: two issues come first and share its count.
 * PREVIEW_OWNER_LOOKS names its page, so the seed refuses any other
 * number rather than leave that look on a 404.
 */
export const PREVIEW_PULL = 3;
/** The seeded repository's head, and its pull's page. */
export const PREVIEW_REPO_HOME = `/${PREVIEW_ADMIN}/${PREVIEW_REPO}`;
export const PREVIEW_PULL_PAGE = `${PREVIEW_REPO_HOME}/pulls/${String(PREVIEW_PULL)}`;

export interface OwnerLook {
  readonly page: string;
  readonly kind: LookKind;
}

/** The named list: each page at desk and phone, taken as the owner. */
export const PREVIEW_OWNER_LOOKS: readonly OwnerLook[] = [
  "/",
  "/flow",
  PREVIEW_REPO_HOME,
  PREVIEW_PULL_PAGE,
].flatMap((page) => (["desktop", "phone"] as const).map((kind) => ({ page, kind })));

/**
 * The owner looks a picture of `repo`'s `env` must include: the named list
 * for a preview of the forge's own repository, none for anything else —
 * production is not seeded, and another app has no such pages.
 */
export function ownerLooksFor(
  forgeRepo: string | undefined,
  repo: { readonly ownerName: string; readonly name: string },
  env: string,
): readonly OwnerLook[] {
  return env !== "production" && forgeRepo !== undefined && forgeRepo === `${repo.ownerName}/${repo.name}`
    ? PREVIEW_OWNER_LOOKS
    : [];
}
