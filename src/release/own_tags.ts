/**
 * The forge's own repository (`FORGE_REPO`) as the place its releases are
 * read from: found by name in this forge's database (any case, as a URL
 * finds it), and its tags read from that repository's git store on disk.
 *
 * When the tags cannot be read — the name is no repository on this forge,
 * or git refuses — the reason goes to the log once, and again only when it
 * changes; otherwise `/releases.json` stops at the frozen list and nothing
 * says why (#6730). A failed read throws, so the behind watch keeps its last
 * answer and the shipped list keeps the last tags read.
 */

import type { Database } from "bun:sqlite";
import type { Log } from "../kernel/log.ts";
import { err, type Result } from "../kernel/result.ts";
import { getRepo } from "../core/repos.ts";
import { repoDir } from "../git/repos.ts";
import { readTags, setTagged, type Shipped } from "./shipped.ts";
import { newestOf, type Newest } from "./behind.ts";

/** The release records on the tags of the repository `named` (`owner/name`) on this forge; why not when there are none to read. */
export async function readOwnTags(
  app: { readonly db: Database; readonly reposRoot: string },
  named: string,
): Promise<Result<Shipped[], string>> {
  const [owner = "", name = ""] = named.split("/");
  const repo = getRepo(app.db, owner, name);
  if (repo === undefined) return err(`FORGE_REPO names ${named}, which is no repository on this forge`);
  const read = await readTags(repoDir(app.reposRoot, repo.ownerName, repo.name));
  return read.ok ? read : err(`git cannot read the tags of ${repo.ownerName}/${repo.name}: ${read.error}`);
}

/** The behind watch's read: the own tags kept as the shipped releases, and the newest of them; the log told when that stops or starts working. */
export function ownTagsReader(
  app: { readonly db: Database; readonly reposRoot: string; readonly log: Log },
  named: string,
): () => Promise<Newest | undefined> {
  let said: string | undefined;
  let newest: string | undefined;
  return async () => {
    const read = await readOwnTags(app, named);
    if (!read.ok) {
      if (read.error !== said) app.log.warn("release tags unread; /releases.json lists what was read before", { why: read.error });
      said = read.error;
      throw new Error(read.error);
    }
    said = undefined;
    setTagged(read.value);
    const top = newestOf(read.value);
    if (top?.version !== newest) app.log.info("release tags read", { repo: named, tags: read.value.length, newest: top?.version ?? "none" });
    newest = top?.version;
    return top;
  };
}
