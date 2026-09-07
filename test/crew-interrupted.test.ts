import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { claimRun, createRun, getRun, listQueued } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { startCrew, type CrewHandle } from "../src/crew/dispatch.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("a run the last forge left running", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let crew: CrewHandle | undefined;
  let alice: User;
  let bot: User;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-interrupted-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, {
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createAgent(app, alice, { username: "bot" });
    if (!made.ok) throw new Error(String(made.error));
    bot = made.value.user;
  });

  afterAll(async () => {
    await crew?.stop();
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("is cancelled at boot and queued again under the same reason", async () => {
    const created = await createRepo(app, alice, {
      name: "garden",
      visibility: "private",
    });
    if (!created.ok) throw new Error(String(created.error));
    const repo = created.value;
    expect(addToCrew(app, alice, repo, "bot").ok).toBe(true);
    const issued = openIssue(app, alice, repo, {
      title: "Plant something",
      body: "",
    });
    if (!issued.ok) throw new Error(String(issued.error));
    const issue = issued.value;

    // The previous forge claimed this run and died mid-way.
    const orphan = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: issue.id,
      actorId: bot.id,
      reason: "feedback",
    });
    claimRun(app.db, orphan.id);
    expect(getRun(app.db, orphan.id)?.state).toBe("running");

    // Concurrency 0: the crew boots, tidies, and starts nothing.
    crew = await startCrew(app, {
      forgeUrl: servers.url,
      localUrl: servers.url,
      binary: join(dataDir, "no-such-claude"),
      concurrency: 0,
      budgetUsd: 1,
      runTimeoutMs: 60_000,
    });

    const after = getRun(app.db, orphan.id)!;
    expect(after.state).toBe("cancelled");
    expect(after.summary).toContain("interrupted by a restart");
    const queued = listQueued(app.db, "agent").filter(
      (r) => r.issueId === issue.id && r.state === "queued",
    );
    expect(queued).toHaveLength(1);
    expect(queued[0]!.reason).toBe("feedback");
    expect(queued[0]!.actorId).toBe(bot.id);
  });
});
