/**
 * What a red batch was (#7639): the queue names the one pull and hands it
 * back with its failing tests, or calls the red the machine's, and says so
 * in the keeper, the flow reading and the boards' sources.
 */
import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app.ts";
import { SOURCES } from "../src/boards/sources.ts";
import { type Candidate, enqueue, type Expect, type Queued } from "../src/checks/queue.ts";
import type { LandVerdict } from "../src/checks/tiers.ts";
import type { Pull } from "../src/core/pulls.ts";
import { createUser } from "../src/core/users.ts";
import { keepVerdict, type QueueVerdict, readVerdicts } from "../src/flow/culprits.ts";
import { id } from "../src/kernel/id.ts";
import { flowFor } from "../src/system/telemetry.ts";
import { flowLines } from "../src/tui/screens/flow.ts";

describe("the merge queue says what a red batch was", () => {
  let dir: string;
  const kept: QueueVerdict[] = [];
  const spies: { mockRestore(): void }[] = [];
  const git = (...args: string[]) =>
    Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args]).stdout.toString().trim();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-queue-verdicts-"));
    Bun.spawnSync(["git", "init", "-q", "-b", "main", dir]);
    git("commit", "-q", "--allow-empty", "-m", "start");
    for (const level of ["info", "warn"] as const) spies.push(spyOn(console, level).mockImplementation(() => {}));
  });
  afterEach(() => void (kept.length = 0));
  afterAll(async () => {
    for (const s of spies) s.mockRestore();
    await rm(dir, { recursive: true, force: true });
  });

  async function headWriting(branch: string, file: string): Promise<string> {
    git("checkout", "-q", "-B", branch, "main");
    git("reset", "-q", "--hard", "main");
    await Bun.write(join(dir, file), `${file}\n`);
    git("add", file);
    git("commit", "-q", "-m", file);
    git("checkout", "-q", "--detach");
    return git("rev-parse", branch);
  }

  const entry = (prefix: string, number: number, headOid: string): Queued => ({
    pull: { id: `${prefix}-${number}`, number, baseBranch: "main", headOid } as Pull,
    dir,
    land: async (expect: Expect) => {
      if (git("rev-parse", "refs/heads/main") !== expect.baseOid) return undefined;
      const tip = git("commit-tree", expect.treeOid, "-p", expect.baseOid, "-m", `#${number}`);
      git("update-ref", "refs/heads/main", tip);
      return tip;
    },
    release: () => {},
    handBack: () => {},
  });

  const red = (reason: { kind: "tests"; failed: number } | { kind: "install" }, names: string[] = []): LandVerdict => ({
    lands: false,
    reopen: true,
    comment: "red",
    learn: [],
    reason,
    ...(names.length === 0
      ? {}
      : { tests: { passed: 1, failed: names.length, failing: names.map((name) => ({ name, errors: [] })) } }),
  });

  test("one bad pull of a batch: named, with the failing test, the rest land", async () => {
    const pulls: Queued[] = [];
    for (let i = 1; i <= 3; i++) pulls.push(entry("real", i, await headWriting(`r${i}`, i === 2 ? "bad.txt" : `r${i}.txt`)));
    const gate = async (c: Candidate): Promise<LandVerdict> =>
      git("ls-tree", "--name-only", c.tipOid).split("\n").includes("bad.txt")
        ? red({ kind: "tests", failed: 1 }, ["suite > breaks"])
        : { lands: true };
    const answers = await enqueue("verdict-real", pulls, gate, { depth: 1, room: () => 0, onVerdict: (_, v) => kept.push(v) });
    expect(answers).toEqual([true, false, true]);
    expect(kept).toEqual([{ kind: "real", why: "tests", pull: 2, tests: ["suite > breaks"] }]);
  });

  test("an install red twice is a load red: no pull blamed", async () => {
    const pulls: Queued[] = [];
    for (let i = 11; i <= 12; i++) pulls.push(entry("load", i, await headWriting(`l${i}`, `l${i}.txt`)));
    await enqueue("verdict-load", pulls, async () => red({ kind: "install" }), {
      depth: 1,
      room: () => 3,
      onVerdict: (_, v) => kept.push(v),
    });
    expect(kept).toEqual([{ kind: "load", why: "install", tests: [] }]);
  });

  test("a flake is a load red, kept even when onFlake throws", async () => {
    const pulls: Queued[] = [];
    for (let i = 31; i <= 34; i++) pulls.push(entry("flake", i, await headWriting(`f${i}`, `f${i}.txt`)));
    const gate = async (c: Candidate): Promise<LandVerdict> =>
      c.steps.length === 4 || c.steps.length === 2 ? red({ kind: "tests", failed: 1 }, ["flaky one"]) : { lands: true };
    let calls = 0;
    await enqueue("verdict-flake", pulls, gate, {
      depth: 1,
      room: () => (calls++ === 0 ? 0 : 1),
      onFlake: () => {
        throw new Error("disk");
      },
      onVerdict: (_, v) => kept.push(v),
    });
    expect(kept).toContainEqual({ kind: "load", why: "flake", tests: ["flaky one"] });
  });

  test("a keeper that throws does not stop the queue", async () => {
    const pulls = [entry("boom", 21, await headWriting("b21", "b21.txt"))];
    const answers = await enqueue("verdict-boom", pulls, async () => red({ kind: "tests", failed: 1 }), {
      depth: 1,
      room: () => 0,
      onVerdict: () => {
        throw new Error("disk");
      },
    });
    expect(answers).toEqual([false]);
  });
});

describe("the kept verdicts", () => {
  test("read as counts and a sentence, cut to public repositories for an agent, shown in the flow reading and the boards", async () => {
    const data = await mkdtemp(join(tmpdir(), "forge-verdicts-"));
    const app = createApp({ dataDir: data, port: 0 });
    try {
      const u = await createUser(app.db, { username: "alice", email: "a@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true });
      if (!u.ok) throw new Error(u.error);
      const repo = (name: string, visibility: string) => {
        const rid = id();
        app.db.query(`INSERT INTO repo (id, owner_id, name, visibility) VALUES (?1, ?2, ?3, ?4)`).run(rid, u.value.id, name, visibility);
        return rid;
      };
      const pub = repo("pub", "public");
      const priv = repo("priv", "private");
      const now = new Date("2026-11-02T12:00:00.000Z");
      keepVerdict(app.db, pub, { kind: "load", why: "install", tests: [] }, new Date(now.getTime() - 3_600_000));
      keepVerdict(app.db, priv, { kind: "real", why: "tests", pull: 9, tests: ["a > b"] }, new Date(now.getTime() - 60_000));
      keepVerdict(app.db, pub, { kind: "real", why: "tests", pull: 7, tests: ["x"] }, new Date(now.getTime() - 120_000));
      keepVerdict(app.db, pub, { kind: "load", why: "flake", tests: [] }, new Date(now.getTime() - 3 * 86_400_000));

      const all = readVerdicts(app.db, now, false);
      expect([all.real, all.load]).toEqual([2, 1]);
      expect(all.says).toBe('2 real, 1 load in 24 h; latest: alice/priv#9 broke "a > b", returned to its builder');
      expect(all.recent[0]).toMatchObject({ pull: 9, action: "returned #9 to its builder" });
      const open = readVerdicts(app.db, now, true);
      expect([open.real, open.load]).toEqual([1, 1]);
      expect(JSON.stringify(open)).not.toContain("priv");
      expect(readVerdicts(app.db, new Date("2026-12-01T00:00:00.000Z")).says).toBe("no red batch in 24 h");

      expect(flowFor(app, { kind: "agent" } as never, now).redBatches).toEqual(open);
      expect(SOURCES.queueVerdicts!.columns).not.toHaveProperty("tests");
      expect(app.db.query(`SELECT COUNT(*) AS n FROM queue_verdict`).get()).toEqual({ n: 4 });
    } finally {
      app.close?.();
      await rm(data, { recursive: true, force: true });
    }
  });
});

describe("the Flow dialog", () => {
  test("names the red batches, public ones alone for an agent", async () => {
    const data = await mkdtemp(join(tmpdir(), "forge-verdicts-tui-"));
    const app = createApp({ dataDir: data, port: 0 });
    try {
      const u = await createUser(app.db, { username: "alice", email: "a@forge.test", password: "a-good-passphrase", origin: "seed", trusted: true });
      if (!u.ok) throw new Error(u.error);
      app.db.query(`INSERT INTO repo (id, owner_id, name, visibility) VALUES ('p1', ?1, 'pub', 'public'), ('p2', ?1, 'priv', 'private')`).run(u.value.id);
      const now = new Date("2026-11-02T12:00:00.000Z");
      keepVerdict(app.db, "p1", { kind: "real", why: "tests", pull: 7, tests: ["x > y"] }, new Date(now.getTime() - 60_000));
      keepVerdict(app.db, "p2", { kind: "real", why: "tests", pull: 9, tests: ["secret"] }, new Date(now.getTime() - 30_000));
      const owner = flowLines(app.db, now, []).join("\n");
      expect(owner).toContain("alice/pub#7 real (tests)");
      expect(owner).toContain("alice/priv#9");
      const agent = flowLines(app.db, now, [], { queues: [] }).join("\n");
      expect(agent).toContain("alice/pub#7");
      expect(agent).not.toContain("priv");
    } finally {
      app.close?.();
      await rm(data, { recursive: true, force: true });
    }
  });
});
