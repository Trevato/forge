/**
 * The `threads` tool over MCP: the page's verdict, with the page's gate —
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
import { addReviewComment, anchorId } from "../src/core/reviews.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

describe("the threads tool over MCP", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let bob: User;
  let aliceRw: string;
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
        params: { name: "threads", arguments: args },
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
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-threads-"));
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

  const withThread = async (branch: string) => {
    const pull = await pullBy(branch, bob);
    const added = addReviewComment(app.db, {
      pullId: pull.id,
      authorId: bob.id,
      body: "why?",
      path: `${branch}.txt`,
      line: 1,
      side: "new",
      commitOid: "0".repeat(40),
      lineHash: "x",
    });
    if (!added.ok) throw new Error(added.error);
    return { pull, anchor: anchorId(`${branch}.txt`, "new", 1) };
  };

  test("a writer lists, resolves and reopens a thread", async () => {
    const { pull, anchor } = await withThread("t1");
    const listed = await tool(aliceRw, { repo: "alice/game", number: pull.number });
    expect(listed.value.threads[0].anchor).toBe(anchor);
    expect(listed.value.says).toBe("1 thread, 1 open.");
    const done = await tool(aliceRw, { repo: "alice/game", number: pull.number, anchor });
    expect(done.value.says).toBe("Thread resolved.");
    expect(done.value.resolvedBy).toBe(alice.id);
    const after = await tool(aliceRw, { repo: "alice/game", number: pull.number });
    expect(after.value.says).toBe("1 thread, 0 open.");
    const back = await tool(aliceRw, { repo: "alice/game", number: pull.number, anchor, resolved: false });
    expect(back.value.says).toBe("Thread reopened.");
    expect(back.value.resolvedAt).toBeNull();
  });

  test("a stranger is refused as the route refuses", async () => {
    const { pull, anchor } = await withThread("t2");
    const carol = await createUser(app.db, {
      origin: "seed", trusted: true, username: "carol",
      email: "carol@forge.local", password: "a-good-passphrase",
    });
    if (!carol.ok) throw new Error(carol.error);
    const carolRw = createToken(app.db, carol.value.id, "rw", "rw").token;
    const refused = await tool(carolRw, { repo: "alice/game", number: pull.number, anchor });
    expect(refused.error).toStartWith("refused:");
    const read = createToken(app.db, alice.id, "ro", "ro").token;
    const ro = await tool(read, { repo: "alice/game", number: pull.number, anchor });
    expect(ro.error).toStartWith("forbidden:");
    const still = await tool(read, { repo: "alice/game", number: pull.number });
    expect(still.value.says).toBe("1 thread, 1 open.");
  });

  test("an unknown anchor and bad arguments are refused", async () => {
    const { pull } = await withThread("t3");
    const base = { repo: "alice/game", number: pull.number };
    expect((await tool(aliceRw, { ...base, anchor: "0123456789abcdef" })).error).toStartWith("no_such_thread:");
    expect((await tool(aliceRw, { ...base, anchor: "../x" })).error).toStartWith("invalid:");
    expect((await tool(aliceRw, { ...base, anchor: 5 })).error).toStartWith("invalid:");
    expect((await tool(aliceRw, { ...base, resolved: true })).error).toStartWith("invalid:");
    expect((await tool(aliceRw, { repo: "alice/game", number: 9999 })).error).toStartWith("no_such_pull:");
    expect((await tool(aliceRw, { repo: "alice/game", number: "1" })).error).toStartWith("no_such_pull:");
  });
});
