/**
 * Bringing carts in that were built outside the forge: a game whose
 * offline file comes from its own build step, not from a page its app
 * serves (Krazy Karts' `build:file`), or a shelf that lived elsewhere
 * before the Arcade. An operator runs it on the forge's own data
 * directory (`scripts/import-carts.ts`); each entry pins its commit if no
 * pin has that label yet, writes the cart facts and cover onto the pin,
 * and stores the file as that commit's capture of the page.
 *
 * A capture is still written once: a page already captured is kept.
 */

import { join } from "node:path";
import { pinBuild, readBuildPin, setPinDemo, storeCover, type Demo } from "../git/builds.ts";
import { repoDir } from "../git/repos.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { importCapture } from "./carts.ts";

export interface CartImport {
  /** `owner/name`. */
  readonly repo: string;
  readonly label: string;
  /** The commit, full id, the cart was built from. */
  readonly sha: string;
  readonly note?: string;
  /** The cart's facts; `shelf` puts it in the showcase. A `producer` is the Arcade's own, not the pin's. */
  readonly cart: Pick<Demo, "name" | "version" | "page"> & { readonly shelf: boolean };
  /** The cart file's bytes. */
  readonly html: Uint8Array;
  /** An uploaded cover, already titled. */
  readonly cover?: Uint8Array | undefined;
  /** A picture of the page, for a cover drawn in the house style. */
  readonly art?: Uint8Array | undefined;
}

export interface ImportResult {
  readonly label: string;
  readonly pinned: boolean;
  readonly captured: boolean;
}

/** Import one cart into the forge at `dataDir`, as `tagger`. */
export async function importCart(
  dataDir: string,
  entry: CartImport,
  tagger: { readonly name: string; readonly email: string },
): Promise<Result<ImportResult, string>> {
  const [owner = "", name = ""] = entry.repo.split("/");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(owner) || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name))
    return err(`${entry.repo}: not owner/name`);
  const dir = repoDir(join(dataDir, "repos"), owner, name);
  let pin = await readBuildPin(dir, entry.label);
  let pinned = false;
  if (pin === undefined) {
    const made = await pinBuild(dir, {
      label: entry.label,
      oid: entry.sha,
      note: entry.note ?? "",
      source: "import",
      tagger,
    });
    if (!made.ok) return err(`${entry.repo} ${entry.label}: ${made.error}`);
    pin = made.value;
    pinned = true;
  } else if (pin.oid !== entry.sha) return err(`${entry.repo} ${entry.label}: pinned at ${pin.oid}, not ${entry.sha}`);
  let cover = pin.demo?.cover;
  if (entry.cover !== undefined) {
    const stored = await storeCover(dir, entry.label, entry.cover);
    if (!stored.ok) return err(`${entry.repo} ${entry.label}: cover ${stored.error}`);
    cover = stored.value;
  }
  // A cart is a captured page: it opens as a file.
  const demo: Demo = {
    name: entry.cart.name,
    version: entry.cart.version,
    launch: "file",
    page: entry.cart.page,
    showcase: entry.cart.shelf,
    ...(cover === undefined ? {} : { cover }),
  };
  const set = await setPinDemo(dir, entry.label, demo);
  if (!set.ok) return err(`${entry.repo} ${entry.label}: ${set.error}`);
  const captured = importCapture(dataDir, { ownerName: owner, name }, entry.sha, entry.cart.page, entry.html, entry.art);
  if (!captured.ok) return err(`${entry.repo} ${entry.label}: page ${entry.cart.page} is no capture path`);
  return ok({ label: entry.label, pinned, captured: captured.value });
}
