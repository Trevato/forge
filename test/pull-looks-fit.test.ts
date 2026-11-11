/**
 * `fit` beside `items` on GET …/pulls/:number/looks: sizes only, owner looks
 * included, none without a size, and a sealed pull's is the writers'.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openPull } from "../src/actions/pulls.ts";
import { commitToBranch, createRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { previewEnv } from "../src/apps/data.ts";
import { createApp as insertApp } from "../src/core/apps.ts";
import { recordLook } from "../src/core/looks.ts";
import type { Pull } from "../src/core/pulls.ts";
import type { Repo } from "../src/core/repos.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser, type User } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { pullFit } from "../src/looks/readable.ts";
import { quietLogs } from "./helpers/globals.ts";

quietLogs();

let dataDir: string;
let app: App;
let servers: Servers;
let alice: User;
let bob: User;
let bobToken: string;
let appId: string;
let pull: Pull;
let repo: Repo;

const size = (scrollWidth: number) => ({ scrollWidth, scrollHeight: 1700, innerWidth: 390, innerHeight: 844 });

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-fit-"));
  app = createApp({ dataDir, port: 0 });
  const person = async (username: string) => {
    const made = await createUser(app.db, {
      origin: "seed", trusted: true, username, email: `${username}@forge.local`,
      password: "a-good-passphrase", adminIfFirst: username === "alice",
    });
    if (!made.ok) throw new Error(made.error);
    return made.value;
  };
  alice = await person("alice");
  bob = await person("bob");
  const made = await createRepo(app, alice, { name: "garden", visibility: "public" });
  if (!made.ok) throw new Error(String(made.error));
  repo = made.value;
  await commitToBranch(app, alice, repo, { message: "seed", files: [{ path: "README.md", content: "# g\n" }] });
  await commitToBranch(app, alice, repo, { branch: "one", base: "main", message: "one", files: [{ path: "a.md", content: "x\n" }] });
  const opened = await openPull(app, alice, repo, { title: "One", body: "", baseBranch: "main", headBranch: "one" });
  if (!opened.ok) throw new Error(String(opened.error));
  pull = opened.value;
  const inserted = insertApp(app.db, { repoId: repo.id, slug: "garden", access: "public" });
  if (!inserted.ok) throw new Error(inserted.error);
  appId = inserted.value.id;
  const base = { appId, env: previewEnv(pull.number), commitOid: "a".repeat(40), path: "looks/x.png" };
  recordLook(app.db, { ...base, kind: "phone", takenAs: "owner", size: size(520) } as Parameters<typeof recordLook>[1]);
  recordLook(app.db, { ...base, kind: "desktop", takenAs: "owner" } as Parameters<typeof recordLook>[1]);
  servers = await serve(app);
  bobToken = createToken(app.db, bob.id, "t", "rw").token;
}, 30_000);

afterAll(async () => {
  servers.stop();
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

const fit = async () => {
  const res = await fetch(`${servers.url}/api/v1/repos/alice/garden/pulls/${pull.number}/looks`, {
    headers: { authorization: `Bearer ${bobToken}` },
  });
  return (await res.json()) as { items: unknown[]; fit: Record<string, unknown>[] };
};

test("an owner-taken sideways phone look is in fit, numbers only, and a look without a size is absent", async () => {
  const body = await fit();
  expect(body.items).toEqual([]);
  expect(body.fit).toEqual([
    { page: "/", width: "phone", scrollWidth: 520, innerWidth: 390, screens: 2, sideways: true },
  ]);
});

test("a sealed pull's fit is the writers'", () => {
  app.db.query("UPDATE issue SET sealed = 1 WHERE repo_id = ?1 AND number = ?2").run(repo.id, pull.number);
  expect(pullFit(app, repo, pull, bob)).toEqual([]);
  expect(pullFit(app, repo, pull, alice)).toHaveLength(1);
});

test("a page retaken on the latest commit gives one, the newest, entry; a fitting page is not sideways", () => {
  app.db.query("UPDATE issue SET sealed = 0 WHERE repo_id = ?1 AND number = ?2").run(repo.id, pull.number);
  const oid = "b".repeat(40);
  const base = { appId, env: previewEnv(pull.number), commitOid: oid, path: "looks/y.png", takenAs: "nobody", page: "/about", kind: "phone" };
  recordLook(app.db, { ...base, size: size(900) } as Parameters<typeof recordLook>[1]);
  recordLook(app.db, { ...base, size: { scrollWidth: 390, scrollHeight: 844, innerWidth: 390, innerHeight: 844 } } as Parameters<typeof recordLook>[1]);
  const about = pullFit(app, repo, pull, alice).filter((f) => f.page === "/about");
  expect(about).toEqual([
    { page: "/about", width: "phone", scrollWidth: 390, innerWidth: 390, screens: 1, sideways: false },
  ]);
});
