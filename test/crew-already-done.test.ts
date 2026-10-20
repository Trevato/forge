/**
 * The crew with a stand-in Claude Code: a decline that says the work is already on main.
 * The stand-in forge is `helpers/crew-standin.ts`; split from
 * `crew.test.ts` so each part runs apart (#1798).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { App } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import type { Run } from "../src/core/runs.ts";
import { resolveOid } from "../src/git/merge.ts";
import { repoDir } from "../src/git/repos.ts";
import {
  agentRunSettled,
  startStandInCrew,
  stopStandInCrew,
  type StandInCrew,
} from "./helpers/crew-standin.ts";

describe("the crew, with a stand-in Claude Code: already done", () => {
  let standIn: StandInCrew;
  let app: App;
  let alice: User;
  let bot: User;
  let repo: Repo;

  const settled = (where: (run: Run) => boolean) =>
    agentRunSettled(app, repo, where, 10_000, 5);

  beforeAll(async () => {
    // A quick tick: the crew picks an assignment up at once, nothing waits
    // out the five-second default.
    standIn = await startStandInCrew({ tickMs: 20 });
    ({ app, alice, bot, repo } = standIn);
  }, 30_000);

  afterAll(() => stopStandInCrew(standIn));

  const ask = async (title: string, marker: string) => {
    const issue = openIssue(app, alice, repo, {
      title,
      body: `DONE-ON-MAIN ${marker}`,
    });
    if (!issue.ok) throw new Error("issue");
    expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);
    return settled((r) => r.issueId === issue.value.id);
  };

  test("a decline naming a commit on main is an already-done run", async () => {
    const dir = repoDir(app.reposRoot, repo.ownerName, repo.name);
    const main = await resolveOid(dir, `refs/heads/${repo.defaultBranch}`);
    const named = await ask("Already built", "NAMED");
    expect(named.state).toBe("ok");
    expect(named.summary).toBe(`already done: ${main}`);
    expect(named.summary).toMatch(/^already done: [0-9a-f]{40}$/);
  }, 5_000);

  test("a decline naming no commit is a decline", async () => {
    const none = await ask("Built, says who", "NONE");
    expect(none.state).toBe("failed");
    expect(none.summary).toBe("declined: already done on main");
  }, 5_000);

  test("a decline naming a commit not on the base is a decline", async () => {
    const absent = await ask("Built somewhere", "ABSENT");
    expect(absent.state).toBe("failed");
    expect(absent.summary).toBe(
      "declined: already done on main in deadbeefdeadbeef",
    );
  }, 5_000);
});
