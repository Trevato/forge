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
import { PINS_FRESH_MS } from "../git/pins_kept.ts";
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
export function demoFactsAt(app: App, repo: Repo, oid: string): Promise<DemoFacts> {
  if (!isSafeOid(oid)) return Promise.resolve({ pages: [] });
  const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
  const key = `${dir}\0${repo.defaultBranch}\0${oid}`;
  const seen = factsKept.get(key);
  if (seen !== undefined && Date.now() <= seen.until) return seen.facts;
  const facts = readDemoFacts(dir, repo, oid);
  const entry = { facts, until: Number.POSITIVE_INFINITY };
  factsKept.delete(key);
  factsKept.set(key, entry);
  if (factsKept.size > FACTS_KEPT_MAX) factsKept.delete(factsKept.keys().next().value!);
  // What a commit holds never changes; facts borrowed from the branch tip are read again after a while.
  facts.then(
    (f) => {
      if (f.borrowed) entry.until = Date.now() + PINS_FRESH_MS;
    },
    () => factsKept.delete(key),
  );
  return facts.then(({ pages, launch }) => (launch === undefined ? { pages } : { pages, launch }));
}

/** The most commits' facts kept at once (#10445): a display reads them once per build, not once per request. */
const FACTS_KEPT_MAX = 4_096;
const factsKept = new Map<string, { facts: Promise<DemoFacts & { borrowed?: true }>; until: number }>();

async function readDemoFacts(dir: string, repo: Repo, oid: string): Promise<DemoFacts & { borrowed?: true }> {
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
  // No pages of its own: whatever is answered may change with the branch, so it is kept a while only.
  if (!stat.ok || stat.value.type !== "commit") return { ...own, borrowed: true };
  const tip = await exactRefOid(dir, `refs/heads/${repo.defaultBranch}`);
  if (tip === undefined || tip === oid) return { ...own, borrowed: true };
  const now = await read(tip);
  return { pages: now.pages, borrowed: true, ...((own.launch ?? now.launch) === undefined ? {} : { launch: own.launch ?? now.launch }) };
}

/** The facts a pin's demo starts from, before anyone edits them. */
export function demoDefaults(repo: Repo, label: string, pages: readonly string[]): Pick<Demo, "name" | "version" | "page"> {
  return { name: repo.name, version: label, page: pages[0] ?? "/" };
}

