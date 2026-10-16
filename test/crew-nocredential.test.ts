/**
 * The crew with a stand-in Claude Code: a repository whose owner is not a
 * forge admin and has no grant never spends the forge's own credential.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { App } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { readRunLog } from "../src/runs/log.ts";
import {
  agentRunSettled,
  startStandInCrew,
  stopStandInCrew,
  type StandInCrew,
} from "./helpers/crew-standin.ts";

describe("the crew, with a stand-in Claude Code: no credential reaches the repository", () => {
  let standIn: StandInCrew;
  let app: App;
  let alice: User;
  let bot: User;
  let repo: Repo;

  beforeAll(async () => {
    standIn = await startStandInCrew();
    ({ app, alice, bot, repo } = standIn);
  }, 30_000);

  afterAll(() => stopStandInCrew(standIn));

  test("a non-admin owner's run fails with a person-worded line, before any agent starts", async () => {
    app.db.query("UPDATE user SET is_admin = 0 WHERE id = ?1").run(alice.id);
    process.env.ANTHROPIC_API_KEY = "sk-forge-own-token";
    try {
      const issue = openIssue(app, alice, repo, {
        title: "Prune the roses",
        body: "Before spring.",
      });
      if (!issue.ok) throw new Error(String(issue.error));
      expect(assignIssue(app, alice, repo, issue.value, bot).ok).toBe(true);
      const run = await agentRunSettled(
        app,
        repo,
        (r) => r.issueId === issue.value.id,
      );
      const said =
        "no model credential reaches this repository; ask an admin to grant one";
      expect(run.state).toBe("failed");
      expect(run.summary).toContain(said);
      expect(readRunLog(standIn.dataDir, run.id).lines.join("\n")).toContain(
        said,
      );
      // The agent never started, so no credential was handed to it.
      expect(existsSync(standIn.argsFile)).toBe(false);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  }, 60_000);
});
