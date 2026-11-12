/**
 * The crew proposes a resolution. One tap on the conflicts page queues one
 * run for the pull's own agent, on the pull's own branch; its brief carries
 * the conflict (`resolutionBrief`): both sides' commits since the base, the
 * files and their blocks, and the tests that cover them. The agent commits
 * the resolution to the branch and its report becomes the note on the pull.
 */

import { NOT_A_MEMBER } from "../core/roles.ts";
import { requireAbility } from "../actions/roles.ts";
import type { App } from "../app.ts";
import { getIssueById, listComments } from "../core/issues.ts";
import { pullDir, pullStatus, type Pull } from "../core/pulls.ts";
import { ARCHIVED_WHY, canWrite, type Repo } from "../core/repos.ts";
import { activeRunFor, listRuns, type Run } from "../core/runs.ts";
import type { User } from "../core/users.ts";
import { readConflictedFiles } from "../git/conflict-file.ts";
import { parseConflicts } from "../git/conflicts.ts";
import { runGitCapture } from "../git/env.ts";
import { isSafeOid, isSafeTreePath } from "../git/guard.ts";
import { err, ok, type Result } from "../kernel/result.ts";
import { agentFor, queueAgentRun } from "./dispatch.ts";

export type ProposeError =
  | "forbidden"
  | "not_open"
  | "no_conflict"
  | "no_agent"
  | "busy"
  | "not_member"
  | "not_queued"
  | "archived";

/** What the brief carries at most: a hand's worth, never a whole history. */
const MAX_COMMITS = 20;
const MAX_BLOCKS = 12;
const MAX_BLOCK_CHARS = 1_500;
const MAX_TESTS = 10;

/** Who would do the work: the agent that holds the pull, if one does. */
export function proposerOf(app: App, pull: Pull): string | undefined {
  const issue = getIssueById(app.db, pull.id);
  return issue === undefined ? undefined : agentFor(app, issue)?.user.username;
}

export async function proposeResolution(
  app: App,
  actor: User | undefined,
  repo: Repo,
  pull: Pull,
): Promise<Result<Run, ProposeError>> {
  if (!canWrite(app.db, repo, actor)) return err("forbidden");
  if (pull.state !== "open") return err("not_open");
  if (repo.archivedAt !== null) return err("archived");
  if (actor !== undefined && !requireAbility(app, actor, "run_crew").ok) return err("not_member");
  const issue = getIssueById(app.db, pull.id);
  const agent = issue === undefined ? undefined : agentFor(app, issue);
  if (issue === undefined || agent === undefined) return err("no_agent");
  const dir = await pullDir(app.db, app.reposRoot, repo, pull);
  const status = await pullStatus(dir, pull);
  if (status.conflicts.length === 0) return err("no_conflict");
  if (activeRunFor(app.db, "agent", issue.id) !== undefined) return err("busy");
  const run = queueAgentRun(app, repo, issue, agent, "resolve", actor?.id);
  return run === undefined ? err("not_queued") : ok(run);
}

/** The runs a person's tap started on this pull, newest first. */
export function proposalsFor(app: App, repo: Repo, pull: Pull): Run[] {
  return listRuns(app.db, repo.id, { kind: "agent", issueId: pull.id }).filter(
    (r) => r.reason === "resolve",
  );
}

async function commitsBetween(
  dir: string,
  range: string,
): Promise<string[]> {
  const out = await runGitCapture(
    [
      "log",
      "--no-merges",
      `--max-count=${MAX_COMMITS}`,
      "--format=%h %an: %s",
      range,
      "--",
    ],
    { cwd: dir },
  );
  return out.code === 0 ? out.stdout.split("\n").filter((l) => l !== "") : [];
}

/** Test files that name a conflicted file, by path or by what they say. */
async function testsFor(
  dir: string,
  oid: string,
  files: readonly string[],
): Promise<string[]> {
  const found = new Set<string>();
  for (const file of files) {
    const stem = (file.split("/").pop() ?? "").replace(/\.[^.]*$/, "");
    if (stem.length < 3 || /[^\w.-]/.test(stem)) continue;
    const out = await runGitCapture(
      ["grep", "-l", "-F", "-e", stem, oid, "--", "test", "tests", "*.test.*"],
      { cwd: dir },
    );
    for (const line of out.stdout.split("\n")) {
      // `git grep` over a commit prefixes each path with `<oid>:`.
      const path = line.slice(oid.length + 1);
      if (line.startsWith(`${oid}:`) && path !== "" && path !== file)
        found.add(path);
    }
  }
  return [...found].sort().slice(0, MAX_TESTS);
}

const clip = (s: string): string =>
  s.length > MAX_BLOCK_CHARS ? `${s.slice(0, MAX_BLOCK_CHARS)}\n…` : s;

/** The conflict, in the words the agent reads. Plain text out. */
export async function resolutionBrief(
  app: App,
  repo: Repo,
  pull: Pull,
): Promise<string> {
  const dir = await pullDir(app.db, app.reposRoot, repo, pull);
  const status = await pullStatus(dir, pull);
  const { baseOid, headOid, conflicts } = status;
  if (!isSafeOid(baseOid) || !isSafeOid(headOid)) return "";
  const mb = await runGitCapture(["merge-base", baseOid, headOid], { cwd: dir });
  const base = mb.code === 0 ? mb.stdout.trim() : "";
  const there = isSafeOid(base);
  const mainSide = there ? await commitsBetween(dir, `${base}..${baseOid}`) : [];
  const branchSide = there ? await commitsBetween(dir, `${base}..${headOid}`) : [];
  const texts = await readConflictedFiles(dir, baseOid, headOid, conflicts);
  const tests = await testsFor(dir, headOid, conflicts);

  const out: string[] = [
    `The conflict. \`${pull.baseBranch}\` is at ${baseOid.slice(0, 7)}, \`${pull.headBranch}\` at ${headOid.slice(0, 7)}${there ? `, and they parted at ${base.slice(0, 7)}` : ""}.`,
    "",
    `Commits on \`${pull.baseBranch}\` since then (${mainSide.length === MAX_COMMITS ? `the latest ${MAX_COMMITS}` : mainSide.length}):`,
    ...(mainSide.length > 0 ? mainSide.map((c) => `- ${c}`) : ["- (none read)"]),
    "",
    `Commits on \`${pull.headBranch}\` since then (${branchSide.length === MAX_COMMITS ? `the latest ${MAX_COMMITS}` : branchSide.length}):`,
    ...(branchSide.length > 0 ? branchSide.map((c) => `- ${c}`) : ["- (none read)"]),
    "",
    `Conflicted files (${conflicts.length}):`,
  ];
  for (const file of conflicts) {
    const parsed = parseConflicts(texts.get(file) ?? "");
    out.push("", `### ${file} — ${parsed.blocks.length} block${parsed.blocks.length === 1 ? "" : "s"}`);
    parsed.blocks.slice(0, MAX_BLOCKS).forEach((b, i) => {
      out.push(
        `Block ${i + 1}, on \`${pull.baseBranch}\`:`,
        "```",
        clip(b.ours),
        "```",
        `Block ${i + 1}, on \`${pull.headBranch}\`:`,
        "```",
        clip(b.theirs),
        "```",
      );
      if (b.base !== "")
        out.push("Before either changed it:", "```", clip(b.base), "```");
    });
    if (parsed.blocks.length > MAX_BLOCKS)
      out.push(`(${parsed.blocks.length - MAX_BLOCKS} more blocks: read the file.)`);
  }
  out.push(
    "",
    tests.length > 0
      ? `Tests that cover these files — run them before you push:\n${tests.map((t) => `- ${t}`).join("\n")}`
      : "No test names these files; run the repository's whole test suite before you push.",
  );
  return out.join("\n");
}

/**
 * The files a merge commit resolved by hand: the ones git's combined diff
 * still shows, which is where its text is neither parent's. A commit that is
 * not a merge names the files it changed.
 */
export async function resolvedFiles(dir: string, oid: string): Promise<string[]> {
  if (!isSafeOid(oid)) return [];
  const out = await runGitCapture(
    ["diff-tree", "--cc", "--no-commit-id", "--name-only", "-r", "-z", oid],
    { cwd: dir },
  );
  if (out.code !== 0) return [];
  return out.stdout
    .split("\0")
    .filter((p) => p !== "" && isSafeTreePath(p))
    .slice(0, 20);
}

/** The agent's latest word on the pull since a run began: its note. */
export function noteSince(app: App, pull: Pull, agent: string, since: string): string | undefined {
  const said = listComments(app.db, pull.id).filter(
    (c) => c.authorName === agent && c.createdAt >= since,
  );
  return said.at(-1)?.body;
}

/** What the crew's latest proposal on a pull amounts to, as plain data for both doors. */
export type Proposal =
  | { readonly kind: "none" }
  | { readonly kind: "working"; readonly state: string }
  | { readonly kind: "failed"; readonly state: string; readonly summary: string }
  | {
      readonly kind: "landed";
      readonly oid: string;
      readonly branch: string;
      readonly note: string | undefined;
      readonly files: string[];
    };

/** The words for each refusal, the same on the page and in the terminal. */
export const PROPOSE_WHY: Record<ProposeError, string> = {
  forbidden: "Only a person with write access can ask the crew to propose.",
  not_open: "That pull is closed.",
  no_conflict: "That pull has no conflicts to resolve.",
  no_agent: "No agent holds this pull, so the crew has no hand to ask.",
  busy: "The crew is already working on this pull.",
  not_member: `Starting a run is for members: ${NOT_A_MEMBER}.`,
  archived: ARCHIVED_WHY,
  not_queued: "The crew could not take it on right now (its ceiling or breaker); try again later.",
};

const NOT_PUSHED = "the crew did not push a resolution";

/**
 * The latest proposal. A landed one is shown only while the pull's head is
 * still the commit that run left: after another push, it is not the crew's.
 * A failed one only while the pull still conflicts.
 */
export async function proposalOf(
  app: App,
  repo: Repo,
  pull: Pull,
  dir: string,
): Promise<Proposal> {
  const last = proposalsFor(app, repo, pull)[0];
  if (last === undefined) return { kind: "none" };
  if (last.state === "queued" || last.state === "running")
    return { kind: "working", state: last.state };
  if (last.state !== "ok") {
    // A failure is news only while there is still something to resolve.
    const status = await pullStatus(dir, pull);
    return status.conflicts.length === 0
      ? { kind: "none" }
      : { kind: "failed", state: last.state, summary: last.summary };
  }
  if (last.commitOid === "") {
    // Ended ok but left no commit: news only while the pull still conflicts.
    const status = await pullStatus(dir, pull);
    return status.conflicts.length === 0
      ? { kind: "none" }
      : { kind: "failed", state: last.state, summary: NOT_PUSHED };
  }
  if (last.commitOid !== pull.headOid) return { kind: "none" };
  const agent = proposerOf(app, pull);
  return {
    kind: "landed",
    oid: last.commitOid,
    branch: pull.headBranch,
    note:
      agent === undefined
        ? undefined
        : noteSince(app, pull, agent, last.startedAt ?? last.createdAt),
    files: await resolvedFiles(dir, last.commitOid),
  };
}
