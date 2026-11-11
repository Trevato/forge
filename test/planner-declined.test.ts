/**
 * "The planner declined, waiting for a person": an autonomous app whose
 * planner declined its direction is an ask — on the board with a box to
 * answer, on the asks page, in MCP `now`, and once on the phone per decline
 * — for those who may see the owner's facts, and gone the moment a person
 * answers on the direction issue.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { dashboardScreen } from "../src/tui/screens/dashboard.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";
import { boardCss } from "../src/web/pages/board.ts";
import { liveRegionsJs } from "../src/web/client.ts";
import { openIssue } from "../src/actions/issues.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import type { Issue } from "../src/core/issues.ts";
import { getRepoById, type Repo } from "../src/core/repos.ts";
import { claimRun, createRun, finishRun } from "../src/core/runs.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { plannerDeclines } from "../src/crew/autonomy.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { askLinesFor } from "../src/web/studio/asks.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-good-passphrase";

describe("the planner declined, waiting for a person", () => {
  let dataDir = "";
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let repo: Repo;
  let direction: Issue;
  let aliceRo = "";
  let bobRo = "";
  let nextId = 1;

  const fresh = (): Repo => getRepoById(app.db, repo.id)!;

  /** A planning run on the direction issue that ends in a decline. */
  const decline = (words: string, at: string): string => {
    const run = createRun(app.db, {
      repoId: repo.id,
      kind: "agent",
      issueId: direction.id,
      reason: "planning",
    });
    claimRun(app.db, run.id);
    finishRun(app.db, run.id, {
      state: "failed",
      summary: `declined: ${words}`,
    });
    app.db
      .query("UPDATE run SET created_at = ?1 WHERE id = ?2")
      .run(at, run.id);
    return run.id;
  };

  const signIn = async (username: string): Promise<string> => {
    const res = await fetch(`${servers.url}/signin`, {
      method: "POST",
      body: new URLSearchParams({ username, password: PASSWORD }),
      redirect: "manual",
    });
    return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  };

  const page = async (cookie: string, path: string): Promise<string> => {
    const res = await fetch(`${servers.url}${path}`, { headers: { cookie } });
    expect(res.status).toBe(200);
    return (await res.text()).replace(/\s+/g, " ");
  };

  const now = async (token: string) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: nextId++,
        method: "tools/call",
        params: { name: "now", arguments: {} },
      }),
    });
    const body = (await res.json()) as any;
    return JSON.parse(body.result.content[0].text) as any[];
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-declined-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: PASSWORD,
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const b = await createUser(app.db, { origin: "seed", trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: PASSWORD,
    });
    if (!b.ok) throw new Error(b.error);
    bob = b.value;
    aliceRo = createToken(app.db, alice.id, "ro", "ro").token;
    bobRo = createToken(app.db, bob.id, "ro", "ro").token;
    // Public, so bob can read it — and still must not see the planner's words.
    const made = await createRepo(app, alice, {
      name: "garden",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    await commitToBranch(app, alice, repo, {
      message: "seed",
      files: [{ path: "README.md", content: "# garden\n" }],
    });
    const record = insertApp(app.db, {
      repoId: repo.id,
      slug: "garden",
      access: "public",
    });
    if (!record.ok) throw new Error(record.error);
    const opened = openIssue(app, alice, repo, {
      title: "Direction: grow food",
    });
    if (!opened.ok) throw new Error(String(opened.error));
    direction = opened.value;
    app.db
      .query(
        "UPDATE repo SET autonomy = 'autonomous', autonomy_direction = 'grow food', direction_issue_id = ?1 WHERE id = ?2",
      )
      .run(direction.id, repo.id);
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("nothing waits while the planner has not declined", () => {
    expect(plannerDeclines(app.db, [fresh()])).toEqual([]);
    expect(
      askLinesFor(app.db, alice).filter((a) => a.kind === "declined"),
    ).toEqual([]);
  });

  test("a decline is an ask for the owner, with the planner's words, and nothing for a reader", async () => {
    const runId = decline(
      "the direction is already done",
      new Date(Date.now() - 60_000).toISOString(),
    );
    const declines = plannerDeclines(app.db, [fresh()]);
    expect(declines.map((d) => [d.runId, d.words])).toEqual([
      [runId, "the direction is already done"],
    ]);

    const lines = askLinesFor(app.db, alice).filter(
      (a) => a.kind === "declined",
    );
    expect(lines.map((a) => a.id)).toEqual([`declined:${runId}`]);
    expect(askLinesFor(app.db, bob)).toEqual([]);

    const aliceCookie = await signIn("alice");
    const board = await page(aliceCookie, "/board");
    expect(board).toContain(
      "the planner declined the direction and waits for you",
    );
    // One line linking the run, where the words are, with the answer box.
    expect(board).not.toContain("the direction is already done");
    expect(board).toContain(`href="/alice/garden/runs/${runId}"`);
    expect(board).toContain(
      `action="/alice/garden/issues/${direction.number}/comments"`,
    );
    expect(board).toContain('name="back" value="board"');
    // The wall board has no pointer or keys: the box and button are hidden there.
    expect(boardCss).toMatch(/\[data-wall\] #notes :is\(\.input, \.btn\) \{ display: none; \}/);
    // A live swap never wipes words a person has typed in a box.
    expect(liveRegionsJs).toContain("input.input, textarea");
    // The terminal's first screen says the same, one line.
    const shown = async (user: User): Promise<string> => {
      const terminal = headlessTerminal(160, 30);
      const { app: tui, session } = createForgeApp(
        app,
        { sshUsername: user.username, remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user },
        { terminal, exitHooks: false },
      );
      tui.start();
      tui.ctx.push(dashboardScreen(session, tui.ctx));
      await settleApp(tui);
      const text = tui.screen.toText();
      tui.stop?.();
      return text;
    };
    expect(await shown(alice)).toContain(
      `garden: the planner declined the direction and waits for you (issue #${direction.number})`,
    );
    expect(await shown(bob)).not.toContain("the planner declined");
    const asks = await page(aliceCookie, "/asks");
    expect(asks).toContain("The planner declined the direction");
    expect(asks).toContain(
      `/alice/garden/issues/${direction.number}#comment-body`,
    );

    const bobBoard = await page(await signIn("bob"), "/board");
    expect(bobBoard).not.toContain("the direction is already done");

    const rows = await now(aliceRo);
    expect(rows[0]).toMatchObject({
      run: null,
      app: "alice/garden",
      why: "declined",
      says: "the direction is already done",
    });
    expect((await now(bobRo)).some((r) => r.why === "declined")).toBe(false);
  });

  test("a later decline is a new ask, so the phone hears it once more", () => {
    const before = askLinesFor(app.db, alice).find(
      (a) => a.kind === "declined",
    )!.id;
    const runId = decline("still done", new Date(Date.now() - 1_000).toISOString());
    const after = askLinesFor(app.db, alice).find(
      (a) => a.kind === "declined",
    )!.id;
    expect(after).toBe(`declined:${runId}`);
    expect(after).not.toBe(before);
  });

  test("an ask quotes the planner's words as one escaped, clamped line, whole in its title (#10199)", async () => {
    const words = "nothing to plan:\n\n  - `main` is **done**\n  - see [the map](http://x.test) <b>now</b>";
    decline(words, new Date().toISOString());
    const asks = await page(await signIn("alice"), "/asks");
    const flat = "nothing to plan: - `main` is **done** - see [the map](http://x.test) &lt;b&gt;now&lt;/b&gt;";
    expect(asks).toContain(`The planner declined the direction: \u201c<span class="row-note" title="${flat}">${flat}</span>\u201d.`);
    expect(asks).not.toContain("<b>now</b>");
    expect(asks).not.toContain('href="http://x.test"');
  });

  test("an assisted repository never waits on its planner", () => {
    app.db
      .query("UPDATE repo SET autonomy = 'assisted' WHERE id = ?1")
      .run(repo.id);
    expect(plannerDeclines(app.db, [fresh()])).toEqual([]);
    app.db
      .query("UPDATE repo SET autonomy = 'autonomous' WHERE id = ?1")
      .run(repo.id);
  });

  test("a person's answer on the direction issue clears it everywhere", async () => {
    // Answered from the board's own form: the comment lands on the
    // direction issue and the person is sent back to the board.
    const cookie = await signIn("alice");
    const answered = await fetch(
      `${servers.url}/alice/garden/issues/${direction.number}/comments`,
      {
        method: "POST",
        headers: { cookie, origin: servers.url },
        body: new URLSearchParams({ back: "board", body: "Plan the next season: herbs." }),
        redirect: "manual",
      },
    );
    expect(answered.status).toBe(303);
    expect(answered.headers.get("location")).toBe("/board");
    expect(plannerDeclines(app.db, [fresh()])).toEqual([]);
    expect(
      askLinesFor(app.db, alice).filter((a) => a.kind === "declined"),
    ).toEqual([]);
    expect(await page(await signIn("alice"), "/board")).not.toContain(
      "waits for you",
    );
  });
  test("`back` is a fixed word: anything else returns to the issue, never elsewhere", async () => {
    const cookie = await signIn("alice");
    const res = await fetch(
      `${servers.url}/alice/garden/issues/${direction.number}/comments`,
      {
        method: "POST",
        headers: { cookie, origin: servers.url },
        body: new URLSearchParams({ back: "https://evil.example/", body: "noted" }),
        redirect: "manual",
      },
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/alice/garden/issues/${direction.number}#conversation`);
  });
});
