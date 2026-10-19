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
} from "../src/core/runs.ts";
import { crewScorecards } from "../src/core/scorecard.ts";
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

  test("an agent with no pull is a row of dashes, not zeros", async () => {
    expect(crewScorecards(app.db).get(agentId)).toBeUndefined();
    const page = await fetch(`${base}/settings/crew`, {
      headers: { cookie },
    }).then((r) => r.text());
    expect(page).toContain(`id="crew-scorecard"`);
    for (const head of [
      "Pulls landed",
      "Review rounds",
      "Red checks",
      "Reverts",
      "Time to land",
    ])
      expect(page).toContain(`<th>${head}</th>`);
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
    expect(text).toContain("2 landed of 3");
    expect(text).toContain("review rounds 1.0");
    expect(text).toContain("red checks 25%");
    expect(text).toContain("reverts 1");
    expect(text).toContain("time to land 3h");
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
    expect(t.text()).not.toContain("2 landed of 3");
    t.stop();
  });
});
