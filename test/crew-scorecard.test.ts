import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createIssue } from "../src/core/issues.ts";
import { submitReview } from "../src/core/reviews.ts";
import {
  claimRun,
  createRun,
  finishRun,
  noteRunProgress,
} from "../src/core/runs.ts";
import {
  crewScorecards,
  crewScorecardSplits,
  recentWindow,
} from "../src/core/scorecard.ts";
import { createUser, getUserByName } from "../src/core/users.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { adminCookie } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { settleApp } from "./helpers/tui.ts";

quietLogs();

describe("a scorecard per crew member", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let base: string;
  let cookie = "";
  let repoId = "";
  let agentId = "";
  let adminId = "";

  /** A pull row as the forge keeps it, without the git it was opened from. */
  function pull(
    authorId: string,
    title: string,
    opts: { openedAt?: string; mergedAt?: string; reverts?: string } = {},
  ): string {
    const issue = createIssue(app.db, { repoId, authorId, title, kind: "pull" });
    if (!issue.ok) throw new Error(issue.error);
    if (opts.openedAt)
      app.db
        .query(`UPDATE issue SET created_at = ?2 WHERE id = ?1`)
        .run(issue.value.id, opts.openedAt);
    app.db
      .query(
        `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid,
                           merged_at, reverts_issue_id)
         VALUES (?1, 'main', ?2, 'a', 'b', ?3, ?4)`,
      )
      .run(issue.value.id, `h${issue.value.number}`, opts.mergedAt ?? null, opts.reverts ?? null);
    return issue.value.id;
  }

  function check(issueId: string, state: "ok" | "failed"): void {
    const run = createRun(app.db, { repoId, kind: "check", issueId });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, { state, summary: state });
  }

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-scorecard-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    base = servers.url;
    cookie = await adminCookie(app, {
      username: "ada",
      email: "ada@forge.example",
      password: "analytical-engine",
    });
    adminId = getUserByName(app.db, "ada")!.id;
    const headers = { cookie, "content-type": "application/json" };
    const repo = (await fetch(`${base}/api/v1/repos`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "hello", visibility: "public" }),
    }).then((r) => r.json())) as { id: string };
    repoId = repo.id;
    await fetch(`${base}/api/v1/agents`, {
      method: "POST",
      headers,
      body: JSON.stringify({ username: "smith", model: "opus" }),
    });
    agentId = getUserByName(app.db, "smith")!.id;
  });

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("the page has no model-per-day table before a run, and has one for an admin after", async () => {
    const get = () =>
      fetch(`${base}/settings/crew`, { headers: { cookie } }).then((r) => r.text());
    expect(await get()).not.toContain(`id="crew-model-days"`);
    const run = createRun(app.db, { repoId, kind: "agent", actorId: agentId });
    claimRun(app.db, run.id);
    noteRunProgress(app.db, run.id, { model: "opus", modelReason: "p0", costUsd: 0.5 });
    finishRun(app.db, run.id, { state: "ok", summary: "" });
    const page = await get();
    expect(page).toContain(`id="crew-model-days"`);
    expect(page).toContain("Per model per day");
    app.db.query("DELETE FROM run WHERE id = ?1").run(run.id);
  });

  test("an admin's page shows the wasted runs per day, and a guest's shows nothing", async () => {
    const get = (headers: Record<string, string>) =>
      fetch(`${base}/settings/crew`, { headers }).then((r) => r.text());
    expect(await get({ cookie })).not.toContain(`id="crew-wasted-days"`);
    for (const summary of ["no changes pushed", "already done: abc", "opened pull #9"]) {
      const run = createRun(app.db, { repoId, kind: "agent", actorId: agentId });
      claimRun(app.db, run.id);
      finishRun(app.db, run.id, { state: "ok", summary, costUsd: 0.25 });
    }
    const page = await get({ cookie });
    const table = page.slice(page.indexOf(`id="crew-wasted-days"`));
    expect(page).toContain("Wasted runs per day");
    const day = new Date().toISOString().slice(0, 10);
    expect(table).toContain(`<td class="mono">${day}</td>
              <td class="num">2</td>
              <td class="num">3</td>
              <td class="num">$0.50</td>`);
    expect(await get({})).not.toContain(`id="crew-wasted-days"`);
    app.db.query("DELETE FROM run WHERE kind = 'agent'").run();
  });

  test("an agent with no pull is a row of dashes, not zeros", async () => {
    expect(crewScorecards(app.db).get(agentId)).toBeUndefined();
    const page = await fetch(`${base}/settings/crew`, {
      headers: { cookie },
    }).then((r) => r.text());
    expect(page).toContain(`id="crew-scorecard"`);
    for (const head of ["Pulls landed", "Review rounds", "Red checks"])
      for (const span of ["30 days", "all time"])
        expect(page).toContain(`<th>${head}<br /><span class="muted small">${span}</span></th>`);
    for (const head of ["Reverts", "Time to land"]) expect(page).toContain(`<th>${head}</th>`);
    // What a landed pull costs is the agent table's "Per landed"; one figure, one column.
    expect(page).not.toContain("<th>Landed per $</th>");
    // The agent's name stays in view while a phone scrolls the figures.
    expect(page).toContain(`id="crew-scorecard" data-sticky-lead`);
  });

  test("a landed pull counts for its author, and only its author", () => {
    pull(agentId, "First change", {
      openedAt: "2026-10-01T00:00:00.000Z",
      mergedAt: "2026-10-01T02:00:00.000Z",
    });
    const card = crewScorecards(app.db).get(agentId)!;
    expect(card.opened).toBe(1);
    expect(card.landed).toBe(1);
    expect(card.meanLandMs).toBe(2 * 3_600_000);
    // A person's pulls are not on the crew's scorecard.
    pull(adminId, "A person's change", { mergedAt: "2026-10-02T00:00:00.000Z" });
    expect(crewScorecards(app.db).has(adminId)).toBe(false);
  });

  test("review rounds, red checks and reverts add up", () => {
    const second = pull(agentId, "Second change", {
      openedAt: "2026-10-03T00:00:00.000Z",
      mergedAt: "2026-10-03T04:00:00.000Z",
    });
    for (const state of ["changes_requested", "changes_requested", "approved"] as const)
      submitReview(app.db, { issueId: second, authorId: adminId, state, body: "", commitOid: "b" });
    // A change request on a pull that never landed is not a round of landing one.
    const open = pull(agentId, "Still open");
    submitReview(app.db, { issueId: open, authorId: adminId, state: "changes_requested", body: "", commitOid: "b" });
    check(second, "failed");
    check(second, "ok");
    check(open, "ok");
    check(open, "ok");
    // Taken back by a merged revert; an unmerged revert takes nothing back.
    pull(adminId, "Revert second", { mergedAt: "2026-10-04T00:00:00.000Z", reverts: second });
    const first = app.db
      .query<{ id: string }, [string]>(`SELECT id FROM issue WHERE title = ?1`)
      .get("First change")!.id;
    pull(adminId, "Revert first, not merged", { reverts: first });

    const card = crewScorecards(app.db).get(agentId)!;
    expect(card.opened).toBe(3);
    expect(card.landed).toBe(2);
    expect(card.reviewRounds).toBe(1); // two change requests over two landed
    expect(card.redCheckRate).toBe(0.25); // one failed of four finished
    expect(card.reverts).toBe(1);
    expect(card.meanLandMs).toBe(3 * 3_600_000); // (2h + 4h) / 2
  });

  test("the crew page shows the scorecard's numbers", async () => {
    const page = await fetch(`${base}/settings/crew`, {
      headers: { cookie },
    }).then((r) => r.text());
    const table = page.slice(page.indexOf(`id="crew-scorecard"`));
    expect(table).toContain("of 3");
    expect(table).toContain("1.0");
    expect(table).toContain("25%");
    expect(table).toContain("3h");
  });

  test("the last 30 days and all time are different figures over old and new pulls", async () => {
    const old = (n: number) => `2020-01-0${n}T00:00:00.000Z`;
    await fetch(`${base}/api/v1/agents`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ username: "jones", model: "opus" }),
    });
    const jones = getUserByName(app.db, "jones")!.id;
    // Long ago: two landed, three change requests between them, one red check of one.
    const a = pull(jones, "Old one", { openedAt: old(1), mergedAt: old(2) });
    const b = pull(jones, "Old two", { openedAt: old(3), mergedAt: old(4) });
    for (const issueId of [a, a, b])
      submitReview(app.db, { issueId, authorId: adminId, state: "changes_requested", body: "", commitOid: "b" });
    check(a, "failed");
    // Lately: one landed with no change request and a green check, one still open.
    const hour = 3_600_000;
    const recent = pull(jones, "New one", {
      openedAt: new Date(Date.now() - 2 * hour).toISOString(),
      mergedAt: new Date(Date.now() - hour).toISOString(),
    });
    check(recent, "ok");
    pull(jones, "New, open");

    // The window both doors share: 30 days of 86 400 000 ms before now.
    expect(recentWindow(Date.UTC(2026, 9, 31)).since).toEqual(new Date(Date.UTC(2026, 9, 1)));
    const all = crewScorecards(app.db).get(jones)!;
    const month = crewScorecards(app.db, recentWindow()).get(jones)!;
    expect([all.opened, all.landed]).toEqual([4, 3]);
    expect(all.reviewRounds).toBe(1); // 3 change requests ÷ 3 landed
    expect(all.redCheckRate).toBe(0.5); // 1 failed ÷ 2 finished
    expect([month.opened, month.landed]).toEqual([2, 1]);
    expect(month.reviewRounds).toBe(0); // 0 ÷ 1 landed
    expect(month.redCheckRate).toBe(0); // 0 failed ÷ 1 finished
    // An agent with nothing in the window is absent from it, not zeros.
    const later = new Date(Date.now() + 86_400_000);
    expect(crewScorecards(app.db, { since: later }).has(jones)).toBe(false);

    const page = await fetch(`${base}/settings/crew`, { headers: { cookie } }).then((r) => r.text());
    const table = page.slice(page.indexOf(`id="crew-scorecard"`));
    const row = table.slice(table.indexOf("jones"), table.indexOf("</tr>", table.indexOf("jones")));
    const cells = [...row.matchAll(/<td class="num">([\s\S]*?)<\/td>/g)].map((m) =>
      m[1]!.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
    );
    // 30 days beside all time: landed, review rounds, red checks; then reverts.
    expect(cells.slice(0, 7)).toEqual(["1 of 2", "3 of 4", "0.0", "1.0", "0%", "50%", "0"]);
  });

  /** The forge's terminal, signed in as one account, on a headless screen. */
  function terminal(username: string) {
    const user = getUserByName(app.db, username)!;
    const { app: tui } = createForgeApp(
      app,
      { sshUsername: "t", remoteAddress: "127.0.0.1", user },
      { terminal: headlessTerminal(160, 32), exitHooks: false },
    );
    tui.start();
    const key = (k: string, ctrl = false) =>
      tui.dispatch({ type: "key", key: k, ctrl, alt: false, shift: false });
    return {
      text: () => tui.screen.toText(),
      palette: async (word: string) => {
        key("k", true);
        for (const ch of word) key(ch);
        await settleApp(tui);
      },
      enter: async () => {
        key("enter");
        await settleApp(tui);
      },
      stop: () => tui.stop(),
    };
  }

  test("the terminal shows an admin the same scorecard", async () => {
    const t = terminal("ada");
    await t.palette("Crew scorecard per agent");
    await t.enter();
    const text = t.text();
    expect(text).toContain("smith");
    expect(text).toContain("· all 2 of 3");
    expect(text).toContain("· all 1.0");
    expect(text).toContain("· all 25%");
    expect(text).toContain("reverts 1");
    expect(text).toContain("time to land 3h");
    t.stop();
  });

  test("the terminal shows the last 30 days beside all time, as the page does", async () => {
    // jones: two landed pulls from 2020 and two opened within the hour (see above).
    const t = terminal("ada");
    await t.palette("Crew scorecard per agent");
    await t.enter();
    const text = t.text();
    expect(text).toContain("Over the last 30 days (30d) and all time");
    expect(text).toContain("landed 30d 1 of 2 · all 3 of 4");
    expect(text).toContain("review rounds 30d 0.0 · all 1.0");
    expect(text).toContain("red checks 30d 0% · all 50%");
    t.stop();
  });

  test("someone who is not an admin has no scorecard in the terminal", async () => {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "bob",
      email: "bob@forge.example",
      password: "a-good-passphrase",
    });
    if (!made.ok) throw new Error(made.error);
    const t = terminal("bob");
    await t.palette("Crew scorecard per agent");
    expect(t.text()).not.toContain("review rounds, red checks");
    await t.enter();
    expect(t.text()).not.toContain("all 2 of 3");
    t.stop();
  });

  test("one member on two models gets a row each, with their own landed counts", async () => {
    await fetch(`${base}/api/v1/agents`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ username: "lee", model: "opus" }),
    });
    const lee = getUserByName(app.db, "lee")!.id;
    const ran = (issueId: string, model: string, promptVersion: string) => {
      const run = createRun(app.db, { repoId, kind: "agent", issueId, actorId: lee });
      claimRun(app.db, run.id);
      app.db
        .query(`UPDATE run SET model = ?2, prompt_version = ?3 WHERE id = ?1`)
        .run(run.id, model, promptVersion);
    };
    const merged = "2026-10-05T00:00:00.000Z";
    ran(pull(lee, "A", { mergedAt: merged }), "opus", "p1");
    ran(pull(lee, "B", { mergedAt: merged }), "opus", "p1");
    ran(pull(lee, "C", { mergedAt: merged }), "haiku", "p1");
    ran(pull(lee, "D"), "haiku", "p1");
    pull(lee, "Before the migration", { mergedAt: merged });

    const rows = crewScorecardSplits(app.db).get(lee)!;
    const by = (m: string) => rows.find((r) => r.model === m)!;
    expect([by("opus").opened, by("opus").landed]).toEqual([2, 2]);
    expect([by("haiku").opened, by("haiku").landed]).toEqual([2, 1]);
    // A pull with no recorded run is shown as unrecorded, not dropped.
    expect([by("").opened, by("").landed, by("").promptVersion]).toEqual([1, 1, ""]);
    expect(rows.reduce((n, r) => n + r.opened, 0)).toBe(5);

    const page = await fetch(`${base}/settings/crew`, { headers: { cookie } }).then((r) => r.text());
    const table = page.slice(page.indexOf(`id="crew-scorecard"`));
    expect(table).toContain("opus");
    expect(table).toContain("haiku");
    expect(table).toContain("unrecorded");

    // The terminal shows the same sub-rows under the member.
    const t = terminal("ada");
    await t.palette("Crew scorecard per agent");
    await t.enter();
    const text = t.text();
    expect(text).toContain("↳ opus · p1");
    expect(text).toContain("↳ haiku · p1");
    expect(text).toContain("↳ unrecorded · unrecorded");
    expect(text).toContain("↳ opus · p1 landed 30d 2 of 2 · all 2 of 2");
    t.stop();
  });
});
