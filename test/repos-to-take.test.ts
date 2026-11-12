/** The new-forge picker lists each repository once, as its source (#11623). */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo, forkRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createApp as createAppRecord } from "../src/core/apps.ts";
import { createAgentRow } from "../src/core/agents.ts";
import { getRepo, listReposToTake, moveArchived } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { pickList } from "../src/web/pick.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dir = "";
let app: App;
let alice: User;
const agents: User[] = [];

async function user(username: string): Promise<User> {
  const u = await createUser(app.db, {
    origin: "seed", trusted: true, username, email: `${username}@x.test`, password: "a-long-take-passphrase", isAdmin: true,
  });
  if (!u.ok) throw new Error("user");
  return u.value;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-take-"));
  app = createApp({ dataDir: dir, url: "https://forge.test", port: 0 });
  alice = await user("alice");
  const r = await createRepo(app, alice, { name: "notes", visibility: "public" });
  if (!r.ok) throw new Error("repo");
  await createRepo(app, alice, { name: "secret", visibility: "private" });
  for (const n of ["a1", "a2", "a3", "a4"]) {
    const a = await user(n);
    createAgentRow(app.db, { userId: a.id, roles: ["builder"] });
    agents.push(a);
    const f = await forkRepo(app, a, r.value, "notes", { now: Date.now() + 3_600_000 });
    if (!f.ok) throw new Error(`fork ${n}: ${f.error}`);
  }
}, 60_000);

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

test("one source repository and four agent forks of it show one row", () => {
  const rows = listReposToTake(app.db, alice);
  expect(rows.map((r) => `${r.ownerName}/${r.name}`)).toEqual(["alice/notes"]);
});

test("a visitor with no account is offered no repositories", () => {
  expect(listReposToTake(app.db, undefined)).toEqual([]);
});

test("another person's public repository with no app is not offered", async () => {
  const bob = await user("bob");
  await createRepo(app, bob, { name: "plain", visibility: "public" });
  expect(listReposToTake(app.db, alice).some((r) => r.ownerName === "bob")).toBe(false);
});

test("a short list is drawn plain, a long one gets the filter", () => {
  const items = (n: number) => Array.from({ length: n }, (_, i) => ({ value: `a/${i}`, label: `a/${i}` }));
  expect(String(pickList({ legend: "L", name: "apps", items: items(10), chosen: [], plainUpTo: 10 }))).toContain("data-pick-plain");
  expect(String(pickList({ legend: "L", name: "apps", items: items(11), chosen: [], plainUpTo: 10 }))).not.toContain("data-pick-plain");
});

const names = (rows: ReturnType<typeof listReposToTake>): string[] => rows.map((r) => `${r.ownerName}/${r.name}`);

async function appRepo(owner: User, name: string): Promise<string> {
  const r = await createRepo(app, owner, { name, visibility: "public" });
  if (!r.ok) throw new Error(`repo ${r.error}`);
  const a = createAppRecord(app.db, { repoId: r.value.id, slug: `${owner.username}-${name}`, access: "private" });
  if (!a.ok) throw new Error("app");
  return r.value.id;
}

test("another person's public source repository with an app is offered, after the viewer's own", async () => {
  const carol = await user("carol");
  await appRepo(carol, "tool");
  const rows = names(listReposToTake(app.db, alice));
  expect(rows).toContain("carol/tool");
  expect(rows.indexOf("alice/notes")).toBeLessThan(rows.indexOf("carol/tool"));
});

test("an archived repository is dropped", async () => {
  const dan = await user("dan");
  const id = await appRepo(dan, "old");
  expect(names(listReposToTake(app.db, alice))).toContain("dan/old");
  expect(moveArchived(app.db, id, true)).toBeTruthy();
  expect(names(listReposToTake(app.db, alice))).not.toContain("dan/old");
});

test("a fork of a listed non-agent parent is dropped, and the limit counts only shown rows", async () => {
  const erin = await user("erin");
  const parent = await appRepo(erin, "base");
  const fk = await user("frank");
  const src = getRepo(app.db, "erin", "base");
  if (src === undefined) throw new Error("src");
  const f = await forkRepo(app, fk, src, "base");
  if (!f.ok) throw new Error("fork");
  // The fork's owner is the viewer: it would be listed on its own, but its parent is listed.
  expect(parent).toBeTruthy();
  const rows = names(listReposToTake(app.db, fk));
  expect(rows).toContain("erin/base");
  expect(rows).not.toContain("frank/base");
  // With a limit of one, the parent is never cut off while the fork stays.
  expect(names(listReposToTake(app.db, fk, 1))).toEqual(["erin/base"]);
});
