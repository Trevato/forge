/**
 * The crew with a stand-in Claude Code: a repository whose owner is not a
 * forge admin and has no grant never spends the forge's own credential.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { App } from "../src/app.ts";
import type { Repo } from "../src/core/repos.ts";
import type { User } from "../src/core/users.ts";
import { addToCrew } from "../src/actions/crew.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createUser } from "../src/core/users.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { getUsage } from "../src/core/usage.ts";
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
        "This repository has no model account: ask an admin to grant one";
      expect(run.state).toBe("failed");
      expect(run.summary).toContain(said);
      expect(readRunLog(standIn.dataDir, run.id).lines.join("\n")).toContain(
        said,
      );
      // The agent never started, so no credential was handed to it.
      expect(existsSync(standIn.argsFile)).toBe(false);
      // Nothing spent: no ledger row for the run, no cost on it.
      expect(getUsage(app.db, run.id)?.costUsd ?? 0).toBe(0);
      expect(run.costUsd).toBe(0);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  }, 60_000);

  test("a fresh outsider's repository with an existing agent does not start; an admin's does", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-forge-own-token";
    try {
      const o = await createUser(app.db, {
        trusted: true,
        username: "otto",
        email: "otto@forge.local",
        password: "a-good-passphrase",
      });
      if (!o.ok) throw new Error(o.error);
      const otto = o.value;
      const made = await createRepo(app, otto, {
        name: "yard",
        visibility: "private",
      });
      if (!made.ok) throw new Error(String(made.error));
      const yard = made.value;
      const seeded = await commitToBranch(app, otto, yard, {
        message: "Start",
        files: [{ path: "README.md", content: "# yard\n" }],
      });
      if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
      expect(addToCrew(app, otto, yard, "bot").ok).toBe(true);
      const issue = openIssue(app, otto, yard, { title: "Mow", body: "Soon." });
      if (!issue.ok) throw new Error(String(issue.error));
      expect(assignIssue(app, otto, yard, issue.value, bot).ok).toBe(true);
      const run = await agentRunSettled(
        app,
        yard,
        (r) => r.issueId === issue.value.id,
      );
      expect(run.state).toBe("failed");
      expect(run.summary).toContain("This repository has no model account");
      expect(run.costUsd).toBe(0);
      expect(getUsage(app.db, run.id)?.costUsd ?? 0).toBe(0);
      expect(existsSync(standIn.argsFile)).toBe(false);

      // The same flow, the owner an admin: the run starts.
      app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(otto.id);
      const again = openIssue(app, otto, yard, { title: "Rake", body: "Now." });
      if (!again.ok) throw new Error(String(again.error));
      expect(assignIssue(app, otto, yard, again.value, bot).ok).toBe(true);
      const started = await agentRunSettled(
        app,
        yard,
        (r) => r.issueId === again.value.id,
      );
      expect(started.summary).not.toContain("no model account");
      expect(existsSync(standIn.argsFile)).toBe(true);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  }, 90_000);
});
