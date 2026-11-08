/**
 * The crew does not build the same thing twice (#7792): a build run on an
 * issue whose twin (same title) has a run going, a pull open or a pull
 * merged is refused; and wasted runs are counted per day.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { assignIssue, openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { createIssue, listComments, type Issue } from "../src/core/issues.ts";
import { sweepAssigned } from "../src/crew/dispatch.ts";
import { twinOf } from "../src/crew/twin.ts";
import { isWasted, wastedDays } from "../src/core/wasted_days.ts";

describe("twins", () => {
  let dataDir: string;
  let app: App;
  let alice: User;
  let bot: User;
  let repo: Repo;

  const fresh = () => getRepoById(app.db, repo.id)!;
  const open = (title: string): Issue => {
    const o = openIssue(app, alice, fresh(), { title, body: "" });
    if (!o.ok) throw new Error(String(o.error));
    return o.value;
  };
  const assign = (issue: Issue): void => {
    const a = assignIssue(app, alice, fresh(), issue, bot);
    if (!a.ok) throw new Error(String(a.error));
  };
  const runsOn = (issue: Issue): number =>
    app.db
      .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM run WHERE issue_id = ?1 AND kind = 'agent'")
      .get(issue.id)!.n;
  /** A pull on `branch`, as the store would hold it. */
  const pullOn = (title: string, branch: string, merged = false): Issue => {
    const p = createIssue(app.db, { repoId: repo.id, authorId: bot.id, title, body: "", kind: "pull" });
    if (!p.ok) throw new Error(p.error);
    app.db
      .query(
        `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, head_repo_id, merged_at)
         VALUES (?1, 'main', ?2, 'a', 'b', ?3, ?4)`,
      )
      .run(p.value.id, branch, repo.id, merged ? new Date().toISOString() : null);
    if (merged) app.db.query("UPDATE issue SET state = 'closed' WHERE id = ?1").run(p.value.id);
    return p.value;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-twin-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, {
      origin: "seed", trusted: true, username: "alice", email: "alice@forge.local",
      password: "a-good-passphrase", adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(app, alice, { name: "svc", visibility: "private" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    const created = await createAgent(app, alice, { username: "bot" });
    if (!created.ok) throw new Error(String(created.error));
    expect(addToCrew(app, alice, repo, "bot").ok).toBe(true);
    bot = getUserByName(app.db, "bot")!;
  });

  afterAll(async () => {
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a second issue with the title of one already running starts no run", () => {
    const first = open("Lighthouse");
    const second = open("  lighthouse ");
    assign(first);
    sweepAssigned(app);
    expect(runsOn(first)).toBe(1);
    assign(second);
    sweepAssigned(app);
    expect(runsOn(second)).toBe(0);
    expect(twinOf(app.db, second)).toEqual({ number: first.number, standing: "running" });
  });

  test("a twin whose pull is open or landed holds the work", () => {
    const first = open("Pottery Wheel");
    pullOn("Pottery wheel, spinning", `bot/${first.number}-pottery-wheel`);
    const second = open("Pottery Wheel");
    assign(second);
    sweepAssigned(app);
    expect(runsOn(second)).toBe(0);
    expect(twinOf(app.db, second)?.standing).toBe("open");

    const done = open("Sled Run");
    const again = open("Sled Run");
    pullOn("Sled Run", `bot/${done.number}-sled`, true);
    assign(again);
    sweepAssigned(app);
    expect(runsOn(again)).toBe(0);
    expect(twinOf(app.db, again)?.standing).toBe("landed");
  });

  test("a pull titled the same stands in front, and a different title does not", () => {
    const dup = open("Domino Run");
    pullOn("Domino Run", "bot/unrelated", true);
    assign(dup);
    sweepAssigned(app);
    expect(runsOn(dup)).toBe(0);
    const other = open("Something else");
    assign(other);
    sweepAssigned(app);
    expect(runsOn(other)).toBe(1);
  });

  test("a pull merged before the issue was opened does not hold a title that comes round again", () => {
    pullOn("Fix typo", "bot/1-fix-typo", true);
    app.db.query("UPDATE pull SET merged_at = '2020-01-01T00:00:00.000Z' WHERE head_branch = 'bot/1-fix-typo'").run();
    const again = open("Fix typo");
    expect(twinOf(app.db, again)).toBeUndefined();
    assign(again);
    sweepAssigned(app);
    expect(runsOn(again)).toBe(1);
  });

  test("a refusal is said on the issue, once, naming the twin", () => {
    const first = open("Weather Vane");
    assign(first);
    sweepAssigned(app);
    const second = open("Weather vane");
    assign(second);
    sweepAssigned(app);
    sweepAssigned(app);
    const said = listComments(app.db, second.id).filter((c) => c.body.includes("already holds this work"));
    expect(said).toHaveLength(1);
    expect(said[0]!.body).toContain(`#${first.number} already holds this work (running)`);
    expect(said[0]!.authorId).toBe(bot.id);
  });

  test("an issue's own pull, though titled the same, is not its twin", () => {
    const mine = open("Own pull");
    pullOn("Own pull", `bot/${mine.number}-own-pull`);
    expect(twinOf(app.db, mine)).toBeUndefined();
  });

  test("a closed, unmerged pull holds nothing", () => {
    const p = pullOn("Kite", "bot/999-kite");
    app.db.query("UPDATE issue SET state = 'closed' WHERE id = ?1").run(p.id);
    const kite = open("Kite");
    expect(twinOf(app.db, kite)).toBeUndefined();
  });

  test("wasted runs are counted per day, and an outage is not one", () => {
    expect(isWasted("the pull closed")).toBe(true);
    expect(isWasted("pull closed")).toBe(true);
    expect(isWasted("no changes pushed")).toBe(true);
    expect(isWasted("already done: abc")).toBe(true);
    expect(isWasted("no changes pushed: getaddrinfo EAI_AGAIN")).toBe(false);
    expect(isWasted("opened pull #3")).toBe(false);
    const issue = open("Wasteful");
    const put = (summary: string, cost: number) =>
      app.db
        .query(
          `INSERT INTO run (id, repo_id, kind, issue_id, actor_id, state, summary, cost_usd)
           VALUES (?1, ?2, 'agent', ?3, ?4, 'ok', ?5, ?6)`,
        )
        .run(crypto.randomUUID(), repo.id, issue.id, bot.id, summary, cost);
    const now = Date.now();
    const key = new Date(now).toISOString().slice(0, 10);
    const dayOf = () => wastedDays(app.db, 7, now).find((d) => d.day === key);
    const before = dayOf()?.wasted ?? 0;
    put("no changes pushed", 0.5);
    put("opened pull #3", 1);
    const today = dayOf()!;
    expect(today.wasted).toBe(before + 1);
    expect(today.spentUsd).toBeGreaterThanOrEqual(0.5);
  });
});
