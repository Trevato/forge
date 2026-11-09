import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { startCrew, type CrewHandle } from "../src/crew/dispatch.ts";
import { createUser, type User } from "../src/core/users.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { addComment, setIssueState } from "../src/actions/issues.ts";
import { openPull } from "../src/actions/pulls.ts";
import { getIssueById, type Issue } from "../src/core/issues.ts";
import { listRuns } from "../src/core/runs.ts";
import { workdirFor } from "../src/crew/workdir.ts";
import type { Agent } from "../src/core/agents.ts";
import type { Repo } from "../src/core/repos.ts";

/**
 * A pull that lands or closes while an agent still works on it: the run is
 * cancelled — there is nothing left to land — and its clone goes once the
 * run is over, never from under a git call.
 */
describe("a pull closed under a running agent", () => {
  // Built once for the file: the forge, its crew, and the agent's pull in
  // its fork. Starting the crew and forking are the slow part, and the test
  // is about neither.
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let crew: CrewHandle;
  let alice: User;
  let bot: Agent;
  let repo: Repo;
  let asIssue: Issue;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-landing-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    // An agent that settles in for a long think: it never ends on its own,
    // only when the crew stops it (the whole process group goes).
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
    // The crew ticks every 50 ms (`tickMs`), not every five seconds, so
    // nothing waits on the default clock.
    crew = await startCrew(app, {
      forgeUrl: servers.url,
      localUrl: servers.url,
      binary: fake,
      concurrency: 1,
      budgetUsd: 1,
      runTimeoutMs: 60_000,
      tickMs: 50,
    });
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createAgent(app, alice, {
      username: "bot",
      brief: "Be brief.",
    });
    if (!made.ok) throw new Error(String(made.error));
    bot = made.value;
    const created = await createRepo(app, alice, {
      name: "garden",
      visibility: "private",
    });
    if (!created.ok) throw new Error(String(created.error));
    repo = created.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# garden\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    if (!addToCrew(app, alice, repo, "bot").ok)
      throw new Error("bot did not join the crew");

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
    const issue = getIssueById(app.db, opened.value.id);
    if (!issue) throw new Error("the pull is not an issue");
    asIssue = issue;
  }, 30_000);

  afterAll(async () => {
    await crew?.stop();
    servers?.stop();
    app?.close();
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
  });

  // Where the run stands, for a failure to name: its state and summary,
  // whether the clone exists, the tail of its log.
  const seen = (clone?: string): string => {
    const runs = listRuns(app.db, repo.id, { kind: "agent" });
    const last = runs[0];
    let tail = "(no run log)";
    if (last) {
      try {
        tail = readFileSync(join(dataDir, "runs", `${last.id}.log`), "utf8")
          .split("\n")
          .slice(-20)
          .join("\n");
      } catch {
        // no log yet
      }
    }
    return `runs=${JSON.stringify(runs.map((r) => [r.reason, r.state, r.summary]))} clone=${clone === undefined ? "n/a" : existsSync(clone)}\nlog tail:\n${tail}`;
  };
  const until = async <T>(
    read: () => T | undefined,
    what: string,
    state: () => string,
    ms = 5_000,
  ): Promise<T> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const value = read();
      if (value !== undefined) return value;
      await Bun.sleep(10);
    }
    throw new Error(`${what}: did not happen in ${ms} ms; saw ${state()}`);
  };

  test("the run is cancelled, and its clone goes after it, not before", async () => {
    // Invariant: closing a pull under its author's running run cancels the run ("the pull closed"), removes its clone only after the run ends, and queues nothing after it.
    // A word on the pull sends its author back to it.
    expect(
      addComment(app, alice, repo, asIssue, "also the daffodils").ok,
    ).toBe(true);
    const run = await until(
      () =>
        listRuns(app.db, repo.id, { kind: "agent" }).find(
          (r) => r.state === "running",
        ),
      "the run starting",
      () => seen(),
    );
    expect(run.reason).toBe("feedback");
    const clone = workdirFor(dataDir, bot, repo, 1);
    await until(() => (existsSync(clone) ? true : undefined), "the clone appearing", () =>
      seen(clone),
    );

    // The pull closes under it.
    expect(setIssueState(app, alice, repo, asIssue, "closed").ok).toBe(true);
    const ended = await until(() => {
      const r = listRuns(app.db, repo.id, { kind: "agent" }).find(
        (x) => x.id === run.id,
      );
      return r && r.state !== "running" ? r : undefined;
    }, "the run's end", () => seen(clone));
    expect(ended.state).toBe("cancelled");
    expect(ended.summary).toBe("the pull closed");
    // The clone went with the run, once the run was over.
    await until(
      () => (existsSync(clone) ? undefined : true),
      "the clone's removal",
      () => seen(clone),
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
  }, 10_000);
});
