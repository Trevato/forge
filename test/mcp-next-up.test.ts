/** `next_up` over MCP: the ranked list, and the same one-action moves as the page. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { createToken } from "../src/core/tokens.ts";
import { readyNow, repoGraph } from "../src/core/dependencies.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { inSlotOrder } from "../src/crew/autonomy.ts";
import { serve, type Servers } from "../src/http/server.ts";

describe("next_up over MCP", () => {
  let dataDir: string;
  let app: App;
  let servers: Servers;
  let rw: string;
  let ro: string;
  let id = 1;
  const numbers: number[] = [];
  let alice: User;

  const tool = async (token: string, args: unknown) => {
    const res = await fetch(`${servers.url}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name: "next_up", arguments: args } }),
    });
    const body = (await res.json()) as any;
    const text: string = body.result.content[0].text;
    return body.result.isError === true ? { error: text } : { value: JSON.parse(text) };
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-mcp-next-up-"));
    app = createApp({ dataDir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!made.ok) throw new Error(made.error);
    alice = made.value;
    const repo = await createRepo(app, alice, { name: "game", visibility: "public" });
    if (!repo.ok) throw new Error(String(repo.error));
    insertApp(app.db, { repoId: repo.value.id, slug: "game", access: "private" });
    for (const title of ["One", "Two", "Three"]) {
      const o = openIssue(app, alice, repo.value, { title });
      if (!o.ok) throw new Error(String(o.error));
      numbers.push(o.value.number);
    }
    rw = createToken(app.db, alice.id, "rw", "rw").token;
    ro = createToken(app.db, alice.id, "ro", "ro").token;
  });

  afterAll(async () => {
    await servers.stop();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("a writer moves an issue to the top and the list answers in the new order", async () => {
    const moved = await tool(rw, { app: "alice/game", issue: numbers[2], to: "top" });
    expect(moved.value.next[0].issue).toBe(numbers[2]);
    expect(moved.value.next[0].place).toBe(1);
  });

  test("a read-only token reads the list and cannot move", async () => {
    expect((await tool(ro, { app: "alice/game" })).value.next[0].issue).toBe(numbers[2]);
    expect((await tool(ro, { app: "alice/game", issue: numbers[0], to: "top" })).error).toBeDefined();
  });

  test("bad input is refused at the boundary", async () => {
    expect((await tool(rw, { app: "alice/game", issue: numbers[0], to: "sideways" })).error).toBeDefined();
    expect((await tool(rw, { app: "alice/game", issue: 9999, to: "top" })).error).toBeDefined();
  });

  /** A repository of its own, so this order touches no rank the tests above rely on. */
  async function orderRepo(): Promise<{ repo: Repo; numbers: number[] }> {
    const made = await createRepo(app, alice, { name: "order", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    insertApp(app.db, { repoId: made.value.id, slug: "order", access: "private" });
    const numbers: number[] = [];
    for (const title of ["One", "Two", "Three", "Four", "A test pins five"]) {
      const o = openIssue(app, alice, made.value, { title });
      if (!o.ok) throw new Error(String(o.error));
      numbers.push(o.value.number);
    }
    return { repo: made.value, numbers };
  }

  const listed = async (): Promise<number[]> => {
    const answer = await tool(rw, { app: "alice/order", all: true });
    return (answer.value.next as { issue: number }[]).map((r) => r.issue);
  };

  const picked = (repo: Repo, slots: number): number[] =>
    inSlotOrder(app, repo, readyNow(repoGraph(app.db, repo.id, { sealed: true })), [], slots).map((r) => r.issue.number);

  test("the list lists the order the picker starts in, ranked first and then the rest, and a ranked small issue survives a full small share", async () => {
    const { repo, numbers } = await orderRepo();
    // Rank two (the fourth ends on top, the third below it); three stay unranked.
    await tool(rw, { app: "alice/order", issue: numbers[2], to: "top" });
    await tool(rw, { app: "alice/order", issue: numbers[3], to: "top" });
    const before = await listed();
    expect(before.slice(0, 2)).toEqual([numbers[3]!, numbers[2]!]);
    expect(picked(repo, 5)).toEqual(before);
    // With no small slot at all, the unranked small issue is dropped; ranking it keeps it, in its place.
    expect(picked(repo, 0)).toEqual(before.filter((n) => n !== numbers[4]));
    await tool(rw, { app: "alice/order", issue: numbers[4], to: "top" });
    const after = await listed();
    expect(after[0]).toBe(numbers[4]!);
    expect(picked(repo, 0)).toEqual(after);
  });
});
