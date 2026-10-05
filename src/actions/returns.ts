/**
 * What the tokens bought, for the people who may know: owner facts only
 * (`canSeeOwnerFacts`) — the owner, their organisation's writers, a site
 * admin. Over every repository the viewer holds those facts for, or one
 * named one; a repository they do not is `not_found`, as a stranger's is.
 */

import type { App } from "../app.ts";
import { isCrew } from "../core/agents.ts";
import { getIssue } from "../core/issues.ts";
import {
  outsideSpendIn,
  recordOutsideSpend,
  type OutsideSpend,
  type OutsideTotal,
} from "../core/outside_spend.ts";
import {
  canWrite,
  getRepo,
  listReposVisibleTo,
  ownerFactRepoIds,
  type Repo,
} from "../core/repos.ts";
import { tokenReturns, type Returns } from "../core/returns.ts";
import type { User } from "../core/users.ts";
import { err, ok, type Result } from "../kernel/result.ts";

/** The window a reader may ask for, in days. */
export const RETURNS_DAYS = { default: 7, max: 90 } as const;

export type ReturnsError = "unauthorized" | "not_found" | "bad_days";

/** The repositories whose spend this viewer may read: those they hold owner facts for. */
export function returnsRepos(app: App, viewer: User): Repo[] {
  const visible = listReposVisibleTo(app.db, viewer, { limit: 200 });
  const facts = ownerFactRepoIds(app.db, visible, viewer);
  return visible.filter((r) => facts.has(r.id));
}

export function readReturns(
  app: App,
  viewer: User | undefined,
  options: { repo?: string | null; days?: number; now?: Date } = {},
): Result<
  Returns & { repos: string[]; outside: OutsideTotal[] },
  ReturnsError
> {
  if (!viewer) return err("unauthorized");
  const days = options.days ?? RETURNS_DAYS.default;
  if (!Number.isInteger(days) || days < 1 || days > RETURNS_DAYS.max)
    return err("bad_days");
  let repos = returnsRepos(app, viewer);
  if (options.repo) {
    const [owner, name, rest] = options.repo.split("/");
    const one = owner && name && rest === undefined ? getRepo(app.db, owner, name) : undefined;
    repos = one === undefined ? [] : repos.filter((r) => r.id === one.id);
    if (repos.length === 0) return err("not_found");
  }
  const now = options.now ?? new Date();
  const window = {
    since: new Date(now.getTime() - days * 86_400_000).toISOString(),
    until: now.toISOString(),
  };
  const ids = repos.map((r) => r.id);
  return ok({
    ...tokenReturns(app.db, ids, window),
    repos: repos.map((r) => `${r.ownerName}/${r.name}`),
    // Apart, never added in: a claim from a session the forge did not run.
    outside: outsideSpendIn(app.db, ids, window.since, window.until),
  });
}

export type ReportError = "unauthorized" | "not_found" | "invalid";

const MAX_USD = 10_000;
const MAX_TOKENS = 10_000_000_000;

const count = (v: unknown): number | undefined =>
  v === undefined
    ? 0
    : typeof v === "number" && Number.isInteger(v) && v >= 0 && v <= MAX_TOKENS
      ? v
      : undefined;

const text = (v: unknown, max: number, required = false): string | undefined => {
  if (v === undefined || v === null) return required ? undefined : "";
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t.length > max || (required && t === "") ? undefined : t;
};

/**
 * Report what an outside session spent on this repository's work: writers
 * and its crew only, everyone else `not_found` (a reader learns nothing, a
 * stranger nothing about a private repository). Kept as said, with who
 * reported it; read by no limit.
 */
export function reportSpend(
  app: App,
  actor: User | undefined,
  repo: Repo,
  input: Record<string, unknown>,
): Result<OutsideSpend, ReportError> {
  if (!actor) return err("unauthorized");
  const may =
    actor.kind === "agent" ? isCrew(app.db, repo.id, actor.id) : canWrite(app.db, repo, actor);
  if (!may) return err("not_found");
  const who = text(input["who"], 100, true);
  const model = text(input["model"], 100);
  const note = text(input["note"], 500);
  const tokensIn = count(input["tokensIn"]);
  const tokensOut = count(input["tokensOut"]);
  const usd = input["usd"] === undefined ? 0 : input["usd"];
  const raw = input["issue"];
  const issue =
    raw === undefined || raw === null
      ? null
      : typeof raw === "number" && Number.isInteger(raw) && raw > 0
        ? (getIssue(app.db, repo.id, raw) ?? undefined)
        : undefined;
  if (
    who === undefined ||
    model === undefined ||
    note === undefined ||
    tokensIn === undefined ||
    tokensOut === undefined ||
    typeof usd !== "number" ||
    !Number.isFinite(usd) ||
    usd < 0 ||
    usd > MAX_USD ||
    issue === undefined ||
    (tokensIn === 0 && tokensOut === 0 && usd === 0)
  )
    return err("invalid");
  const made = recordOutsideSpend(app.db, {
    repoId: repo.id,
    issueId: issue === null ? null : issue.id,
    reporterId: actor.id,
    who,
    model,
    tokensIn,
    tokensOut,
    usd: Math.round(usd * 100) / 100,
    note,
  });
  app.bus.append({
    kind: "spend.reported",
    repoId: repo.id,
    actorId: actor.id,
    payload: { id: made.id, usd: made.usd, ...(issue === null ? {} : { number: issue.number }) },
  });
  return ok(made);
}
