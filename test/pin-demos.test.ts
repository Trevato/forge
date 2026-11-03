/**
 * A pin's demo (src/actions/pin_demos.ts): defaults from a label and pages,
 * the facts a pinned commit's forge.json names, and who may save one.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { demoDefaults, demoFactsAt, saveDemo } from "../src/actions/pin_demos.ts";
import { pinBuild } from "../src/actions/builds.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { getRepo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { launchOf, readBuildPin } from "../src/git/builds.ts";
import { repoDir } from "../src/git/repos.ts";

let dataDir: string;
let app: App;
let alice: User;
let bob: User;
let oid: string;
const fresh = () => getRepo(app.db, "alice", "game")!;
const input = { name: "Game", version: "v1", page: "/", showcase: false, launch: "env" as const };

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-pin-demos-"));
  app = createApp({ dataDir, port: 0 });
  const users: User[] = [];
  for (const name of ["alice", "bob"]) {
    const made = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: name,
      email: `${name}@forge.local`,
      password: "a-good-passphrase",
      adminIfFirst: name === "alice",
    });
    if (!made.ok) throw new Error(made.error);
    users.push(made.value);
  }
  [alice, bob] = users as [User, User];
  const made = await createRepo(app, alice, { name: "game", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  const forgeJson = JSON.stringify({ app: { run: "bun run x.ts", pages: ["/", "/spicy"], launch: "file" } });
  const c = await commitToBranch(app, alice, fresh(), {
    branch: "main",
    message: "one",
    files: [{ path: "forge.json", content: forgeJson }, { path: "x.ts", content: "\n" }],
  });
  if (!c.ok) throw new Error(JSON.stringify(c.error));
  oid = c.value.commitOid;
  const pinned = await pinBuild(app, alice, fresh(), { oid, label: "v1" });
  if (!pinned.ok) throw new Error(String(pinned.error));
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

test("demoDefaults names a demo from a label and the first page", () => {
  expect(demoDefaults(fresh(), "v1", ["/spicy", "/"])).toEqual({ name: "game", version: "v1", page: "/spicy" });
  expect(demoDefaults(fresh(), "v2", []).page).toBe("/");
});

test("demoFactsAt reads a pinned commit's pages and launch", async () => {
  expect(await demoFactsAt(app, fresh(), oid)).toEqual({ pages: ["/", "/spicy"], launch: "file" });
  expect(await demoFactsAt(app, fresh(), "not-an-oid")).toEqual({ pages: [] });
});

test("launchOf: the pin, then the app, then pages decide", () => {
  expect(launchOf({ launch: "shots" }, "file", ["/"])).toBe("shots");
  expect(launchOf(undefined, "env", ["/"])).toBe("env");
  expect(launchOf(undefined, undefined, ["/"])).toBe("file");
  expect(launchOf(undefined, undefined, [])).toBe("env");
});

test("saveDemo by a non-writer is refused with the access error", async () => {
  const refused = await saveDemo(app, bob, fresh(), "v1", input);
  expect(refused).toEqual({ ok: false, error: "forbidden" });
  const anon = await saveDemo(app, undefined, fresh(), "v1", input);
  expect(anon).toEqual({ ok: false, error: "unauthorized" });
  expect((await readBuildPin(repoDir(app.reposRoot, "alice", "game"), "v1"))?.demo).toBeUndefined();
});

test("saveDemo by the writer keeps the demo on the pin", async () => {
  const saved = await saveDemo(app, alice, fresh(), "v1", input);
  expect(saved.ok).toBe(true);
  const pin = await readBuildPin(repoDir(app.reposRoot, "alice", "game"), "v1");
  expect(pin?.demo).toMatchObject({ name: "Game", version: "v1", launch: "env", page: "/" });
});
