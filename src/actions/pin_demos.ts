/**
 * What a commit's `forge.json` says about its demos: the two reads a display
 * item starts from. (Saving, showcasing and capturing demos are not here.)
 */
import type { App } from "../app.ts";
import { readFileAt } from "../apps/checkout.ts";
import { parseManifest } from "../apps/manifest.ts";
import type { Repo } from "../core/repos.ts";
import { exactRefOid } from "../git/branches.ts";
import type { Demo, Launch } from "../git/builds.ts";
import { isSafeOid } from "../git/guard.ts";
import { readerFor } from "../git/read.ts";
import { repoDir } from "../git/repos.ts";

/** What a commit's `forge.json` says about its demos. */
export interface DemoFacts {
  /** `app.pages`: the pages it offers to play and download. */
  readonly pages: readonly string[];
  /** `app.launch`, when it names one. */
  readonly launch?: Launch | undefined;
}

/**
 * The pages and the launch a commit's `forge.json` names — or, for a
 * commit pinned before the repository named any pages, what its default
 * branch names now. A page the old build does not serve is simply not
 * found when played.
 */
export async function demoFactsAt(app: App, repo: Repo, oid: string): Promise<DemoFacts> {
  if (!isSafeOid(oid)) return { pages: [] };
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const read = async (at: string): Promise<DemoFacts> => {
    const [forgeJson, packageJson] = await Promise.all([
      readFileAt(dir, at, "forge.json"),
      readFileAt(dir, at, "package.json"),
    ]);
    const manifest = parseManifest(forgeJson, packageJson);
    if (!manifest.ok) return { pages: [] };
    return {
      pages: manifest.value.pages ?? [],
      ...(manifest.value.launch === undefined ? {} : { launch: manifest.value.launch }),
    };
  };
  const own = await read(oid);
  if (own.pages.length > 0) return own;
  // Only a commit this repository holds borrows anything.
  const stat = await readerFor(dir).stat(oid);
  if (!stat.ok || stat.value.type !== "commit") return own;
  const tip = await exactRefOid(dir, `refs/heads/${repo.defaultBranch}`);
  if (tip === undefined || tip === oid) return own;
  const now = await read(tip);
  return { pages: now.pages, ...((own.launch ?? now.launch) === undefined ? {} : { launch: own.launch ?? now.launch }) };
}

/** The facts a pin's demo starts from, before anyone edits them. */
export function demoDefaults(repo: Repo, label: string, pages: readonly string[]): Pick<Demo, "name" | "version" | "page"> {
  return { name: repo.name, version: label, page: pages[0] ?? "/" };
}

