/**
 * An issue sums its pulls (#1389): its cost is its own runs' dollars plus
 * those of every pull whose description closes it — worked by hand below:
 * $0.40 own + $1.25 on #2's pull + $0.35 on the second pull = $2.00; a pull
 * that names another issue adds nothing.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { costLine, costRows, issueCost, issueCostFor } from "../src/core/issue_cost.ts";
import type { Repo } from "../src/core/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("issue cost roll-up", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let repo: Repo;

  const open = (title: string, body = "") => {
    const r = openIssue(app, alice, repo, { title, body });
    if (!r.ok) throw new Error(String(r.error));
    return r.value;
  };
  const asPull = (id: string) => {
    app.db.query("UPDATE issue SET kind = 'pull' WHERE id = ?1").run(id);
    app.db
      .query(`INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid) VALUES (?1, ?2, 'x', '', '')`)
      .run(id, repo.defaultBranch);
  };
  const spend = (issueId: string, usd: number) => {
    const r = createRun(app.db, { repoId: repo.id, kind: "agent", issueId });
    app.db.query("UPDATE run SET cost_usd = ?1 WHERE id = ?2").run(usd, r.id);
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-issue-cost-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const made = await createRepo(app, alice, { name: "shop" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
  });
  afterAll(async () => {
    servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("own runs plus the pulls that close it, and no others", () => {
    const one = open("One");
    const two = open("Two");
    spend(one.id, 0.1);
    spend(one.id, 0.3);
    const p1 = open("Fix two", `Closes #${two.number}`);
    asPull(p1.id);
    spend(p1.id, 1.25);
    const p2 = open("Fix two again", `fixes #${two.number}, and #${one.number} is only mentioned`);
    asPull(p2.id);
    spend(p2.id, 0.35);
    const other = open("Fix one", `Closes #9${one.number}9`);
    asPull(other.id);
    spend(other.id, 9);
    spend(two.id, 0.4);

    const cost = issueCost(app.db, repo.id, two.id, two.number);
    expect(cost.ownUsd).toBe(0.4);
    expect(cost.pulls).toEqual([
      { id: p1.id, number: p1.number, usd: 1.25 },
      { id: p2.id, number: p2.number, usd: 0.35 },
    ]);
    expect(cost.totalUsd).toBe(2);
    // One's own is its runs only: no pull closes it ("#1" is not "#191").
    expect(issueCost(app.db, repo.id, one.id, one.number)).toEqual({ ownUsd: 0.4, pulls: [], totalUsd: 0.4 });
  });

  const signin = async (username: string, password: string) => {
    const login = await fetch(`${servers.url}/signin`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: servers.url },
      body: new URLSearchParams({ username, password }),
    });
    return (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  };
  const costDl = (html: string) => /<dl class="status-rows" data-issue-cost>([\s\S]*?)<\/dl>/.exec(html)?.[1];
  const page = async (n: number, cookie = "") =>
    (await fetch(`${servers.url}/alice/shop/issues/${n}`, { headers: { cookie } })).text();

  test("the tell page shows the cost as rows, each pull a link", async () => {
    const t = open("Costly");
    spend(t.id, 0.5);
    const p = open("Fix costly", `Closes #${t.number}`);
    asPull(p.id);
    spend(p.id, 0.25);
    const text = await page(t.number, await signin("alice", "a-good-passphrase"));
    const rows = [...(costDl(text) ?? "").matchAll(/<dt>(.*?)<\/dt><dd class="num">([\s\S]*?)<\/dd>/g)].map((m) => [
      m[1],
      m[2]!.replace(/<a href="([^"]+)">(#\d+)<\/a>/g, "[$2 $1]").trim(),
    ]);
    expect(rows).toEqual([
      ["Cost", "$0.75"],
      ["This issue", "$0.50"],
      ["Pull", `[#${p.number} /alice/shop/pulls/${p.number}] $0.25`],
    ]);
    expect(text).not.toContain("this tell");
  });

  test("with no runs of its own but a closing pull, the Runs card goes and the cost stays", async () => {
    const t = open("Quiet");
    const p = open("Fix quiet", `Closes #${t.number}`);
    asPull(p.id);
    spend(p.id, 0.2);
    const text = await page(t.number, await signin("alice", "a-good-passphrase"));
    expect(text).not.toContain("<h2>Runs</h2>");
    expect(costDl(text)).toContain("$0.20");
  });

  test("a guest and a reader who cannot write are shown no cost", async () => {
    const t = open("Private money");
    spend(t.id, 0.9);
    const b = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    expect(costDl(await page(t.number))).toBeUndefined();
    expect(costDl(await page(t.number, await signin("bob", "a-good-passphrase")))).toBeUndefined();
    expect(issueCostFor(app.db, repo, t, undefined)).toBeNull();
    expect(issueCostFor(app.db, repo, t, b.value)).toBeNull();
    const mine = issueCostFor(app.db, repo, t, alice);
    expect(mine && costLine(mine)).toBe("Cost $0.90");
  });

  test("the terminal's line is the plain sentence", () => {
    const t = open("Words");
    spend(t.id, 0.5);
    const p = open("Fix words", `Closes #${t.number}`);
    asPull(p.id);
    spend(p.id, 0.25);
    const c = issueCostFor(app.db, repo, t, alice)!;
    expect(costLine(c)).toBe(`Cost $0.75: this issue $0.50, #${p.number} $0.25`);
    expect(costRows(c).map((r) => r.label)).toEqual(["Cost", "This issue", "Pull"]);
  });
});
