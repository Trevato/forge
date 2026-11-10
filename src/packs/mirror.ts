/**
 * Bringing the packs' upstreams in (#10530): each https `source` named in
 * packs/*\/pack.json becomes one public repository `packs/<app>` that follows
 * its upstream through the follow the forge already has
 * (`actions/upstream_follow.ts`). The request only creates the repository and
 * its follow row; the scheduled follow makes the first sync. The follow moves a mirror's default branch
 * to the upstream's tip on every check and opens no pull; nobody pushes to
 * one (`owner.ts`). An admin's action, and idempotent: a mirror that exists
 * is kept as it is, so running it twice makes nothing new.
 */

import type { App } from "../app.ts";
import { createRepo, getRepo } from "../core/repos.ts";
import { putFollow, upstreamUrl } from "../core/upstream_follow.ts";
import { createUser, getUserByName, type User } from "../core/users.ts";
import { runGitCapture } from "../git/env.ts";
import { isSafeName, isSafeRef } from "../git/guard.ts";
import { REMOTE_PROTOCOLS } from "../git/remote-env.ts";
import { vettedEnv } from "../origins/git-mirror.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { catalog } from "./catalog.ts";
import { PACKS_OWNER } from "./owner.ts";

export interface MirrorReport {
  /** Mirrors made by this run, as `packs/<app>`. */
  readonly made: readonly string[];
  /** Mirrors that were already there, left as they are. */
  readonly kept: readonly string[];
  /** Apps that could not be brought in, and the one line why. */
  readonly failed: readonly { readonly app: string; readonly why: string }[];
}

/** The whole run's time: what it has not reached by then is left for the next press. */
export const MIRROR_BUDGET_MS = 20_000;
const PER_UPSTREAM_MS = 8_000;

export const MIRROR_FORBIDDEN = "Only an admin brings the packs' upstreams in.";

/** The mirrors' owner: an account nobody signs in as, made on first use. */
async function mirrorOwner(app: App): Promise<User | undefined> {
  const found = getUserByName(app.db, PACKS_OWNER);
  if (found !== undefined) return found;
  const made = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    allowReserved: true,
    username: PACKS_OWNER,
    email: `${PACKS_OWNER}@forge.invalid`,
    displayName: "Forge packs",
  });
  return made.ok ? made.value : getUserByName(app.db, PACKS_OWNER);
}

/** The upstream's own default branch, or `main` when it does not say. */
async function upstreamBranch(url: string, timeoutMs: number): Promise<Result<string, string>> {
  const pinned = await vettedEnv(url, {}, REMOTE_PROTOCOLS);
  if (!pinned.ok) return err(pinned.error.message);
  const listed = await runGitCapture(["ls-remote", "--symref", "--", url, "HEAD"], {
    env: pinned.value,
    timeoutMs,
  });
  if (listed.code !== 0)
    return err(listed.stderr.split("\n").find((l) => l.trim() !== "")?.slice(0, 200) ?? "the upstream could not be read");
  const named = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(listed.stdout)?.[1];
  return ok(named !== undefined && isSafeRef(named) && named.length <= 200 ? named : "main");
}

/** Every distinct app with an https source across the packs, first named first. */
export function packSources(): { readonly name: string; readonly source: string; readonly description: string }[] {
  const seen = new Set<string>();
  const out: { name: string; source: string; description: string }[] = [];
  for (const pack of catalog().packs)
    for (const a of pack.apps) {
      const key = a.name.toLowerCase();
      if (a.source === undefined || seen.has(key)) continue;
      seen.add(key);
      out.push({ name: a.name, source: a.source, description: a.description });
    }
  return out;
}

/** Bring each pack source in once as a read-only `packs/<app>`. Admin only. */
export async function mirrorPacks(
  app: App,
  actor: User | undefined,
  sources: ReturnType<typeof packSources> = packSources(),
  budgetMs = MIRROR_BUDGET_MS,
): Promise<Result<MirrorReport, "not_found">> {
  if (actor === undefined || !actor.isAdmin || actor.kind === "agent") return err("not_found");
  const owner = await mirrorOwner(app);
  if (owner === undefined) return err("not_found");
  const made: string[] = [];
  const kept: string[] = [];
  const failed: { app: string; why: string }[] = [];
  const stopAt = Date.now() + budgetMs;
  for (const a of sources) {
    const full = `${PACKS_OWNER}/${a.name}`;
    if (getRepo(app.db, PACKS_OWNER, a.name) !== undefined) {
      kept.push(full);
      continue;
    }
    const url = upstreamUrl(a.source);
    if (url === undefined || !isSafeName(a.name)) {
      failed.push({ app: a.name, why: "its source is not an address a mirror may follow" });
      continue;
    }
    const left = stopAt - Date.now();
    if (left < 1_000) {
      failed.push({ app: a.name, why: "not reached in time; press again" });
      continue;
    }
    const branch = await upstreamBranch(url, Math.min(PER_UPSTREAM_MS, left));
    if (!branch.ok) {
      failed.push({ app: a.name, why: branch.error });
      continue;
    }
    const repo = await createRepo(app.db, app.reposRoot, {
      ownerId: owner.id,
      name: a.name,
      visibility: "public",
      description: `${a.description} A read-only mirror of ${a.source}.`.slice(0, 2000),
      defaultBranch: branch.value,
    });
    if (!repo.ok) {
      failed.push({ app: a.name, why: repo.error });
      continue;
    }
    putFollow(app.db, {
      repoId: repo.value.id,
      url,
      branch: branch.value,
      enabled: true,
      byId: owner.id,
      originId: "",
    });
    // Never checked, so the scheduled follow's next pass makes the first sync; a failure is noted on its row.
    made.push(full);
  }
  return ok({ made, kept, failed });
}

/** One line for the report, for the page and the tool alike. */
export function reportWords(r: MirrorReport): string {
  const parts = [`${r.made.length} brought in`, `${r.kept.length} already there`];
  if (r.failed.length > 0) parts.push(`${r.failed.length} failed (${r.failed.map((f) => `${f.app}: ${f.why}`).join("; ")})`);
  return `${parts.join(", ")}.`;
}
