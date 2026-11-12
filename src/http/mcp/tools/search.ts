import type { Database } from "bun:sqlite";
import { getRepo, type Repo } from "../../../core/repos.ts";
import { getIssue, type Issue } from "../../../core/issues.ts";
import { markReaders } from "../../../crew/direct.ts";
import { SEARCH_ROWS as CARD_HITS } from "../../../web/studio/cards.ts";
import { search, searchRefusal } from "../../../actions/search.ts";
import { CODE_BUDGET_MS, searchKind, searchNote, type SearchResults } from "../../../core/search.ts";
import { good, bad, type Tool, repoArg, isAnswer } from "../shared.ts";

export const tool: Tool = {
  name: "search",
  doc: "`{ q, kind?, limit?, repo?, all? }`: issues, pulls, repositories and code you can read, the same results as /search, drawn as the `ui://forge/search` card; `repo` keeps to one; `moreCode` says the code grep stopped at its budget, `all` greps the rest",
  description:
    "Find issues, pulls, repositories and code you can read; `kind` and `repo` narrow.",
  inputSchema: {
    type: "object",
    properties: {
      q: { type: "string", maxLength: 200 },
      kind: { type: "string", enum: ["all", "issues", "repos", "code"] },
      limit: { type: "integer" },
      repo: { type: "string", maxLength: 140 },
      all: { type: "boolean" },
    },
    required: ["q"],
  },
  writes: false,
  async run(ctx, user, args) {
    const q = args["q"];
    if (typeof q !== "string" || q.length > 200) return bad("invalid", "`q` is a string of at most 200 characters");
    const kind = args["kind"];
    if (kind !== undefined && typeof kind !== "string") return bad("invalid_kind", "kind is all, repos, issues or code");
    const refusal = searchRefusal(kind, args["limit"] === undefined || typeof args["limit"] === "number" ? (args["limit"] as number | undefined) : NaN);
    if (refusal) return bad(refusal.code, refusal.message);
    const all = args["all"];
    if (all !== undefined && typeof all !== "boolean") return bad("invalid", "`all` is true or false");
    let only: Repo | undefined;
    if (args["repo"] !== undefined) {
      if (typeof args["repo"] !== "string") return bad("invalid", "`repo` is owner/name");
      const repo = repoArg(ctx, user, args);
      if (isAnswer(repo)) return repo;
      only = repo;
    }
    const note = searchNote(q, searchKind(kind ?? null));
    const found = await search(ctx.app, user, {
      q,
      ...(kind ? { kind: searchKind(kind) } : {}),
      ...(typeof args["limit"] === "number" ? { limit: args["limit"] } : {}),
      ...(only ? { repo: only } : {}),
      ...(all === true ? {} : { codeBudgetMs: ctx.app.config.codeBudgetMs ?? CODE_BUDGET_MS }),
    });
    const answer = good(note === undefined ? found : { ...found, note });
    return ctx.auth.through === undefined ? { ...answer, card: { q, ...cardMarks(ctx.app.db, found) } } : answer;
  },
};

/**
 * What the card needs beyond the hits: which local issue and pull hits an outsider wrote
 * (`untrusted`, as "owner/name#number", by the same `markReaders` rule `issues` uses) and the
 * default branch of each repository with a code hit, so a code row links to its file.
 */
function cardMarks(db: Database, found: SearchResults): Record<string, unknown> {
  const repos = new Map<string, Repo | undefined>();
  const repoOf = (owner: string, name: string): Repo | undefined => {
    const key = `${owner}/${name}`;
    if (!repos.has(key)) repos.set(key, getRepo(db, owner, name));
    return repos.get(key);
  };
  const byRepo = new Map<Repo, Issue[]>();
  for (const h of found.issues.slice(0, CARD_HITS)) {
    if (h.source !== "local") continue;
    const repo = repoOf(h.repo.owner, h.repo.name);
    const issue = repo === undefined ? undefined : getIssue(db, repo.id, h.number);
    if (repo === undefined || issue === undefined) continue;
    byRepo.set(repo, [...(byRepo.get(repo) ?? []), issue]);
  }
  const untrusted: string[] = [];
  for (const [repo, issues] of byRepo)
    for (const m of markReaders(db, repo, issues))
      if (m.untrusted !== undefined) untrusted.push(`${repo.ownerName}/${repo.name}#${m.number}`);
  const branches: Record<string, string> = {};
  for (const c of found.code.slice(0, CARD_HITS)) {
    const repo = repoOf(c.repo.owner, c.repo.name);
    if (repo !== undefined) branches[`${c.repo.owner}/${c.repo.name}`] = repo.defaultBranch;
  }
  return { untrusted, branches };
}
