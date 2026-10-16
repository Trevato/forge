/**
 * What `cloud.json` declares, read from a repository's default branch, and
 * what each vendor is used for now across the repositories an admin can see.
 * A missing, unreadable or refused file declares nothing. Also the "bring it
 * home" note per vendor: the way back to running without it.
 */

import type { Database } from "bun:sqlite";
import { readFileAt } from "../apps/checkout.ts";
import { parseCloud, type CloudDeclaration } from "../apps/manifest.ts";
import { listReposVisibleTo, type Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { resolveOid } from "../git/merge.ts";
import { repoDir } from "../git/repos.ts";
import type { Provider } from "./providers.ts";

export const HOME: Record<Provider, string> = {
  cloudflare: "Bring it home: point DNS back at your own nameservers, then remove the token.",
  digitalocean: "Bring it home: snapshot the droplets to your own disk, then remove the token.",
  aws: "Bring it home: copy the volumes and buckets to your own disk, then remove the key.",
  azure: "Bring it home: export the disks to your own disk, then remove the principal.",
  fly: "Bring it home: run the app image on your own machine, then remove the token.",
  backblaze: "Bring it home: copy the buckets to your own disk, then remove the key.",
  github: "Bring it home: the forge holds the full git history; push it to your own remote and remove the token.",
  vercel: "Bring it home: build the site on your own machine and serve it from the forge, then remove the token.",
};

export async function declarationsOf(
  reposRoot: string,
  repo: Repo,
): Promise<readonly CloudDeclaration[]> {
  const bare = repoDir(reposRoot, repo.ownerName, repo.name);
  const tip = await resolveOid(bare, `refs/heads/${repo.defaultBranch}`);
  if (tip === undefined) return [];
  const parsed = parseCloud(await readFileAt(bare, tip, "cloud.json"));
  return parsed.ok ? parsed.value : [];
}

export interface VendorUse {
  readonly repo: string;
  readonly use: string;
  readonly why: string;
}

/** Declarations per repository, kept this long: the page never waits on git twice a minute. */
const TTL_MS = 60_000;
const cache = new Map<string, { at: number; uses: readonly CloudDeclaration[] }>();

async function cached(
  reposRoot: string,
  repo: Repo,
  now: number,
): Promise<readonly CloudDeclaration[]> {
  const key = `${reposRoot}\0${repo.id}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.uses;
  const uses = await declarationsOf(reposRoot, repo);
  cache.set(key, { at: now, uses });
  return uses;
}

/**
 * Every declared use, by `cloud.json` vendor (look an account up with
 * `VENDOR_OF[provider]`), across at most 100 repositories. Cached for a
 * minute per repository, so the common load spawns no git.
 */
export async function usesByVendor(
  db: Database,
  reposRoot: string,
  admin: User,
  now: number = Date.now(),
): Promise<Map<string, VendorUse[]>> {
  const repos = listReposVisibleTo(db, admin, { limit: 100 });
  const all = await Promise.all(repos.map((r) => cached(reposRoot, r, now)));
  const out = new Map<string, VendorUse[]>();
  repos.forEach((repo, i) => {
    for (const d of all[i]!) {
      const list = out.get(d.vendor) ?? [];
      list.push({ repo: `${repo.ownerName}/${repo.name}`, use: d.use, why: d.why });
      out.set(d.vendor, list);
    }
  });
  return out;
}

/** One line: what a vendor is used for now. */
export function usedFor(uses: readonly VendorUse[] | undefined): string {
  if (!uses || uses.length === 0) return "Used for nothing now: no repository declares it.";
  const shown = uses.slice(0, 3).map((u) => `${u.use} by ${u.repo} (${u.why})`);
  return `Used for ${shown.join("; ")}${uses.length > 3 ? `; and ${uses.length - 3} more` : ""}.`;
}
