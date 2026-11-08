/**
 * The `labels` tool is the page's labels form over MCP: the same action, so
 * the same gate. A writer sets them, a reader is told what the page says,
 * and bad input stops at the boundary.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createIssue, createLabel, listLabels } from "../src/core/issues.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

describe("MCP labels", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let alice: User;
  let aliceRw: string;
  let bobRw: string;
  let number: number;
  let id = 1;

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
        id: id++,
        method: "tools/call",
        params: { name: "labels", arguments: args },
      }),
    });
    const body: any = await res.json();
    const text: string = body.result.content[0].text;
    return body.result.isError === true
      ? { error: text }
      : { value: JSON.parse(text) };
  };
  const names = () =>
    listLabels(app.db, repoId)
      .map((l) => l.name)
      .sort();
  let repoId: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-labels-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const a = await createUser(app.db, { origin: "seed", trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    alice = a.value;
    const b = await createUser(app.db, { origin: "seed", trusted: true,
      username: "bob",
      email: "bob@forge.local",
      password: "a-good-passphrase",
    });
    if (!b.ok) throw new Error(b.error);
    promote(app.db, b.value);
    aliceRw = createToken(app.db, alice.id, "rw", "rw").token;
    bobRw = createToken(app.db, b.value.id, "rw", "rw").token;
    const made = await createRepo(app, alice, { name: "game", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repoId = made.value.id;
    createLabel(app.db, repoId, "bug", "d73a4a");
    createLabel(app.db, repoId, "ui", "0075ca");
    const issue = createIssue(app.db, { repoId, authorId: alice.id, title: "Sort it" });
    if (!issue.ok) throw new Error(issue.error);
    number = issue.value.number;
  }, 30_000);

  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  const issueLabels = (token = aliceRw) =>
    tool(token, { repo: "alice/game", number, labels: [] });

  test("a writer sets and clears them, and the answer is brief with the URL", async () => {
    const set = await tool(aliceRw, { repo: "alice/game", number, labels: ["bug", "ui"] });
    expect(set.value.labels.sort()).toEqual(["bug", "ui"]);
    expect(set.value.says).toContain(`#${number}`);
    expect(set.value.url).toEndWith(`/alice/game/issues/${number}`);
    const one = await tool(aliceRw, { repo: "alice/game", number, labels: ["ui"] });
    expect(one.value.labels).toEqual(["ui"]);
    const cleared = await issueLabels();
    expect(cleared.value.labels).toEqual([]);
    expect(cleared.value.says).toContain("Cleared");
  });

  test("a label the repository does not have is refused with the page's words", async () => {
    const r = await tool(aliceRw, { repo: "alice/game", number, labels: ["nope"] });
    expect(r.error).toContain("One of those labels no longer exists.");
  });

  test("a reader is refused with the page's words and nothing changes", async () => {
    await tool(aliceRw, { repo: "alice/game", number, labels: ["ui"] });
    const r = await tool(bobRw, { repo: "alice/game", number, labels: ["bug"] });
    expect(r.error).toContain("You need write access to change labels.");
    const after = await tool(aliceRw, { repo: "alice/game", number, labels: ["ui"] });
    expect(after.value.labels).toEqual(["ui"]);
    expect(names()).toEqual(["bug", "ui"]);
  });

  test("`add` and `remove` change only the named labels; `flow` is made on first add, by a writer only", async () => {
    await issueLabels();
    expect((await tool(bobRw, { repo: "alice/game", number, labels: ["flow"], action: "add" })).error).toContain(
      "You need write access",
    );
    expect(names()).toEqual(["bug", "ui"]);
    await tool(aliceRw, { repo: "alice/game", number, labels: ["ui"] });
    const added = await tool(aliceRw, { repo: "alice/game", number, labels: ["flow"], action: "add" });
    expect(added.value.labels.sort()).toEqual(["flow", "ui"]);
    expect(names()).toEqual(["bug", "flow", "ui"]);
    const removed = await tool(aliceRw, { repo: "alice/game", number, labels: ["FLOW"], action: "remove" });
    expect(removed.value.labels).toEqual(["ui"]);
    expect((await tool(aliceRw, { repo: "alice/game", number, labels: [], action: "toggle" })).error).toContain(
      "action is set, add or remove",
    );
  });

  test("bad input stops at the boundary", async () => {
    for (const labels of ["bug", [1], [{}], null, Array(51).fill("a"), ["x".repeat(65)]]) {
      const r = await tool(aliceRw, { repo: "alice/game", number, labels });
      expect(r.error).toContain("labels is a list");
    }
    expect((await tool(aliceRw, { repo: "alice/game", number: 999, labels: [] })).error).toContain("no issue #999");
    expect((await tool(aliceRw, { repo: "alice/game", number: "1", labels: [] })).error).toContain("no issue");
  });
});
