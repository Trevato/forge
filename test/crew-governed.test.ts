/** The governor in the picker (#6375): a pile that opens faster than it lands starts fewer runs, and the feed says so once. */
import { afterAll, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo, updateRepoSettings } from "../src/actions/repos.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { listEventsVisibleTo } from "../src/core/events.ts";
import { readFeed } from "../src/feed/feed.ts";
import { autonomyTick } from "../src/crew/autonomy.ts";
import { id } from "../src/kernel/id.ts";
import { logLevel, setLogLevel } from "../src/kernel/log.ts";

describe("the governor in the picker", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let repo: Repo;
  const level = logLevel();
  const NOW = new Date(Date.now() + 120_000);
  const ago = (min: number) => new Date(NOW.getTime() - min * 60_000).toISOString();
  const governed = () =>
    listEventsVisibleTo(app.db, alice, { limit: 200 }).filter((e) => e.kind === "crew.governed");
  const started = () =>
    app.db.query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM issue WHERE repo_id = ?1 AND kind = 'issue' AND assignee_id IS NOT NULL").get(repo.id)!.n;

  beforeAll(async () => {
    setLogLevel("info");
    dataDir = await mkdtemp(join(tmpdir(), "forge-governed-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(app, alice, { name: "pile", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const seeded = await commitToBranch(app, alice, repo, { message: "Start", files: [{ path: "README.md", content: "# pile\n" }] });
    if (!seeded.ok) throw new Error(JSON.stringify(seeded.error));
    for (const name of ["brick", "chart", "lathe", "mold"]) {
      const agent = await createAgent(app, alice, { username: name });
      if (!agent.ok) throw new Error(String(agent.error));
      expect(addToCrew(app, alice, repo, name).ok).toBe(true);
    }
    const on = await updateRepoSettings(app, alice, repo, {
      autonomy: "autonomous",
      autonomyDirection: "Weave the loom",
      autonomyCeilingUsd: 100,
      autonomySlots: 5,
      autonomyBy: alice.id,
    });
    expect(on.ok).toBe(true);
    // 40 opened in the hour, 10 of them landed half an hour ago: 30 stay open.
    for (let n = 1; n <= 40; n++) {
      const issueId = id();
      const landed = n <= 10;
      app.db
        .query(`INSERT INTO issue (id, repo_id, number, kind, title, body, author_id, state, created_at) VALUES (?1, ?2, ?3, 'pull', ?4, '', ?5, ?6, ?7)`)
        .run(issueId, repo.id, 1000 + n, `P${n}`, alice.id, landed ? "closed" : "open", ago(20));
      app.db
        .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at) VALUES (?1, ?2, ?3, '', '', ?4, ?5)`)
        .run(issueId, repo.defaultBranch, `b/${n}`, repo.id, landed ? ago(30) : null);
    }
    for (let n = 0; n < 8; n++) {
      const opened = openIssue(app, alice, repo, { title: `Ready ${n}` });
      if (!opened.ok) throw new Error(String(opened.error));
    }
  });

  afterAll(async () => {
    setLogLevel(level);
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("starts the governed number, no more, says why on the tick line, and the feed item appears once across two ticks", async () => {
    const lines: string[] = [];
    const spy = spyOn(console, "info").mockImplementation((line: unknown) => {
      lines.push(String(line));
    });
    try {
      await autonomyTick(app, NOW, async () => 0);
      await autonomyTick(app, NOW, async () => 0);
    } finally {
      spy.mockRestore();
    }
    // 5 slots × 1.5 × 10 landed ÷ 40 opened = 1.
    expect(getRepoById(app.db, repo.id)!.autonomySlots).toBe(5);
    expect(started()).toBe(1);
    const ticks = lines.filter((l) => l.includes("tick") && l.includes("pile"));
    expect(ticks.length).toBe(2);
    for (const t of ticks) expect(t).toContain("Builders 5 → 1: 40 opened vs 10 landed last hour");
    expect(governed().length).toBe(1);
    expect(governed()[0]!.payload).toMatchObject({ from: 5, to: 1 });
    const { items } = readFeed(app.db, alice, { now: NOW.getTime() });
    expect(items.filter((i) => i.what.includes("Builders 5 → 1")).length).toBe(1);
  });
});
