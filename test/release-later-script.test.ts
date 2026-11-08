/** `scripts/release-later.ts` run as the owner runs it: a subprocess on a real data directory (#7801). */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { addDependency } from "../src/core/dependencies.ts";
import { createIssue, type Issue } from "../src/core/issues.ts";
import { getUserByName } from "../src/core/users.ts";
import { heldByGateAlone } from "../src/crew/release_later.ts";
import { adminCookie } from "./helpers/admin.ts";
import { quietLogs } from "./helpers/globals.ts";
import { Database } from "bun:sqlite";

quietLogs();

const script = join(import.meta.dir, "../scripts/release-later.ts");
const run = (...args: string[]) => {
  const p = Bun.spawnSync(["bun", script, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
};

describe("scripts/release-later.ts", () => {
  let dataDir = "";
  let repoId = "";
  let a: Issue;
  let b: Issue;

  const held = () => {
    const db = new Database(join(dataDir, "forge.db"), { readonly: true });
    try {
      return heldByGateAlone(db, repoId).map((h) => h.number);
    } finally {
      db.close();
    }
  };

  beforeAll(async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-release-script-"));
    const app = createApp({ dataDir, port: 0 });
    await adminCookie(app, { username: "alice", email: "alice@forge.test", password: "a-long-words-passphrase" });
    const alice = getUserByName(app.db, "alice")!;
    const made = await createRepo(app, alice, { name: "garden", visibility: "public" });
    if (!made.ok) throw new Error(String(made.error));
    repoId = made.value.id;
    const open = (title: string): Issue => {
      const r = createIssue(app.db, { repoId, authorId: alice.id, title });
      if (!r.ok) throw new Error(String(r.error));
      return r.value;
    };
    const gate = open("Later gate: not yet");
    a = open("Held one");
    b = open("Held two");
    for (const i of [a, b]) {
      const r = addDependency(app.db, i, gate, alice.id);
      if (!r.ok) throw new Error(r.error);
    }
    app.close();
  });
  afterAll(() => rm(dataDir, { recursive: true, force: true }));

  test("lists by default and writes nothing", () => {
    const r = run(dataDir, "alice/garden");
    expect(r.code).toBe(0);
    expect(r.out).toContain(`#${a.number}\tlinked by alice\tHeld one`);
    expect(r.out).toContain(`#${b.number}\tlinked by alice\tHeld two`);
    expect(r.out).toContain("2 held by the Later gate alone");
    expect(r.out).not.toContain("released");
    expect(held()).toEqual([a.number, b.number]);
  });

  test("--only narrows the list, and still writes nothing without --apply", () => {
    const r = run(dataDir, "alice/garden", "--only", String(b.number));
    expect(r.out).toContain("Held two");
    expect(r.out).not.toContain("Held one");
    expect(r.out).toContain("1 held by the Later gate alone");
    expect(held()).toEqual([a.number, b.number]);
  });

  test("--only --apply releases just those named", () => {
    const r = run(dataDir, "alice/garden", "--only", String(a.number), "--apply");
    expect(r.out).toContain("released 1");
    expect(held()).toEqual([b.number]);
  });

  test("--apply waits for a forge holding the write lock, then releases the rest", async () => {
    const forge = new Database(join(dataDir, "forge.db"));
    forge.run("BEGIN IMMEDIATE");
    const p = Bun.spawn(["bun", script, dataDir, "alice/garden", "--apply"], { stdout: "pipe", stderr: "pipe" });
    await Bun.sleep(500);
    forge.run("COMMIT");
    forge.close();
    const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
    expect([code, err]).toEqual([0, ""]);
    expect(out).toContain("released 1");
  });

  test("a second run is empty", () => {
    expect(held()).toEqual([]);
    expect(run(dataDir, "alice/garden").out).toContain("0 held by the Later gate alone");
  });

  test("refuses with a plain message: bad arguments, unknown repository, missing or foreign database", async () => {
    expect(run(dataDir).code).toBe(2);
    expect(run(dataDir, "alice/garden", "--only", "x").err).toContain("usage:");
    const none = run(dataDir, "alice/nowhere");
    expect([none.code, none.err]).toEqual([2, "release-later: no repository alice/nowhere\n"]);
    const empty = await mkdtemp(join(tmpdir(), "forge-release-empty-"));
    expect(run(empty, "alice/garden").err).toContain("no forge.db");
    new Database(join(empty, "forge.db")).close();
    const bare = run(empty, "alice/garden");
    expect(bare.code).toBe(2);
    expect(bare.err).toContain("is not a forge database");
    expect(bare.err).not.toContain("SQLiteError");
    await rm(empty, { recursive: true, force: true });
  });
});
