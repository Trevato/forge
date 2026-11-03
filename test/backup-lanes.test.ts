/**
 * Backup lanes (#8811): each platform lane's newest object and age, read
 * from its store with a fake one — fresh, 27 h old, empty, refusing —
 * bounded to the last-named folder, judged by the one bucket verdict home,
 * MCP `backups` and Resilience read, and never a credential in the answer.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createToken } from "../src/core/tokens.ts";
import { createUser } from "../src/core/users.ts";
import { serve, type Servers } from "../src/http/server.ts";
import { backupVerdict, judge, LATE_MS, watchBucket, type LaneRead } from "../src/snapshot/bucket.ts";
import type { DrillResult } from "../src/snapshot/drill.ts";
import {
  PAGES,
  newestUnder,
  parseLanes,
  readDeclaredLanes,
  readObjectLane,
  s3Lister,
  type LanePage,
  type Lister,
} from "../src/snapshot/lanes.ts";
import { startSnapshots, type SnapshotsHandle } from "../src/snapshot/service.ts";
import { dirStore } from "../src/snapshot/store.ts";
import { verdictLines } from "../src/tui/screens/resilience.ts";

const NOW = Date.parse("2026-11-02T12:00:00Z");
const H = 3_600_000;
const SECRET = "sk-very-secret-lane-key";
const ACCESS = "AKIA-lane-access";

/** A bucket in memory: keys with times, listed one delimited level at a time, `perPage` entries a page. */
function fakeStore(objects: Record<string, { bytes: number; at: number }>, perPage = 1000) {
  const calls: string[] = [];
  const lister: Lister = {
    where: "s3.test/bucket",
    async page(prefix, next) {
      calls.push(prefix);
      const entries = new Map<string, LanePage["objects"][number] | "folder">();
      for (const [key, o] of Object.entries(objects)) {
        if (!key.startsWith(prefix)) continue;
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf("/");
        if (slash === -1) entries.set(key, { key, bytes: o.bytes, at: new Date(o.at).toISOString() });
        else entries.set(prefix + rest.slice(0, slash + 1), "folder");
      }
      const sorted = [...entries.keys()].sort();
      const from = next === undefined ? 0 : Number(next);
      const slice = sorted.slice(from, from + perPage);
      return {
        objects: slice.flatMap((k) => {
          const e = entries.get(k)!;
          return e === "folder" ? [] : [e];
        }),
        folders: slice.filter((k) => entries.get(k) === "folder"),
        next: from + perPage < sorted.length ? String(from + perPage) : undefined,
      };
    },
  };
  return { lister, calls };
}

const refusing: Lister = {
  where: "s3.test/bucket",
  async page() {
    throw new Error(`403 Forbidden for ${ACCESS} signed with ${SECRET}\n`);
  },
};

const target = { endpoint: "https://s3.test", bucket: "bucket", accessKeyId: ACCESS, secretAccessKey: SECRET };

const drill: DrillResult = {
  at: "2026-11-02T09:00:00Z",
  snapshotId: "s",
  ms: 1,
  counts: { repositories: 4, issues: 9, users: 2, pulls: 1, apps: 1 },
  health: "ok",
  verdict: "green",
  failedStep: null,
  phases: [],
  budgetMs: 1,
  reason: null,
};
/** The one verdict, over these reads, now. */
const verdict = (lanes: LaneRead[]) => judge({ lanes, checkedAt: new Date(NOW).toISOString() }, drill, NOW);

describe("one lane", () => {
  test("a fresh lane is green and names its newest object, size and age", async () => {
    const { lister } = fakeStore({
      "pg/2026-11-01.sql.gz": { bytes: 2048, at: NOW - 27 * H },
      "pg/2026-11-02.sql.gz": { bytes: 3 * 1024 * 1024, at: NOW - 3 * H },
    });
    const r = await readObjectLane({ name: "backup/postgres", prefix: "pg/", lister }, NOW);
    expect(r).toMatchObject({
      lane: "backup/postgres",
      where: "s3.test/bucket/pg/",
      offBox: true,
      newestName: "pg/2026-11-02.sql.gz",
      newestBytes: 3 * 1024 * 1024,
      newestAt: new Date(NOW - 3 * H).toISOString(),
    });
    const v = verdict([r]);
    expect(v.state).toBe("green");
    expect(v.lanes[0]!.says).toBe("backup/postgres newest pg/2026-11-02.sql.gz 3 h old, 3.0 MiB");
  });

  test("a lane 27 h old is red and says it is late, naming the object it found", async () => {
    const { lister } = fakeStore({ "pg/old.sql.gz": { bytes: 100, at: NOW - 27 * H } });
    const v = verdict([await readObjectLane({ name: "backup/postgres", prefix: "pg/", lister }, NOW)]);
    expect(v.state).toBe("red");
    expect(v.reasons).toEqual(["Backup/postgres (s3.test/bucket/pg/) newest snapshot pg/old.sql.gz is 27 h old."]);
  });

  test("exactly 26 h old is green; a minute past is red", async () => {
    const at = (ms: number) => fakeStore({ "pg/x.sql": { bytes: 1, at: NOW - ms } }).lister;
    const edge = await readObjectLane({ name: "edge", prefix: "pg/", lister: at(LATE_MS) }, NOW);
    expect(verdict([edge]).lanes[0]!.state).toBe("green");
    const past = await readObjectLane({ name: "edge", prefix: "pg/", lister: at(LATE_MS + 60_000) }, NOW);
    expect(verdict([past]).lanes[0]!.state).toBe("red");
  });

  test("an ESC or other control byte a store wrote never reaches the line", () => {
    const base = { lane: "backup/x", where: "s3.test/b", offBox: true, newestBytes: 1, count: 1, readAt: new Date(NOW).toISOString() };
    const v = verdict([
      { ...base, newestAt: new Date(NOW - H).toISOString(), newestName: "pg/\u001b[2J\u001b]0;owned\u0007dump\u202e.sql" },
      { ...base, newestAt: null, newestName: null, error: "denied \u001b[31mred\u009b" },
    ]);
    const text = JSON.stringify([v.lanes.map((l) => l.says), v.reasons]);
    expect(text).not.toMatch(/\\u00(1b|07|9b)|\\u202e/);
    expect(v.lanes[0]!.says).toBe("backup/x newest pg/?[2J?]0;owned?dump?.sql 1 h old, 1 B");
    expect(v.lanes[1]!.says).toBe("backup/x (s3.test/b) cannot be read: denied ?[31mred?");
  });

  test("an empty lane is red and says it holds nothing", async () => {
    const { lister } = fakeStore({ "other/x": { bytes: 1, at: NOW } });
    const r = await readObjectLane({ name: "backup/redis", prefix: "redis/", lister }, NOW);
    expect(r.newestAt).toBeNull();
    expect(verdict([r]).reasons).toEqual(["Backup/redis (s3.test/bucket/redis/) holds no snapshot."]);
  });

  test("a store that refuses is red, says so on one line, and never carries its keys", async () => {
    const r = await readObjectLane({ name: "backup/postgres", prefix: "pg/", lister: refusing, target }, NOW);
    expect(r.error).toBe("403 Forbidden for … signed with …");
    const v = verdict([r]);
    expect(v.state).toBe("red");
    expect(v.reasons[0]).toContain("cannot be read: 403 Forbidden");
    expect(JSON.stringify(v)).not.toContain(SECRET);
    expect(JSON.stringify(v)).not.toContain(ACCESS);
  });

  test("a store that never answers is red within the lane's deadline", async () => {
    const hung: Lister = { where: "s3.test/bucket", page: () => new Promise(() => {}) };
    const r = await readObjectLane({ name: "slow", prefix: "", lister: hung }, NOW, 20);
    expect(r.error).toContain("no answer");
  });
});

describe("bounded: never a full listing", () => {
  test("only the last-named folder is walked into, one page per level", async () => {
    const objects: Record<string, { bytes: number; at: number }> = {};
    for (let d = 1; d <= 30; d++) {
      const day = `2026-10-${String(d).padStart(2, "0")}`;
      for (const part of ["db", "repos", "manifest.json"]) objects[`backups/${day}/${part}`] = { bytes: d, at: NOW - (31 - d) * H };
    }
    const { lister, calls } = fakeStore(objects);
    const r = await readObjectLane({ name: "velero", prefix: "backups/", lister }, NOW);
    expect(calls).toEqual(["backups/", "backups/2026-10-30/"]);
    expect(r.newestName?.startsWith("backups/2026-10-30/")).toBe(true);
    expect(r.error).toBeUndefined();
  });

  test("a level wider than its pages stops at the bound, and a stale find there says so", async () => {
    const objects: Record<string, { bytes: number; at: number }> = {};
    for (let i = 0; i < 50; i++) objects[`flat/${String(i).padStart(3, "0")}`] = { bytes: 1, at: NOW - 40 * H + i * 1000 };
    const { lister, calls } = fakeStore(objects, 10);
    const found = await newestUnder(lister, "flat/");
    expect(calls).toHaveLength(PAGES);
    expect(found.bounded).toBe(true);
    const r = await readObjectLane({ name: "flat", prefix: "flat/", lister }, NOW);
    expect(r.error).toContain("name a narrower prefix");
  });
});

describe("configuration", () => {
  const lane = { name: "backup/postgres", endpoint: "https://s3.test", bucket: "backups", prefix: "pg/", accessKey: ACCESS, secretKey: SECRET };

  test("a whole lane reads; nothing set is no lanes", () => {
    expect(parseLanes(undefined)).toEqual({ lanes: [], refused: [] });
    const got = parseLanes(JSON.stringify([lane]));
    expect(got.refused).toEqual([]);
    expect(got.lanes).toEqual([
      { name: "backup/postgres", prefix: "pg/", line: { backsUp: undefined, afterSpinDown: undefined }, target: { endpoint: "https://s3.test", bucket: "backups", accessKeyId: ACCESS, secretAccessKey: SECRET, region: undefined } },
    ]);
  });

  test("a lane that does not read whole is refused by name, and no value of it is said", () => {
    const got = parseLanes(
      JSON.stringify([
        { ...lane, endpoint: "file:///etc/passwd" },
        { ...lane, name: "nokey", secretKey: "" },
        { ...lane, name: "ctl", prefix: "a\u0000b" },
        { ...lane, name: "creds", endpoint: `https://${ACCESS}:${SECRET}@s3.test` },
        lane,
        lane,
      ]),
    );
    expect(got.lanes.map((l) => l.name)).toEqual(["backup/postgres"]);
    expect(got.refused.map((r) => r.name)).toEqual(["backup/postgres", "nokey", "ctl", "creds", "backup/postgres"]);
    expect(JSON.stringify(got.refused)).not.toContain(SECRET);
    expect(parseLanes("{not json").refused[0]!.says).toBe("configuration: not a JSON list of lanes");
  });

  test("readDeclaredLanes reads every declared lane; a refused one is a red read with its reason", async () => {
    const { lister } = fakeStore({ "pg/a.sql": { bytes: 5, at: NOW - H } });
    const read = await readDeclaredLanes(
      { FORGE_BACKUP_LANES: JSON.stringify([lane, { ...lane, name: "broken", bucket: "" }]) },
      NOW,
      () => lister,
    );
    const v = verdict(read);
    expect(v.lanes.map((l) => [l.lane, l.state])).toEqual([
      ["backup/postgres", "green"],
      ["broken", "red"],
    ]);
    expect(v.lanes[1]!.says).toContain("configuration: its bucket is missing");
    expect(JSON.stringify(v)).not.toContain(SECRET);
  });
});

describe("the bucket watch reads the declared lanes beside the forge's own", () => {
  let dir = "";
  let app: App;
  let servers: Servers;
  let admin = "";
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "forge-lanes-watch-"));
    app = createApp({ dataDir: dir, port: 0 });
    servers = await serve(app);
    const made = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "alice@x.test", password: "a-long-lanes-passphrase", isAdmin: true });
    if (!made.ok) throw new Error(made.error);
    admin = createToken(app.db, made.value.id, "t", "ro").token;
  });
  afterAll(async () => {
    servers.stop();
    app.close();
    await rm(dir, { recursive: true, force: true });
  });

  test("one pass: primary and every platform lane in the verdict home, MCP and Resilience read", async () => {
    const { lister } = fakeStore({ "pg/a.sql": { bytes: 5, at: Date.now() - 27 * H } });
    const w = watchBucket(
      dir,
      () => [{ lane: "primary", store: dirStore(join(dir, "store")) }],
      3_600_000,
      3_600_000,
      () => [],
      (now) => readDeclaredLanes({ FORGE_BACKUP_LANES: JSON.stringify([{ name: "backup/postgres", endpoint: "https://s3.test", bucket: "b", prefix: "pg/", accessKey: ACCESS, secretKey: SECRET }]) }, now, () => lister),
    );
    try {
      await w.pass();
      const v = backupVerdict(dir, drill);
      expect(v.lanes.map((l) => [l.lane, l.state])).toEqual([
        ["primary", "red"],
        ["backup/postgres", "red"],
      ]);
      const lines = verdictLines({ app } as never);
      // The dialog wraps at its width; the words are what count.
      expect(lines.join(" ").replace(/\s+/g, " ")).toContain("! backup/postgres (s3.test/bucket/pg/) newest snapshot pg/a.sql is 27 h old");
      expect(lines.join("\n")).not.toContain(SECRET);
    } finally {
      w.stop();
    }
  });

  test("MCP backups returns the platform lane in verdict.lanes, with its newest object and no key", async () => {
    const { lister } = fakeStore({ "pg/2026-11-02.sql.gz": { bytes: 2048, at: Date.now() - 2 * H } });
    const w = watchBucket(dir, () => [], 3_600_000, 3_600_000, () => [], (now) =>
      readDeclaredLanes({ FORGE_BACKUP_LANES: JSON.stringify([{ name: "backup/postgres", endpoint: "https://s3.test", bucket: "b", prefix: "pg/", accessKey: ACCESS, secretKey: SECRET }]) }, now, () => lister),
    );
    try {
      await w.pass();
      const res = await fetch(`${servers.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${admin}` },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "backups", arguments: {} } }),
      });
      const text = ((await res.json()) as any).result.content[0].text as string;
      const lane = JSON.parse(text).verdict.lanes.find((l: { lane: string }) => l.lane === "backup/postgres");
      expect(lane).toMatchObject({ state: "green", where: "s3.test/bucket/pg/", newestName: "pg/2026-11-02.sql.gz", newestBytes: 2048 });
      expect(lane.says).toBe("backup/postgres newest pg/2026-11-02.sql.gz 2 h old, 2.0 KiB");
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(ACCESS);
    } finally {
      w.stop();
    }
  });

  test("a declared reader that throws costs the pass nothing: the forge's own lanes are still kept", async () => {
    const w = watchBucket(dir, () => [{ lane: "primary", store: dirStore(join(dir, "store")) }], 3_600_000, 3_600_000, () => [], () =>
      Promise.reject(new Error("boom")),
    );
    try {
      await w.pass();
      expect(backupVerdict(dir, drill).lanes.map((l) => l.lane)).toEqual(["primary"]);
    } finally {
      w.stop();
    }
  });
});

describe("the S3 lister asks for one delimited page", () => {
  const realS3 = Bun.S3Client;
  const asked: Record<string, unknown>[] = [];
  let made: Record<string, unknown> | undefined;
  let refuse = false;
  beforeAll(() => {
    (Bun as any).S3Client = class {
      constructor(options: Record<string, unknown>) {
        made = options;
      }
      async list(options: Record<string, unknown>) {
        asked.push(options);
        if (refuse) throw new Error(`AccessDenied: key ${ACCESS} refused`);
        if (options["prefix"] === "pg/")
          return {
            contents: [{ key: "pg/a.sql", lastModified: new Date(NOW - 2 * H).toISOString(), size: 42 }],
            commonPrefixes: [{ prefix: "pg/2026-11-01/" }, { prefix: "pg/2026-11-02/" }],
            isTruncated: false,
          };
        if (options["prefix"] === "esc/")
          return { contents: [{ key: "esc/\u001b[2Jdump.sql", lastModified: new Date(NOW - H).toISOString(), size: 1 }], isTruncated: false };
        if (options["prefix"] === "pg/2026-11-02/")
          return { contents: [{ key: "pg/2026-11-02/dump.sql", lastModified: new Date(NOW - H).toISOString(), size: 4096 }], isTruncated: false };
        return { isTruncated: false };
      }
    };
  });
  afterAll(() => {
    (Bun as any).S3Client = realS3;
  });

  test("newest found by walking the last folder; delimiter and 1,000 keys asked each time", async () => {
    const r = await readObjectLane({ name: "postgres", prefix: "pg/", lister: s3Lister(target), target }, NOW);
    expect(made).toMatchObject({ endpoint: "https://s3.test", bucket: "bucket" });
    expect(r).toMatchObject({ newestName: "pg/2026-11-02/dump.sql", newestBytes: 4096, newestAt: new Date(NOW - H).toISOString() });
    expect(r.error).toBeUndefined();
    expect(asked).toEqual([
      { prefix: "pg/", delimiter: "/", maxKeys: 1000 },
      { prefix: "pg/2026-11-02/", delimiter: "/", maxKeys: 1000 },
    ]);
  });

  test("a key holding an ESC is kept with the byte replaced", async () => {
    const r = await readObjectLane({ name: "esc", prefix: "esc/", lister: s3Lister(target), target }, NOW);
    expect(r.newestName).toBe("esc/?[2Jdump.sql");
  });

  test("a refusal is red, and the access key it echoes is struck out", async () => {
    refuse = true;
    const r = await readObjectLane({ name: "postgres", prefix: "pg/", lister: s3Lister(target), target }, NOW);
    expect(r.error).toBe("AccessDenied: key … refused");
    expect(JSON.stringify(r)).not.toContain(ACCESS);
  });
});

describe("a line per lane (#9067)", () => {
  const lane = { name: "backup/postgres", endpoint: "https://s3.test", bucket: "backups", prefix: "pg/", accessKey: ACCESS, secretKey: SECRET };
  const fresh = { "pg/2026-11-02T10:00:00Z/dump": { bytes: 10, at: NOW - H } };
  const env = (lanes: object[]) => ({ FORGE_BACKUP_LANES: JSON.stringify(lanes) });
  const verdictOf = async (lanes: object[], listerFor?: (t: unknown) => Lister) => {
    const read = await readDeclaredLanes(env(lanes), NOW, listerFor as never ?? (() => fakeStore(fresh).lister));
    return judge({ lanes: read, checkedAt: new Date(NOW).toISOString() }, undefined, NOW);
  };

  test("a lane with both values shows them", async () => {
    const v = await verdictOf([{ ...lane, backsUp: "the postgres dump", afterSpinDown: "ops, from B2" }]);
    expect(v.lanes[0]!.line).toBe("backs up the postgres dump; after spin-down: ops, from B2");
    expect(v.lanes[0]!.state).toBe("green");
  });

  test("a lane with neither says there is no line, and stays green", async () => {
    const v = await verdictOf([lane]);
    expect(v.lanes[0]!.line).toBe("No line yet: say what it backs up and who reads it after spin-down");
    expect(v.state).not.toBe("red");
    expect(v.lanes[0]!.state).toBe("green");
  });

  test("a lane with one value shows it and names the missing one", async () => {
    const a = await verdictOf([{ ...lane, backsUp: "the postgres dump" }]);
    expect(a.lanes[0]!.line).toBe("backs up the postgres dump; after spin-down: (not said)");
    const b = await verdictOf([{ ...lane, afterSpinDown: "ops, from B2" }]);
    expect(b.lanes[0]!.line).toBe("backs up (not said); after spin-down: ops, from B2");
  });

  test("values are bounded, typed and printable; no key reaches the line", async () => {
    expect(parseLanes(JSON.stringify([{ ...lane, backsUp: 7 }])).refused).toHaveLength(1);
    expect(parseLanes(JSON.stringify([{ ...lane, afterSpinDown: "x".repeat(201) }])).refused).toHaveLength(1);
    const v = await verdictOf([{ ...lane, backsUp: "a\u001b[31mb", afterSpinDown: "ops" }]);
    expect(v.lanes[0]!.line).not.toContain("\u001b");
    expect(JSON.stringify(v)).not.toContain(SECRET);
  });

  test("a retired lane with an unreachable store is listed, never read, and the verdict stays green", async () => {
    const boom: Lister = { where: "gone.test/b", async page() { throw new Error("connection refused"); } };
    const v = await verdictOf(
      [lane, { ...lane, name: "backup/old", bucket: "oldb", backsUp: "the old thing", afterSpinDown: "retired" }],
      (t: any) => (t.bucket === "oldb" ? boom : fakeStore(fresh).lister),
    );
    const old = v.lanes.find((l) => l.lane === "backup/old")!;
    expect(old.state).toBe("retired");
    expect(old.says).toContain("retired");
    expect(v.reasons).toEqual([]);
    expect(v.state).not.toBe("red");
  });

  test("a retired lane's store is never asked", async () => {
    let asked = 0;
    const read = await readDeclaredLanes(env([{ ...lane, afterSpinDown: "Retired" }]), NOW, () => {
      asked++;
      return fakeStore(fresh).lister;
    });
    expect(read[0]!.error).toBeUndefined();
    expect(asked).toBe(0);
    expect(read[0]!.newestAt).toBeNull();
  });
});

describe("the lanes in the web door and the terminal (#9067)", () => {
  let root = "";
  let app: App;
  let servers: Servers;
  let stop: () => void;
  let svc: SnapshotsHandle;
  const fresh = { "pg/2026-11-02T10:00:00Z/dump": { bytes: 10, at: Date.now() - H } };
  const lane = { name: "backup/pg", endpoint: "https://s3.test", bucket: "backups", prefix: "pg/", accessKey: ACCESS, secretKey: SECRET };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "forge-lanes-door-"));
    app = createApp({ dataDir: root, port: 0 });
    const u = await createUser(app.db, { origin: "seed", trusted: true, username: "alice", email: "a@forge.local", password: "a-good-passphrase", adminIfFirst: true });
    if (!u.ok) throw new Error(u.error);
    // The page draws only where a snapshot service is running.
    svc = startSnapshots(app, dirStore(join(root, "store")), { version: "t", nightly: false });
    servers = await serve(app);
    const env = {
      FORGE_BACKUP_LANES: JSON.stringify([
        { ...lane, backsUp: "the postgres dump", afterSpinDown: "ops, from B2" },
        { ...lane, name: "backup/bare", bucket: "bare" },
        { ...lane, name: "backup/old", bucket: "old", backsUp: "the old thing", afterSpinDown: "retired" },
      ]),
    };
    const w = watchBucket(root, () => [], 3_600_000, 3_600_000, () => [], (now) => readDeclaredLanes(env, now, () => fakeStore(fresh).lister));
    stop = w.stop;
    await w.pass();
  });
  afterAll(async () => {
    stop();
    await svc.stop();
    await servers.stop();
    await rm(root, { recursive: true, force: true });
  });

  test("/settings/backups lists each lane as a row, with its line, the missing line said, and a retired mark", async () => {
    const r = await fetch(`${servers.url}/settings/backups`, { headers: { cookie: await login() } });
    const t = await r.text();
    const li = (name: string) => t.split("<li").find((x) => x.includes(`data-lane="${name}"`)) ?? "";
    expect(li("backup/pg")).toContain("backs up the postgres dump; after spin-down: ops, from B2");
    expect(li("backup/pg")).toContain('data-lane-state="green"');
    expect(li("backup/bare")).toContain("No line yet: say what it backs up and who reads it after spin-down");
    expect(li("backup/old")).toContain('data-lane-state="retired"');
    expect(li("backup/old")).toContain("retired");
    expect(li("backup/old")).toContain('class="badge"');
    expect(t).toContain('class="list setting-list"');
  });

  test("the terminal's verdict lines carry each lane's line", () => {
    const text = verdictLines({ app } as never).join("\n");
    expect(text).toContain("backs up the postgres dump; after spin-down: ops, from B2");
    expect(text).toContain("No line yet");
  });

  async function login(): Promise<string> {
    const r = await fetch(`${servers.url}/signin`, {
      method: "POST",
      headers: { origin: servers.url },
      body: new URLSearchParams({ username: "alice", password: "a-good-passphrase" }),
      redirect: "manual",
    });
    return (r.headers.get("set-cookie") ?? "").split(";")[0]!;
  }
});
