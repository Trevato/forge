/**
 * The packs this forge shows (#10532): a pack is a forge repo with a
 * `pack.json` at its root, and the packs are the public repos an admin marked
 * in the `packs.repos` setting (`marked.ts`), read from git at their default
 * branch. A repo not marked is not listed. A repo that is missing, private,
 * has no pack.json or one that fails to parse is left out and named in
 * `problems`, so a bad pack never reaches a page.
 *
 * `catalog()` answers from memory; `refreshCatalog(app)` re-reads git. It is
 * called at boot, when the setting is saved, and by the pages that list packs.
 */

import type { App } from "../app.ts";
import { getRepo } from "../core/repos.ts";
import { blobHead } from "../git/read.ts";
import { repoDir } from "../git/repos.ts";
import { markedRepos } from "./marked.ts";
import { parsePack, type Pack } from "./pack.ts";

export type Catalog = { packs: readonly Pack[]; problems: readonly string[] };

/** A pack.json larger than this is not read. */
export const MAX_PACK_BYTES = 64 * 1024;

/** Read the marked repos of `app` from git. */
export async function readCatalog(app: App): Promise<Catalog> {
  const packs: Pack[] = [];
  const problems: string[] = [];
  for (const full of markedRepos(app.db)) {
    const [owner = "", name = ""] = full.split("/");
    const repo = getRepo(app.db, owner, name);
    if (repo === undefined) problems.push(`${full}: no such repository`);
    else if (repo.visibility !== "public") problems.push(`${full}: a pack repository must be public`);
    else {
      const bytes = await blobHead(repoDir(app.reposRoot, repo.ownerName, repo.name), "HEAD", "pack.json", MAX_PACK_BYTES + 1);
      if (bytes === undefined || bytes.length === 0) problems.push(`${full}: no pack.json at its root`);
      else if (bytes.length > MAX_PACK_BYTES) problems.push(`${full}: pack.json is too large`);
      else {
        const parsed = parsePack(new TextDecoder().decode(bytes));
        if (!parsed.ok) problems.push(`${full}: ${parsed.error}`);
        else if (parsed.value.name !== repo.name.toLowerCase()) problems.push(`${full}: pack name must match the repository name`);
        else if (!packs.some((p) => p.name === parsed.value.name)) packs.push(parsed.value);
        else problems.push(`${full}: another marked repository is already the pack ${parsed.value.name}`);
      }
    }
  }
  packs.sort((a, b) => a.name.localeCompare(b.name));
  return { packs, problems };
}

let current: Catalog = { packs: [], problems: [] };
const readAt = new WeakMap<App, number>();
let running: Promise<Catalog> | undefined;
let queued: Promise<Catalog> | undefined;

/** The catalog as last read, in memory. */
export const catalog = (): Catalog => current;

export const packNamed = (name: string): Pack | undefined => current.packs.find((p) => p.name === name);

async function readOnce(app: App): Promise<Catalog> {
  const read = await readCatalog(app);
  current = read;
  readAt.set(app, Date.now());
  return read;
}

/**
 * Re-read git unless this app's catalog was read within `maxAgeMs`. Reads run
 * one at a time and in the order asked: a call made while one is running waits
 * for it and then reads again (so it sees what changed since that one began),
 * and every call made meanwhile shares that second read. An older read can
 * therefore never overwrite a newer one.
 */
export function refreshCatalog(app: App, maxAgeMs = 0): Promise<Catalog> {
  const last = readAt.get(app);
  if (last !== undefined && Date.now() - last < maxAgeMs) return Promise.resolve(current);
  if (running === undefined) {
    const mine = readOnce(app).finally(() => {
      if (running === mine) running = undefined;
    });
    running = mine;
    return mine;
  }
  if (queued === undefined) {
    const next: Promise<Catalog> = running
      .catch(() => undefined)
      .then(() => {
        queued = undefined;
        return refreshCatalog(app);
      });
    queued = next;
  }
  return queued;
}

/** `refreshCatalog` for a caller that cannot act on a failure: it is logged, the catalog stays as it was. */
export function refreshCatalogQuietly(app: App, maxAgeMs = 0): Promise<Catalog> {
  return refreshCatalog(app, maxAgeMs).catch((e: unknown) => {
    app.log.warn("the packs catalog could not be read", { error: e instanceof Error ? e.message : String(e) });
    return current;
  });
}
