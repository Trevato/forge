/**
 * A child forge's own source (#10989): `<org>/forge`, a fork of the
 * parent's code at the commit the parent holds, with the history behind it.
 * Three things make it the child's own to work on:
 *
 *  1. the child's `forgeRepo` setting names it, so the forge shows that
 *     repository as itself (`core/forge_repo.ts`);
 *  2. `parent.json`'s `forgeCode` record names the parent's repository as
 *     its upstream: "bring in upstream" (`spawn/take.ts`) and "send a change
 *     back" (`actions/upstream.ts`, a pull on the parent through the
 *     proposal token, docs/ORIGINS.md) both read that record;
 *  3. the crew is seated on it with the roles it holds elsewhere, so
 *     "improve my forge" has someone to take it.
 *
 * Every step is idempotent, and a repository a person already made under
 * that name is left alone (`backfillForgeCode`).
 */

import { rename } from "node:fs/promises";
import { join } from "node:path";
import type { App } from "../app.ts";
import { addCrew, listAgents, listCrewRoles, setCrewRole, type CrewRole } from "../core/agents.ts";
import { getOrg, listTeamMembers, listTeams, OWNERS_TEAM } from "../core/orgs.ts";
import { createRepo, getRepo, listReposOwnedBy, type Repo } from "../core/repos.ts";
import { runGit } from "../git/env.ts";
import { repoDir } from "../git/repos.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { forgeSource, setForgeSource, storedForgeSource } from "../settings/forge_source.ts";
import { chainForChild, DEFAULT_MODE, forgeLinkOf, type FollowMode, type Hop } from "./chain.ts";

/** The repository's name inside the child's organisation. */
export const FORGE_CODE_NAME = "forge";

export interface ForgeCode {
  readonly upstream: string;
  readonly mode: FollowMode;
  readonly tip: string;
  readonly chain: readonly Hop[];
}

/** The parent's own code repository as `owner/name`: its `forgeRepo`, else the fork it was born with. */
export async function forgeCodeRef(app: App): Promise<string | undefined> {
  const ref = forgeSource(app.db, app.config.forgeRepo) ?? (await forgeLinkOf(app))?.repo;
  const parts = ref?.split("/") ?? [];
  return parts.length === 2 && parts[0] && parts[1] ? ref : undefined;
}

/**
 * Fork the parent's code into the child's organisation with its full
 * history; undefined when the forge names no code or it is not there (a
 * child is still made, just without the fork). Git carries the history; the
 * upstream stays reachable through `parent.json`.
 */
export async function forkForgeCode(
  app: App,
  child: App,
  orgName: string,
  mode: FollowMode,
): Promise<Result<ForgeCode | undefined, string>> {
  const ref = await forgeCodeRef(app);
  if (ref === undefined) return ok(undefined);
  const [o, n] = ref.split("/") as [string, string];
  const parent = getRepo(app.db, o, n);
  const org = getOrg(child.db, orgName);
  if (!parent || !org) return ok(undefined);
  let repo = getRepo(child.db, orgName, FORGE_CODE_NAME);
  if (!repo) {
    const made = await createRepo(child.db, child.reposRoot, {
      ownerId: org.id,
      name: FORGE_CODE_NAME,
      visibility: "public",
      description: `A fork of ${o}/${n}: the forge's own code, following its parent.`,
      defaultBranch: parent.defaultBranch,
    });
    if (!made.ok) return err(`could not make the child's forge repo: ${made.error}`);
    repo = made.value;
  }
  const fetched = await runGit(
    [
      "fetch",
      "--no-write-fetch-head",
      repoDir(app.reposRoot, o, n),
      "+refs/heads/*:refs/heads/*",
      "+refs/tags/*:refs/tags/*",
    ],
    { cwd: repoDir(child.reposRoot, orgName, FORGE_CODE_NAME), timeoutMs: 600_000 },
  );
  if (!fetched.ok) return err(`could not copy the forge's code: ${fetched.error.stderr}`);
  const born = await chainForChild(app, `${o}/${n}`);
  return ok({ upstream: `${o}/${n}`, mode, tip: born?.tip ?? "", chain: born?.chain ?? [] });
}

/**
 * Make the fork the child's own source: its `forgeRepo` names it (an admin's
 * earlier choice stands) and every crew member is seated on it, with the
 * role it holds on the child's other repositories, if any.
 */
export function adoptForgeCode(child: App, orgName: string, actorId: string): Repo | undefined {
  const repo = getRepo(child.db, orgName, FORGE_CODE_NAME);
  if (!repo) return undefined;
  if (storedForgeSource(child.db) === undefined)
    setForgeSource(child.db, `${orgName}/${FORGE_CODE_NAME}`, actorId);
  const roleOf = new Map<string, CrewRole>();
  for (const other of listReposOwnedBy(child.db, repo.ownerId).filter((r) => r.id !== repo.id))
    for (const { agent, role } of listCrewRoles(child.db, other.id))
      if (!roleOf.has(agent.user.id)) roleOf.set(agent.user.id, role);
  for (const agent of listAgents(child.db)) {
    addCrew(child.db, repo.id, agent.user.id, actorId);
    const role = roleOf.get(agent.user.id);
    if (role !== undefined) setCrewRole(child.db, repo.id, agent.user.id, role);
  }
  return repo;
}

export type Backfilled = "made" | "already" | "left-alone" | "no-code" | "not-a-child";

/**
 * Give an existing child its own source (#10989), once: forks the parent's
 * code into `<org>/forge`, records it in the child's `parent.json`, names it
 * as `forgeRepo`, and seats the crew. A child that already has it is
 * `already`; a repository of that name nobody here made is `left-alone`,
 * untouched. "We made it" is a record, `forgeCodeStarted`, written to
 * `parent.json` before the repository is created: a run that died after the
 * repo but before the fetch or the `forgeCode` record finds it on the next
 * pass and finishes (both steps are idempotent), where a repo without the
 * record is a person's.
 */
export async function backfillForgeCode(
  app: App,
  child: App,
  childDir: string,
  mode: FollowMode = DEFAULT_MODE,
): Promise<Result<Backfilled, string>> {
  const file = join(childDir, "parent.json");
  let doc: Record<string, unknown>;
  try {
    const parsed = await Bun.file(file).json();
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return ok("not-a-child");
    doc = parsed as Record<string, unknown>;
  } catch {
    return ok("not-a-child");
  }
  const orgName = doc["org"];
  const org = typeof orgName === "string" ? getOrg(child.db, orgName) : undefined;
  if (org === undefined || typeof orgName !== "string") return ok("not-a-child");
  const ownersTeam = listTeams(child.db, org.id).find((t) => t.name === OWNERS_TEAM);
  const owner = ownersTeam === undefined ? undefined : listTeamMembers(child.db, ownersTeam.id)[0];
  const actorId = owner?.id ?? org.id;

  const have = doc["forgeCode"] !== undefined && doc["forgeCode"] !== null;
  const name = `${orgName}/${FORGE_CODE_NAME}`;
  const unfinished = doc["forgeCodeStarted"] === name;
  if (!have && !unfinished && getRepo(child.db, orgName, FORGE_CODE_NAME) !== undefined) return ok("left-alone");
  let made = false;
  if (!have) {
    const write = async (next: Record<string, unknown>): Promise<void> => {
      await Bun.write(`${file}.tmp`, JSON.stringify(next));
      await rename(`${file}.tmp`, file);
    };
    // Only a parent that has code to give starts the record: otherwise a
    // person's later `forge` repo would read as ours.
    const ref = await forgeCodeRef(app);
    const [o, n] = ref?.split("/") ?? [];
    if (ref === undefined || !o || !n || getRepo(app.db, o, n) === undefined) return ok("no-code");
    if (!unfinished) await write({ ...doc, forgeCodeStarted: name });
    const forked = await forkForgeCode(app, child, orgName, mode);
    if (!forked.ok) return err(forked.error);
    if (forked.value === undefined) return ok("no-code");
    const { forgeCodeStarted: _started, ...rest } = doc;
    await write({ ...rest, forgeCode: { repo: name, ...forked.value } });
    made = true;
  }
  adoptForgeCode(child, orgName, actorId);
  return ok(made ? "made" : "already");
}
