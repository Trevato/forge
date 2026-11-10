/** An approved pull says when it will land, on its page and in the `pull` tool (#10860): a fixed queue and pace. */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { addToCrew, createAgent } from "../src/actions/crew.ts";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { submitReview } from "../src/core/reviews.ts";
import { createToken } from "../src/core/tokens.ts";
import type { Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, getUserByName, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

const PASSWORD = "a-long-step-passphrase";

let dataDir = "";
let app: App;
let servers: Servers;
let alice: User;
let cookie = "";
let repo: Repo;
let pull: Pull;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-landing-line-"));
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
  await createAgent(app, alice, { username: "bot" });
  const made = await createRepo(app, alice, { name: "site", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  await commitToBranch(app, alice, repo, { message: "seed", files: [{ path: "README.md", content: "# site\n" }] });
  addToCrew(app, alice, repo, "bot");
  await commitToBranch(app, alice, repo, {
    branch: "bot/1",
    base: "main",
    message: "Tidy",
    files: [{ path: "F.md", content: "1\n" }],
  });
  const opened = await openPull(app, getUserByName(app.db, "bot")!, repo, {
    title: "Tidy the footer",
    body: "",
    baseBranch: "main",
    headBranch: "bot/1",
  });
  if (!opened.ok) throw new Error(String(opened.error));
  pull = opened.value;
}, 30_000);

afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const LINE = "first in the queue: lands in about 15 min";

async function pageLine(): Promise<string> {
  const res = await fetch(`${servers.url}/alice/site/pulls/${pull.number}`, { headers: { cookie } });
  const m = /data-landing-eta>([^<]*)</.exec(await res.text());
  return m === null ? "" : m[1]!.trim();
}

async function tool(): Promise<{ eta: { minutes: number | null; says: string } | null }> {
  const res = await fetch(`${servers.url}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${createToken(app.db, alice.id, "t", "ro").token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "pull", arguments: { repo: "alice/site", number: pull.number } },
    }),
  });
  return JSON.parse(((await res.json()) as any).result.content[0].text);
}

test("an unapproved pull says nothing about landing", async () => {
  expect(await pageLine()).toBe("");
  expect((await tool()).eta).toBeNull();
});

test("an approved pull says its place and pace on the page and in the tool", async () => {
  // A fixed pace: nothing landed in the last hour, one gate of 14 min.
  const end = new Date(Date.now() - 10 * 60_000);
  app.db
    .query("INSERT INTO check_gate (id, repo_id, started_at, finished_at) VALUES ('g1', ?1, ?2, ?3)")
    .run(repo.id, new Date(end.getTime() - 14 * 60_000).toISOString(), end.toISOString());
  const r = submitReview(app.db, {
    issueId: pull.id,
    authorId: alice.id,
    state: "approved",
    commitOid: pull.headOid,
  } as Parameters<typeof submitReview>[1]);
  expect(r.ok).toBe(true);
  expect(await pageLine()).toBe(LINE);
  const eta = (await tool()).eta;
  expect(eta).toEqual({ minutes: 14, says: LINE });
});
