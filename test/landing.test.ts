import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A pull that lands or closes while an agent still works on it: the run is
 * cancelled — there is nothing left to land — and its clone goes once the
 * run is over, never from under a git call.
 */
describe("a pull closed under a running agent", () => {
  test("the run is cancelled, and its clone goes after it, not before", async () => {
    const { createApp } = await import("../src/app.ts");
    const { serve } = await import("../src/http/server.ts");
    const { startCrew } = await import("../src/crew/dispatch.ts");
    const { createUser } = await import("../src/core/users.ts");
    const { addToCrew, createAgent } = await import("../src/actions/crew.ts");
    const { commitToBranch, createRepo, forkRepo } =
      await import("../src/actions/repos.ts");
    const { addComment, setIssueState } =
      await import("../src/actions/issues.ts");
    const { openPull } = await import("../src/actions/pulls.ts");
    const { getIssueById } = await import("../src/core/issues.ts");
    const { listRuns } = await import("../src/core/runs.ts");
    const { workdirFor } = await import("../src/crew/workdir.ts");

    const dataDir = await mkdtemp(join(tmpdir(), "forge-landing-"));
    const app = createApp({ dataDir, port: 0 });
    const servers = await serve(app);
    // An agent that settles in for a long think.
    const fake = join(dataDir, "fake-claude");
    writeFileSync(
      fake,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
IFS= read -r first
echo '{"type":"system","subtype":"init","session_id":"s3","model":"fake"}'
sleep 60
`,
    );
    chmodSync(fake, 0o755);
    const crew = await startCrew(app, {
      forgeUrl: servers.url,
      localUrl: servers.url,
      binary: fake,
      concurrency: 1,
      budgetUsd: 1,
      runTimeoutMs: 60_000,
    });
    const until = async <T>(
      read: () => T | undefined,
      what: string,
      ms = 20_000,
    ): Promise<T> => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const value = read();
        if (value !== undefined) return value;
        await Bun.sleep(50);
      }
      throw new Error(`${what}: did not happen in time`);
    };
    try {
      const a = await createUser(app.db, {
        username: "alice",
        email: "alice@forge.local",
        password: "a-good-passphrase",
        adminIfFirst: true,
      });
      if (!a.ok) throw new Error(a.error);
      const alice = a.value;
      const made = await createAgent(app, alice, {
        username: "bot",
        brief: "Be brief.",
      });
      if (!made.ok) throw new Error(String(made.error));
      const bot = made.value;
      const created = await createRepo(app, alice, {
        name: "garden",
        visibility: "private",
      });
      if (!created.ok) throw new Error(String(created.error));
      const repo = created.value;
      const seeded = await commitToBranch(app, alice, repo, {
        message: "Start",
        files: [{ path: "README.md", content: "# garden\n" }],
      });
      if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
      expect(addToCrew(app, alice, repo, "bot").ok).toBe(true);

      // The agent's branch for issue 1 in its fork, its pull, and the
      // author, the agent.
      const forked = await forkRepo(app, bot.user, repo);
      if (!forked.ok) throw new Error(String(forked.error));
      const branched = await commitToBranch(app, bot.user, forked.value, {
        branch: "bot/1-tulips",
        message: "Tulips",
        files: [{ path: "TULIPS.md", content: "tulips\n" }],
      });
      if (!branched.ok) throw new Error(JSON.stringify(branched.error));
      const opened = await openPull(app, bot.user, repo, {
        title: "Tulips",
        baseBranch: repo.defaultBranch,
        headBranch: "bot/1-tulips",
        headRepo: forked.value,
      });
      if (!opened.ok) throw new Error(String(opened.error));
      const pull = opened.value;
      const asIssue = getIssueById(app.db, pull.id);
      if (!asIssue) throw new Error("the pull is not an issue");
      // A word on the pull sends its author back to it.
      expect(
        addComment(app, alice, repo, asIssue, "also the daffodils").ok,
      ).toBe(true);
      const run = await until(
        () =>
          listRuns(app.db, repo.id, { kind: "agent" }).find(
            (r) => r.state === "running",
          ),
        `the run (${JSON.stringify(listRuns(app.db, repo.id, { kind: "agent" }).map((r) => [r.reason, r.state, r.summary]))})`,
      );
      expect(run.reason).toBe("feedback");
      const clone = workdirFor(dataDir, bot, repo, 1);
      await until(() => (existsSync(clone) ? true : undefined), "the clone");

      // The pull closes under it.
      expect(setIssueState(app, alice, repo, asIssue, "closed").ok).toBe(true);
      const ended = await until(() => {
        const r = listRuns(app.db, repo.id, { kind: "agent" }).find(
          (x) => x.id === run.id,
        );
        return r && r.state !== "running" ? r : undefined;
      }, "the run's end");
      expect(ended.state).toBe("cancelled");
      expect(ended.summary).toBe("the pull closed");
      // The clone went with the run, once the run was over.
      await until(
        () => (existsSync(clone) ? undefined : true),
        "the clone's end",
      );
      const log = readFileSync(join(dataDir, "runs", `${run.id}.log`), "utf8");
      expect(log).not.toContain("the run failed");
      expect(log).not.toContain("ENOENT");
      // Nothing queued behind it for a pull that is gone.
      expect(
        listRuns(app.db, repo.id, { kind: "agent" }).filter(
          (r) => r.state === "queued",
        ),
      ).toHaveLength(0);
    } finally {
      await crew.stop();
      servers.stop();
      app.close();
      await rm(dataDir, { recursive: true, force: true });
    }
    // The crew starts a queued run on its next tick, five seconds apart:
    // the default timeout is a race against that clock.
  }, 60_000);
});
