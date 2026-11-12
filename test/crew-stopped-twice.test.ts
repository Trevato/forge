import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { claimRun, createRun, getRun, listQueued } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import { requeueInterrupted } from "../src/crew/dispatch.ts";
import { STALE_AFTER_MS } from "../src/runs/lease.ts";
import type { User } from "../src/core/users.ts";

describe("a run a restart cuts off", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let bot: User;
  let n = 0;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-stopped-twice-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice",
      email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createAgent(app, alice, { username: "bot" });
    if (!made.ok) throw new Error(String(made.error));
    bot = made.value.user;
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  /** A queued run on a fresh issue, claimed and its lease lapsed. */
  const setup = async () => {
    const created = await createRepo(app, alice, { name: `r${n++}`, visibility: "private" });
    if (!created.ok) throw new Error(String(created.error));
    expect(addToCrew(app, alice, created.value, "bot").ok).toBe(true);
    const issued = openIssue(app, alice, created.value, { title: "Plant", body: "" });
    if (!issued.ok) throw new Error(String(issued.error));
    const run = createRun(app.db, {
      repoId: created.value.id, kind: "agent", issueId: issued.value.id,
      actorId: bot.id, reason: "feedback",
    });
    return { issue: issued.value, run };
  };
  const lapse = (id: string) => {
    claimRun(app.db, id);
    app.db
      .query("UPDATE run SET heartbeat_at = ?2 WHERE id = ?1")
      .run(id, new Date(Date.now() - STALE_AFTER_MS - 1_000).toISOString());
  };
  const forIssue = (issueId: string) =>
    listQueued(app.db, "agent").filter((r) => r.issueId === issueId);

  test("once: cancelled and queued again", async () => {
    const { issue, run } = await setup();
    lapse(run.id);
    requeueInterrupted(app);
    expect(getRun(app.db, run.id)!.state).toBe("cancelled");
    const again = forIssue(issue.id);
    expect(again.length).toBe(1);
    expect(again[0]!.summary).toStartWith("interrupted by a restart; queued again");
  });

  test("twice in a row: failed with its reason, nothing queued", async () => {
    const { issue, run } = await setup();
    lapse(run.id);
    requeueInterrupted(app);
    const second = forIssue(issue.id)[0]!;
    lapse(second.id);
    requeueInterrupted(app);
    const after = getRun(app.db, second.id)!;
    expect(after.state).toBe("failed");
    expect(after.summary).toBe("stopped twice by its forge restarting; not tried again");
    expect(forIssue(issue.id)).toEqual([]);
  });
});
