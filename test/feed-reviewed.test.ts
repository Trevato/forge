/** A reviewed-pull post says the verdict and the reviewer's first sentence (#5823). */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull, submitReview } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import type { Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { candidatesFor } from "../src/feed/items.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-long-reviewed-passphrase";
const APPROVED = "approved Tidy the footer";
const CHANGES = "asked for changes on Widen the board: The migration drops a column people use.";

let dataDir = "";
let app: App;
let servers: Servers;
let alice: User;
let cookie = "";
let token = "";
let repo: Repo;
let n = 0;

const pull = async (title: string): Promise<Pull> => {
  n++;
  await commitToBranch(app, alice, repo, {
    branch: `bot/${n}`,
    base: "main",
    message: title,
    files: [{ path: `F${n}.md`, content: `${n}\n` }],
  });
  const opened = await openPull(app, getUserByName(app.db, "bot")!, repo, {
    title,
    body: "",
    baseBranch: "main",
    headBranch: `bot/${n}`,
  });
  if (!opened.ok) throw new Error(String(opened.error));
  return opened.value;
};

/** The fold appends " · opened …, 1 review" (#5808); the verdict is what comes before it. */
const said = (what: string): string => what.split(" · ")[0]!;

const mcpFeed = async (): Promise<string[]> => {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "feed", arguments: {} },
    }),
  });
  const body = (await res.json()) as { result: { content: { text: string }[] } };
  const text = body.result.content[0]!.text;
  return (JSON.parse(text) as { items: { what: string }[] }).items.map((i) => said(i.what));
};

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-feed-reviewed-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
  const a = await createUser(app.db, {
    origin: "seed",
    trusted: true,
    username: "alice",
    email: "alice@forge.local",
    password: PASSWORD,
    adminIfFirst: true,
  });
  if (!a.ok) throw new Error(a.error);
  alice = a.value;
  const res = await fetch(`${servers.url}/signin`, {
    method: "POST",
    body: new URLSearchParams({ username: "alice", password: PASSWORD }),
    redirect: "manual",
  });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
  token = createToken(app.db, alice.id, "ro", "ro").token;
  await createAgent(app, alice, { username: "bot" });
  const made = await createRepo(app, alice, { name: "site", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  await commitToBranch(app, alice, repo, {
    message: "seed",
    files: [{ path: "README.md", content: "# site\n" }],
  });
  addToCrew(app, alice, repo, "bot");
}, 30_000);

afterAll(async () => {
  await servers.stop();
  await rm(dataDir, { recursive: true, force: true });
});

test("each verdict is said in the post, asked-for-changes first, on / and in the MCP feed", async () => {
  const ok = await pull("Tidy the footer");
  const bad = await pull("Widen the board");
  // The approval is the later event, so recency alone would put it first.
  const asked = await submitReview(app, alice, repo, bad, {
    state: "changes_requested",
    body: "The migration drops a column people use. Please keep it.",
  });
  expect(asked.ok).toBe(true);
  const approved = await submitReview(app, alice, repo, ok, { state: "approved" });
  expect(approved.ok).toBe(true);

  const posts = candidatesFor(app.db, alice, Date.now())
    .map((c) => said(c.what))
    .filter((w) => w.startsWith("approved ") || w.startsWith("asked for changes"));
  expect(posts.sort()).toEqual([APPROVED, CHANGES].sort());

  const home = await fetch(`${servers.url}/feed`, { headers: { cookie } });
  const html = (await home.text()).replace(/\s+/g, " ");
  const at = (s: string): number => html.indexOf(s);
  expect(at(APPROVED)).toBeGreaterThan(-1);
  expect(at(CHANGES)).toBeGreaterThan(-1);
  expect(at(CHANGES)).toBeLessThan(at(APPROVED));

  const rows = (await mcpFeed()).filter((w) => w === APPROVED || w === CHANGES);
  expect(rows).toEqual([CHANGES, APPROVED]);
});

test("a review that is gone, or has no verdict, keeps the old words", async () => {
  const gone = await pull("Remove the banner");
  const given = await submitReview(app, alice, repo, gone, { state: "approved" });
  if (!given.ok) throw new Error(given.error);
  app.db.run("DELETE FROM review WHERE id = ?1", [given.value.id]);
  const note = await pull("Explain the banner");
  expect((await submitReview(app, alice, repo, note, { state: "commented", body: "Hm." })).ok).toBe(true);
  const words = candidatesFor(app.db, alice, Date.now()).map((c) => said(c.what));
  expect(words).toContain("reviewed a pull request: Remove the banner");
  expect(words).toContain("reviewed a pull request: Explain the banner");
});
