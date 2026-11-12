/**
 * Packs as the forge has them (#10532): forge repos `packs/<name>` holding a
 * pack.json, marked in `packs.repos`. `seedPacks` makes the two the tests walk
 * (games, business) from test/fixtures/packs and reads them into the catalog.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { App } from "../../src/app.ts";
import { createRepo } from "../../src/core/repos.ts";
import { createUser, getUserByName } from "../../src/core/users.ts";
import { commitFiles } from "../../src/git/write.ts";
import { repoDir } from "../../src/git/repos.ts";
import { refreshCatalog } from "../../src/packs/catalog.ts";
import { markedRepos, saveMarkedRepos } from "../../src/packs/marked.ts";
import { parsePack, type Pack } from "../../src/packs/pack.ts";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "packs");

/** The text of a fixture pack.json. */
export const fixtureText = (name: string): string => readFileSync(join(FIXTURES, `${name}.json`), "utf8");

/** The two fixture packs, parsed, with no forge at all. */
export const fixturePacks = (): Pack[] =>
  ["business", "games"].map((n) => {
    const r = parsePack(fixtureText(n));
    if (!r.ok) throw new Error(r.error);
    return r.value;
  });

/** Make `packs/<name>` with `text` as its pack.json; mark it when `mark`. */
export async function seedPackRepo(app: App, name: string, text: string, mark = true): Promise<void> {
  const owner =
    getUserByName(app.db, "packs") ??
    (await (async () => {
      const made = await createUser(app.db, { origin: "seed", trusted: true, allowReserved: true, username: "packs", email: "packs@forge.invalid", displayName: "Forge packs" });
      if (!made.ok) throw new Error(made.error);
      return made.value;
    })());
  const repo = await createRepo(app.db, app.reposRoot, { ownerId: owner.id, name, visibility: "public", description: "A pack.", defaultBranch: "main" });
  if (!repo.ok) throw new Error(repo.error);
  await commitFiles(repoDir(app.reposRoot, "packs", name), {
    branch: "main",
    message: "pack.json",
    files: [{ path: "pack.json", content: text }],
    author: { name: "packs", email: "packs@forge.invalid" },
  });
  if (mark) saveMarkedRepos(app.db, [...markedRepos(app.db), `packs/${name}`], owner.id);
}

/** Games and Business as marked pack repos, read into the catalog. */
export async function seedPacks(app: App): Promise<void> {
  for (const n of ["games", "business"]) await seedPackRepo(app, n, fixtureText(n));
  await refreshCatalog(app);
}
