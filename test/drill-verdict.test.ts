/**
 * The drill tells people. A drill that finishes posts one comment on the
 * recovery issue (snapshot, time, health, counts, verdict); a failed one is
 * an inbox card naming the step, and the next passing drill clears it. A
 * restored directory is booted on a side port and must read healthy.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { createRepo } from "../src/actions/repos.ts";
import { createUser } from "../src/core/users.ts";
import { vitals } from "../src/kernel/vitals.ts";
import { bootRestored } from "../src/snapshot/boot.ts";
import { takeSnapshot } from "../src/snapshot/snapshot.ts";
import { dirStore } from "../src/snapshot/store.ts";
import { runDrill } from "../src/snapshot/drill.ts";
import { untilDrill } from "../src/snapshot/service.ts";
import { lastVerdict, postToRecoveryIssue, reportVerdict, verdictComment } from "../src/snapshot/verdict.ts";

const PASS = "correct horse battery staple";

describe("the drill's verdict", () => {
  let root: string;
  let app: App;
  const store = () => dirStore(join(root, "store"));
  const card = () =>
    vitals({ db: app.db, dataDir: app.config.dataDir, signals: app.signals }).degraded.find(
      (d) => d.cause === "drill",
    );

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "forge-verdict-"));
    app = createApp({ dataDir: join(root, "live"), port: 0 });
    const u = await createUser(app.db, {
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!u.ok) throw new Error(u.error);
    const repo = await createRepo(app, u.value, { name: "notes", visibility: "private" });
    if (!repo.ok) throw new Error(String(repo.error));
    await takeSnapshot(
      {
        db: app.db,
        dataDir: app.config.dataDir,
        reposRoot: app.reposRoot,
        version: "t",
        passphrase: PASS,
      },
      store(),
      new Date("2026-09-22T08:00:00Z"),
    );
  });

  afterAll(async () => {
    app.close();
    await rm(root, { recursive: true, force: true });
  });

  // The shipped path: `drill()` in the service runs the drill, then reports it.
  const drillAndReport = async (
    d: ReturnType<typeof deps>,
    post: (body: string) => Promise<string>,
  ) => {
    const result = await runDrill(d);
    return { result, posted: await reportVerdict(d.dataDir, result, post) };
  };

  const deps = (boot: () => Promise<{ ok: boolean; reason: string }>) => ({
    store: store(),
    dataDir: app.config.dataDir,
    passphrase: PASS,
    boot,
  });

  test("a stand-in drill posts one comment with snapshot, time, health, counts and the verdict", async () => {
    const posts: string[] = [];
    const { result } = await drillAndReport(
      deps(async () => ({ ok: true, reason: "" })),
      async (body) => {
        posts.push(body);
        return "posted: 201";
      },
    );
    expect(result.verdict).toBe("green");
    expect(result.health).toBe("ok");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain("PASSED");
    expect(posts[0]).toContain("snapshot: 2026-09-22T08-00-00Z");
    expect(posts[0]).toContain("health: ok");
    expect(posts[0]).toContain("repositories: 1");
    expect(posts[0]).toContain("issues: 0");
    expect(posts[0]).toMatch(/restore took: \d+\.\d s/);
    expect(card()).toBeUndefined();
  });

  test("a failing drill makes the card naming the step, and the next passing drill clears it", async () => {
    const posts: string[] = [];
    const post = async (body: string) => (posts.push(body), "ok");
    const { result } = await drillAndReport(
      deps(async () => ({ ok: false, reason: "health answered 503" })),
      post,
    );
    expect(result.verdict).toBe("red");
    expect(result.failedStep).toBe("health");
    expect(posts[0]).toContain("FAILED at health");
    const c = card();
    expect(c?.sentence).toContain("failed at health");
    expect(c?.sentence).toContain("health answered 503");
    expect(lastVerdict(app.config.dataDir)?.verdict).toBe("red");

    await drillAndReport(deps(async () => ({ ok: true, reason: "" })), post);
    expect(card()).toBeUndefined();
  });

  test("a post that throws still keeps the verdict", async () => {
    const { posted } = await drillAndReport(
      deps(async () => ({ ok: false, reason: "no" })),
      async () => {
        throw new Error("forge unreachable");
      },
    );
    expect(posted).toContain("forge unreachable");
    expect(card()).toBeDefined();
  });

  test("the comment of a drill that never reached health says so", () => {
    const text = verdictComment({
      at: "2026-09-22T09:00:00Z",
      snapshotId: null,
      ms: 5,
      counts: { repositories: 0, issues: 0 },
      health: "unreached",
      verdict: "red",
      failedStep: "fetch",
      reason: "the store holds no snapshot",
    });
    expect(text).toContain("FAILED at fetch");
    expect(text).toContain("health: unreached");
  });

  test("the real boot reads a restored directory's health on a side port", async () => {
    const dir = join(root, "boot-data");
    const { restoreSnapshot } = await import("../src/snapshot/restore.ts");
    await restoreSnapshot(store(), "2026-09-22T08-00-00Z", dir, { passphrase: PASS });
    const booted = await bootRestored(dir, 40_000);
    expect(booted).toEqual({ ok: true, reason: "" });
  }, 60_000);
});

describe("the weekly schedule", () => {
  const at = (iso: string) => Date.parse(iso);
  const fires = (iso: string) => new Date(at(iso) + untilDrill(at(iso)));

  test("from a Saturday it fires the next day at 09:00 UTC", () => {
    expect(fires("2026-10-17T12:00:00Z").toISOString()).toBe("2026-10-18T09:00:00.000Z");
  });
  test("on a Sunday before 09:00 it fires that morning", () => {
    expect(fires("2026-10-18T08:59:00Z").toISOString()).toBe("2026-10-18T09:00:00.000Z");
  });
  test("on a Sunday at or after 09:00 it waits a week", () => {
    expect(fires("2026-10-18T09:00:00Z").toISOString()).toBe("2026-10-25T09:00:00.000Z");
    expect(fires("2026-10-18T09:00:01Z").toISOString()).toBe("2026-10-25T09:00:00.000Z");
  });
  test("whenever asked, it is a Sunday at 09:00 UTC, within a week", () => {
    for (let h = 0; h < 24 * 14; h += 7) {
      const now = at("2026-01-01T00:30:00Z") + h * 3_600_000;
      const wait = untilDrill(now);
      const d = new Date(now + wait);
      expect([d.getUTCDay(), d.getUTCHours(), d.getUTCMinutes()]).toEqual([0, 9, 0]);
      expect(wait).toBeGreaterThan(0);
      expect(wait).toBeLessThanOrEqual(7 * 24 * 3_600_000);
    }
  });
});

describe("telling the recovery issue", () => {
  const real = globalThis.fetch;
  const env = { ...process.env };
  afterAll(() => {
    globalThis.fetch = real;
    process.env = env;
  });
  const setup = (status: number) => {
    process.env["FORGE_URL"] = "http://forge.test";
    process.env["FORGE_TOKEN"] = "t";
    process.env["FORGE_RECOVERY_ISSUE"] = "7";
    const seen: { url: string; signal: boolean }[] = [];
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      seen.push({ url, signal: init.signal !== undefined });
      return new Response("{}", { status });
    }) as unknown as typeof fetch;
    return seen;
  };

  test("a 201 is posted, to the named issue, with a timeout", async () => {
    const seen = setup(201);
    expect(await postToRecoveryIssue("hi")).toBe("posted: 201");
    expect(seen[0]).toEqual({
      url: "http://forge.test/api/v1/repos/trevato/forge/issues/7/comments",
      signal: true,
    });
  });

  test("a 403 is not posted", async () => {
    setup(403);
    expect(await postToRecoveryIssue("hi")).toBe("not posted: 403");
  });

  test("a verdict file that cannot be written still lets the comment go", async () => {
    const dir = join(tmpdir(), "forge-verdict-nodir", "\0bad");
    const posts: string[] = [];
    const said = await reportVerdict(
      dir,
      {
        at: "2026-10-18T09:00:00Z",
        snapshotId: "s",
        ms: 1,
        counts: { repositories: 0, issues: 0 },
        health: "ok",
        verdict: "green",
        failedStep: null,
        reason: null,
      },
      async (b) => (posts.push(b), "posted: 201"),
    );
    expect(posts).toHaveLength(1);
    expect(said).toContain("verdict not kept");
  });
});
