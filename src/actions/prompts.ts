/**
 * Prompt-source actions: connect the Instagram account whose Reels prompt
 * the crew, look at it now, and disconnect it. Admin over the repository,
 * like every other setting that spends the crew's time. The daily run
 * itself is the routine's (`crew/prompts.ts`); `Fetch now` borrows it.
 */

import type { App } from "../app.ts";
import {
  addPromptSource as insertSource,
  getPromptSource,
  listPromptSources as querySources,
  removePromptSource as deleteSource,
  type AddPromptError,
  type PromptKind,
  type PromptSource,
} from "../core/prompts.ts";
import type { Repo } from "../core/repos.ts";
import type { User } from "../core/users.ts";
import { promptsFor } from "../crew/prompts.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { requireRepoAdmin } from "./access.ts";

/** A source as a page or the API shows it: everything but the token. */
export interface PromptSourceView {
  readonly id: string;
  readonly kind: PromptKind;
  /** The account's username, or empty until the first run has asked. */
  readonly account: string;
  readonly atUtc: string;
  readonly lastRanAt: string | null;
  readonly lastSaid: string;
  readonly lastIssueNumber: number | null;
  readonly tokenRefreshedAt: string;
}

export const viewOf = (source: PromptSource): PromptSourceView => ({
  id: source.id,
  kind: source.kind,
  account: source.account,
  atUtc: source.atUtc,
  lastRanAt: source.lastRanAt,
  lastSaid: source.lastSaid,
  lastIssueNumber: source.lastIssueNumber,
  tokenRefreshedAt: source.tokenRefreshedAt,
});

export type PromptError = "not_found" | "no_such_source";

/** One of this repository's sources, by id — never another's. */
function ownedSource(
  app: App,
  repo: Repo,
  sourceId: string,
): PromptSource | undefined {
  const source = getPromptSource(app.db, sourceId);
  return source?.repoId === repo.id ? source : undefined;
}

export function listPromptSources(
  app: App,
  actor: User | undefined,
  repo: Repo,
): Result<PromptSourceView[], "not_found"> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  return ok(querySources(app.db, repo.id).map(viewOf));
}

export interface AddPromptInput {
  readonly kind: string;
  readonly token: string;
  readonly at: string;
}

/**
 * Connect an account. One of each kind per repository: a second Instagram
 * account would mean two tells a day from two places, and the page shows
 * one. The token is sealed on the way in and not shown again.
 */
export function addPromptSource(
  app: App,
  actor: User | undefined,
  repo: Repo,
  input: AddPromptInput,
): Result<
  PromptSourceView,
  "not_found" | "invalid_kind" | "already_connected" | AddPromptError
> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  if (input.kind !== "instagram") return err("invalid_kind");
  if (querySources(app.db, repo.id).some((s) => s.kind === input.kind))
    return err("already_connected");
  const added = insertSource(app.db, app.config.dataDir, {
    repoId: repo.id,
    kind: input.kind,
    token: input.token,
    atUtc: input.at,
    createdBy: admin.value.id,
  });
  if (!added.ok) return added;
  app.bus.append({
    kind: "prompt.source_added",
    repoId: repo.id,
    actorId: admin.value.id,
    payload: {
      source: added.value.id,
      kind: added.value.kind,
      at: added.value.atUtc,
    },
  });
  return ok(viewOf(added.value));
}

/** Look at Instagram now, whatever the hour; the source as the run left it. */
export async function runPromptSource(
  app: App,
  actor: User | undefined,
  repo: Repo,
  sourceId: string,
): Promise<Result<PromptSourceView, PromptError | "not_running">> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  if (ownedSource(app, repo, sourceId) === undefined)
    return err("no_such_source");
  const routine = promptsFor(app);
  if (routine === undefined) return err("not_running");
  const ran = await routine.runNow(sourceId);
  return ran === undefined ? err("no_such_source") : ok(viewOf(ran));
}

/** Disconnect. The token is forgotten; the issues already told stay. */
export function removePromptSource(
  app: App,
  actor: User | undefined,
  repo: Repo,
  sourceId: string,
): Result<void, PromptError> {
  const admin = requireRepoAdmin(app, actor, repo);
  if (!admin.ok) return admin;
  const source = ownedSource(app, repo, sourceId);
  if (source === undefined || !deleteSource(app.db, source.id))
    return err("no_such_source");
  app.bus.append({
    kind: "prompt.source_removed",
    repoId: repo.id,
    actorId: admin.value.id,
    payload: { source: source.id, kind: source.kind, account: source.account },
  });
  return ok();
}
