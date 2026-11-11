import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_NODES, forkTree } from "../src/actions/fork_tree.ts";
import { createRepo, forkRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { setForkFollowMode } from "../src/core/fork_follow.ts";
import type { Repo } from "../src/core/repos.ts";
import { createUser, type User } from "../src/core/users.ts";
import { promote } from "./helpers/members.ts";
import { once } from "./helpers/statements.ts";
import { expectWork } from "./helpers/work.ts";

const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

let dir: string;
let app: App;
const users: Record<string, User> = {};
let forge: Repo;
let org: Repo;
let person: Repo;
let hidden: Repo;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "forge-fork-tree-reader-"));
  app = createApp({ dataDir: dir, port: 0 });
  for (const name of ["alice", "bob", "carol", "dan", "erin"]) {
    users[name] = must(
      await createUser(app.db, {
        origin: "seed",
        trusted: true,
        username: name,
        email: `${name}@f.dev`,
        password: "a-good-passphrase",
        adminIfFirst: name === "alice",
      }),
    );
    promote(app.db, users[name]!);
  }
  forge = must(await createRepo(app, users["alice"]!, { name: "app", visibility: "public" }));
  org = must(await forkRepo(app, users["bob"]!, forge));
  must(await forkRepo(app, users["carol"]!, forge));
  person = must(await forkRepo(app, users["dan"]!, org));
  hidden = must(await forkRepo(app, users["erin"]!, org, "secret", { visibility: "private" }));
  must(await forkRepo(app, users["erin"]!, hidden, "under", { visibility: "public" }));
  setForkFollowMode(app.db, person.id, "take-updates");
}, 60_000);

afterAll(async () => {
  app.close();
  await rm(dir, { recursive: true, force: true });
});

const names = (t: { nodes: { repo: string }[] }) => t.nodes.map((n) => n.repo);

describe("forkTree", () => {
  test("read from the middle node: root, siblings, descendants, with parent, depth and follow", () => {
    const t = forkTree(app.db, org, users["alice"]!)!;
    expect(t.root).toBe("alice/app");
    expect(t.truncated).toBe(false);
    const by = Object.fromEntries(t.nodes.map((n) => [n.repo, n]));
    expect(by["alice/app"]).toEqual({ repo: "alice/app", parent: null, depth: 0, follow: "autonomous", word: "" });
    expect(by["bob/app"]).toEqual({ repo: "bob/app", parent: "alice/app", depth: 1, follow: "offers", word: "proposes" });
    expect(by["carol/app"]!.parent).toBe("alice/app");
    expect(by["dan/app"]).toEqual({ repo: "dan/app", parent: "bob/app", depth: 2, follow: "take-updates", word: "follows" });
  });

  test("a stranger and the owner of a private fork get different lists, and the stranger's has no trace", () => {
    const owner = names(forkTree(app.db, org, users["erin"]!)!);
    const stranger = forkTree(app.db, org, users["dan"]!)!;
    const anon = forkTree(app.db, org, undefined)!;
    expect(owner).toContain("erin/secret");
    expect(owner).toContain("erin/under");
    for (const t of [stranger, anon]) {
      const json = JSON.stringify(t);
      expect(json).not.toContain("secret");
      expect(json).not.toContain("under");
      expect(names(t)).not.toEqual(owner);
    }
  });

  test("a repo the caller cannot read yields nothing", () => {
    expect(forkTree(app.db, hidden, users["dan"]!)).toBeUndefined();
  });

  test("depth limits generations and says it truncated", () => {
    const t = forkTree(app.db, forge, users["alice"]!, { depth: 1 })!;
    expect(t.nodes.every((n) => n.depth <= 1)).toBe(true);
    expect(t.truncated).toBe(true);
    expect(forkTree(app.db, forge, users["alice"]!, { depth: 99 })!.nodes.length).toBeGreaterThan(4);
  });

  test("a limit cuts the nodes and says so; the cap is 200", () => {
    const t = forkTree(app.db, forge, users["alice"]!, { limit: 3 })!;
    expect(t.nodes.length).toBe(3);
    expect(t.truncated).toBe(true);
    expect(MAX_NODES).toBe(200);
  });

  test("the repo asked about is in nodes even when it lies deeper than depth", async () => {
    let at = forge;
    for (let i = 0; i < 5; i++) {
      const u = must(
        await createUser(app.db, { origin: "seed", trusted: true, username: `deep${i}`, email: `deep${i}@f.dev`, password: "a-good-passphrase" }),
      );
      promote(app.db, u);
      at = must(await forkRepo(app, u, at));
    }
    const t = forkTree(app.db, at, users["alice"]!, { depth: 1 })!;
    const me = t.nodes.find((n) => n.repo === "deep4/app")!;
    expect(me.depth).toBe(5);
    expect(t.nodes.some((n) => n.repo === "deep3/app")).toBe(true);
    const tiny = forkTree(app.db, at, users["alice"]!, { limit: 1 })!;
    expect(tiny.nodes.some((n) => n.repo === "deep4/app")).toBe(true);
  });

  test("200 forks: capped, truncated, and a warm call stays within a counted number of statements", async () => {
    const cols = (
      app.db.query<{ name: string }, []>("PRAGMA table_info(repo)").all()
    ).map((c) => c.name);
    const list = (f: (c: string) => string) => cols.map(f).join(",");
    const base = forge.id;
    for (let i = 0; i < 205; i++) {
      const sub = (c: string) =>
        c === "id" ? `'bulk${i}'` : c === "name" ? `'bulk${i}'` : c === "fork_parent_id" ? `'${base}'` : c;
      app.db.query(`INSERT INTO repo (${cols.join(",")}) SELECT ${list(sub)} FROM repo WHERE id = ?1`).run(base);
    }
    forkTree(app.db, forge, users["bob"]!);
    let t!: NonNullable<ReturnType<typeof forkTree>>;
    const n = await once(app.db, () => {
      t = forkTree(app.db, forge, users["bob"]!)!;
    });
    expect(t.nodes.length).toBe(200);
    expect(t.truncated).toBe(true);
    // 205 forks: a handful of statements per generation, not per node (was 408).
    expectWork(n, { max: 25 });
  });
});

describe("the terminal screen", () => {
  test("draws the tree from the reader, marks the asked repo, and shows nothing for an unreadable one", async () => {
    const { treeLines } = await import("../src/tui/screens/fork_tree.ts");
    const lines = treeLines(forkTree(app.db, org, users["dan"]!), "bob/app");
    expect(lines).toContain("alice/app");
    expect(lines).toContain("  * bob/app  proposes");
    const own = treeLines(forkTree(app.db, person, users["dan"]!), "dan/app");
    expect(own).toContain("    * dan/app  follows");
    expect(lines.join("\n")).not.toContain("offers");
    expect(lines.join("\n")).not.toContain("secret");
    expect(treeLines(forkTree(app.db, hidden, users["dan"]!), "erin/secret")).toEqual(["Nothing to show."]);
  });
});
