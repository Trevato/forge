/** Every move on /next is one audit entry: who, what, where to and where from; a refused move writes none (#11754). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { rankIssue } from "../src/actions/next.ts";
import { createRepo } from "../src/actions/repos.ts";
import { eventVerb } from "../src/design/activity.ts";
import { listEvents } from "../src/core/events.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";

let dir: string;
let app: App;
let alice: User;
let bob: User;
let repo: Repo;
const n: number[] = [];

const entries = () => listEvents(app.db, { repoId: repo.id, kind: "issue.ranked", limit: 100 });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-next-audit-"));
  app = createApp({ dataDir: dir, port: 0 });
  const a = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@forge.local", password: "a-good-passphrase", adminIfFirst: true });
  const b = await createUser(app.db, { origin: "seed", trusted: true, username: "bob", email: "bob@forge.local", password: "a-good-passphrase" });
  if (!a.ok || !b.ok) throw new Error("users");
  alice = a.value;
  bob = b.value;
  const r = await createRepo(app, alice, { name: "audit", visibility: "public" });
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  repo = r.value;
  const gate = openIssue(app, alice, repo, { title: "Later gate: not now" });
  if (!gate.ok) throw new Error(String(gate.error));
  for (let i = 1; i <= 3; i++) {
    const o = openIssue(app, alice, repo, { title: `Issue ${i}` });
    if (!o.ok) throw new Error(String(o.error));
    n.push(o.value.number);
  }
});

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("a move writes exactly one entry with who, what, where to and where from, and nothing else", () => {
  const before = entries().length;
  expect(rankIssue(app, alice, repo, n[2]!, { to: "top" }).ok).toBe(true);
  const made = entries();
  expect(made.length).toBe(before + 1);
  const e = made[0]!;
  expect(e.actorId).toBe(alice.id);
  expect(e.payload).toEqual({ number: n[2]!, to: "top", from: 3 });
  expect(eventVerb(e)).toContain(`#${n[2]} is on top.`);
});

test("a place under another row is named, and the position it left", () => {
  expect(rankIssue(app, alice, repo, n[2]!, { to: "after", number: n[1]! }).ok).toBe(true);
  const e = entries()[0]!;
  expect(e.payload).toEqual({ number: n[2]!, to: "after", after: n[1]!, from: 1 });
  expect(eventVerb(e)).toContain(`#${n[2]} moved under #${n[1]}.`);
});

test("not now is one entry too", () => {
  expect(rankIssue(app, alice, repo, n[0]!, { to: "not_now" }).ok).toBe(true);
  expect(entries()[0]!.payload).toMatchObject({ number: n[0]!, to: "not_now" });
});

test("a forbidden, missing or invalid move writes none", () => {
  const before = entries().length;
  expect(rankIssue(app, bob, repo, n[1]!, { to: "top" }).ok).toBe(false);
  expect(rankIssue(app, alice, repo, 9999, { to: "top" }).ok).toBe(false);
  expect(rankIssue(app, alice, repo, n[1]!, { to: "after", number: 9999 }).ok).toBe(false);
  expect(rankIssue(app, alice, repo, n[0]!, { to: "not_now" }).ok).toBe(false);
  expect(entries().length).toBe(before);
});
