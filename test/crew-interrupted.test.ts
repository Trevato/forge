import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
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

  test("a run in flight when the crew stops goes back on the queue", async () => {
    await crew?.stop();
    crew = undefined;
    const created = await createRepo(app, alice, {
      name: "orchard",
      visibility: "private",
    });
    if (!created.ok) throw new Error(String(created.error));
    const repo = created.value;
    const seeded = await commitToBranch(app, alice, repo, {
      message: "Start",
      files: [{ path: "README.md", content: "# orchard\n" }],
    });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    expect(addToCrew(app, alice, repo, "bot").ok).toBe(true);
    const issued = openIssue(app, alice, repo, { title: "Prune", body: "" });
    if (!issued.ok) throw new Error(String(issued.error));
    const issue = issued.value;
    // A stand-in that never finishes on its own.
    const slow = join(dataDir, "slow-claude");
    writeFileSync(
      slow,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "2.1.0 (fake)"; exit 0; fi
cat > /dev/null &
echo '{"type":"system","subtype":"init","session_id":"slow-1","model":"fake"}'
sleep 120
`,
    );
    chmodSync(slow, 0o755);
    const queuedRun = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: issue.id,
      actorId: bot.id,
      reason: "feedback",
    });
    crew = await startCrew(app, {
      forgeUrl: servers.url,
      localUrl: servers.url,
      binary: slow,
      concurrency: 1,
      budgetUsd: 1,
      runTimeoutMs: 60_000,
    });
    const deadline = Date.now() + 20_000;
    while (
      getRun(app.db, queuedRun.id)?.state !== "running" &&
      Date.now() < deadline
    )
      await Bun.sleep(100);
    expect(getRun(app.db, queuedRun.id)?.state).toBe("running");

    await crew.stop();
    crew = undefined;

    const ended = getRun(app.db, queuedRun.id)!;
    expect(ended.state === "cancelled" || ended.state === "failed").toBe(true);
    const again = listQueued(app.db, "agent").filter(
      (r) => r.issueId === issue.id && r.state === "queued",
    );
    expect(again).toHaveLength(1);
    expect(again[0]!.reason).toBe("feedback");
  }, 40_000);
});
