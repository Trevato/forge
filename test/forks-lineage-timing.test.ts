/** The forks page reads its lineage in a fixed number of queries (#6202). */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRepo, forkRepo } from "../src/actions/repos.ts";
import { createApp, type App } from "../src/app.ts";
import { lineageOf } from "../src/core/following.ts";
import { getRepo, type Repo } from "../src/core/repos.ts";
import { repoDir } from "../src/git/repos.ts";
import { readTipOrAbsent } from "../src/git/tip.ts";
import { createUser } from "../src/core/users.ts";
import { promote } from "./helpers/members.ts";
import { seedAdmin } from "./helpers/admin.ts";

let dataDir = "";
let app: App;
let chain: Repo[] = [];

beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "forge-fklin-"));
  app = createApp({ dataDir, port: 0 });
  const admin = await seedAdmin(app, { username: "alice", email: "a@forge.local", password: "correct-horse-battery" });
  if (!admin.ok) throw new Error(admin.error);
  const must = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.value;
  };
  let parent = must(await createRepo(app, admin.value, { name: "r0", visibility: "public", description: "" }));
  chain = [parent];
  for (let i = 1; i < 4; i++) {
    parent = must(await forkRepo(app, admin.value, parent, `r${i}`));
    chain.push(parent);
  }
  for (let i = 0; i < 30; i++) {
    const who = must(
      await createUser(app.db, { origin: "seed", trusted: true, username: `u${i}`, email: `u${i}@f.dev`, password: "a-good-passphrase" }),
    );
    promote(app.db, who);
    must(await forkRepo(app, who, chain[2]!, `leaf${i}`));
  }
});

afterAll(async () => {
  app.close();
  await rm(dataDir, { recursive: true, force: true });
});

/** How many statements `run` sends to the database. */
async function queriesDuring(run: () => Promise<unknown>): Promise<number> {
  const real = app.db.query.bind(app.db);
  let n = 0;
  app.db.query = (sql: string) => {
    n++;
    return real(sql);
  };
  try {
    await run();
  } finally {
    app.db.query = real as typeof app.db.query;
  }
  return n;
}

test("the lineage costs the same few queries for 30 forks as for none", async () => {
  const big = await queriesDuring(() => lineageOf(app, chain[3]!, () => true));
  const small = await queriesDuring(() => lineageOf(app, chain[0]!, () => true));
  expect(big).toBeLessThanOrEqual(3);
  expect(small).toBe(big);
  const leaf = getRepo(app.db, "u0", "leaf0")!;
  expect(await queriesDuring(() => lineageOf(app, leaf, () => true))).toBe(big);
});

test("an unborn branch is read from the ref files, with no git to ask", async () => {
  const dir = repoDir(app.reposRoot, chain[0]!.ownerName, chain[0]!.name);
  expect(await readTipOrAbsent(dir, "refs/heads/main")).toBeNull();
  expect(await readTipOrAbsent(dir, "refs/heads/../x")).toBeUndefined();
});

test("the lineage reaches the root and holds every fork", async () => {
  const lineage = await lineageOf(app, chain[3]!, () => true);
  expect(lineage.root.repo.name).toBe("r0");
  expect(lineage.size).toBe(34);
});

test("a fork the viewer may not read is not in the lineage, nor hinted at", async () => {
  const hidden = getRepo(app.db, "u0", "leaf0")!;
  app.db.query("UPDATE repo SET visibility = 'private' WHERE id = ?1").run(hidden.id);
  const lineage = await lineageOf(app, chain[3]!, (r) => r.visibility === "public");
  expect(lineage.size).toBe(33);
  const names: string[] = [];
  const walk = (n: { repo: Repo; children: readonly (typeof lineage.root)[] }): void => {
    names.push(n.repo.name);
    n.children.forEach(walk);
  };
  walk(lineage.root);
  expect(names).not.toContain("leaf0");
});
