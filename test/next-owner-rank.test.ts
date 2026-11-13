/** A row a person ranked is the owner's: marked on /next, left alone by automatic ranking (#11753). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { rankIssue } from "../src/actions/next.ts";
import { createRepo } from "../src/actions/repos.ts";
import { ranksInRepo, writeOrder } from "../src/core/rank.ts";
import type { Repo } from "../src/core/repos.ts";
import { createSession } from "../src/core/sessions.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";

let dir: string;
let app: App;
let servers: Servers;
let cookie: string;
let alice: User;
let repo: Repo;
const ids: string[] = [];
const nums: number[] = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-owner-rank-"));
  app = createApp({ dataDir: dir, port: 0 });
  servers = await serve(app);
  const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  if (!made.ok) throw new Error(made.error);
  alice = made.value;
  cookie = `forge_session=${createSession(app.db, alice.id).token}`;
  const r = await createRepo(app, alice, { name: "own", visibility: "public" });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  repo = r.value;
  for (let i = 1; i <= 4; i++) {
    const o = openIssue(app, alice, repo, { title: `Issue ${i}` });
    if (!o.ok) throw new Error(String(o.error));
    ids.push(o.value.id);
    nums.push(o.value.number);
  }
});

afterAll(async () => {
  await servers.stop();
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const order = () => [...ranksInRepo(app.db, repo.id).places].sort((a, b) => a[1] - b[1]).map(([id]) => id);

test("a person's move is stored as the owner's, and survives a planner pass", () => {
  expect(rankIssue(app, alice, repo, nums[2]!, { to: "top" }).ok).toBe(true);
  expect(ranksInRepo(app.db, repo.id).owners).toEqual(new Set([ids[2]!]));
  // A planner pass over the same issues, trying to put the owner's row last.
  app.db.transaction(() => {
    writeOrder(app.db, repo, [ids[0]!, ids[1]!, ids[2]!], "planner", undefined, { owner: false });
  })();
  expect(order()).toEqual([ids[2]!, ids[0]!, ids[1]!]);
  expect(ranksInRepo(app.db, repo.id).owners).toEqual(new Set([ids[2]!]));
});

test("a planner's own rank is still re-ranked", () => {
  app.db.transaction(() => {
    writeOrder(app.db, repo, [ids[1]!, ids[0]!, ids[2]!], "planner", undefined, { owner: false });
  })();
  expect(order()).toEqual([ids[2]!, ids[1]!, ids[0]!]);
  expect(ranksInRepo(app.db, repo.id).owners.has(ids[1]!)).toBe(false);
});

test("a later person's move of another row does not make the planner's rows the owner's", () => {
  expect(rankIssue(app, alice, repo, nums[3]!, { to: "top" }).ok).toBe(true);
  expect(ranksInRepo(app.db, repo.id).owners).toEqual(new Set([ids[2]!, ids[3]!]));
  expect(order()[0]).toBe(ids[3]!);
});

test("only the owner's rows wear the mark", async () => {
  const page = await (await fetch(`${servers.url}/alice/own/next`, { headers: { cookie } })).text();
  const rows = page.split("<li").filter((c) => /data-number="\d+"/.test(c));
  const marked = rows.filter((c) => c.includes('class="mine"')).map((c) => Number(/data-number="(\d+)"/.exec(c)![1]));
  expect(marked.sort()).toEqual([nums[2]!, nums[3]!].sort());
  expect(rows.length).toBeGreaterThan(marked.length);
});
