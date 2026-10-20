/**
 * The `review` tool over MCP: the page's verdict, with the page's gate —
 * a writer's approval lands, a reader's is refused in the page's words, an
 * author cannot approve their own pull, and bad input stops at the boundary.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { listReviews } from "../src/core/reviews.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

describe("the review tool over MCP", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let aliceRw: string;
  let bobRw: string;
  let nextId = 1;

  const tool = async (token: string, args: unknown) => {
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
        params: { name: "review", arguments: args },
      }),
    });
    const body = (await res.json()) as any;
    const text: string = body.result.content[0].text;
    return body.result.isError === true
      ? { error: text }
      : { value: JSON.parse(text) };
  };

  /** A pull on alice/game, its author set to `author`. */
  const pullBy = async (branch: string, author: User) => {
    const repo = (await import("../src/core/repos.ts")).getRepo(
      app.db,
      "alice",
      "game",
    )!;
    const made = await commitToBranch(app, alice, repo, {
      branch,
      message: branch,
      files: [{ path: `${branch}.txt`, content: `${branch}\n` }],
    });
    if (!made.ok) throw new Error(JSON.stringify(made.error));
    const opened = await openPull(app, alice, repo, {
      title: branch,
      baseBranch: "main",
      headBranch: branch,
    });
    if (!opened.ok) throw new Error(String(opened.error));
    app.db
      .query("UPDATE issue SET author_id = ?1 WHERE id = ?2")
      .run(author.id, opened.value.id);
    return opened.value;
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-review-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const mk = async (username: string, first = false) => {
      const made = await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username,
        email: `${username}@forge.local`,
        password: "a-good-passphrase",
        adminIfFirst: first,
      });
      if (!made.ok) throw new Error(made.error);
      return made.value;
    };
    alice = await mk("alice", true);
    bob = await mk("bob");
    promote(app.db, alice, bob);
    aliceRw = createToken(app.db, alice.id, "rw", "rw").token;
    bobRw = createToken(app.db, bob.id, "rw", "rw").token;
    const made = await createRepo(app, alice, {
      name: "game",
      visibility: "public",
    });
    if (!made.ok) throw new Error(String(made.error));
    await commitToBranch(app, alice, made.value, {
      message: "seed",
      files: [{ path: "README.md", content: "# game\n" }],
    });
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a writer approves, and requests changes with a reason", async () => {
    const pull = await pullBy("one", bob);
    const approved = await tool(aliceRw, {
      repo: "alice/game",
      number: pull.number,
      verdict: "approve",
    });
    expect(approved.value).toEqual({
      says: "Approved.",
      url: `/alice/game/pulls/${pull.number}`,
    });
    const asked = await tool(aliceRw, {
      repo: "alice/game",
      number: pull.number,
      verdict: "changes",
      reason: "Add a test.",
    });
    expect(asked.value.says).toBe("Changes requested.");
    expect(listReviews(app.db, pull.id).map((r) => [r.state, r.body])).toEqual([
      ["approved", ""],
      ["changes_requested", "Add a test."],
    ]);
  });

  test("a reader's verdict is refused with the page's words", async () => {
    const pull = await pullBy("two", alice);
    const refused = await tool(bobRw, {
      repo: "alice/game",
      number: pull.number,
      verdict: "approve",
    });
    expect(refused.error).toContain(
      "A verdict that gates a merge needs write access.",
    );
    expect(listReviews(app.db, pull.id)).toEqual([]);
  });

  test("an author cannot approve their own pull", async () => {
    const pull = await pullBy("three", alice);
    const refused = await tool(aliceRw, {
      repo: "alice/game",
      number: pull.number,
      verdict: "approve",
    });
    expect(refused.error).toContain("You cannot approve your own pull request.");
  });

  test("bad input is refused at the boundary", async () => {
    const pull = await pullBy("four", bob);
    const base = { repo: "alice/game", number: pull.number };
    expect((await tool(aliceRw, { ...base, verdict: "lgtm" })).error).toContain(
      "verdict is approve or changes",
    );
    expect(
      (await tool(aliceRw, { ...base, verdict: "changes", reason: "  " })).error,
    ).toContain("say what to change");
    expect(
      (await tool(aliceRw, { ...base, number: 9999, verdict: "approve" })).error,
    ).toContain("no pull #9999");
    expect(
      (await tool(aliceRw, { ...base, number: "1", verdict: "approve" })).error,
    ).toContain("no pull");
    expect(
      (await tool(aliceRw, { repo: "nope", number: 1, verdict: "approve" })).error,
    ).toContain("not_found");
    expect(listReviews(app.db, pull.id)).toEqual([]);
  });
});
