/** A tell carries the page it was told from (#1625). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { setIssueState } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import { parseFrom } from "../src/actions/tell_from.ts";
import { tell } from "../src/actions/tell.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { getIssue, listIssues } from "../src/core/issues.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dir: string;
let app: App;
let servers: Servers;
let alice: User;
let repo: Repo;
let token: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-tellfrom-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const u = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: "a-good-passphrase",
    adminIfFirst: true,
  });
  if (!u.ok) throw new Error(u.error);
  alice = u.value;
  const r = await createRepo(app, alice, { name: "notes", visibility: "public" });
  if (!r.ok) throw new Error(String(r.error));
  repo = r.value;
  token = createToken(app.db, alice.id, "rw", "rw").token;
});

afterAll(async () => {
  await servers.stop();
  await rm(dir, { recursive: true, force: true });
});

/** Close what a test opened, so nothing is left asking. */
function close(numbers: readonly number[]): void {
  for (const n of numbers) {
    const i = getIssue(app.db, repo.id, n);
    if (i) setIssueState(app, alice, repo, i, "closed");
  }
}

describe("parseFrom", () => {
  test("takes same-forge paths and nothing else", () => {
    expect(parseFrom(undefined)).toBeNull();
    expect(parseFrom("/alice/notes/pulls/3")).toBe("/alice/notes/pulls/3");
    for (const bad of [
      "https://evil.example/x",
      "//evil.example",
      "javascript:alert(1)",
      "alice/notes",
      "",
      "/a b",
      "/a)(b",
      "/*x*",
      "/a\\b",
      "/" + "x".repeat(512),
      42,
    ])
      expect(parseFrom(bad)).toBeUndefined();
    expect(parseFrom("/" + "x".repeat(511))).toBeDefined();
  });
});

describe("tell with from", () => {
  test("the issue says where it was told from", async () => {
    const t = await tell(app, alice, repo, "Make it purple", 1, "/alice/notes/pulls/3");
    expect(t.ok).toBe(true);
    if (!t.ok) return;
    expect(t.value.issue.body).toContain("Told from [/alice/notes/pulls/3](/alice/notes/pulls/3)");
    close([t.value.issue.number]);
  });
  test("a bad from opens nothing", async () => {
    const t = await tell(app, alice, repo, "Hi", 1, "https://evil.example");
    expect(t.ok).toBe(false);
  });
  test("the API refuses a bad from and accepts a good one", async () => {
    const post = (from: unknown) =>
      fetch(`${servers.url}/api/v1/feed/tells`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ app: "alice/notes", text: "Via API", from }),
      });
    const bad = await post("https://evil.example/");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("invalid_from");
    const good = await post("/alice/notes");
    expect(good.status).toBe(201);
    close([((await good.json()) as { issue: number }).issue]);
  });
  test("the MCP tool refuses a bad from and accepts a good one", async () => {
    const call = async (from: string) => {
      const res = await fetch(`${servers.url}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "tell", arguments: { repo: "alice/notes", text: "Via MCP", from } },
        }),
      });
      return (await res.json()) as {
        result: { isError?: boolean; content: { text: string }[] };
      };
    };
    const bad = await call("http://evil.example");
    expect(bad.result.isError).toBe(true);
    expect(bad.result.content[0]!.text).toContain("from is a path");
    const good = await call("/alice/notes/issues");
    expect(good.result.isError).toBeFalsy();
    close([(JSON.parse(good.result.content[0]!.text) as { issue: number }).issue]);
  });
});

describe("tell from a page, through the box", () => {
  test("the palette offers the page it is on, and the tell remembers it", async () => {
    const made = insertApp(app.db, { repoId: repo.id, slug: "notes", access: "private" });
    expect(made.ok).toBe(true);
    const auth = { authorization: `Bearer ${token}` };
    // The palette's row carries this page's path as `from`.
    const pageRes = await fetch(`${servers.url}/alice/notes/files`, { headers: auth });
    const html = await pageRes.text();
    expect(html).toContain("/alice/notes/tell?from=%2Falice%2Fnotes%2Ffiles");
    // On the app's own page it stays the box already there.
    const home = await (await fetch(`${servers.url}/alice/notes`, { headers: auth })).text();
    expect(home).toContain("/alice/notes#tell");
    // Posting through the box (as the in-place script does) opens the issue
    // with `from`, answers JSON, and does not redirect.
    const told = await fetch(`${servers.url}/alice/notes/tell`, {
      method: "POST",
      headers: { ...auth, accept: "application/json" },
      body: new URLSearchParams({ text: "Make this purple", from: "/alice/notes/files" }),
      redirect: "manual",
    });
    expect(told.status).toBe(200);
    expect(((await told.json()) as { ok: boolean }).ok).toBe(true);
    const issue = listIssues(app.db, repo.id, {}).find((i) => i.title === "Make this purple");
    expect(issue?.body).toContain("Told from [/alice/notes/files](/alice/notes/files)");
    close([issue!.number]);
    // Without a script it lands back on the page it was told from.
    const plain = await fetch(`${servers.url}/alice/notes/tell`, {
      method: "POST",
      headers: auth,
      body: new URLSearchParams({ text: "And again", from: "/alice/notes/files" }),
      redirect: "manual",
    });
    expect(plain.status).toBe(303);
    expect(plain.headers.get("location")).toContain("/alice/notes/files");
    // A foreign `from` is no place to go back to.
    const evil = await fetch(`${servers.url}/alice/notes/tell`, {
      method: "POST",
      headers: auth,
      body: new URLSearchParams({ text: "Third", from: "https://evil.example/" }),
      redirect: "manual",
    });
    expect(evil.headers.get("location")).not.toContain("evil.example");
    close(listIssues(app.db, repo.id, {}).map((i) => i.number));
  });
});
