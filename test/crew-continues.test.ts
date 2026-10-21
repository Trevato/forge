/**
 * The crew with a stand-in Claude Code: a follow-up whose pull merged first.
 * The stand-in forge is `helpers/crew-standin.ts`; split from
 * `crew.test.ts` so each part runs apart (#1798).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { App } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { mergePull } from "../src/actions/pulls.ts";
import { queueAgentRun } from "../src/crew/dispatch.ts";
import { getAgentByName } from "../src/core/agents.ts";
import { getIssue } from "../src/core/issues.ts";
import { listPulls } from "../src/core/pulls.ts";
import type { Run } from "../src/core/runs.ts";
import {
  agentRunSettled,
  startStandInCrew,
  stopStandInCrew,
  type StandInCrew,
} from "./helpers/crew-standin.ts";

describe("the crew, with a stand-in Claude Code: continuing a merged pull", () => {
  let standIn: StandInCrew;
  let app: App;
  let alice: User;
  let bot: User;
  let repo: Repo;
  let argsFile: string;
  let promptFile: string;

  const settled = (where: (run: Run) => boolean, timeoutMs?: number) =>
    agentRunSettled(app, repo, where, timeoutMs, 20);

  beforeAll(async () => {
    standIn = await startStandInCrew({ tickMs: 20 });
    ({ app, alice, bot, repo, argsFile, promptFile } = standIn);
  }, 30_000);

  afterAll(() => stopStandInCrew(standIn));

  test("a pull merged before its run begins: the follow-up branches from the default branch and lands as a new pull", async () => {
    const issue = openIssue(app, alice, repo, {
      title: "Prune roses",
      body: "Before spring.",
    });
    if (!issue.ok) throw new Error(String(issue.error));
    expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);
    const built = await settled(
      (r) => r.issueId === issue.value.id && r.reason === "assigned",
    );
    expect(built.summary).toMatch(/^opened pull #\d+/);
    const pull = listPulls(app.db, repo.id, { state: "open" }).find(
      (p) => p.headBranch === `bot/${issue.value.number}-prune-roses`,
    )!;
    expect(pull).toBeDefined();
    const merged = await mergePull(app, alice, repo, pull, "merge");
    expect(merged.ok).toBe(true);

    // The race: feedback queued while the pull was open, begun after the
    // merge. The branch is spent; the work goes on a fresh one from the
    // default branch, in the same session, and lands as a pull of its own.
    const pullIssue = getIssue(app.db, repo.id, pull.number)!;
    const agent = getAgentByName(app.db, "bot")!;
    // The word that queued it, said after the run that opened the pull:
    // stamped a second past the run's end, so no wait orders them.
    const said = new Date(Date.now() + 1_000).toISOString();
    app.db
      .query(
        "INSERT INTO comment (id, issue_id, author_id, body, created_at) VALUES (?1, ?2, ?3, 'Shorter, please.', ?4)",
      )
      .run(`c-${pull.number}`, pullIssue.id, alice.id, said);
    const queued = queueAgentRun(
      app,
      repo,
      pullIssue,
      agent,
      "feedback",
      alice.id,
    );
    expect(queued).toBeDefined();
    const run = await settled((r) => r.id === queued!.id);
    expect(run.state).toBe("ok");
    expect(run.summary).toMatch(/^opened pull #\d+/);
    expect(run.branch).toBe(`bot/${pull.number}-prune-roses`);
    expect(readFileSync(promptFile, "utf8")).toContain(
      `Pull #${pull.number} has been merged`,
    );
    expect(readFileSync(argsFile, "utf8")).toContain("--resume\nfake-1");
    const next = listPulls(app.db, repo.id, { state: "open" }).find(
      (p) => p.headBranch === run.branch,
    )!;
    expect(next).toBeDefined();
    expect(next.baseBranch).toBe(repo.defaultBranch);
    expect(next.body).toContain(`Continues #${pull.number}`);
    expect(next.body).not.toContain("Closes #");
  }, 90_000);
});
