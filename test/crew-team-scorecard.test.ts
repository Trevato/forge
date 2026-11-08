import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createAgentRow } from "../src/core/agents.ts";
import { createIssue } from "../src/core/issues.ts";
import { submitReview } from "../src/core/reviews.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { crewScorecards, teamScorecards, recentWindow } from "../src/core/scorecard.ts";
import { listTeams, saveTeam } from "../src/core/teams.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { createRepo } from "../src/core/repos.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

describe("a scorecard row per team", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let repoId = "";
  let reviewer = "";
  const ids: Record<string, string> = {};
  // Opened two days before the run, so "the last 30 days" holds whatever the date.
  const twoDaysAgo = new Date(Date.now() - 2 * 86_400_000).toISOString();

  function pull(author: string, title: string, merged: boolean, hours = 2, openedAt?: string) {
    const issue = createIssue(app.db, { repoId, authorId: ids[author]!, title, kind: "pull" });
    if (!issue.ok) throw new Error(issue.error);
    const opened = openedAt ?? twoDaysAgo;
    app.db.query(`UPDATE issue SET created_at = ?2 WHERE id = ?1`).run(issue.value.id, opened);
    const mergedAt = merged ? new Date(Date.parse(opened) + hours * 3_600_000).toISOString() : null;
    app.db
      .query(
        `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at)
         VALUES (?1, 'main', ?2, 'a', 'b', ?3)`,
      )
      .run(issue.value.id, `h${issue.value.number}`, mergedAt);
    return issue.value.id;
  }
  const check = (issueId: string, state: "ok" | "failed") => {
    const run = createRun(app.db, { repoId, kind: "check", issueId });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state, summary: state });
  };
  const change = (issueId: string) =>
    submitReview(app.db, {
      issueId,
      authorId: reviewer,
      state: "changes_requested",
      body: "",
      commitOid: "b",
    });

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-team-scorecard-"));
    app = createApp({ dataDir, port: 0 });
    for (const name of ["boss", "a1", "a2", "b1", "idle"]) {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: name,
        email: `${name}@forge.local`,
        // Agents hold no password (and cost no hash); only the admin has one.
        ...(name === "boss" ? { password: "a-good-passphrase", adminIfFirst: true } : { agent: true }),
      });
      if (!made.ok) throw new Error(made.error);
      ids[name] = made.value.id;
      if (name !== "boss") app.db.query("UPDATE user SET is_agent = 1 WHERE id = ?1").run(made.value.id);
      if (name !== "boss") createAgentRow(app.db, { userId: made.value.id, model: "opus" });
    }
    reviewer = ids.boss!;
    const repo = await createRepo(app.db, app.reposRoot, { ownerId: reviewer, name: "hello" });
    if (!repo.ok) throw new Error(repo.error);
    repoId = repo.value.id;
    const [one, two, three] = listTeams(app.db).map((t) => t.slug);
    saveTeam(app.db, one!, { charter: "", dial: 0, members: [ids.a1!, ids.a2!] });
    saveTeam(app.db, two!, { charter: "", dial: 0, members: [ids.b1!] });
    saveTeam(app.db, three!, { charter: "", dial: 0, members: [ids.idle!] });
  });

  afterAll(async () => {
    servers?.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("ratios come from pooled counts, not an average of ratios", () => {
    // a1: one landed pull, 1 change request, 1 failed of 1 check (rate 1.0).
    const p1 = pull("a1", "a1 one", true, 2);
    change(p1);
    check(p1, "failed");
    // a2: three landed pulls, no change requests, 0 failed of 3 checks (rate 0).
    for (const n of [1, 2, 3]) check(pull("a2", `a2 ${n}`, true, 6), "ok");
    // b1: one landed, one open.
    pull("b1", "b1 one", true, 4);
    pull("b1", "b1 open", false);

    const [one, two, three] = listTeams(app.db).map((t) => t.slug);
    const cards = teamScorecards(app.db);
    const a = cards.get(one!)!;
    expect([a.opened, a.landed]).toEqual([4, 4]);
    expect(a.reviewRounds).toBe(0.25); // 1 ÷ 4, not mean(1, 0)
    expect(a.redCheckRate).toBe(0.25); // 1 of 4 finished, not mean(1, 0)
    expect(a.meanLandMs).toBe(5 * 3_600_000); // (2 + 6 + 6 + 6) ÷ 4
    const b = cards.get(two!)!;
    expect([b.opened, b.landed, b.reviewRounds, b.redCheckRate]).toEqual([2, 1, 0, null]);
    expect(b.meanLandMs).toBe(4 * 3_600_000);
    // A team with no pulls has no card; the page says dashes.
    expect(cards.has(three!)).toBe(false);
    // The members' own cards are unchanged by pooling.
    expect(crewScorecards(app.db).get(ids.a1!)!.reviewRounds).toBe(1);
    // Two days ago is inside the last 30 days; the idle team is still absent.
    expect(teamScorecards(app.db, recentWindow()).has(three!)).toBe(false);
  });

  const cookieOf = (name: string) =>
    `forge_session=${createSession(app.db, ids[name]!).token}`;

  test("the page shows a team row with its pooled figures, to an admin only", async () => {
    app.db.query("UPDATE user SET is_admin = 1 WHERE id = ?1").run(ids.boss!);
    servers = await serve(app);
    const [one, , three] = listTeams(app.db).map((t) => t.slug);
    const page = await fetch(`${servers.url}/settings/crew`, {
      headers: { cookie: cookieOf("boss") },
    }).then((r) => r.text());
    expect(page).toContain("<th>Agent / team</th>");
    const table = page.slice(page.indexOf(`id="crew-scorecard"`));
    const row = table.slice(
      table.indexOf(`data-team="${one}"`),
      table.indexOf("</tr>", table.indexOf(`data-team="${one}"`)),
    );
    const cells = [...row.matchAll(/<td class="num">([\s\S]*?)<\/td>/g)].map((m) =>
      m[1]!.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
    );
    // 30 days beside all time: landed, review rounds, red checks; then reverts.
    expect(cells.slice(0, 7)).toEqual(["4 of 4", "4 of 4", "0.3", "0.3", "25%", "25%", "0"]);
    // A team without a card has no row, and the team rows sit under the agents.
    expect(table).not.toContain(`data-team="${three}"`);
    expect(table.indexOf("a1")).toBeLessThan(table.indexOf(`data-team="${one}"`));
    // Someone who is not an admin gets no scorecard.
    const other = await fetch(`${servers.url}/settings/crew`, {
      headers: { cookie: cookieOf("a1") },
    });
    expect(await other.text()).not.toContain("crew-scorecard");
  });

  test("the terminal shows the team rows to an admin, and nothing to anyone else", async () => {
    const terminal = (username: string) => {
      const user = getUserByName(app.db, username)!;
      const { app: tui } = createForgeApp(
        app,
        { sshUsername: "t", remoteAddress: "127.0.0.1", user },
        { terminal: headlessTerminal(160, 40), exitHooks: false },
      );
      tui.start();
      return tui;
    };
    const open = async (username: string) => {
      const tui = terminal(username);
      const key = (k: string, ctrl = false) =>
        tui.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
      key("k", true);
      for (const ch of "Crew scorecard per agent") key(ch);
      await settleApp(tui);
      key("enter");
      await settleApp(tui);
      const text = tui.screen.toText();
      tui.stop();
      return text;
    };
    const [one, , three] = listTeams(app.db);
    const admin = await open("boss");
    expect(admin).toContain(`team ${one!.name}`);
    expect(admin).toContain("all 4 of 4");
    expect(admin).toContain("all 0.3");
    expect(admin).not.toContain(`team ${three!.name}`);
    const other = await open("a1");
    expect(other).not.toContain(`team ${one!.name}`);
  });
});
