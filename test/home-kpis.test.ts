/**
 * The home page's figures as plain data (#2870): seeded landings, deploys and
 * checks give the expected numbers, a pull that landed no commit is not
 * counted, and an empty forge gives zeros and a null median.
 */


import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, type App } from "../src/app.ts";
import { openIssue } from "../src/actions/issues.ts";
import { createRepo } from "../src/actions/repos.ts";
import type { Repo } from "../src/core/repos.ts";
import { createRun } from "../src/core/runs.ts";
import { createUser } from "../src/core/users.ts";
import { readKpis } from "../src/flow/kpis.ts";
import { createForgeApp } from "../src/tui/forge.ts";
import { dashboardScreen } from "../src/tui/screens/dashboard.ts";
import { headlessTerminal } from "../src/tui/term/terminal.ts";
import { settleApp } from "./helpers/tui.ts";

const HOUR = 3_600_000;
const MIN = 60_000;
const NOW = Date.parse("2026-10-19T12:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("home kpis", () => {
  let dataDir: string;
  let app: App;
  let repo: Repo;
  let n = 0;

  const setup = async () => {
    dataDir = await mkdtemp(join(tmpdir(), "forge-kpis-"));
    app = createApp({ dataDir, port: 0 });
    const a = await createUser(app.db, {
      origin: "seed",
      trusted: true,
      username: "alice",
      email: "alice@forge.local",
      password: "a-good-passphrase",
      adminIfFirst: true,
    });
    if (!a.ok) throw new Error(a.error);
    const made = await createRepo(app, a.value, { name: "shop" });
    if (!made.ok) throw new Error(String(made.error));
    repo = made.value;
    return a.value;
  };
  const landing = (user: Awaited<ReturnType<typeof setup>>, mergedAt: string, oid: string, baseOid: string) => {
    const issue = openIssue(app, user, repo, { title: `Pull ${++n}`, body: "" });
    if (!issue.ok) throw new Error(String(issue.error));
    app.db.query("UPDATE issue SET kind = 'pull', state = 'closed' WHERE id = ?1").run(issue.value.id);
    app.db
      .query(
        `INSERT INTO pull (issue_id, base_branch, head_branch, base_oid, head_oid, merged_at, merged_oid)
         VALUES (?1, ?2, ?3, ?4, '', ?5, ?6)`,
      )
      .run(issue.value.id, repo.defaultBranch, `b/${n}`, baseOid, mergedAt, oid);
  };
  const run = (kind: "check" | "deploy", set: Record<string, string | null>, extra = {}) => {
    const r = createRun(app.db, { repoId: repo.id, kind, ...extra });
    for (const [column, value] of Object.entries(set))
      app.db.query(`UPDATE run SET ${column} = ?1 WHERE id = ?2`).run(value, r.id);
  };

  afterAll(async () => {
    app?.db.close();
    await rm(dataDir, { recursive: true, force: true });
  });

  test("an empty forge gives zeros and a null median", async () => {
    await setup();
    const k = readKpis(app.db, new Date(NOW));
    expect(k.landedHours).toEqual(new Array(24).fill(0));
    expect(k.landed).toBe(0);
    expect(k.live).toBeNull();
    expect(k.medianCheckMs).toBeNull();
  });

  describe("a seeded forge", () => {
    beforeAll(async () => {
      await rm(dataDir, { recursive: true, force: true });
      const alice = await setup();
      landing(alice, ago(10 * MIN), "c1", "b0");
      landing(alice, ago(40 * MIN), "c2", "c1");
      landing(alice, ago(70 * MIN), "c3", "c2");
      landing(alice, ago(23 * HOUR + 30 * MIN), "c4", "c3");
      landing(alice, ago(25 * HOUR), "c0", "bz"); // outside the day
      landing(alice, ago(20 * MIN), "c3", "c2"); // carried by an earlier landing
      landing(alice, ago(30 * MIN), "c2", "c2"); // empty: merged into the base it found
      run("deploy", { state: "ok", commit_oid: "old", serving_at: ago(30 * HOUR) }, { env: "production" });
      run("deploy", { state: "ok", commit_oid: "c2", serving_at: ago(35 * MIN) }, { env: "production" });
      run("deploy", { state: "ok", commit_oid: "pre", serving_at: ago(5 * MIN) }, { env: "preview" });
      run("check", { state: "ok", started_at: ago(30 * MIN), finished_at: ago(20 * MIN) }); // 10 min
      run("check", { state: "failed", started_at: ago(2 * HOUR), finished_at: ago(2 * HOUR - 20 * MIN) }); // 20 min
      run("check", { state: "ok", started_at: ago(5 * HOUR), finished_at: ago(5 * HOUR - 60 * MIN) }); // 60 min
      run("check", { state: "ok", started_at: ago(30 * HOUR), finished_at: ago(29 * HOUR) }); // too old
      run("check", { state: "cancelled", started_at: ago(1 * HOUR), finished_at: ago(50 * MIN) });
    });

    test("landings per hour, the empty ones left out", () => {
      const k = readKpis(app.db, new Date(NOW));
      expect(k.landedHours[0]).toBe(2);
      expect(k.landedHours[1]).toBe(1);
      expect(k.landedHours[23]).toBe(1);
      expect(k.landedHours).toHaveLength(24);
      expect(k.landed).toBe(4);
    });

    test("the newest serving production deploy is live", () => {
      expect(readKpis(app.db, new Date(NOW)).live).toEqual({ sha: "c2", at: ago(35 * MIN) });
    });

    test("the median check time is over finished checks of the day", () => {
      expect(readKpis(app.db, new Date(NOW)).medianCheckMs).toBe(20 * MIN);
    });

    test("times come from now, not the clock", () => {
      const later = readKpis(app.db, new Date(NOW + 2 * HOUR));
      expect(later.landedHours[2]).toBe(2);
      expect(later.landedHours[0]).toBe(0);
      expect(later.landed).toBe(3);
      const earlier = readKpis(app.db, new Date(NOW - 45 * MIN));
      expect(earlier.live?.sha).toBe("old");
    });
  });
});

describe("terminal dashboard figures", () => {
  test("an admin with no running version still gets the figures, and the live line says so", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-kpis-tui-"));
    const tuiApp = createApp({ dataDir: dir, port: 0 });
    const saved = { c: process.env["FORGE_COMMIT"], a: process.env["FORGE_APP_COMMIT"] };
    delete process.env["FORGE_COMMIT"];
    delete process.env["FORGE_APP_COMMIT"];
    try {
      const made = await createUser(tuiApp.db, {
        origin: "seed",
        trusted: true,
        username: "alice",
        email: "alice@forge.local",
        password: "a-good-passphrase",
        adminIfFirst: true,
      });
      if (!made.ok) throw new Error(made.error);
      const terminal = headlessTerminal(120, 30);
      const { app: tui, session } = createForgeApp(
        tuiApp,
        { sshUsername: "alice", remoteAddress: "127.0.0.1", fingerprint: "SHA256:test", user: made.value },
        { terminal, exitHooks: false },
      );
      tui.start();
      tui.ctx.push(dashboardScreen(session, tui.ctx));
      await settleApp(tui);
      const text = tui.screen.toText();
      tui.stop?.();
      expect(text).toContain("Shipped per hour");
      expect(text).toContain("nothing live yet");
      expect(text).toContain("Median check time");
    } finally {
      if (saved.c !== undefined) process.env["FORGE_COMMIT"] = saved.c;
      if (saved.a !== undefined) process.env["FORGE_APP_COMMIT"] = saved.a;
      tuiApp.db.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
