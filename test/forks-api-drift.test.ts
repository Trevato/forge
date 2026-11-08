/** The forks API list gives each fork's drift and the parent, as the forks page does. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitToBranch, createRepo, forkRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { promote } from "./helpers/members.ts";

let dataDir = "";
let app: App, servers: Servers;

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-fkdrift-"));
  app = createApp({ dataDir, port: 0 });
  servers = await serve(app);
});
afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("a fork one commit ahead reads ahead 1, behind 0, with the parent named", async () => {
  const mk = async (username: string) => {
    const r = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@f.dev`, password: "a-good-passphrase", adminIfFirst: username === "alice" });
    if (!r.ok) throw new Error("user");
    promote(app.db, r.value);
    return r.value;
  };
  const alice = await mk("alice");
  const bob = await mk("bob");
  const made = await createRepo(app, alice, { name: "app", visibility: "public" });
  if (!made.ok) throw new Error("repo");
  await commitToBranch(app, alice, made.value, { message: "one", files: [{ path: "a.txt", content: "x\n" }] });
  const fork = await forkRepo(app, bob, made.value);
  if (!fork.ok) throw new Error("fork");
  await commitToBranch(app, bob, fork.value, { message: "two", files: [{ path: "b.txt", content: "y\n" }] });
  const res = await fetch(`${servers.url}/api/v1/repos/alice/app/forks`);
  const page = (await res.json()) as { parent: string | null; items: { id: string; name: string; ahead: number | null; behind: number | null; updatedAt: string | null }[]; next_cursor: string | null };
  expect(res.status).toBe(200);
  expect(page.items.length).toBe(1);
  expect(page.items[0]!.name).toBe("app");
  expect(page.items[0]!.ahead).toBe(1);
  expect(page.items[0]!.behind).toBe(0);
  expect(page.items[0]!.updatedAt).not.toBeNull();
  expect(page.next_cursor).toBeNull();
  expect(page.parent).toBeNull(); // the source itself has no parent
  const names = (res.headers.get("server-timing") ?? "").split(", ").map((p) => p.split(";")[0]!).filter((n) => n !== "app");
  expect(names).toEqual(["session", "forks", "drift", "render"]);
  const down = await fetch(`${servers.url}/api/v1/repos/bob/app/forks`);
  expect(((await down.json()) as { parent: string | null }).parent).toBe("alice/app");
});

test("drift is read for the page being answered, not for every fork", async () => {
  const { spyOn } = await import("bun:test");
  const forksMod = await import("../src/actions/forks.ts");
  const mk = async (username: string) => {
    const r = await createUser(app.db, { origin: "seed", trusted: true, username, email: `${username}@f.dev`, password: "a-good-passphrase" });
    if (!r.ok) throw new Error("user");
    promote(app.db, r.value);
    return r.value;
  };
  const carol = await mk("carol");
  const dan = await mk("dan");
  const erin = await mk("erin");
  const made = await createRepo(app, carol, { name: "lib", visibility: "public" });
  if (!made.ok) throw new Error("repo");
  await commitToBranch(app, carol, made.value, { message: "one", files: [{ path: "a.txt", content: "x\n" }] });
  for (const [who, n] of [[dan, 1], [erin, 2]] as const) {
    const f = await forkRepo(app, who, made.value);
    if (!f.ok) throw new Error("fork");
    for (let i = 0; i < n; i++)
      await commitToBranch(app, who, f.value, { message: `m${i}`, files: [{ path: `f${i}.txt`, content: "y\n" }] });
  }
  const spy = spyOn(forksMod, "driftOfForks");
  type Page = { items: { id: string; ownerName: string; ahead: number | null }[]; next_cursor: string | null };
  const get = async (q: string) => (await (await fetch(`${servers.url}/api/v1/repos/carol/lib/forks?${q}`)).json()) as Page;
  const first = await get("limit=1");
  const readFirst = spy.mock.calls.flatMap((c) => c[2].map((f) => f.id));
  expect(first.items.length).toBe(1);
  expect(first.next_cursor).toBe(first.items[0]!.id);
  expect(readFirst).toEqual([first.items[0]!.id]);
  spy.mockClear();
  const second = await get(`limit=1&cursor=${first.next_cursor}`);
  const readSecond = spy.mock.calls.flatMap((c) => c[2].map((f) => f.id));
  spy.mockRestore();
  expect(second.items.length).toBe(1);
  expect(second.next_cursor).toBeNull();
  expect(readSecond).toEqual([second.items[0]!.id]);
  expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
  expect([first.items[0]!.ahead, second.items[0]!.ahead].sort()).toEqual([1, 2]);
});
